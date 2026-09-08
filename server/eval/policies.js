// SPDX-License-Identifier: GPL-3.0-or-later
//
// 评测台里被对比的策略。
//
// 这里**只有一个变量**：胜率按什么假设算。
//
//   baseline  对手按剩余牌堆里随机两张发（这是改造前的行为）
//   range     对手按行动序列推断出的范围发（bot/range.js 的启发式）
//
// 除此之外两边完全一样：同一个 decideByRule、同一套阈值、同一批牌、同一个
// 随机源。所以两者的差值就是「范围建模」这一件事的净效果，不掺任何别的东西。
//
// 为什么不直接测 agent：那样测出来的是「模型的判断力 × 范围建模的价值」，
// 两个因素混在一起，而且每跑一次都要烧 API。先用确定性的笨启发式把
// 「范围建模这个方向有没有用」问清楚，再谈模型能不能判断得更准。

import { decideByRule } from '../bot/policy.js';
import { estimateEquity } from '../bot/equity.js';
import { inferOpponentRange } from '../bot/range.js';

/**
 * 规则策略 + 可选的范围感知胜率。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.useRange] true = 按推断范围算胜率；false = 随机两张牌
 * @param {number}  [opts.sims]     每次估算的模拟次数，默认 2000（±2%）
 * @param {string}  [opts.name]
 */
export function rulePolicy(opts = {}) {
  const useRange = !!opts.useRange;
  const sims = Math.max(1, Number(opts.sims ?? 2000));

  return {
    name: opts.name || (useRange ? 'range' : 'baseline'),
    useRange,
    sims,

    decide(ctx) {
      const { legal } = ctx;
      let equity = null;

      // 只在**真正用得上**的决策点算胜率。decideByRule 里胜率只影响
      // 「面对下注要不要跟」这一个分支（能过牌就直接过牌了，加注走的是
      // handStrength 阈值）。别的时候算了也是白算 —— 这一条把评测的
      // 计算量砍掉约九成，而且对两个策略一视同仁，不影响公平性。
      const needsEquity = !legal.canCheck && legal.canCall && ctx.opponents >= 1;

      if (needsEquity && Array.isArray(ctx.hole) && ctx.hole.length === 2) {
        const opponentRange = useRange
          ? inferOpponentRange({ history: ctx.history, mySeat: ctx.mySeat })
          : null;
        equity = estimateEquity({
          hole: ctx.hole,
          board: ctx.board,
          opponents: ctx.opponents,
          sims,
          budgetMs: 60_000,     // 给足预算：评测要的是确定性，不是低延迟
          opponentRange,
          rng: ctx.rng,
        });
      }

      return decideByRule({
        hole: ctx.hole,
        board: ctx.board,
        legal,
        pot: ctx.pot,
        chips: ctx.chips,
        seed: ctx.seed,
        traits: ctx.traits,
        equity,
      });
    },
  };
}

export default rulePolicy;
