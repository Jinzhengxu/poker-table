// SPDX-License-Identifier: GPL-3.0-or-later
//
// 人机能调的工具。
//
// 只有三个，而且是刻意只给三个：
//
//   estimate_equity  按**自己判断的对手范围**算胜率。这是整套改造里唯一能真正
//                    提升牌力的东西。原来那版是我们在调模型之前把「对随机两张牌」
//                    的胜率算好塞进提示词，模型没得选；现在它读完行动序列，
//                    自己决定「这人打成这样，范围大概前 10%」，再要一个那个
//                    假设下的胜率。AKo 对随机牌 66%，对前 5% 只有 47%——
//                    这个差额就是工具的价值。
//
//   read_opponents   跨手牌的对手画像（VPIP / PFR / 激进度 / 弃牌率 / 最近摊牌）。
//                    做成工具而不是无脑塞进提示词，是因为大部分决策用不上它
//                    （拿到 72o 在枪口位，看谁都一样要弃），省下的 token 和延迟
//                    留给真正难的那几个决策。
//
//   act              提交动作。**没有 execute** —— 它不执行任何东西，只是循环的
//                    终点：模型一调它，stopWhen 就停，我们从 toolCalls 里把
//                    参数取出来。用工具而不是结构化输出来收尾，是因为
//                    OpenAI 兼容的第三方接口对「工具 + structured output 并用」
//                    的支持参差不齐，而工具调用是它们都稳的那条路。
//
// 底池赔率、位置、行动序列这些仍然直接写在提示词里——那是纯算术和纯事实，
// 让模型花一轮工具调用去取它，只是增加延迟和出错面。

import { z } from 'zod';
import { tool } from 'ai';
import { estimateEquityAsync, countLiveOpponents } from '../bot/equity.js';
import { positionOf } from './memory.js';

/** 范围档位的中文说明，写进工具描述里让模型有个锚 */
const RANGE_HINT = [
  '0.05 ≈ 只玩 AA-TT / AK / AQs 这类（极紧，比如一个石头在河牌加注）',
  '0.15 ≈ 大对子 + 强 A + 同花大牌（典型紧凶玩家的开池范围）',
  '0.35 ≈ 任意对子 + 任意 A + 同花连张（普通人的开池范围）',
  '0.70 ≈ 除了纯垃圾牌都玩（松散玩家 / 大盲位跟注范围）',
  '1.00 = 任意两张（完全不做假设；对手越松、越是翻牌前，这个越接近真相）',
].join('；');

/**
 * 造这一次决策能用的工具集。
 *
 * @param {object} ctx
 * @param {object} ctx.state      Room#buildStateFor(botPlayerId) 的输出（脱敏快照）
 * @param {import('./memory.js').OpponentMemory} [ctx.memory]
 * @param {AbortSignal} [ctx.signal]
 * @param {number} [ctx.equitySims]
 * @param {number} [ctx.equityMs]   单次 estimate_equity 的墙钟上限
 * @param {number} [ctx.equityChunkMs]
 * @param {object} [ctx.trace]      调用记录会 push 进 trace.calls，用于日志与测试
 * @returns {{tools:object, readAct:() => object|null}}
 */
export function buildTools(ctx) {
  const { state, memory, signal } = ctx;
  const trace = ctx.trace || { calls: [] };

  const sims = Math.max(0, Number(ctx.equitySims ?? 20000));
  const budgetMs = Math.max(1, Number(ctx.equityMs ?? 1200));
  const chunkMs = Math.max(1, Number(ctx.equityChunkMs ?? 8));

  const tools = {
    estimate_equity: tool({
      description:
        '蒙特卡洛估算你这手牌的胜率。你必须自己判断对手的起手牌范围有多紧，' +
        '并通过 opponent_range 传进来——传得越准，算出来的胜率越有用。' +
        `参考：${RANGE_HINT}。` +
        '判断依据是本手的行动序列和对手画像：加注越多、街数越靠后，范围越紧。' +
        '拿不准就用两个不同的范围各算一次，看结论会不会反转。',
      inputSchema: z.object({
        opponent_range: z
          .number()
          .describe('对手只玩最强的前百分之几起手牌，0~1 之间。1 = 任意两张。'),
        reason: z
          .string()
          .optional()
          .describe('你为什么这样估范围，一句话。只进日志，不影响计算。'),
      }),
      execute: async ({ opponent_range: range, reason }) => {
        const hole = state?.you?.cards;
        if (!Array.isArray(hole) || hole.length !== 2) {
          return { error: '拿不到你的底牌' };
        }
        const opponents = countLiveOpponents(state);
        if (opponents < 1) return { error: '已经没有对手在牌里了' };

        // 夹到 [0.02, 1]。equity.js 里还会再夹一道，这里先夹是为了
        // 把「模型传了 -3」这种情况变成一个合理的数而不是报错，
        // 报错会浪费一整轮工具调用。
        let f = Number(range);
        if (!Number.isFinite(f)) f = 1;
        f = Math.max(0.02, Math.min(1, f));

        let out;
        try {
          out = await estimateEquityAsync({
            hole,
            board: state.table?.board || [],
            opponents,
            sims,
            budgetMs,
            chunkMs,
            signal,
            opponentRange: f >= 1 ? null : f,
          });
        } catch (e) {
          return { error: `估算失败：${e.message}` };
        }
        if (!out) return { error: '输入不合法，算不出来' };

        trace.calls.push({ tool: 'estimate_equity', range: f, pct: out.pct, reason: reason || null });

        // 把「需要多少胜率才划算」一起回给它，省得它自己做除法
        const legal = state.you?.legal;
        const pot = state.table?.totalPot || 0;
        let breakeven = null;
        if (legal?.canCall && legal.callAmount > 0) {
          breakeven = Math.round((legal.callAmount / (pot + legal.callAmount)) * 100);
        }

        return {
          equity_pct: out.pct,
          margin: out.margin,
          opponents: out.opponents,
          sims: out.sims,
          assumed_range: out.range === null ? '任意两张' : `前 ${Math.round(out.range * 100)}%`,
          call_breakeven_pct: breakeven,
          note: out.rangeExhausted > 0
            ? `有 ${out.rangeExhausted} 次因为撞牌没采到范围内的手牌，范围可能太窄了`
            : null,
        };
      },
    }),

    read_opponents: tool({
      description:
        '读还在这手牌里的对手的长期画像：VPIP（翻牌前入池率）、PFR（翻牌前加注率）、' +
        'AF（翻牌后激进度，>2 算凶、<1 算被动）、面对下注的弃牌率、以及最近几次摊牌亮的牌。' +
        '样本不足的人不会有数据。用它来校准你对 estimate_equity 的范围估计：' +
        'VPIP 低的人范围窄，弃牌率高的人可以诈唬，AF 高的人加注不一定有牌。' +
        '**优先看 here 而不是总账**：here 是这个人这手牌所在的位置档' +
        '（early 枪口 / middle 中间 / late 庄位附近 / blinds 盲位）以及他在这一档的历史数据。' +
        '同一个人在枪口位和按钮位的入池率能差一倍还多，总账把两者平均了。' +
        '每档都带 hands（样本量），样本少的自己打折看。',
      inputSchema: z.object({}),
      execute: async () => {
        if (!memory) return { players: [], note: '没有开启对手记忆' };
        const seats = Array.isArray(state?.seats) ? state.seats : [];
        const mySeat = state?.you?.seat;
        const out = [];
        for (const s of seats) {
          if (!s || s.seat === mySeat) continue;
          if (s.state !== 'in' && s.state !== 'allin') continue;
          const p = memory.profile(s.name);
          if (!p) continue;
          // 这手牌他坐在哪一档，以及他在这一档的历史。没攒够样本就只有档名。
          const here = positionOf(state, s.seat);
          out.push({ ...p, here, hereStats: (here && p.byPos?.[here]) || null });
        }
        trace.calls.push({ tool: 'read_opponents', found: out.length });
        return {
          players: out,
          note: out.length ? null : '这些对手都还没打够手数，没有可靠画像——按默认假设打',
        };
      },
    }),

    act: tool({
      description:
        '提交你的最终决定，结束这次思考。只能选「可选动作」里列出的动作。' +
        'bet / raise 的 amount 是本轮总投入额，不是增量，且必须落在给定区间内。',
      inputSchema: z.object({
        action: z.enum(['fold', 'check', 'call', 'bet', 'raise', 'allin']),
        amount: z.number().optional().describe('只有 bet / raise 需要'),
        say: z.string().optional().describe('说给牌桌听的一句话，最多 20 字，可以不说'),
      }),
      // 故意没有 execute：这个工具不干活，它只是循环的终点。
    }),
  };

  /** 从一次 generateText 的结果里把 act 的参数取出来 */
  function readAct(result) {
    const calls = Array.isArray(result?.toolCalls) ? result.toolCalls : [];
    for (let i = calls.length - 1; i >= 0; i--) {
      if (calls[i]?.toolName === 'act') return calls[i].input || null;
    }
    return null;
  }

  return { tools, readAct, trace };
}

export default buildTools;
