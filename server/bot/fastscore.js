// SPDX-License-Identifier: GPL-3.0-or-later
//
// 只给胜率估算用的快速 7 张牌打分。
//
// 为什么要有它：evaluator.js 枚举 C(7,5)=21 种组合，每次还构造 best/name/ranks
// 三个对象。蒙特卡洛一次决策要调几千次，那些分配全是浪费——我们只要一个 score。
// 这里直接从牌型结构算出答案，不枚举、不分配对象。
//
// **打分公式与 evaluator.js 完全一致**（cat * 15^5 + ranks[0]*15^4 + ...），
// 所以两者的 score 可以逐位比较。test/bot.test.js 里有 20 万手随机牌的
// 交叉验证，断言 fastScore7 === evaluate().score。
//
// 正确性归 evaluator.js —— 它是 SPEC §4 定义的真相来源。这个文件是它的
// 性能镜像，任何分歧都算这个文件的 bug。

const RANK_OF = Object.create(null);
'23456789TJQKA'.split('').forEach((ch, i) => { RANK_OF[ch] = i + 2; });

const SUIT_OF = { c: 0, d: 1, h: 2, s: 3 };

const P1 = 15, P2 = 225, P3 = 3375, P4 = 50625, P5 = 759375;

/** 5 个连续位的掩码，从高到低检查（A 高的顺子在前） */
const STRAIGHT_MASKS = [];
for (let high = 14; high >= 5; high--) {
  let m = 0;
  for (let r = high; r > high - 5; r--) m |= 1 << r;
  STRAIGHT_MASKS.push({ high, mask: m });
}
// A-2-3-4-5：把 A 当作 1，用 bit 1
const WHEEL_MASK = (1 << 1) | (1 << 2) | (1 << 3) | (1 << 4) | (1 << 5);

/**
 * 算 7 张（也支持 5/6 张）牌的 score。
 * @param {string[]} cards
 * @returns {number} 与 evaluate(cards).score 相同
 */
export function fastScore7(cards) {
  const n = cards.length;

  // rankCount[2..14]，suitMask[0..3] 是该花色出现过的点数位图
  const rankCount = new Int8Array(15);
  const suitCount = new Int8Array(4);
  const suitRankMask = new Int32Array(4);
  let rankMask = 0;

  for (let i = 0; i < n; i++) {
    const c = cards[i];
    const r = RANK_OF[c.charCodeAt(0) === 84 ? 'T' : c[0]];
    const s = SUIT_OF[c[1]];
    rankCount[r]++;
    suitCount[s]++;
    suitRankMask[s] |= 1 << r;
    rankMask |= 1 << r;
  }

  // ---- 8 同花顺 / 5 同花 ----
  let flushSuit = -1;
  for (let s = 0; s < 4; s++) if (suitCount[s] >= 5) { flushSuit = s; break; }

  if (flushSuit >= 0) {
    const fm = suitRankMask[flushSuit];
    const sfHigh = straightHigh(fm);
    if (sfHigh > 0) return 8 * P5 + sfHigh * P4;
  }

  // ---- 统计对子/三条/四条 ----
  // 从高到低找，保证拿到的是最大的那组
  let quad = 0, trips = 0, trips2 = 0, pair = 0, pair2 = 0;
  for (let r = 14; r >= 2; r--) {
    const c = rankCount[r];
    if (c === 4) { if (!quad) quad = r; }
    else if (c === 3) { if (!trips) trips = r; else if (!trips2) trips2 = r; }
    else if (c === 2) { if (!pair) pair = r; else if (!pair2) pair2 = r; }
  }

  // ---- 7 四条 ----
  if (quad) {
    let kicker = 0;
    for (let r = 14; r >= 2; r--) if (r !== quad && rankCount[r] > 0) { kicker = r; break; }
    return 7 * P5 + quad * P4 + kicker * P3;
  }

  // ---- 6 葫芦 ----
  if (trips) {
    // 第二组三条也能当对子用（AAAKKK 的对子是 K）
    const bestPair = Math.max(trips2, pair);
    if (bestPair) return 6 * P5 + trips * P4 + bestPair * P3;
  }

  // ---- 5 同花 ----
  if (flushSuit >= 0) {
    const fm = suitRankMask[flushSuit];
    let score = 5 * P5;
    let taken = 0;
    for (let r = 14; r >= 2 && taken < 5; r--) {
      if (fm & (1 << r)) { score += r * pow(4 - taken); taken++; }
    }
    return score;
  }

  // ---- 4 顺子 ----
  const stHigh = straightHigh(rankMask);
  if (stHigh > 0) return 4 * P5 + stHigh * P4;

  // ---- 3 三条 ----
  if (trips) {
    let score = 3 * P5 + trips * P4;
    let taken = 0;
    for (let r = 14; r >= 2 && taken < 2; r--) {
      if (r !== trips && rankCount[r] > 0) { score += r * pow(3 - taken); taken++; }
    }
    return score;
  }

  // ---- 2 两对 ----
  if (pair && pair2) {
    let kicker = 0;
    for (let r = 14; r >= 2; r--) {
      if (r !== pair && r !== pair2 && rankCount[r] > 0) { kicker = r; break; }
    }
    return 2 * P5 + pair * P4 + pair2 * P3 + kicker * P2;
  }

  // ---- 1 一对 ----
  if (pair) {
    let score = 1 * P5 + pair * P4;
    let taken = 0;
    for (let r = 14; r >= 2 && taken < 3; r--) {
      if (r !== pair && rankCount[r] > 0) { score += r * pow(3 - taken); taken++; }
    }
    return score;
  }

  // ---- 0 高牌 ----
  let score = 0;
  let taken = 0;
  for (let r = 14; r >= 2 && taken < 5; r--) {
    if (rankCount[r] > 0) { score += r * pow(4 - taken); taken++; }
  }
  return score;
}

/** 15^k，k 取 0..4 */
function pow(k) {
  return k === 4 ? P4 : k === 3 ? P3 : k === 2 ? P2 : k === 1 ? P1 : 1;
}

/**
 * 位图里最大的顺子高牌点数；没有顺子返回 0。
 * A-2-3-4-5 返回 5（与 SPEC §4 一致）。
 */
function straightHigh(mask) {
  for (let i = 0; i < STRAIGHT_MASKS.length; i++) {
    const s = STRAIGHT_MASKS[i];
    if ((mask & s.mask) === s.mask) return s.high;
  }
  // 轮子：把 A 挪到 bit 1
  const withAceLow = (mask & (1 << 14)) ? (mask | (1 << 1)) : mask;
  if ((withAceLow & WHEEL_MASK) === WHEEL_MASK) return 5;
  return 0;
}

export default fastScore7;
