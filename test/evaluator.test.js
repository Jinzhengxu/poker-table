// SPDX-License-Identifier: GPL-3.0-or-later
// 牌型评估器与牌堆的测试（SPEC §3 / §4）

import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluate, compareHands, rankValue } from '../server/evaluator.js';
import { freshDeck, shuffle } from '../server/deck.js';

// ---------------------------------------------------------------------------
// 独立的暴力参考实现（与 evaluator.js 的实现思路不同，用于交叉验证）
// ---------------------------------------------------------------------------

const ORDER = '23456789TJQKA';

/** 所有可能的顺子：{cards: 点数集合, high: 用于 ranks 的最大点} */
const ALL_STRAIGHTS = [];
for (let hi = 14; hi >= 6; hi--) {
  ALL_STRAIGHTS.push({ cards: [hi, hi - 1, hi - 2, hi - 3, hi - 4], high: hi });
}
ALL_STRAIGHTS.push({ cards: [14, 5, 4, 3, 2], high: 5 }); // 轮子，最大点算 5

/** 参考实现：恰好 5 张牌 -> score */
function naiveScore5(cards) {
  assert.equal(cards.length, 5);
  const vals = cards.map((c) => ORDER.indexOf(c[0]) + 2);
  const suits = cards.map((c) => c[1]);

  const flush = suits.filter((s) => s === suits[0]).length === 5;

  let straightHigh = 0;
  for (const st of ALL_STRAIGHTS) {
    if (st.cards.every((x) => vals.includes(x))) {
      straightHigh = st.high;
      break;
    }
  }

  // 按“出现次数”把点数分桶
  const distinct = [...new Set(vals)].sort((a, b) => b - a);
  const quads = distinct.filter((x) => vals.filter((y) => y === x).length === 4);
  const trips = distinct.filter((x) => vals.filter((y) => y === x).length === 3);
  const pairs = distinct.filter((x) => vals.filter((y) => y === x).length === 2);
  const singles = distinct.filter((x) => vals.filter((y) => y === x).length === 1);
  const desc = [...vals].sort((a, b) => b - a);

  let cat;
  let ranks;
  if (flush && straightHigh) {
    cat = 8; ranks = [straightHigh, 0, 0, 0, 0];
  } else if (quads.length === 1) {
    cat = 7; ranks = [quads[0], singles[0], 0, 0, 0];
  } else if (trips.length === 1 && pairs.length === 1) {
    cat = 6; ranks = [trips[0], pairs[0], 0, 0, 0];
  } else if (flush) {
    cat = 5; ranks = desc;
  } else if (straightHigh) {
    cat = 4; ranks = [straightHigh, 0, 0, 0, 0];
  } else if (trips.length === 1) {
    cat = 3; ranks = [trips[0], singles[0], singles[1], 0, 0];
  } else if (pairs.length === 2) {
    cat = 2; ranks = [pairs[0], pairs[1], singles[0], 0, 0];
  } else if (pairs.length === 1) {
    cat = 1; ranks = [pairs[0], singles[0], singles[1], singles[2], 0];
  } else {
    cat = 0; ranks = desc;
  }

  return cat * 759375
    + ranks[0] * 50625
    + ranks[1] * 3375
    + ranks[2] * 225
    + ranks[3] * 15
    + ranks[4];
}

/** 枚举 n 选 5 的全部下标组合 */
function combos5(n) {
  const out = [];
  for (let a = 0; a < n - 4; a++) {
    for (let b = a + 1; b < n - 3; b++) {
      for (let c = b + 1; c < n - 2; c++) {
        for (let d = c + 1; d < n - 1; d++) {
          for (let e = d + 1; e < n; e++) out.push([a, b, c, d, e]);
        }
      }
    }
  }
  return out;
}

/** 便于断言：把牌数组排序后拼成一个可比较的串 */
const norm = (cs) => [...cs].sort().join(' ');

// ---------------------------------------------------------------------------
// rankValue
// ---------------------------------------------------------------------------

test('rankValue 按 SPEC 映射点数字符', () => {
  const expected = { 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, T: 10, J: 11, Q: 12, K: 13, A: 14 };
  for (const [ch, v] of Object.entries(expected)) {
    assert.equal(rankValue(ch), v, `rankValue('${ch}') 应为 ${v}`);
  }
  assert.throws(() => rankValue('1'), /非法/);
});

// ---------------------------------------------------------------------------
// 九种牌型
// ---------------------------------------------------------------------------

test('九种牌型的 cat 与中文 name 都正确', () => {
  const cases = [
    { cards: ['9h', '8h', '7h', '6h', '5h'], cat: 8, name: '同花顺' },
    { cards: ['As', 'Ks', 'Qs', 'Js', 'Ts'], cat: 8, name: '皇家同花顺' },
    { cards: ['9h', '9d', '9c', '9s', '5h'], cat: 7, name: '四条' },
    { cards: ['9h', '9d', '9c', '5s', '5h'], cat: 6, name: '葫芦' },
    { cards: ['Ah', 'Jh', '9h', '4h', '2h'], cat: 5, name: '同花' },
    { cards: ['9h', '8d', '7c', '6s', '5h'], cat: 4, name: '顺子' },
    { cards: ['9h', '9d', '9c', 'Ks', '5h'], cat: 3, name: '三条' },
    { cards: ['9h', '9d', '5c', '5s', 'Kh'], cat: 2, name: '两对' },
    { cards: ['9h', '9d', 'Kc', '5s', '3h'], cat: 1, name: '一对' },
    { cards: ['Ah', 'Jd', '9c', '5s', '3h'], cat: 0, name: '高牌' },
  ];
  for (const c of cases) {
    const r = evaluate(c.cards);
    assert.equal(r.cat, c.cat, `${c.cards.join(',')} 的 cat 应为 ${c.cat}，实际 ${r.cat}`);
    assert.equal(r.name, c.name, `${c.cards.join(',')} 的 name 应为 ${c.name}，实际 ${r.name}`);
    assert.equal(r.ranks.length, 5, 'ranks 长度必须固定为 5');
  }
});

test('ranks 语义严格遵守 SPEC 表格（含补 0）', () => {
  assert.deepEqual(evaluate(['Ah', 'Kh', 'Qh', 'Jh', 'Th']).ranks, [14, 0, 0, 0, 0]);
  assert.deepEqual(evaluate(['9h', '9d', '9c', '9s', '5h']).ranks, [9, 5, 0, 0, 0]);
  assert.deepEqual(evaluate(['9h', '9d', '9c', '5s', '5h']).ranks, [9, 5, 0, 0, 0]);
  assert.deepEqual(evaluate(['Ah', 'Jh', '9h', '4h', '2h']).ranks, [14, 11, 9, 4, 2]);
  assert.deepEqual(evaluate(['9h', '8d', '7c', '6s', '5h']).ranks, [9, 0, 0, 0, 0]);
  assert.deepEqual(evaluate(['9h', '9d', '9c', 'Ks', '5h']).ranks, [9, 13, 5, 0, 0]);
  assert.deepEqual(evaluate(['9h', '9d', '5c', '5s', 'Kh']).ranks, [9, 5, 13, 0, 0]);
  assert.deepEqual(evaluate(['9h', '9d', 'Kc', '5s', '3h']).ranks, [9, 13, 5, 3, 0]);
  assert.deepEqual(evaluate(['Ah', 'Jd', '9c', '5s', '3h']).ranks, [14, 11, 9, 5, 3]);
});

test('score 等于 cat*15^5 + ranks 的 15 进制展开', () => {
  const r = evaluate(['9h', '9d', '5c', '5s', 'Kh']); // 两对 9/5 带 K
  const expect = 2 * 759375 + 9 * 50625 + 5 * 3375 + 13 * 225 + 0 * 15 + 0;
  assert.equal(r.score, expect);
});

// ---------------------------------------------------------------------------
// 同花顺 / 皇家同花顺 / 轮子
// ---------------------------------------------------------------------------

test('皇家同花顺强于普通同花顺，且 name 区分开', () => {
  const royal = evaluate(['As', 'Ks', 'Qs', 'Js', 'Ts']);
  const sf = evaluate(['Ks', 'Qs', 'Js', 'Ts', '9s']);
  assert.equal(royal.name, '皇家同花顺');
  assert.equal(sf.name, '同花顺');
  assert.equal(royal.cat, 8);
  assert.equal(sf.cat, 8);
  assert.equal(royal.ranks[0], 14);
  assert.equal(sf.ranks[0], 13);
  assert.ok(royal.score > sf.score);
  assert.equal(compareHands(royal, sf), 1);
  assert.equal(compareHands(sf, royal), -1);
});

test('轮子顺子 A-2-3-4-5 判为顺子且 ranks[0] === 5', () => {
  const wheel = evaluate(['Ah', '2d', '3c', '4s', '5h']);
  assert.equal(wheel.cat, 4);
  assert.equal(wheel.name, '顺子');
  assert.deepEqual(wheel.ranks, [5, 0, 0, 0, 0]);
  // 轮子是最小的顺子，弱于 6 高顺子
  const six = evaluate(['2h', '3d', '4c', '5s', '6h']);
  assert.equal(compareHands(wheel, six), -1);
});

test('轮子同花 A-2-3-4-5 同花色判为同花顺（不是皇家）', () => {
  const wheelSF = evaluate(['Ah', '2h', '3h', '4h', '5h']);
  assert.equal(wheelSF.cat, 8);
  assert.equal(wheelSF.name, '同花顺');
  assert.deepEqual(wheelSF.ranks, [5, 0, 0, 0, 0]);
  // 强于任何四条，弱于 6 高同花顺
  assert.ok(wheelSF.score > evaluate(['As', 'Ad', 'Ac', 'Ah', 'Ks']).score);
  assert.equal(compareHands(wheelSF, evaluate(['2h', '3h', '4h', '5h', '6h'])), -1);
});

test('7 张里的轮子同花顺能被找出来', () => {
  const r = evaluate(['Ah', '2h', '3h', '4h', '5h', 'Kd', 'Kc']);
  assert.equal(r.cat, 8);
  assert.equal(r.name, '同花顺');
  assert.deepEqual(r.ranks, [5, 0, 0, 0, 0]);
  assert.equal(norm(r.best), norm(['Ah', '2h', '3h', '4h', '5h']));
});

// ---------------------------------------------------------------------------
// 同花 / 顺子 / 同花顺 的相互误判
// ---------------------------------------------------------------------------

test('同时存在同花与顺子时，同花顺不被误判为同花或顺子', () => {
  // 7 张里既有同花（红桃 5 张）也有顺子（5-9），且它们重合成同花顺
  const r = evaluate(['5h', '6h', '7h', '8h', '9h', '2c', 'Kd']);
  assert.equal(r.cat, 8);
  assert.equal(r.name, '同花顺');
  assert.deepEqual(r.ranks, [9, 0, 0, 0, 0]);
  assert.equal(norm(r.best), norm(['5h', '6h', '7h', '8h', '9h']));
});

test('有同花也有顺子但不构成同花顺时，取同花', () => {
  // 红桃 5 张同花：Ah Th 8h 4h 2h；另有顺子 5-6-7-8-9（混花色）
  const r = evaluate(['Ah', 'Th', '8h', '4h', '2h', '9c', '5s']);
  // 顺子需要 5 6 7 8 9，这里只有 5 8 9，故不成顺子；同花成立
  assert.equal(r.cat, 5);
  assert.equal(r.name, '同花');
  assert.deepEqual(r.ranks, [14, 10, 8, 4, 2]);

  // 真正同时有同花和顺子（不同牌）的情况
  const r2 = evaluate(['9h', '8h', '5h', '3h', '2h', '7c', '6d']);
  // 顺子 5-6-7-8-9 存在（9h 8h 7c 6d 5h），同花 9-8-5-3-2 也存在，同花更大
  assert.equal(evaluate(['9h', '8h', '7c', '6d', '5h']).cat, 4, '该 5 张确实是顺子');
  assert.equal(r2.cat, 5, '同花强于顺子');
  assert.deepEqual(r2.ranks, [9, 8, 5, 3, 2]);
});

test('7 张里同花有 6 张时取最大的 5 张', () => {
  const r = evaluate(['2h', '5h', '7h', '9h', 'Jh', 'Kh', '3c']);
  assert.equal(r.cat, 5);
  assert.equal(r.name, '同花');
  assert.deepEqual(r.ranks, [13, 11, 9, 7, 5]);
  assert.equal(norm(r.best), norm(['Kh', 'Jh', '9h', '7h', '5h']));
});

test('7 张里同花有 7 张时取最大的 5 张', () => {
  const r = evaluate(['2h', '4h', '6h', '8h', 'Th', 'Qh', 'Ah']);
  assert.equal(r.cat, 5);
  assert.deepEqual(r.ranks, [14, 12, 10, 8, 6]);
  assert.equal(norm(r.best), norm(['Ah', 'Qh', 'Th', '8h', '6h']));
});

test('顺子只在没有同花顺时成立；A 不能跨接（Q-K-A-2-3 不是顺子）', () => {
  const r = evaluate(['Qh', 'Kd', 'Ac', '2s', '3h']);
  assert.equal(r.cat, 0, 'K-A-2-3-Q 只是高牌');
  assert.equal(r.name, '高牌');
});

// ---------------------------------------------------------------------------
// 葫芦 / 四条 的多组合取舍
// ---------------------------------------------------------------------------

test('7 张里三条 + 两组对子，葫芦取最大三条 + 最大对子', () => {
  const r = evaluate(['7h', '7d', '7c', 'Ks', 'Kd', 'Qh', 'Qc']);
  assert.equal(r.cat, 6);
  assert.equal(r.name, '葫芦');
  assert.deepEqual(r.ranks, [7, 13, 0, 0, 0]);
  assert.equal(norm(r.best), norm(['7h', '7d', '7c', 'Ks', 'Kd']));
});

test('7 张里两组三条，葫芦取大三条 + 小三条中的两张', () => {
  const r = evaluate(['Kh', 'Kd', 'Kc', '7s', '7d', '7c', '2h']);
  assert.equal(r.cat, 6);
  assert.deepEqual(r.ranks, [13, 7, 0, 0, 0]);
  assert.equal(r.best.length, 5);
  assert.equal(evaluate(r.best).score, r.score);
});

test('四条 + 对子时，踢脚取最大的单张', () => {
  const r = evaluate(['9h', '9d', '9c', '9s', '5h', '5d', 'Ac']);
  assert.equal(r.cat, 7);
  assert.equal(r.name, '四条');
  assert.deepEqual(r.ranks, [9, 14, 0, 0, 0]);
  assert.equal(norm(r.best), norm(['9h', '9d', '9c', '9s', 'Ac']));
});

// ---------------------------------------------------------------------------
// 踢脚比较
// ---------------------------------------------------------------------------

test('一对：同对子比踢脚', () => {
  const a = evaluate(['Ah', 'Ad', 'Kc', 'Qs', 'Jh']);
  const b = evaluate(['As', 'Ac', 'Kd', 'Qh', 'Th']);
  assert.equal(a.cat, 1);
  assert.equal(b.cat, 1);
  assert.equal(compareHands(a, b), 1);
  assert.equal(compareHands(b, a), -1);

  // 第一踢脚就分出胜负
  const c = evaluate(['Ah', 'Ad', 'Qc', 'Js', '9h']);
  assert.equal(compareHands(a, c), 1);
});

test('两对：先比大对，再比小对，最后比踢脚', () => {
  const kkQQa = evaluate(['Kh', 'Kd', 'Qc', 'Qs', 'Ah']);
  const kkJJa = evaluate(['Ks', 'Kc', 'Jc', 'Js', 'Ad']);
  const kkQQj = evaluate(['Ks', 'Kc', 'Qd', 'Qh', 'Jd']);
  const aaQQ2 = evaluate(['Ah', 'Ad', 'Qc', 'Qs', '2h']);

  assert.equal(compareHands(kkQQa, kkJJa), 1, '大对相同则比小对');
  assert.equal(compareHands(kkQQa, kkQQj), 1, '两对相同则比踢脚');
  assert.equal(compareHands(aaQQ2, kkQQa), 1, '大对更大者胜');
});

test('四条：同四条比踢脚', () => {
  const a = evaluate(['9h', '9d', '9c', '9s', 'Ah']);
  const b = evaluate(['9h', '9d', '9c', '9s', 'Kh']);
  assert.equal(a.cat, 7);
  assert.equal(b.cat, 7);
  assert.equal(compareHands(a, b), 1);
  assert.equal(compareHands(b, a), -1);
});

test('三条：比完三条比两个踢脚', () => {
  const a = evaluate(['8h', '8d', '8c', 'As', 'Qh']);
  const b = evaluate(['8h', '8d', '8c', 'As', 'Jh']);
  assert.equal(compareHands(a, b), 1);
});

test('高牌：逐张比较到第五张', () => {
  const a = evaluate(['Ah', 'Kd', '9c', '7s', '5h']);
  const b = evaluate(['Ad', 'Kh', '9s', '7c', '4d']);
  assert.equal(compareHands(a, b), 1);
});

test('牌型类别之间的强弱顺序正确', () => {
  const ordered = [
    evaluate(['Ah', 'Kd', '9c', '7s', '5h']),          // 0 高牌
    evaluate(['2h', '2d', '9c', '7s', '5h']),          // 1 一对
    evaluate(['2h', '2d', '3c', '3s', '5h']),          // 2 两对
    evaluate(['2h', '2d', '2c', '7s', '5h']),          // 3 三条
    evaluate(['2h', '3d', '4c', '5s', '6h']),          // 4 顺子
    evaluate(['2h', '4h', '6h', '8h', 'Th']),          // 5 同花
    evaluate(['2h', '2d', '2c', '3s', '3h']),          // 6 葫芦
    evaluate(['2h', '2d', '2c', '2s', '3h']),          // 7 四条
    evaluate(['2h', '3h', '4h', '5h', '6h']),          // 8 同花顺
  ];
  for (let i = 0; i < ordered.length; i++) {
    assert.equal(ordered[i].cat, i);
    if (i > 0) {
      assert.equal(compareHands(ordered[i], ordered[i - 1]), 1,
        `cat=${i} 应强于 cat=${i - 1}`);
    }
  }
});

// ---------------------------------------------------------------------------
// 平局
// ---------------------------------------------------------------------------

test('牌力完全相同（仅花色不同）时 score 相等且 compareHands 返回 0', () => {
  const a = evaluate(['Ah', 'Kd', 'Qc', 'Js', '9h']);
  const b = evaluate(['As', 'Kc', 'Qd', 'Jh', '9s']);
  assert.equal(a.score, b.score);
  assert.equal(compareHands(a, b), 0);
  assert.equal(compareHands(b, a), 0);

  // 7 张下公共牌决定胜负（“打平”）的场景：底牌都用不上
  const c = evaluate(['2c', '3d', 'Ah', 'Kh', 'Qh', 'Jh', 'Th']); // 公共牌就是皇家同花顺
  const d = evaluate(['4s', '5d', 'Ah', 'Kh', 'Qh', 'Jh', 'Th']);
  assert.equal(c.name, '皇家同花顺');
  assert.equal(c.score, d.score);
  assert.equal(compareHands(c, d), 0);

  // 同一副 5 张牌，顺序不同不影响结果
  const e = evaluate(['Ah', 'Kd', 'Qc', 'Js', '9h']);
  const f = evaluate(['9h', 'Js', 'Qc', 'Kd', 'Ah']);
  assert.equal(e.score, f.score);
  assert.equal(compareHands(e, f), 0);
});

// ---------------------------------------------------------------------------
// 6 张输入
// ---------------------------------------------------------------------------

test('支持 6 张输入（C(6,5)=6 组合）', () => {
  const r = evaluate(['Ah', 'Ad', 'Kc', 'Ks', 'Qh', '2d']);
  assert.equal(r.cat, 2);
  assert.deepEqual(r.ranks, [14, 13, 12, 0, 0]);
  assert.equal(norm(r.best), norm(['Ah', 'Ad', 'Kc', 'Ks', 'Qh']));
});

test('牌数不合法时抛错', () => {
  assert.throws(() => evaluate(['Ah', 'Kd', 'Qc', 'Js']), /5\.\.7/);
  assert.throws(() => evaluate(['Ah', 'Kd', 'Qc', 'Js', '9h', '8h', '7h', '6h']), /5\.\.7/);
  assert.throws(() => evaluate(['Ah', 'Kd', 'Qc', 'Js', 'Xh']), /非法的牌/);
});

// ---------------------------------------------------------------------------
// 随机对拍
// ---------------------------------------------------------------------------

test('随机 2000 手 7 张牌：best 是 21 种组合里 score 最大者（暴力交叉验证）', () => {
  const indices = combos5(7);
  assert.equal(indices.length, 21);

  for (let iter = 0; iter < 2000; iter++) {
    const deck = shuffle(freshDeck());
    const seven = deck.slice(0, 7);

    // 暴力：用独立参考实现算 21 种组合的最大分
    let bestNaive = -1;
    let bestNaiveHand = null;
    for (const idx of indices) {
      const hand = idx.map((i) => seven[i]);
      const s = naiveScore5(hand);
      if (s > bestNaive) {
        bestNaive = s;
        bestNaiveHand = hand;
      }
    }

    const r = evaluate(seven);

    assert.equal(r.score, bestNaive,
      `7 张 [${seven.join(',')}] 的 score 应为 ${bestNaive}，实际 ${r.score}（参考最优 ${bestNaiveHand.join(',')}）`);

    // best 必须是 5 张、来自这 7 张、且本身评估出同样的 score
    assert.equal(r.best.length, 5, 'best 必须是 5 张');
    const pool = new Set(seven);
    assert.equal(new Set(r.best).size, 5, 'best 里不应有重复牌');
    for (const c of r.best) {
      assert.ok(pool.has(c), `best 里的 ${c} 必须来自输入的 7 张`);
    }
    assert.equal(naiveScore5(r.best), bestNaive, 'best 本身必须达到最大分');

    const reEval = evaluate(r.best);
    assert.equal(reEval.score, r.score, 'evaluate(best).score 必须等于 evaluate(7张).score');
    assert.equal(reEval.cat, r.cat);
    assert.deepEqual(reEval.ranks, r.ranks);
    assert.equal(reEval.name, r.name);
  }
});

test('随机 500 手 6 张牌也与暴力实现一致', () => {
  const indices = combos5(6);
  assert.equal(indices.length, 6);
  for (let iter = 0; iter < 500; iter++) {
    const six = shuffle(freshDeck()).slice(0, 6);
    let bestNaive = -1;
    for (const idx of indices) bestNaive = Math.max(bestNaive, naiveScore5(idx.map((i) => six[i])));
    const r = evaluate(six);
    assert.equal(r.score, bestNaive, `6 张 [${six.join(',')}] 评估不一致`);
    assert.equal(naiveScore5(r.best), bestNaive);
  }
});

// ---------------------------------------------------------------------------
// 牌堆
// ---------------------------------------------------------------------------

test('freshDeck 是 52 张互不相同的合法牌', () => {
  const deck = freshDeck();
  assert.equal(deck.length, 52);
  assert.equal(new Set(deck).size, 52, '不能有重复牌');
  for (const c of deck) {
    assert.equal(typeof c, 'string');
    assert.equal(c.length, 2);
    assert.ok('23456789TJQKA'.includes(c[0]), `点数字符非法: ${c}`);
    assert.ok('cdhs'.includes(c[1]), `花色字符非法: ${c}`);
  }
  // 每个花色 13 张，每个点数 4 张
  for (const s of 'cdhs') {
    assert.equal(deck.filter((c) => c[1] === s).length, 13);
  }
  for (const rch of '23456789TJQKA') {
    assert.equal(deck.filter((c) => c[0] === rch).length, 4);
  }
  // 顺序固定：两次调用结果完全一致
  assert.deepEqual(freshDeck(), deck);
});

test('shuffle 原地打乱、返回同一数组、且仍是同一个 52 张集合', () => {
  const deck = freshDeck();
  const before = [...deck];
  const returned = shuffle(deck);

  assert.equal(returned, deck, 'shuffle 必须返回同一个数组引用（原地洗牌）');
  assert.equal(deck.length, 52);
  assert.deepEqual([...deck].sort(), [...before].sort(), '洗牌后必须还是同一个 52 张集合');
  assert.equal(new Set(deck).size, 52);
});

test('shuffle 确实打乱了顺序（多次洗牌不应总是原序）', () => {
  let sameAsFresh = 0;
  const runs = 20;
  for (let i = 0; i < runs; i++) {
    const fresh = freshDeck();
    const d = shuffle(freshDeck());
    if (d.join('') === fresh.join('')) sameAsFresh++;
  }
  assert.equal(sameAsFresh, 0, '52! 分之一的概率，出现即说明洗牌有问题');
});

test('shuffle 的随机性大致均匀（每张牌不会固定停在同一位置）', () => {
  // 统计首张牌的分布：1000 次洗牌里首位出现的不同牌数应该足够多
  const firstCards = new Set();
  for (let i = 0; i < 1000; i++) firstCards.add(shuffle(freshDeck())[0]);
  assert.ok(firstCards.size > 30, `首位出现的不同牌只有 ${firstCards.size} 种，疑似分布不均`);
});
