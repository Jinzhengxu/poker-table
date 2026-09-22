// SPDX-License-Identifier: GPL-3.0-or-later
// 中英文切换：词典必须覆盖页面、前端脚本、服务端日志键和服务端报错——漏一条这里就红。
// 词典的键是中文原文，所以"覆盖"就是：源码里每一条会给人看的中文，词典里都有。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const CJK = /[一-鿿]/;

/** 在 vm 里加载 public/i18n.js，喂一个假的浏览器环境 */
function load({ languages = ['en-US'], saved = null } = {}) {
  const window = {
    navigator: { languages, language: languages[0] || '' },
    localStorage: { getItem: () => saved, setItem() {} },
  };
  const ctx = { window };
  vm.runInNewContext(read('public/i18n.js'), ctx);
  return window.I18N;
}

test('语言判定：列表里有任何一种中文就是中文，手动选过的优先', () => {
  assert.equal(load({ languages: ['en-US'] }).lang, 'en');
  assert.equal(load({ languages: ['de-DE', 'en'] }).lang, 'en');
  assert.equal(load({ languages: ['en-US', 'zh-CN'] }).lang, 'zh');
  assert.equal(load({ languages: ['zh-TW'] }).lang, 'zh');
  assert.equal(load({ languages: [] }).lang, 'zh');
  assert.equal(load({ languages: ['en-US'], saved: 'zh' }).lang, 'zh');
  assert.equal(load({ languages: ['zh-CN'], saved: 'en' }).lang, 'en');
});

test('t()：中文原样、英文查表、两边都填参数、查不到不炸', () => {
  const zh = load({ languages: ['zh-CN'] });
  const en = load({ languages: ['en-US'] });
  assert.equal(zh.t('弃牌'), '弃牌');
  assert.equal(en.t('弃牌'), 'Fold');
  assert.equal(zh.t('第 {n} 手', { n: 3 }), '第 3 手');
  assert.equal(en.t('第 {n} 手', { n: 3 }), 'Hand 3');
  assert.equal(en.t('这句没有翻译'), '这句没有翻译');
  assert.equal(en.tlog({ text: '小明 加注到 80', k: 'raise', p: { name: '小明', amount: 80 } }), '小明 raises to 80');
  assert.equal(zh.tlog({ text: '小明 加注到 80', k: 'raise', p: { name: '小明', amount: 80 } }), '小明 加注到 80');
  assert.equal(en.tlog({ text: '老日志没有键' }), '老日志没有键');
});

test('词典覆盖 index.html 里每一条中文文本和属性', () => {
  const { EN } = load();
  let html = read('public/index.html').replace(/<!--[\s\S]*?-->/g, '');
  html = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
  const missing = new Set();
  for (const m of html.matchAll(/>([^<]*)</g)) {
    const key = m[1].replace(/\s+/g, ' ').trim();
    if (key && CJK.test(key) && !(key in EN)) missing.add(key);
  }
  for (const m of html.matchAll(/(?:title|aria-label|placeholder|data-key)="([^"]*)"/g)) {
    if (CJK.test(m[1]) && !(m[1] in EN)) missing.add(m[1]);
  }
  assert.deepEqual([...missing], [], 'index.html 里这些中文没有英文');
});

test('词典覆盖 app.js / voice.js 里每一处 tr(...) 的键', () => {
  const { EN } = load();
  const missing = new Set();
  for (const f of ['public/app.js', 'public/voice.js']) {
    for (const m of read(f).matchAll(/\btr\('((?:[^'\\]|\\.)*)'/g)) {
      if (!(m[1] in EN)) missing.add(`${f}: ${m[1]}`);
    }
    // 三元里挑键的写法：tr(cond ? 'a' : 'b', …)
    for (const m of read(f).matchAll(/\btr\([^)]*?\?\s*'([^']+)'\s*:\s*'([^']+)'/g)) {
      for (const k of [m[1], m[2]]) if (!(k in EN)) missing.add(`${f}: ${k}`);
    }
  }
  assert.deepEqual([...missing], []);
});

test('词典覆盖服务端每一个日志键，以及每一条会发给客户端的报错', () => {
  const { EN, LOG_EN } = load();
  const engine = read('server/engine.js');
  const room = read('server/room.js');
  const index = read('server/index.js');
  const keys = new Set();
  // 引擎事件：{ k: 'xxx' } / { k: cond ? 'a' : 'b' } / k: p.lastAction.type（六种动作）
  for (const m of engine.matchAll(/\bk: ([^,}]+)/g)) {
    for (const q of m[1].matchAll(/'([a-zA-Z]+)'/g)) keys.add(q[1]);
  }
  for (const k of ['fold', 'check', 'call', 'bet', 'raise', 'allin']) keys.add(k);
  // 房间日志：#pushLog(text, 'key' | cond ? 'a' : 'b', …)
  for (const m of room.matchAll(/#pushLog\((?:[^;])*?,\s*((?:'[a-zA-Z]+'|[^,)]*\?\s*'[a-zA-Z]+'\s*:\s*'[a-zA-Z]+'))/g)) {
    for (const q of m[1].matchAll(/'([a-zA-Z]+)'/g)) keys.add(q[1]);
  }
  assert.ok(keys.size >= 30, `只抓到 ${keys.size} 个日志键，抓取正则可能坏了`);
  const missingLog = [...keys].filter((k) => !(k in LOG_EN));
  assert.deepEqual(missingLog, [], '这些日志键没有英文模板');

  const missingMsg = new Set();
  for (const src of [room, index]) {
    for (const m of src.matchAll(/\bmsg: '([^']+)'/g)) {
      if (CJK.test(m[1]) && !(m[1] in EN)) missingMsg.add(m[1]);
    }
    for (const m of src.matchAll(/fail\('[A-Z_]+', '([^']+)'\)/g)) {
      if (CJK.test(m[1]) && !(m[1] in EN)) missingMsg.add(m[1]);
    }
  }
  assert.deepEqual([...missingMsg], [], '这些服务端报错没有英文');
});
