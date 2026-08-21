// SPDX-License-Identifier: GPL-3.0-or-later
//
// 「热词」的词向量层：加载 int8 量化的词表，按目标词算出全词表排名。
//
// 数据是 scripts/build-hotword-data.mjs 从腾讯 AI Lab 中文词向量压出来的
// （52,728 词 / 200 维 / int8），常驻内存约 11MB。
//
// 性能账：每开一局给目标词建一次全表排名要 60-70ms（52728 × 200 次乘加再排序），
// 之后这一局里每次猜词都只是查表，O(1)。所以【一定】要在开局时建表、
// 而不是每次猜词现算——现算的话八个人一起猜能把事件循环压死。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const HW_DATA_DIR = path.resolve(__dirname, 'data');

/** 排名用 Uint16 存，词表超过 65536 就得换 Uint32 —— 这里挡一道，别静默截断 */
const MAX_VOCAB = 65536;

export class WordVectors {
  /**
   * @param {string} [dir] 数据目录，默认 server/hotword/data
   * @returns {WordVectors|null} 数据文件缺失时返回 null（游戏不可用，但不该拖垮整个进程）
   */
  static load(dir) {
    dir = dir || HW_DATA_DIR;
    const binPath = path.join(dir, 'vocab.bin');
    const txtPath = path.join(dir, 'vocab.txt');
    const ansPath = path.join(dir, 'answers.txt');
    for (const f of [binPath, txtPath, ansPath]) {
      if (!fs.existsSync(f)) return null;
    }
    return new WordVectors(binPath, txtPath, ansPath);
  }

  constructor(binPath, txtPath, ansPath) {
    const buf = fs.readFileSync(binPath);
    this.size = buf.readUInt32LE(0);
    this.dim = buf.readUInt32LE(4);
    if (this.size > MAX_VOCAB) {
      throw new Error(`词表 ${this.size} 个词超过 ${MAX_VOCAB}，排名存不进 Uint16，得改 vectors.js`);
    }
    // 直接在文件 Buffer 上开视图，不复制。Node 读进来的 Buffer 起点不一定 4 字节对齐，
    // Float32Array 对齐不了会抛错，所以 scale 那段单独拷一份，int8 无所谓对齐。
    const scaleBytes = this.size * 4;
    this.scale = new Float32Array(this.size);
    for (let i = 0; i < this.size; i++) this.scale[i] = buf.readFloatLE(8 + i * 4);
    this.q = new Int8Array(buf.buffer, buf.byteOffset + 8 + scaleBytes, this.size * this.dim);

    this.words = fs.readFileSync(txtPath, 'utf8').split('\n');
    if (this.words.length !== this.size) {
      throw new Error(`vocab.txt 有 ${this.words.length} 行，vocab.bin 说有 ${this.size} 个词，对不上`);
    }
    this.index = new Map();
    for (let i = 0; i < this.size; i++) this.index.set(this.words[i], i);

    /** @type {{word:string, category:string}[]} */
    this.answers = [];
    for (const line of fs.readFileSync(ansPath, 'utf8').split('\n')) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const [word, category] = s.split(/\s+/);
      if (!word || !this.index.has(word)) continue; // 不在词表的答案会让整局无解，直接跳过
      this.answers.push({ word, category: category || '其他' });
    }
    if (!this.answers.length) throw new Error('答案池是空的，检查 answers.txt');
  }

  has(word) {
    return this.index.has(word);
  }

  /**
   * 给目标词算出全词表排名。
   * @param {string} target
   * @returns {Uint16Array} rank[i] 是词表第 i 个词的排名，0 就是目标词自己
   */
  rankTable(target) {
    const ti = this.index.get(target);
    if (ti === undefined) throw new Error(`目标词不在词表里：${target}`);
    const { size, dim, q, scale } = this;

    // 余弦相似度。向量在离线阶段已经 L2 归一化过了，所以点积就是余弦，
    // 再各自乘回自己的量化缩放系数。
    const sims = new Float32Array(size);
    const to = ti * dim;
    const ts = scale[ti];
    for (let i = 0; i < size; i++) {
      let dot = 0;
      const o = i * dim;
      for (let d = 0; d < dim; d++) dot += q[o + d] * q[to + d];
      sims[i] = dot * scale[i] * ts;
    }

    const order = new Uint16Array(size);
    for (let i = 0; i < size; i++) order[i] = i;
    // Uint16Array 的 sort 是数值排序，但我们要按 sims 排，得先转成普通数组
    const arr = Array.from(order).sort((a, b) => sims[b] - sims[a]);
    const rank = new Uint16Array(size);
    for (let r = 0; r < size; r++) rank[arr[r]] = r;
    return rank;
  }

  /**
   * 找出所有跟目标词互为子串的词。
   *
   * 这是中文版特有的坑：目标词「咖啡」，前 50 名邻居里有 8 个是
   * 喝咖啡/咖啡豆/咖啡馆/咖啡杯/咖啡店/咖啡机/咖啡厅/咖啡因 ——
   * 随手猜个「咖啡厅」看到"第 26 名"，答案就白给了。英文版没这个问题。
   *
   * 处理方式是把这些词整个从本局词表里摘掉，让它们表现得跟生僻词一样
   * （"不认识这个词"）。不能提示"太接近了"——那句话本身就在告诉对方
   * 答案里有这两个字。
   *
   * @returns {Set<number>} 词表下标
   */
  relatedForms(target) {
    const out = new Set();
    for (let i = 0; i < this.size; i++) {
      const w = this.words[i];
      if (w === target) continue;
      if (w.includes(target) || target.includes(w)) out.add(i);
    }
    return out;
  }
}
