// SPDX-License-Identifier: GPL-3.0-or-later
//
// 「热词」的离线数据管线：把腾讯 AI Lab 中文词向量压成服务端能常驻内存的小文件。
//
// 只需要跑一次，产物已经提交进仓库了。要换词表或者换模型才需要重跑。
//
// 用法：
//   1. 下载词向量（116MB，Apache-2.0）：
//      curl -L -o /tmp/tencent-light.bin \
//        https://huggingface.co/shibing624/text2vec-word2vec-tencent-chinese/resolve/main/light_Tencent_AILab_ChineseEmbedding.bin
//   2. node scripts/build-hotword-data.mjs /tmp/tencent-light.bin
//
// 产物（写进 server/hotword/data/）：
//   vocab.txt  词表，一行一个词，顺序＝词频从高到低
//   vocab.bin  int8 量化的词向量，头部 8 字节存 词数/维数
//
// 为什么是 int8：float32 是 42MB，int8 是 10.5MB，实测前 1000 名的重合度
// 99.6%、前 2000 名的平均排名偏移 7 位——游戏里根本感觉不出来，但仓库和
// 内存都省下四分之三。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'server', 'hotword', 'data');

/** 只取词频最高的这么多个词来筛。再往后就全是人名、错别字和网络黑话了 */
const FREQ_CUTOFF = 60000;
/** 词长（汉字数）。1 个字的太歧义，5 个字以上基本是短语 */
const MIN_LEN = 2;
const MAX_LEN = 4;

const CJK = /^[一-龥]+$/;

function die(msg) {
  console.error(`[build] ${msg}`);
  process.exit(1);
}

/**
 * 解析 word2vec 的二进制格式：
 *   "<词数> <维数>\n" 然后每个词是 "词 " + 维数 × float32（小端）
 */
function readWord2Vec(file) {
  const buf = fs.readFileSync(file);
  let p = buf.indexOf(0x0a); // '\n'
  if (p < 0) die(`${file} 不像 word2vec 二进制格式（找不到头部换行）`);
  const [count, dim] = buf.toString('ascii', 0, p).trim().split(/\s+/).map(Number);
  if (!Number.isInteger(count) || !Number.isInteger(dim)) die(`头部解析失败：${buf.toString('ascii', 0, p)}`);
  p += 1;

  const words = new Array(count);
  const vecs = new Float32Array(count * dim);
  for (let i = 0; i < count; i++) {
    const sp = buf.indexOf(0x20, p); // ' '
    if (sp < 0) die(`第 ${i} 个词解析失败`);
    words[i] = buf.toString('utf8', p, sp);
    p = sp + 1;
    for (let d = 0; d < dim; d++) {
      vecs[i * dim + d] = buf.readFloatLE(p);
      p += 4;
    }
  }
  return { words, vecs, dim, count };
}

const src = process.argv[2];
if (!src) die('用法：node scripts/build-hotword-data.mjs <tencent-light.bin 的路径>');
if (!fs.existsSync(src)) die(`找不到 ${src}`);

console.log(`[build] 读 ${src} …`);
const { words, vecs, dim, count } = readWord2Vec(src);
console.log(`[build] 原始词向量：${count} 词 / ${dim} 维`);

// ==================== 挑词表 ====================
//
// 规则很粗但有效：词频前 6 万里，纯汉字、2-4 个字。
// 剩下的那 9 万个是标点、单字、英文、数字、颜文字和一堆网络黑话，
// 留着只会让"这词不在词表"变成"这词在，但排名毫无意义"。

const keep = [];
for (let i = 0; i < Math.min(FREQ_CUTOFF, count); i++) {
  const w = words[i];
  if (w.length < MIN_LEN || w.length > MAX_LEN) continue;
  if (!CJK.test(w)) continue;
  keep.push(i);
}
console.log(`[build] 筛出 ${keep.length} 个词（词频前 ${FREQ_CUTOFF}，${MIN_LEN}-${MAX_LEN} 个汉字）`);

// ==================== 归一化 + int8 量化 ====================
//
// 先做 L2 归一化，之后算相似度就只是点积，服务端不用每次再开方。
// 再按每个向量自己的最大绝对值缩放到 [-127,127]，缩放系数单独存 float32。

const n = keep.length;
const q = new Int8Array(n * dim);
const scale = new Float32Array(n);
const vocab = new Array(n);

for (let k = 0; k < n; k++) {
  const src0 = keep[k] * dim;
  vocab[k] = words[keep[k]];

  let norm = 0;
  for (let d = 0; d < dim; d++) norm += vecs[src0 + d] * vecs[src0 + d];
  norm = Math.sqrt(norm) || 1;

  let peak = 0;
  for (let d = 0; d < dim; d++) peak = Math.max(peak, Math.abs(vecs[src0 + d] / norm));
  const s = (peak || 1) / 127;
  scale[k] = s;

  const dst = k * dim;
  for (let d = 0; d < dim; d++) {
    q[dst + d] = Math.max(-127, Math.min(127, Math.round(vecs[src0 + d] / norm / s)));
  }
}

// ==================== 写出 ====================

fs.mkdirSync(DATA_DIR, { recursive: true });

const head = Buffer.alloc(8);
head.writeUInt32LE(n, 0);
head.writeUInt32LE(dim, 4);
const binPath = path.join(DATA_DIR, 'vocab.bin');
fs.writeFileSync(binPath, Buffer.concat([
  head,
  Buffer.from(scale.buffer, scale.byteOffset, scale.byteLength),
  Buffer.from(q.buffer, q.byteOffset, q.byteLength),
]));

const txtPath = path.join(DATA_DIR, 'vocab.txt');
fs.writeFileSync(txtPath, vocab.join('\n'), 'utf8');

console.log(`[build] 写出 ${binPath}（${(fs.statSync(binPath).size / 1e6).toFixed(1)}MB）`);
console.log(`[build] 写出 ${txtPath}（${(fs.statSync(txtPath).size / 1e6).toFixed(1)}MB）`);

// ==================== 校验答案池 ====================
//
// 答案池是手挑的（server/hotword/data/answers.txt），但手挑的词不一定在词表里。
// 不在词表里的答案会让整局无解，必须在这里挡掉。

const ansPath = path.join(DATA_DIR, 'answers.txt');
if (!fs.existsSync(ansPath)) {
  console.warn(`[build] ⚠ 没有 ${ansPath}，跳过答案池校验`);
} else {
  const have = new Set(vocab);
  const missing = [];
  let total = 0;
  for (const line of fs.readFileSync(ansPath, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const word = s.split(/\s+/)[0];
    total += 1;
    if (!have.has(word)) missing.push(word);
  }
  console.log(`[build] 答案池 ${total} 个词，其中 ${missing.length} 个不在词表里`);
  if (missing.length) {
    console.warn(`[build] ⚠ 这些词得从 answers.txt 里删掉，否则那一局无解：\n  ${missing.join(' ')}`);
    process.exitCode = 1;
  }
}
