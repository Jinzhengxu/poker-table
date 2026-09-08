#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// 算出 169 个起手牌各自的真实胜率，生成 server/bot/data/preflop.js。
//
// 只需要跑一次，产物已经提交进仓库了。改了 evaluator.js 的计分口径才需要重跑。
//
//   node scripts/build-preflop-equity.mjs            # 默认 40 万次/手，约 5 分钟
//   node scripts/build-preflop-equity.mjs --sims 100000 --out /tmp/preflop.js
//
// 为什么自己算而不是抄一张网上的表：
//
//   1. 口径一致。这张表是用本项目的 evaluator.js（经 fastscore.js 的性能镜像）
//      算出来的，和牌桌上真正比大小用的是同一套规则。抄来的表要是有一点点
//      不同的假设（比如平分底池怎么折算），就会和引擎对不上。
//   2. 可复现。种子写死，任何人重跑都得到逐位相同的结果。
//   3. 零外部数据。仓库不必依赖某个网页哪天还在不在。
//
// 定义：**对 1 个随机对手、打到河牌的胜率**（平分底池按份数折算）。
// 这是「起手牌有多强」最标准也最好复现的定义。
//
// 它的局限，用之前必须知道：这不是「开池范围表」。真实的开池范围还要考虑
// 翻牌后的可玩性——同花连张（比如 76s）对随机牌的胜率很低，但因为能做成
// 顺子同花、翻后好打，多数职业玩家的开池范围里都有它。按这张表切「前 20%」
// 会低估这类牌。
//
// **这一层现在由 scripts/build-preflop-ranges.mjs 补上了**：它从真实范围表里
// 读出 169 个手型的可玩性档位，equity.js 先按档位排、档内才按这张表的胜率排。
// 所以这张表现在是次级键，不再单独决定 "前 X%" 是哪些牌。

import { estimateEquity } from '../server/bot/equity.js';
import { makeRng } from '../server/eval/harness.js';
import { writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const RANKS = 'AKQJT98765432';           // 从大到小

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 || i === process.argv.length - 1 ? dflt : process.argv[i + 1];
}

const SIMS = Number(arg('sims', 400_000));
const SEED = Number(arg('seed', 20260908));
const OUT = arg('out', 'server/bot/data/preflop.js');

/** 169 个起手牌的规范名与代表牌型 */
function canonicalHands() {
  const out = [];
  for (let i = 0; i < RANKS.length; i++) {
    for (let j = i; j < RANKS.length; j++) {
      const hi = RANKS[i];
      const lo = RANKS[j];
      if (i === j) {
        // 对子：6 种组合
        out.push({ name: hi + lo, cards: [hi + 's', lo + 'h'], combos: 6 });
      } else {
        // 同花：4 种组合；不同花：12 种组合
        out.push({ name: hi + lo + 's', cards: [hi + 's', lo + 's'], combos: 4 });
        out.push({ name: hi + lo + 'o', cards: [hi + 's', lo + 'h'], combos: 12 });
      }
    }
  }
  return out;
}

const hands = canonicalHands();
console.error(`${hands.length} 个起手牌，每个 ${SIMS.toLocaleString('en-US')} 次模拟，seed=${SEED}`);
if (hands.length !== 169) throw new Error(`应该是 169 个，实际 ${hands.length}`);
const totalCombos = hands.reduce((s, h) => s + h.combos, 0);
if (totalCombos !== 1326) throw new Error(`组合数应该是 1326，实际 ${totalCombos}`);

const rng = makeRng(SEED);
const t0 = Date.now();
const results = [];

for (let i = 0; i < hands.length; i++) {
  const h = hands[i];
  const e = estimateEquity({
    hole: h.cards,
    board: [],
    opponents: 1,
    sims: SIMS,
    budgetMs: 10 * 60_000,      // 给足：这里要的是精度，不是低延迟
    rng,
  });
  if (!e) throw new Error(`${h.name} 算不出来`);
  results.push({ ...h, pct: e.pct, margin: e.margin });

  if ((i + 1) % 20 === 0 || i === hands.length - 1) {
    const el = (Date.now() - t0) / 1000;
    const eta = (el / (i + 1)) * (hands.length - i - 1);
    process.stderr.write(`\r  ${i + 1}/${hands.length}  已用 ${el.toFixed(0)}s  预计还要 ${eta.toFixed(0)}s   `);
  }
}
process.stderr.write('\n');

results.sort((a, b) => b.pct - a.pct);

// ---- 交叉验证：和公开的标准值对一下 ----
// 这些是扑克圈广泛引用的「对随机一手的胜率」。对不上说明哪里错了，
// 不该把一张错的表提交进仓库。
const KNOWN = { AA: 85.2, KK: 82.4, QQ: 79.9, JJ: 77.5, TT: 75.1,
                AKs: 67.0, AKo: 65.3, '22': 50.3, '72o': 34.6 };
console.error('\n交叉验证（对公开标准值）：');
let worst = 0;
for (const [name, expect] of Object.entries(KNOWN)) {
  const got = results.find((r) => r.name === name);
  const d = Math.abs(got.pct - expect);
  worst = Math.max(worst, d);
  console.error(`  ${name.padEnd(4)} 算出 ${String(got.pct).padStart(5)}%  公开值 ${String(expect).padStart(5)}%  差 ${d.toFixed(1)}`);
}
console.error(`最大偏差 ${worst.toFixed(2)} 个百分点`);
if (worst > 1.0) {
  throw new Error(`和公开值差太多（${worst.toFixed(2)}pt），不写出文件 —— 先查是不是算错了`);
}

console.error(`\n最强 5 手：${results.slice(0, 5).map((r) => `${r.name} ${r.pct}%`).join('  ')}`);
console.error(`最弱 5 手：${results.slice(-5).map((r) => `${r.name} ${r.pct}%`).join('  ')}`);

// ---- 写文件 ----
const lines = results.map((r) => `  ${JSON.stringify(r.name)}: ${r.pct},`);
const body = `// SPDX-License-Identifier: GPL-3.0-or-later
//
// 169 个起手牌对 1 个随机对手、打到河牌的胜率（百分比）。
//
// **这是自动生成的，不要手改。** 重新生成：
//   node scripts/build-preflop-equity.mjs
//
// 生成参数：每手 ${SIMS.toLocaleString('en-US')} 次蒙特卡洛，seed=${SEED}，
// 用的是本项目自己的 evaluator.js（经 fastscore.js）。已对公开标准值交叉验证，
// 最大偏差 ${worst.toFixed(2)} 个百分点。95% 置信半宽约 ±${results[0].margin} 个百分点。
//
// 用途：equity.js 按这张表给 1326 个两张牌组合排序，"对手只玩前 X%" 就是从
// 这个序里切前 X%。取代了原来的 Chen formula —— Chen 是 1970 年代的启发式
// 打分，这张表是真实胜率。
//
// 局限：这不是「开池范围表」。真实开池范围还要考虑翻牌后的可玩性，
// 同花连张（76s 之类）对随机牌胜率低但很好打，按这张表切范围会低估它们。

/** 起手牌规范名 -> 对 1 个随机对手的胜率（%） */
export const PREFLOP_EQUITY = Object.freeze({
${lines.join('\n')}
});

/**
 * 把两张牌变成规范名：点数从大到小，同花加 s，不同花加 o，对子不加后缀。
 * 例：('As','Kh') -> 'AKo'，('7h','7d') -> '77'
 */
export function canonicalHand(a, b) {
  const order = '${RANKS}';
  const ra = a[0];
  const rb = b[0];
  const ia = order.indexOf(ra);
  const ib = order.indexOf(rb);
  if (ia < 0 || ib < 0) return null;
  const hi = ia <= ib ? ra : rb;
  const lo = ia <= ib ? rb : ra;
  if (ra === rb) return hi + lo;
  return hi + lo + (a[1] === b[1] ? 's' : 'o');
}

export default PREFLOP_EQUITY;
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, body);
console.error(`\n已写入 ${OUT}（${results.length} 项，${(body.length / 1024).toFixed(1)} KB）`);
console.error(`总用时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
