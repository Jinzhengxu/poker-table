// SPDX-License-Identifier: GPL-3.0-or-later
//
// 评测台的测试。评测台自己出错的话，它给出的所有数字都是假的，
// 所以这里把「筹码守恒」「零和」「可复现」「统计口径」逐条钉住。

import test from 'node:test';
import assert from 'node:assert/strict';

import { freshDeck } from '../server/deck.js';
import { actionHistory } from '../server/engine.js';
import { inferOpponentRange } from '../server/bot/range.js';
import {
  makeRng, shuffleWith, playHand, runMatch, summarize, runShadow, runCalibration, formatReport,
} from '../server/eval/harness.js';
import { rulePolicy } from '../server/eval/policies.js';

// ==================== 随机源与牌堆 ====================

test('makeRng：同种子逐位可复现，不同种子不同', () => {
  const a = makeRng(42);
  const b = makeRng(42);
  const c = makeRng(43);
  const xs = Array.from({ length: 20 }, () => a());
  const ys = Array.from({ length: 20 }, () => b());
  const zs = Array.from({ length: 20 }, () => c());
  assert.deepEqual(xs, ys);
  assert.notDeepEqual(xs, zs);
  for (const v of xs) assert.ok(v >= 0 && v < 1, `越界：${v}`);
});

test('shuffleWith：是个排列，不改原数组，同种子同结果', () => {
  const base = freshDeck();
  const copy = base.slice();
  const s1 = shuffleWith(base, makeRng(7));
  const s2 = shuffleWith(base, makeRng(7));
  assert.deepEqual(base, copy, '原数组被改了');
  assert.deepEqual(s1, s2);
  assert.equal(s1.length, 52);
  assert.equal(new Set(s1).size, 52, '有重复牌');
  assert.deepEqual([...s1].sort(), [...base].sort(), '不是同一副牌的排列');
});

// ==================== 范围推断 ====================

test('inferOpponentRange：没有行动信息时就是「任意两张」', () => {
  assert.equal(inferOpponentRange({ history: [], mySeat: 0 }), 1);
  assert.equal(inferOpponentRange({ history: null, mySeat: 0 }), 1);
  // 只有跟注，没人开火 —— 仍然没信息
  assert.equal(inferOpponentRange({
    history: [{ street: 'preflop', acts: [{ seat: 1, type: 'call' }] }], mySeat: 0,
  }), 1);
});

test('inferOpponentRange：对手每多一次进攻，范围单调收窄', () => {
  const one = inferOpponentRange({
    history: [{ street: 'preflop', acts: [{ seat: 1, type: 'raise', amount: 30 }] }], mySeat: 0,
  });
  const two = inferOpponentRange({
    history: [{ street: 'preflop', acts: [
      { seat: 1, type: 'raise', amount: 30 }, { seat: 2, type: 'raise', amount: 90 }] }], mySeat: 0,
  });
  assert.ok(one < 1, '一次加注应该收窄');
  assert.ok(two < one, '再加注应该更窄');
});

test('inferOpponentRange：自己的加注不算对手信息', () => {
  const mine = inferOpponentRange({
    history: [{ street: 'preflop', acts: [{ seat: 0, type: 'raise', amount: 30 }] }], mySeat: 0,
  });
  assert.equal(mine, 1, '自己加注不该收窄对手范围');
});

test('inferOpponentRange：永远落在 [0.12, 1]，下限是标定出来的不是拍的', () => {
  const many = { street: 'river', acts: Array.from({ length: 20 }, (_, i) => ({ seat: 1, type: 'raise', amount: i })) };
  const r = inferOpponentRange({ history: [many, many, many, many], mySeat: 0 });
  assert.ok(r >= 0.12 && r <= 1, `越界：${r}`);
  // 0.12 这个下限是 runCalibration 量出来的：推断最紧的局面里，对手真牌的
  // 中位排名也就在前 20% 上下。夹到 0.05 会让人机做出没根据的弃牌。
  assert.equal(r, 0.12, '下限被改了？改之前先重跑 --calibrate');
});

test('inferOpponentRange：第一次进攻收得多，之后每次收得少（边际信息量递减）', () => {
  const mk = (n) => [{ street: 'preflop', acts: Array.from({ length: n }, () => ({ seat: 1, type: 'raise', amount: 30 })) }];
  const r1 = inferOpponentRange({ history: mk(1), mySeat: 0 });
  const r2 = inferOpponentRange({ history: mk(2), mySeat: 0 });
  const r3 = inferOpponentRange({ history: mk(3), mySeat: 0 });

  const firstDrop = 1 - r1;         // 从「任意两张」收到 r1
  const secondDrop = r1 - r2;       // 再收一点
  assert.ok(firstDrop > secondDrop * 2,
    `第一次进攻该比第二次信息量大得多：收了 ${firstDrop.toFixed(2)} vs ${secondDrop.toFixed(2)}`);
  assert.ok(r3 < r2 && r2 < r1, '仍然要单调');
});

// ==================== 一手牌 ====================

test('playHand：筹码守恒，返回的净盈亏加起来是 0', () => {
  const p = rulePolicy({ sims: 200 });
  for (let d = 0; d < 30; d++) {
    const assignment = new Map();
    for (let s = 0; s < 6; s++) assignment.set(s, p);
    const out = playHand({
      assignment,
      deck: shuffleWith(freshDeck(), makeRng(d + 1)),
      buttonSeat: d % 6,
      startingStack: 1000,
      config: { smallBlind: 5, bigBlind: 10, ante: 0 },
      handNo: d + 1,
      rng: makeRng(d + 100),
    });
    assert.ok(out.complete, `第 ${d} 副没打完`);
    const sum = [...out.net.values()].reduce((a, b) => a + b, 0);
    assert.equal(sum, 0, `第 ${d} 副筹码不守恒：${sum}`);
    assert.ok(out.decisions > 0);
  }
});

test('playHand：策略给非法动作也不会卡死，退化成合法动作', () => {
  const evil = { name: 'evil', decide: () => ({ type: 'raise', amount: -999999 }) };
  const assignment = new Map();
  for (let s = 0; s < 4; s++) assignment.set(s, evil);
  const out = playHand({
    assignment,
    deck: shuffleWith(freshDeck(), makeRng(1)),
    buttonSeat: 0,
    startingStack: 1000,
    config: { smallBlind: 5, bigBlind: 10, ante: 0 },
    handNo: 1,
    rng: makeRng(2),
  });
  assert.ok(out.complete, '非法动作把牌局卡死了');
  assert.equal([...out.net.values()].reduce((a, b) => a + b, 0), 0);
});

test('playHand：策略抛异常也不会让评测崩掉', () => {
  const boom = { name: 'boom', decide: () => { throw new Error('炸了'); } };
  const assignment = new Map();
  for (let s = 0; s < 3; s++) assignment.set(s, boom);
  const out = playHand({
    assignment,
    deck: shuffleWith(freshDeck(), makeRng(9)),
    buttonSeat: 0,
    startingStack: 1000,
    config: { smallBlind: 5, bigBlind: 10, ante: 0 },
    handNo: 1,
    rng: makeRng(3),
  });
  assert.ok(out.complete);
});

// ==================== 对局与统计 ====================

test('runMatch：零和 —— 两个策略的 bb/100 必须相反（到取整精度）', () => {
  const res = runMatch({
    policies: [rulePolicy({ useRange: true, sims: 200 }), rulePolicy({ useRange: false, sims: 200 })],
    decks: 40, seats: 6, seed: 11,
  });
  assert.equal(res.rows.length, 2);
  // 这里**不能**写 a === -b。bbPer100 是 round2 之后的数，而 Math.round 对
  // ±x.5 不对称（Math.round(7062.5) = 7063，Math.round(-7062.5) = -7062，
  // 都是朝 +∞ 取整）。真值正好落在半分位时，两边会差 0.01——那是取整的性质，
  // 不是零和被破坏。所以判据是「和为零，误差不超过一个取整步长」。
  const sum = res.rows[0].bbPer100 + res.rows[1].bbPer100;
  assert.ok(Math.abs(sum) <= 0.01,
    `不是零和：${res.rows[0].bbPer100} vs ${res.rows[1].bbPer100}（和 ${sum}）`);
  assert.equal(res.rows[0].handsPlayed, res.rows[1].handsPlayed, '两边手数应该一样多');
});

test('runMatch：同种子完全可复现', () => {
  const run = () => runMatch({
    policies: [rulePolicy({ useRange: true, sims: 200 }), rulePolicy({ useRange: false, sims: 200 })],
    decks: 25, seats: 6, seed: 99,
  });
  assert.deepEqual(run().rows, run().rows);
});

test('runMatch：对偶发牌 —— 每个策略打的玩家手数相等', () => {
  const res = runMatch({
    policies: [rulePolicy({ useRange: true, sims: 100 }), rulePolicy({ useRange: false, sims: 100 })],
    decks: 20, seats: 6, seed: 3,
  });
  // 6 座位 / 2 策略 × 2 遍轮转 = 每副牌每个策略 6 个玩家手
  assert.equal(res.rows[0].handsPlayed, 6 * 20);
  assert.equal(res.meta.handsTotal, 20 * 2);
});

test('runMatch：座位数不能被策略数整除时直接报错，不给出不公平的结果', () => {
  assert.throws(() => runMatch({
    policies: [rulePolicy({ sims: 50, name: 'a' }), rulePolicy({ sims: 50, name: 'b' })],
    decks: 2, seats: 5,
  }), /不能被/);
});

test('runMatch：少于 2 个策略要报错', () => {
  assert.throws(() => runMatch({ policies: [rulePolicy({ sims: 50 })], decks: 2 }), /至少需要 2 个/);
});

test('summarize：统计口径 —— 已知输入算出已知的 bb/100 与置信区间', () => {
  // 3 副牌，策略 A 每副赢 6bb（每副 2 个玩家手 -> 每手 3bb），B 相反
  const perDeck = [{ A: 6, B: -6 }, { A: 6, B: -6 }, { A: 6, B: -6 }];
  const res = summarize({
    perDeck, handsPerDeck: { A: 2, B: 2 },
    policies: [{ name: 'A' }, { name: 'B' }],
    decks: 3, rotations: 2, seats: 4,
    config: { smallBlind: 5, bigBlind: 10 }, startingStack: 1000,
    totalDecisions: 0, incomplete: 0, seed: 1,
  });
  assert.equal(res.rows[0].bbPer100, 300, '每手 3bb 就是 300 bb/100');
  assert.equal(res.rows[0].ci95, 0, '样本完全一致时置信区间应该是 0');
  assert.equal(res.diff.bbPer100, 600);
});

test('summarize：方差大时置信区间跨过 0，并且标成不显著', () => {
  const perDeck = [{ A: 100, B: -100 }, { A: -100, B: 100 }, { A: 50, B: -50 }, { A: -48, B: 48 }];
  const res = summarize({
    perDeck, handsPerDeck: { A: 1, B: 1 },
    policies: [{ name: 'A' }, { name: 'B' }],
    decks: 4, rotations: 2, seats: 2,
    config: { smallBlind: 5, bigBlind: 10 }, startingStack: 1000,
    totalDecisions: 0, incomplete: 0, seed: 1,
  });
  assert.ok(res.diff.ci95 > Math.abs(res.diff.bbPer100), '这种数据不该被判成显著');
  assert.equal(res.diff.significant, false);
  assert.ok(res.diff.p > 0.05);
});

test('formatReport：不显著时必须说「没测出差别」，不能说成打平', () => {
  const perDeck = [{ A: 100, B: -100 }, { A: -100, B: 100 }];
  const res = summarize({
    perDeck, handsPerDeck: { A: 1, B: 1 },
    policies: [{ name: 'A' }, { name: 'B' }],
    decks: 2, rotations: 2, seats: 2,
    config: { smallBlind: 5, bigBlind: 10 }, startingStack: 1000,
    totalDecisions: 0, incomplete: 0, seed: 1,
  });
  const txt = formatReport(res);
  assert.match(txt, /没测出差别/);
  assert.ok(!/打平/.test(txt));
});

// ==================== 影子评测 ====================

test('runShadow：分桶统计自洽，且噪声底远低于收窄桶的改变率', () => {
  const s = runShadow({ decks: 120, sims: 1500, seed: 21 });
  assert.equal(s.wide.n + s.narrowed.n, s.equityDecisions, '两个桶加起来应该等于总数');
  assert.ok(s.equityDecisions > 0 && s.equityDecisions <= s.decisions);

  // range=1 的桶里两次估算走的是同一条代码路径，差异只可能来自蒙特卡洛采样噪声。
  // 这是测量的噪声底：收窄桶的信号必须显著高于它，否则说明什么都没测到。
  assert.ok(s.wide.changedPct < 4, `噪声底太高了：${s.wide.changedPct}%`);
  assert.ok(s.narrowed.changedPct > s.wide.changedPct * 3,
    `信号没有明显高过噪声：收窄 ${s.narrowed.changedPct}% vs 噪声 ${s.wide.changedPct}%`);
});

test('runShadow：范围收窄时胜率被【下修】，方向不能反', () => {
  const s = runShadow({ decks: 120, sims: 1500, seed: 22 });
  assert.ok(s.narrowed.medianEquityDrop > 0,
    `对手范围变紧，自己的胜率该降不该升：${s.narrowed.medianEquityDrop}`);
  // 收紧的方向应该以「本来跟注改成弃牌」为主
  assert.ok(s.foldedInstead > s.calledInstead,
    `方向反了：改弃 ${s.foldedInstead} 次 vs 改跟 ${s.calledInstead} 次`);
});

test('runShadow：越靠后的街道，推断范围越紧', () => {
  const s = runShadow({ decks: 300, sims: 1000, seed: 23 });
  const pre = s.byStreet.preflop;
  const river = s.byStreet.river;
  assert.ok(pre && river, '应该有翻牌前和河牌的样本');
  assert.ok(river.avgRange < pre.avgRange,
    `河牌的范围该比翻牌前紧：${river.avgRange} vs ${pre.avgRange}`);
});


// ==================== 校准检查 ====================

test('runCalibration：能对上对手真牌，桶里有观测值', () => {
  const c = runCalibration({ decks: 150, seed: 31 });
  assert.ok(c.rows.length >= 2, '至少该有几个桶');
  for (const r of c.rows) {
    assert.ok(r.n > 0);
    assert.ok(r.actualMedian > 0 && r.actualMedian <= 1, `百分位越界：${r.actualMedian}`);
    assert.ok(Number.isFinite(r.tightnessRatio));
  }
});

test('runCalibration：没有任何桶紧过头 3 倍以上（紧过头 = 人机会乱弃牌）', () => {
  const c = runCalibration({ decks: 400, seed: 32 });
  const worst = c.rows.reduce((m, r) => Math.max(m, r.tightnessRatio), 0);
  // 这条是对 bot/range.js 那几个常数的回归保护。第一版是 4 倍，
  // 实测导致 bb/100 净亏损；重新标定之后最差 2 倍。
  assert.ok(worst <= 3,
    `范围推断紧过头 ${worst} 倍 —— 重新跑 npm run eval -- --calibrate 再调 range.js`);
});

test('runCalibration：完全没信息时（范围=1）对手就该接近随机牌', () => {
  const c = runCalibration({ decks: 300, seed: 33 });
  const wide = c.rows.find((r) => r.assumed === 1);
  assert.ok(wide, '应该有「无信息」这个桶');
  // 随机两张牌的百分位中位数就是 0.5
  assert.ok(Math.abs(wide.actualMedian - 0.5) < 0.15,
    `无信息时对手该接近随机，实际中位 ${wide.actualMedian}`);
});

// ==================== 共用的行动历史 ====================

test('actionHistory：盲注不算动作（否则 VPIP 全是假的）', () => {
  const events = [
    { kind: 'blind', seat: 1, amount: 5, text: '小盲' },
    { kind: 'blind', seat: 2, amount: 10, text: '大盲' },
    { kind: 'deal' },
    { kind: 'action', seat: 3, type: 'call', amount: 10, text: '' },
    { kind: 'flop' },
    { kind: 'action', seat: 1, type: 'bet', amount: 20, text: '' },
  ];
  const h = actionHistory(events);
  assert.equal(h.length, 2);
  assert.equal(h[0].street, 'preflop');
  assert.equal(h[0].acts.length, 1, '盲注混进行动序列了');
  assert.equal(h[0].acts[0].type, 'call');
  assert.equal(h[1].street, 'flop');
});

test('actionHistory：没有动作的街道会被丢掉，输入非法时返回空数组', () => {
  assert.deepEqual(actionHistory(null), []);
  assert.deepEqual(actionHistory(undefined), []);
  assert.deepEqual(actionHistory([{ kind: 'flop' }, { kind: 'turn' }]), []);
});
