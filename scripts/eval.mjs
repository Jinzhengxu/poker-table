#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// 自对弈评测：量一下「范围感知的胜率」到底值多少 bb/100。
//
//   node scripts/eval.mjs                      # 默认 500 副牌
//   node scripts/eval.mjs --decks 3000         # 跑久一点，置信区间更窄
//   node scripts/eval.mjs --seats 6 --sims 2000 --seed 7
//   node scripts/eval.mjs --json > out.json    # 机器可读
//   node scripts/eval.mjs --shadow             # 影子模式：量「改变了多少决策」
//   node scripts/eval.mjs --calibrate          # 校准：范围推断准不准（拿对手真牌对照）
//
// 两种模式回答不同的问题：
//   默认   赢多少钱（bb/100）。方差巨大，要几万副牌才可能显著。
//   shadow 改变了多少个决策、胜率被修正了多少。方差小得多，几百副就能测准，
//          而且它解释【为什么】bb/100 是那个数。先看 shadow 再看 bb/100。
//
// 跑多久：一个决策点约 7ms（2000 次蒙特卡洛），6 人桌一手约 4 个需要算胜率的
// 决策点。500 副 × 2 遍 ≈ 30 秒；3000 副 ≈ 3 分钟。

import { runMatch, runShadow, runCalibration, formatReport } from '../server/eval/harness.js';
import { rulePolicy } from '../server/eval/policies.js';

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i === process.argv.length - 1) return dflt;
  return process.argv[i + 1];
}
const flag = (name) => process.argv.includes(`--${name}`);

const decks = Number(arg('decks', 500));
const seats = Number(arg('seats', 6));
const sims = Number(arg('sims', 2000));
const seed = Number(arg('seed', 1));
const asJson = flag('json');

if (flag('calibrate')) {
  const c = runCalibration({ decks, seats, seed });
  if (asJson) { console.log(JSON.stringify(c, null, 2)); process.exit(0); }
  console.log(`校准检查：${decks} 副牌。启发式假设的对手范围 vs 对手真牌的实际排名。\n`);
  console.log('| 假设范围 | 观测数 | 对手真牌实际排名（中位） | 紧了多少倍 |');
  console.log('| --- | ---: | ---: | ---: |');
  for (const r of c.rows) {
    console.log(`| 前 ${(r.assumed * 100).toFixed(0)}% | ${r.n} | 前 ${(r.actualMedian * 100).toFixed(0)}% | ${r.tightnessRatio}× |`);
  }
  console.log('\n最后一列 > 1 表示启发式认为对手比实际更紧 —— 那会让人机弃掉本该跟的牌。');
  process.exit(0);
}

if (flag('shadow')) {
  if (!asJson) {
    console.error(`影子模式：${decks} 副牌，${seats} 人桌，每个决策点把两种假设各算一遍\n`);
  }
  const t = Date.now();
  const s = runShadow({
    decks, seats, sims, seed,
    onProgress: asJson ? undefined : ({ done, total }) => {
      process.stderr.write(`\r  ${String(Math.round(done / total * 100)).padStart(3)}%  ${done}/${total} 副`);
    },
  });
  if (asJson) {
    console.log(JSON.stringify(s, null, 2));
  } else {
    process.stderr.write('\r' + ' '.repeat(40) + '\r');
    console.log(`决策点 ${s.decisions} 个，其中用得上胜率的 ${s.equityDecisions} 个（${s.equityDecisionPct}%）`);
    console.log('');
    console.log('| 街道 | 决策数 | 平均推断范围 | 动作改变率 |');
    console.log('| --- | ---: | ---: | ---: |');
    for (const k of ['preflop', 'flop', 'turn', 'river']) {
      const v = s.byStreet[k];
      if (v) console.log(`| ${k} | ${v.n} | ${v.avgRange} | ${v.changedPct}% |`);
    }
    console.log('');
    console.log(`范围没收窄（=1）的 ${s.wide.n} 个决策：改变率 ${s.wide.changedPct}%`);
    console.log(`  ↑ 这是【测量噪声底】——两次独立蒙特卡洛的采样差偶尔会翻转临界决策。`);
    console.log(`    下面那个数要拿它当基准来读，不是拿 0 当基准。`);
    console.log(`范围收窄了的 ${s.narrowed.n} 个决策：改变率 ${s.narrowed.changedPct}%，` +
                `胜率中位数下修 ${s.narrowed.medianEquityDrop} 个百分点`);
    console.log('');
    console.log(`方向：${s.foldedInstead} 次「本来跟注 → 改成弃牌」，` +
                `${s.calledInstead} 次反向`);
    console.log(`\n用时 ${((Date.now() - t) / 1000).toFixed(1)}s`);
  }
  process.exit(0);
}

const policies = [
  rulePolicy({ useRange: true, sims, name: 'range' }),
  rulePolicy({ useRange: false, sims, name: 'baseline' }),
];

if (!asJson) {
  console.error(`跑 ${decks} 副牌 × ${policies.length} 遍轮转，${seats} 人桌，` +
                `每次估算 ${sims} 次模拟，seed=${seed}`);
  console.error('对比：range（按行动序列推断对手范围）vs baseline（对手随机两张牌）\n');
}

const t0 = Date.now();
const res = runMatch({
  policies, decks, seats, seed,
  onProgress: asJson ? undefined : ({ done, total }) => {
    const pct = Math.round((done / total) * 100);
    process.stderr.write(`\r  ${String(pct).padStart(3)}%  ${done}/${total} 副`);
  },
});
const secs = ((Date.now() - t0) / 1000).toFixed(1);

if (asJson) {
  console.log(JSON.stringify({ ...res, seconds: Number(secs) }, null, 2));
} else {
  process.stderr.write('\r' + ' '.repeat(40) + '\r');
  console.log(formatReport(res));
  console.log(`\n用时 ${secs}s`);
}
