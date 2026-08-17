// SPDX-License-Identifier: GPL-3.0-or-later
// 牌力评估器（SPEC §4）
//
// 输入 5..7 张牌，返回最优 5 张组成的牌型。
// 实现方式：多于 5 张时枚举所有 C(n,5) 组合逐个评估取最大。正确性优先于性能。

/** 点数字符 -> 数值，'2'->2 ... 'T'->10 'J'->11 'Q'->12 'K'->13 'A'->14 */
const RANK_MAP = {
  2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9,
  T: 10, J: 11, Q: 12, K: 13, A: 14,
};

const VALID_SUITS = new Set(['c', 'd', 'h', 's']);

/** 牌型类别常量（数字越大越强） */
export const CATEGORY = {
  HIGH_CARD: 0,
  ONE_PAIR: 1,
  TWO_PAIR: 2,
  THREE_OF_A_KIND: 3,
  STRAIGHT: 4,
  FLUSH: 5,
  FULL_HOUSE: 6,
  FOUR_OF_A_KIND: 7,
  STRAIGHT_FLUSH: 8,
};

/** cat -> 中文名（同花顺的皇家情况单独处理） */
const CAT_NAMES = [
  '高牌',     // 0
  '一对',     // 1
  '两对',     // 2
  '三条',     // 3
  '顺子',     // 4
  '同花',     // 5
  '葫芦',     // 6
  '四条',     // 7
  '同花顺',   // 8
];

/** score 的进制基数：score = cat*15^5 + ranks[0]*15^4 + ... + ranks[4]*15 */
const BASE = 15;
const POW = [
  BASE * BASE * BASE * BASE * BASE, // 15^5 -> cat
  BASE * BASE * BASE * BASE,        // 15^4 -> ranks[0]
  BASE * BASE * BASE,               // 15^3 -> ranks[1]
  BASE * BASE,                      // 15^2 -> ranks[2]
  BASE,                             // 15^1 -> ranks[3]
  1,                                // 15^0 -> ranks[4]
];

/**
 * 点数字符转数值。
 * @param {string} ch 单个点数字符
 * @returns {number} 2..14
 */
export function rankValue(ch) {
  const v = RANK_MAP[ch];
  if (v === undefined) throw new Error(`非法的点数字符: ${JSON.stringify(ch)}`);
  return v;
}

/** 校验单张牌字符串并返回 {v, s} */
function parseCard(card) {
  if (typeof card !== 'string' || card.length !== 2) {
    throw new Error(`非法的牌: ${JSON.stringify(card)}`);
  }
  const v = RANK_MAP[card[0]];
  if (v === undefined || !VALID_SUITS.has(card[1])) {
    throw new Error(`非法的牌: ${JSON.stringify(card)}`);
  }
  return { v, s: card[1] };
}

/** score = cat*15^5 + ranks[0]*15^4 + ranks[1]*15^3 + ranks[2]*15^2 + ranks[3]*15 + ranks[4] */
function computeScore(cat, ranks) {
  return cat * POW[0]
    + ranks[0] * POW[1]
    + ranks[1] * POW[2]
    + ranks[2] * POW[3]
    + ranks[3] * POW[4]
    + ranks[4] * POW[5];
}

/** 牌型名：同花顺里 A 高（A-K-Q-J-T）叫皇家同花顺 */
function catName(cat, ranks) {
  if (cat === CATEGORY.STRAIGHT_FLUSH && ranks[0] === 14) return '皇家同花顺';
  return CAT_NAMES[cat];
}

/**
 * 恰好 5 张牌的评估。
 * @param {string[]} cards 5 张牌字符串
 * @returns {{cat:number, ranks:number[], best:string[], name:string, score:number}}
 */
function evaluate5(cards) {
  const parsed = cards.map(parseCard);
  const vals = parsed.map((p) => p.v);
  const suits = parsed.map((p) => p.s);

  // 同花：5 张花色相同
  const isFlush = suits.every((s) => s === suits[0]);

  // 点数降序（用于高牌/同花的 ranks）
  const desc = [...vals].sort((a, b) => b - a);

  // 顺子：5 张点数互不相同且连续；A-2-3-4-5（轮子）最大点算 5
  const uniqDesc = [...new Set(vals)].sort((a, b) => b - a);
  let straightHigh = 0;
  if (uniqDesc.length === 5) {
    if (uniqDesc[0] - uniqDesc[4] === 4) {
      straightHigh = uniqDesc[0];
    } else if (
      uniqDesc[0] === 14 && uniqDesc[1] === 5 && uniqDesc[2] === 4
      && uniqDesc[3] === 3 && uniqDesc[4] === 2
    ) {
      straightHigh = 5; // 轮子顺子 A-2-3-4-5，最大点算 5
    }
  }

  // 按点数分组，先按张数降序、张数相同再按点数降序
  const countByVal = new Map();
  for (const v of vals) countByVal.set(v, (countByVal.get(v) || 0) + 1);
  const groups = [...countByVal.entries()]
    .map(([v, n]) => ({ v, n }))
    .sort((a, b) => (b.n - a.n) || (b.v - a.v));

  let cat;
  let ranks;

  // 注意顺序：必须先判同花顺，避免被当成同花或顺子
  if (isFlush && straightHigh) {
    cat = CATEGORY.STRAIGHT_FLUSH;
    ranks = [straightHigh, 0, 0, 0, 0];
  } else if (groups[0].n === 4) {
    cat = CATEGORY.FOUR_OF_A_KIND;
    ranks = [groups[0].v, groups[1].v, 0, 0, 0];
  } else if (groups[0].n === 3 && groups[1] && groups[1].n === 2) {
    cat = CATEGORY.FULL_HOUSE;
    ranks = [groups[0].v, groups[1].v, 0, 0, 0];
  } else if (isFlush) {
    cat = CATEGORY.FLUSH;
    ranks = desc;
  } else if (straightHigh) {
    cat = CATEGORY.STRAIGHT;
    ranks = [straightHigh, 0, 0, 0, 0];
  } else if (groups[0].n === 3) {
    cat = CATEGORY.THREE_OF_A_KIND;
    ranks = [groups[0].v, groups[1].v, groups[2].v, 0, 0];
  } else if (groups[0].n === 2 && groups[1].n === 2) {
    cat = CATEGORY.TWO_PAIR;
    ranks = [groups[0].v, groups[1].v, groups[2].v, 0, 0];
  } else if (groups[0].n === 2) {
    cat = CATEGORY.ONE_PAIR;
    ranks = [groups[0].v, groups[1].v, groups[2].v, groups[3].v, 0];
  } else {
    cat = CATEGORY.HIGH_CARD;
    ranks = desc;
  }

  return {
    cat,
    ranks,
    best: [...cards],
    name: catName(cat, ranks),
    score: computeScore(cat, ranks),
  };
}

/**
 * 枚举 n 选 5 的全部组合下标。
 * @param {number} n
 * @returns {number[][]}
 */
function combinations5(n) {
  const out = [];
  for (let a = 0; a < n - 4; a++) {
    for (let b = a + 1; b < n - 3; b++) {
      for (let c = b + 1; c < n - 2; c++) {
        for (let d = c + 1; d < n - 1; d++) {
          for (let e = d + 1; e < n; e++) {
            out.push([a, b, c, d, e]);
          }
        }
      }
    }
  }
  return out;
}

/**
 * 评估 5..7 张牌，返回最优的 5 张牌型。
 * @param {string[]} cards 5..7 张牌
 * @returns {{cat:number, ranks:number[], best:string[], name:string, score:number}}
 *   ranks 长度固定 5，不足补 0；语义见 SPEC §4。
 *   best 为真正组成该牌型的 5 张**原始牌字符串**。
 */
export function evaluate(cards) {
  if (!Array.isArray(cards)) throw new TypeError('evaluate 需要一个牌数组');
  if (cards.length < 5 || cards.length > 7) {
    throw new Error(`evaluate 需要 5..7 张牌，收到 ${cards.length} 张`);
  }
  if (cards.length === 5) return evaluate5(cards);

  // 6/7 张：枚举所有 5 张组合，取 score 最大者
  let bestResult = null;
  for (const idx of combinations5(cards.length)) {
    const hand = [cards[idx[0]], cards[idx[1]], cards[idx[2]], cards[idx[3]], cards[idx[4]]];
    const r = evaluate5(hand);
    if (bestResult === null || r.score > bestResult.score) bestResult = r;
  }
  return bestResult;
}

/**
 * 比较两个 evaluate 的返回值。
 * @param {{score:number}} a
 * @param {{score:number}} b
 * @returns {number} a 强返回 1，相等返回 0，a 弱返回 -1
 */
export function compareHands(a, b) {
  if (a.score > b.score) return 1;
  if (a.score < b.score) return -1;
  return 0;
}
