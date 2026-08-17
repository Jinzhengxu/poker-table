// SPDX-License-Identifier: GPL-3.0-or-later
//
// 规则人机：不调用任何外部服务的确定性策略。
//
// 三个用途：
//   1. LLM 超时 / 报错 / 限流时的兜底，保证牌桌永远不会因为外部服务挂了而卡住；
//   2. 一个 key 都没配时，人机仍然可用（项目不依赖外部服务也能玩）；
//   3. 单元测试里的确定性对手。
//
// 强度评估直接复用 evaluator.js（7 张取最优 5 张，约 37μs 一次），
// 每次决策只调一次，对 1 核小机没有任何压力。

import { evaluate, rankValue } from '../evaluator.js';
import { traitBias } from './persona.js';

/** 花色字符 -> 用于判断同花的键 */
function suitOf(card) {
  return card[1];
}

/**
 * Chen formula：广为流传的翻牌前起手牌打分，范围约 -1.5 ~ 20（AA=20）。
 * 这里用它做翻牌前决策，比自己拍脑袋的表更可靠也更好解释。
 *
 * @param {string[]} hole 两张底牌，如 ['As','Kd']
 * @returns {number}
 */
export function chenScore(hole) {
  if (!Array.isArray(hole) || hole.length !== 2) return 0;
  const a = rankValue(hole[0][0]);
  const b = rankValue(hole[1][0]);
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);

  // 高牌基础分：A=10 K=8 Q=7 J=6，其余取一半
  const base = { 14: 10, 13: 8, 12: 7, 11: 6 }[hi] ?? hi / 2;

  let score;
  if (a === b) {
    // 对子翻倍，最低 5 分（22 也有 5 分）
    score = Math.max(base * 2, 5);
  } else {
    score = base;
    if (suitOf(hole[0]) === suitOf(hole[1])) score += 2;

    const gap = hi - lo - 1;
    const penalty = gap === 0 ? 0 : gap === 1 ? 1 : gap === 2 ? 2 : gap === 3 ? 4 : 5;
    score -= penalty;

    // 两张都小于 Q 且接近时，顺子潜力补 1 分
    if (gap <= 1 && hi < 12) score += 1;
  }

  return Math.ceil(score * 2) / 2;
}

/**
 * 把当前牌力折算成 0~1 的强度。
 * 翻牌前用 Chen，翻牌后用牌型类别 + 是否用到了底牌。
 *
 * @param {string[]} hole
 * @param {string[]} board
 * @returns {number} 0~1
 */
export function handStrength(hole, board) {
  if (!Array.isArray(hole) || hole.length !== 2) return 0;

  if (!Array.isArray(board) || board.length === 0) {
    // Chen 的 -1.5~20 压到 0~1，20 分（AA）对应 1
    return Math.max(0, Math.min(1, chenScore(hole) / 20));
  }

  const ev = evaluate([...hole, ...board]);

  // cat: 0 高牌 / 1 一对 / 2 两对 / 3 三条 / 4 顺子 / 5 同花 / 6 葫芦 / 7 四条 / 8 同花顺
  const byCat = [0.12, 0.35, 0.55, 0.7, 0.8, 0.85, 0.93, 0.98, 1.0];
  let s = byCat[ev.cat] ?? 0.12;

  // 牌型完全由公共牌构成时（底牌没参与），实际优势要打折——
  // 桌上人人都有这副牌型。
  const usesHole = Array.isArray(ev.best) && ev.best.some((c) => hole.includes(c));
  if (!usesHole) s *= 0.45;

  // 只有一对时，是不是"顶对"差别很大，用踢脚点数微调
  if (ev.cat === 1 && usesHole) {
    const pairRank = ev.ranks[0] || 0;
    const boardHigh = Math.max(...board.map((c) => rankValue(c[0])));
    if (pairRank >= boardHigh) s += 0.12; // 顶对或超对
  }

  return Math.max(0, Math.min(1, s));
}

/**
 * 确定性抖动：同一个牌局状态永远得到同一个值，但不同位置各不相同。
 * 用来让规则人机不至于完全可预测，同时保持测试可复现。
 */
function jitter(seed) {
  // xorshift 的一轮，够用了
  let x = (seed | 0) || 1;
  x ^= x << 13; x |= 0;
  x ^= x >>> 17;
  x ^= x << 5; x |= 0;
  return Math.abs(x % 1000) / 1000;
}

/**
 * 规则决策。**返回的动作保证在 legal 允许的范围内。**
 *
 * @param {object} ctx
 * @param {string[]} ctx.hole      自己的两张底牌
 * @param {string[]} ctx.board     公共牌
 * @param {object}   ctx.legal     hand.legalActions(seat) 的返回值
 * @param {number}   ctx.pot       当前总底池
 * @param {number}   ctx.chips     自己剩余筹码
 * @param {number}   ctx.seed      确定性抖动种子（手牌号 * 8 + 座位号）
 * @param {object}   [ctx.traits]  人格特质，用来偏移阈值（见 persona.js）
 * @param {object}   [ctx.equity]  蒙特卡洛胜率估算（equity.js 的返回值）。
 *                                 有的话**只用在跟注决策上**——"跟注是否划算"就是
 *                                 拿胜率和底池赔率比，两者是同一把尺子。
 *                                 加注决策仍走启发式强度：0.62 这个门槛是对着
 *                                 handStrength 调出来的，换成胜率含义就不一样了。
 * @returns {{type:string, amount?:number}}
 */
export function decideByRule(ctx) {
  const { hole, board, legal, pot, chips, seed = 0, traits, equity } = ctx;
  if (!legal) return { type: 'fold' };

  const bias = traitBias(traits);

  const strength = handStrength(hole, board);
  const noise = jitter(seed) * 0.1 - 0.05; // ±0.05
  const s = Math.max(0, Math.min(1, strength + noise));

  const callAmt = legal.canCall ? legal.callAmount || 0 : 0;
  // 底池赔率：跟注额 / (底池 + 跟注额)。要跟注，胜率大致得高于这个值。
  const potOdds = callAmt > 0 ? callAmt / (pot + callAmt) : 0;

  // ---- 强牌：加注 ----
  // canBet 与 canRaise 由引擎保证互斥（本轮还没人下注 vs 已经有人下注）
  // 阈值按人格偏移：激进/爱诈唬的人门槛更低，被动/不诈唬的更高。
  const raiseAt = 0.62 + bias.raiseThreshold;
  if (s >= raiseAt && (legal.canRaise || legal.canBet)) {
    const base = s >= 0.85 ? 0.85 : 0.6;
    const target = sizeBet({ legal, pot, fraction: base * bias.betSize });
    if (target !== null) {
      return { type: legal.canRaise ? 'raise' : 'bet', amount: target };
    }
  }

  // ---- 中等牌：能过牌就过牌，赔率合适就跟 ----
  if (legal.canCheck) return { type: 'check' };

  if (legal.canCall) {
    // 全下跟注要更谨慎一点；扛压能力也按人格偏移
    const need = (legal.isAllInCall ? potOdds + 0.15 : potOdds) + bias.callThreshold;
    // 有真实胜率就用它，没有才退回启发式强度
    const have = equity && Number.isFinite(equity.pct) ? equity.pct / 100 : s;
    if (have >= need) return { type: 'call' };
  }

  return legal.canFold ? { type: 'fold' } : { type: 'check' };
}

/**
 * 按底池比例算下注额，并夹到引擎允许的区间里。
 * @returns {number|null} null 表示当前下不了注
 */
function sizeBet({ legal, pot, fraction }) {
  const canBet = !!legal.canBet;
  const canRaise = !!legal.canRaise;
  if (!canBet && !canRaise) return null;

  // 两种情况下限不同（首次下注是 bigBlind，加注是 minRaiseTo），
  // 上限都是 maxRaiseTo = 本轮已投入 + 剩余筹码。
  const min = canRaise ? legal.minRaiseTo : legal.minBet;
  const max = legal.maxRaiseTo;
  if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) return null;

  const want = Math.round(pot * fraction);
  return clamp(want, min, max);
}

/** 把金额夹进 [min,max]，并取整 */
export function clamp(v, min, max) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return min;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}
