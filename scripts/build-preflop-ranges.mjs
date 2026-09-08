#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// 把一组真实的 GTO 范围表压成「可玩性档位」，生成 server/bot/data/ranges.js。
//
//   node scripts/build-preflop-ranges.mjs               # 从网上抓，需要联网
//   node scripts/build-preflop-ranges.mjs --src ./greenline.ts --out /tmp/ranges.js
//
// 只需要跑一次，产物已经提交进仓库了。运行时不联网。
//
// ---- 为什么需要这张表 ----
//
// data/preflop.js 是「牌有多强」的排序（对随机两张牌的全下胜率）。
// 但 equity.js 的 opponentRange 问的是另一个问题：「对手会**玩**哪些牌」。
// 这两个序不一样，而且差得系统性地远——拿真实开池范围和「按胜率取前 X%」比：
//
//     UTG  14.2%  重合 80.9%
//     CO   26.7%  重合 75.1%      <- 四分之一是错的
//     BTN  43.6%  重合 83.7%
//
// 分歧全是一个方向：胜率排序多收 offsuit 高牌（A9o A8o K9o A5o），
// 漏掉同花连张和小对子（76s 65s 54s 98s T9s 22 33）。76s 胜率排 #116/169，
// 但每一张 CO 开池表里都有它；K9o 排 #40，没人拿它在 CO 开池。
// 摊牌牌力和翻后可玩性是两个维度，胜率只测了前一个。
//
// ---- 构造 ----
//
// 范围表是**集合**，不是序。把它变成序的办法是利用嵌套：一手牌能在多紧的
// 局面里出现，就说明它有多强。从最紧（4bet 全下）到最松（大盲防守）排成
// 一条梯子，每一档取「到这一档为止的并集」，一手牌落在它第一次出现的那档。
// 档内没有更多信息，就按 data/preflop.js 的胜率排——这两个维度在档内高度相关。
//
// 实测这条梯子几乎完美嵌套：169 个手型里只有 2 个越档（87s、J2s），
// 被并集构造吸收掉。
//
// 最松那档（65%）之外还剩 35% 的组合没人玩，没有可玩性信息，只能按胜率排。
// 无所谓：没有哪个对手范围推断会切到那里。
//
// **一个必须知道的性质**：最紧的几档里会混进同花连张。UTG 面对 3bet 的继续范围
// 里 87s、T9s 都是 call —— 那是真的 GTO 打法（同花连张靠可玩性和隐含赔率跟 3bet），
// 不是解析错误。后果是这个序把 87s 排在 AJo 前面：作为**范围**陈述它是对的
// （AJo 面对 3bet 会被弃掉，87s 不会），但如果对手是一个只按牌力打的真人石头，
// 「前 7%」里塞进 87s 就偏了。这是「用出现在多紧的局面里」当代理变量的固有代价。
//
// ---- 数据来源与许可 ----
//
// 上游：https://github.com/AHTOOOXA/poker-charts （MIT），
//       src/data/ranges/greenline.ts，pin 在 commit SHA 见下。
//
// **注意**：该仓库的 MIT 许可覆盖它自己的代码。这个数据文件的头部注释写着
// 「Extracted from GreenCharts2024_01.pdf (Greenline Poker)」——也就是说
// 底层的图表是第三方的作品，上游仓库转成 MIT 重新发布这一步，未必是它有权做的。
// 我们这里只用它做**排序的档位划分**（169 个手型各归到 11 个档中的一个），
// 不复制原图表的呈现，也不再分发原始 PDF。用之前请自行判断这条链是否可接受。
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PREFLOP_EQUITY } from '../server/bot/data/preflop.js';

/** 上游文件锁在这个 commit，保证任何时候重跑得到同样的输入 */
const SRC_SHA = '85ad2041ad9268e2c9a71b22028ca27588b99362';
const SRC_URL = `https://raw.githubusercontent.com/AHTOOOXA/poker-charts/${SRC_SHA}/src/data/ranges/greenline.ts`;

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 || i === process.argv.length - 1 ? dflt : process.argv[i + 1];
}

const OUT = arg('out', 'server/bot/data/ranges.js');
const SRC = arg('src', null);

/**
 * 梯子。每项是 [标签, 位置列表, 只算主动动作]。
 *
 * 前三档来自「面对 3bet/4bet 还继续」的范围——那是最紧的表达；
 * 中间四档是各位置的开池范围；最后两档是大盲防守，最松。
 * onlyStrong=true 时只取 raise/allin，用来把最紧的那两档切出来
 * （BB 面对 UTG 4bet 还全下的只有 AA/AKs/KK）。
 */
const LADDER = [
  ['4bet 全下',      ['BB-vs-4bet-UTG'],              true],
  ['5bet 价值',      ['UTG-vs-3bet-BB'],              true],
  ['跟 4bet',        ['BB-vs-4bet-UTG'],              false],
  ['UTG 面对 3bet',  ['UTG-vs-3bet-BB'],              false],
  ['UTG 面对 3bet+', ['UTG-vs-3bet-SB'],              false],
  ['UTG 开池',       ['UTG-RFI'],                     false],
  ['MP 开池',        ['MP-RFI'],                      false],
  ['CO 开池',        ['CO-RFI'],                      false],
  ['BTN/SB 开池',    ['BTN-RFI', 'SB-RFI'],           false],
  ['BB 防守 BTN',    ['BB-vs-open-BTN'],              false],
  ['BB 防守 SB',     ['BB-vs-open-SB'],               false],
];

/** 手型 -> 组合数 */
function combos(h) {
  if (h.length === 2) return 6;          // 对子
  return h.endsWith('s') ? 4 : 12;
}

/** 从上游的 .ts 里把每张表解析成 {手型: 动作} */
function parseCharts(src) {
  const out = {};
  for (const [, name, body] of src.matchAll(/'([A-Za-z0-9\-+]+)':\s*\{(.*?)\n {2}\}/gs)) {
    const cells = {};
    for (const [, hand, act] of body.matchAll(/'([AKQJT2-9]{2}[so]?)':\s*'([a-z]+)'/g)) {
      cells[hand] = act;
    }
    if (Object.keys(cells).length) out[name] = cells;
  }
  return out;
}

const raw = SRC
  ? readFileSync(SRC, 'utf8')
  : await (async () => {
      const r = await fetch(SRC_URL);
      if (!r.ok) throw new Error(`抓取上游失败：HTTP ${r.status} ${SRC_URL}`);
      return r.text();
    })();

const charts = parseCharts(raw);
console.error(`解析到 ${Object.keys(charts).length} 张表`);

// ---- 累积并集：一手牌归到它第一次出现的那档 ----
const tierOf = new Map();
const bounds = [];
const seen = new Set();
let violations = 0;

LADDER.forEach(([label, spots, onlyStrong], tier) => {
  const here = new Set();
  for (const spot of spots) {
    const cells = charts[spot];
    if (!cells) throw new Error(`上游没有这张表：${spot}`);
    for (const [hand, act] of Object.entries(cells)) {
      if (onlyStrong && act !== 'raise' && act !== 'allin') continue;
      here.add(hand);
    }
  }
  // 上一档有、这一档没有的手牌 = 越档。并集构造会吸收掉，只记个数。
  for (const h of seen) if (!here.has(h)) violations++;
  let added = 0;
  for (const h of here) {
    if (seen.has(h)) continue;
    seen.add(h);
    tierOf.set(h, tier);
    added++;
  }
  const cum = [...seen].reduce((s, h) => s + combos(h), 0);
  bounds.push({ tier, label, spots: spots.join('+'), added, combos: cum, pct: +(100 * cum / 1326).toFixed(1) });
  console.error(
    `  ${String(tier).padStart(2)} ${label.padEnd(14)} 累计 ${String(cum).padStart(4)} 组合 ` +
    `${String(bounds[tier].pct).padStart(5)}%  新增 ${String(added).padStart(3)} 手型`
  );
});

// 剩下的没人玩，塞进最后一档，档内按胜率排
const TAIL = LADDER.length;
const all = Object.keys(PREFLOP_EQUITY);
if (all.length !== 169) throw new Error(`起手牌表应该有 169 项，实际 ${all.length}`);
let tailCount = 0;
for (const h of all) {
  if (!tierOf.has(h)) { tierOf.set(h, TAIL); tailCount++; }
}
bounds.push({
  tier: TAIL, label: '没人玩', spots: '(按胜率排)', added: tailCount,
  combos: 1326, pct: 100,
});
console.error(`  ${String(TAIL).padStart(2)} 没人玩        累计 1326 组合 100.0%  新增 ${tailCount} 手型`);
console.error(`越档手型 ${violations} 个（并集构造已吸收）`);

// ---- 自检：错了就别写文件 ----
const problems = [];
for (const h of all) if (!tierOf.has(h)) problems.push(`${h} 没有档位`);
if (tierOf.size !== 169) problems.push(`档位表 ${tierOf.size} 项，应该 169`);
// 档位必须单调不减
for (let i = 1; i < bounds.length; i++) {
  if (bounds[i].combos < bounds[i - 1].combos) problems.push(`第 ${i} 档累计组合数倒退了`);
}
// 常识锚点：这些顺序错了说明解析或梯子搭错了
const ORDER_ANCHORS = [
  ['AA', '72o'], ['KK', 'K9o'], ['AKs', 'AKo'],
  ['76s', 'K9o'],   // 同花连张要排在 offsuit 高牌前面 —— 这正是换表的理由
  ['22', 'A8o'], ['JTs', 'A9o'],
];
for (const [strong, weak] of ORDER_ANCHORS) {
  if (tierOf.get(strong) >= tierOf.get(weak)) {
    problems.push(`${strong} 的档位（${tierOf.get(strong)}）应该严格紧于 ${weak}（${tierOf.get(weak)}）`);
  }
}
if (tierOf.get('AA') !== 0) problems.push(`AA 应该在第 0 档，实际 ${tierOf.get('AA')}`);
if (tierOf.get('72o') !== TAIL) problems.push(`72o 应该在最后一档，实际 ${tierOf.get('72o')}`);
if (violations > 5) problems.push(`越档 ${violations} 个，梯子可能搭错了`);

if (problems.length) {
  console.error('\n自检没过，不写文件：');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.error('自检通过');

// ---- 输出 ----
// 按档位、档内按胜率排，读起来就是那条梯子本身
const sorted = [...all].sort((a, b) =>
  (tierOf.get(a) - tierOf.get(b)) || (PREFLOP_EQUITY[b] - PREFLOP_EQUITY[a]));
const lines = [];
let cur = -1;
for (const h of sorted) {
  const t = tierOf.get(h);
  if (t !== cur) {
    cur = t;
    const b = bounds[t];
    lines.push(`  // ${t}. ${b.label} —— 累计 ${b.combos}/1326 = ${b.pct}%  [${b.spots}]`);
  }
  lines.push(`  ${JSON.stringify(h)}: ${t},`);
}

const body = `// SPDX-License-Identifier: GPL-3.0-or-later
//
// 169 个起手牌的**可玩性档位**：数字越小，越紧的局面里也会出现这手牌。
//
// **这是自动生成的，不要手改。** 重新生成：
//   node scripts/build-preflop-ranges.mjs
//
// 用途：equity.js 用 (档位, 胜率) 给 1326 个组合排序，"对手只玩前 X%" 从这个
// 序里切。之前只按胜率排，那是「牌有多强」；范围问的是「人会玩哪些牌」，
// 两者系统性地不同——CO 开池范围和按胜率取前 26.7% 只重合 75%，
// 差的全是同花连张（76s 65s 54s）对 offsuit 高牌（A9o K9o A5o）。
//
// 档位是从一条**嵌套的真实范围梯子**上读出来的：从「面对 4bet 还全下」
// （1.2%，只有 AA/AKs/KK）一路松到「大盲防守小盲开池」（65%），
// 每手牌归到它第一次出现的那一档。最后一档是没人玩的 35%，按胜率排。
//
// 注意最紧的几档里混着同花连张（87s、T9s 在「UTG 面对 3bet」里是 call）。
// 那是真的 GTO 打法，不是解析错误 —— 但它让这个序把 87s 排在 AJo 前面。
// 作为范围陈述对，作为牌力陈述不对。详见生成脚本头部。
//
// 档位边界（累计组合数占 1326 的比例）：
${bounds.map((b) => `//   ${String(b.tier).padStart(2)}  ${String(b.pct).padStart(5)}%  ${b.label}`).join('\n')}
//
// 数据来源：https://github.com/AHTOOOXA/poker-charts （MIT）
//   src/data/ranges/greenline.ts @ ${SRC_SHA}
// 该文件自述提取自 GreenCharts2024_01.pdf (Greenline Poker)。我们只取档位划分，
// 不复制原图表的呈现。详见 scripts/build-preflop-ranges.mjs 头部的说明。

/** 档位数量（含最后那档「没人玩」） */
export const TIER_COUNT = ${bounds.length};

/** 每档的累计组合数占比（%），用于文档与测试 */
export const TIER_PCT = Object.freeze([${bounds.map((b) => b.pct).join(', ')}]);

/** 起手牌规范名 -> 可玩性档位（0 最紧） */
export const PLAY_TIER = Object.freeze({
${lines.join('\n')}
});

export default PLAY_TIER;
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, body);
console.error(`\n已写入 ${OUT}（169 项，${(body.length / 1024).toFixed(1)} KB）`);
