// SPDX-License-Identifier: GPL-3.0-or-later
//
// 人机能调的工具。
//
// 四个。前三个是**思考**（胜率、画像、下注尺度），第四个是**收尾**。
//
// 为什么是四个而不是原来的三个：前一版的工具集只会说「跟注」这一门语言 ——
// estimate_equity 回的是胜率和「跟注要多少胜率才划算」，全是跟注决策的尺子。
// 可扑克有一半的钱来自开火（价值下注 + 诈唬），而那一边一个数都没有，
// 模型的下注尺度只能靠感觉。plan_bet 就是补这一边（见下面它自己的说明）。
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
//   plan_bet         按**你自己给的尺度**算这个注划不划算。跟注决策有底池赔率这把
//                    现成的尺子（提示词里就写着「你的胜率需要高于 X% 才划算」），
//                    下注决策对应的那把尺子叫「需要他弃多少牌」，而它一直没人给。
//                    模型从「他面对下注弃牌率 55%」到「我下 2/3 池需要他弃 40%」
//                    这一步除法经常算错，错的方向还很整齐：低估需要的弃牌率，
//                    于是乱开火。
//                    公式是底池赔率的镜像：需要的弃牌率 = 亏损 / (底池 + 亏损)，
//                    其中「亏损」已经扣掉了被跟以后你还能赢回来的那部分 —— 所以
//                    带 30% 胜率的半诈唬需要的弃牌率远低于纯诈唬（100 打 100 的池，
//                    纯诈唬要 50%，30% 胜率的听牌只要 9%）。这个差别正是
//                    「半诈唬」这个概念的全部内容，而它不是模型心算得出来的。
//                    明确的建模假设，必须让模型知道：**基线是「不下注就拿 0」**。
//                    于是牌很强的时候 needs_fold_pct 恒为 0（被跟也不亏），
//                    那句话是对的，但它答不了「该下多大」。所以还回一个 ev_chips
//                    用来横向比尺度 —— 同样只能比尺度，不能和过牌比，因为过牌
//                    也能赢钱，而那部分不在这个模型里。
//                    还有一条：底池那边按「只有一个人跟」推，胜率那边也就按 1 个
//                    对手算。两边必须同一个假设，否则数字自己打自己。多人底池里
//                    这偏乐观，结果里会附一句提醒。
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
import { sanitizeName } from '../bot/decide.js';
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
 * @param {number} [ctx.equityMs]   单次蒙特卡洛的墙钟上限（estimate_equity / plan_bet 各算一次）
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

    plan_bet: tool({
      description:
        '算一个下注/加注尺度划不划算。**想开火就先调它，别靠感觉定尺度。**' +
        '你给金额和「他面对这个尺度还会拿多少牌继续」，工具回两个数：' +
        'needs_fold_pct = 这个注需要他弃多少牌才不亏（已经把「被跟时你还能赢回来的部分」扣掉了，' +
        '所以有听牌的半诈唬需要的弃牌率远低于纯诈唬）；' +
        'implied_fold_pct = 按你给的两个范围推出来他实际会弃多少。后者明显大于前者才值得开火。' +
        '给了 opponent_range 还会回 ev_chips（这个尺度的期望收益，筹码）：' +
        '**换几个 amount 各调一次、挑 ev_chips 最大的，就是选尺度的办法**。' +
        '注意 ev_chips 的基线是「不下注就拿 0」，只能用来横向比尺度，不能拿它和过牌比。' +
        'continue_range 怎么估：尺度越大他继续得越少；read_opponents 的 foldToBet 是现成的依据，' +
        '弃牌率高的人 continue_range 要给得更小。' +
        `范围档位参考同 estimate_equity：${RANGE_HINT}。`,
      inputSchema: z.object({
        amount: z
          .number()
          .describe('本轮总投入额，和 act 的 amount 同一个口径（不是增量）。超出区间会被夹回来。'),
        continue_range: z
          .number()
          .describe('他面对这个尺度还会继续（跟注或加注）的手牌比例，0~1。必须比他当前的范围更紧。'),
        opponent_range: z
          .number()
          .optional()
          .describe('他现在的范围（estimate_equity 里用的那个）。给了才能推他会弃多少牌。'),
        reason: z.string().optional().describe('一句话说明，只进日志，不影响计算。'),
      }),
      execute: async ({ amount, continue_range: cont, opponent_range: current, reason }) => {
        const legal = state?.you?.legal;
        if (!legal || (!legal.canBet && !legal.canRaise)) {
          return { error: '这个局面下不了注也加不了注（多半是面对全下），只能跟或弃' };
        }
        const hole = state?.you?.cards;
        if (!Array.isArray(hole) || hole.length !== 2) return { error: '拿不到你的底牌' };
        const opponents = countLiveOpponents(state);
        if (opponents < 1) return { error: '已经没有对手在牌里了' };

        // 引擎保证 canBet / canRaise 互斥：本轮还没人下注是 bet，已经有人下注是 raise
        const isRaise = !!legal.canRaise;
        const min = isRaise ? legal.minRaiseTo : legal.minBet;
        const max = legal.maxRaiseTo;
        const want = Math.floor(Number(amount));
        if (!Number.isFinite(want)) return { error: 'amount 不是一个数' };
        const to = Math.max(min, Math.min(max, want));

        const me = state.seats?.[state.you.seat];
        const myCommitted = Number(me?.committedRound) || 0;
        const pot = Number(state.table?.totalPot) || 0;
        // 这个注真正多掏的钱。本轮已经投进去的是死钱，已经算在 pot 里了。
        const risk = Math.max(0, to - myCommitted);

        // 「只有一个人跟」的假设：取本轮投入最多的那个还能行动的对手（多半就是
        // 开火的人）。全下的人跟不了，不算。多人底池里这个假设偏乐观，下面会提醒。
        let caller = null;
        for (const sx of Array.isArray(state.seats) ? state.seats : []) {
          if (!sx || sx.seat === state.you.seat || sx.state !== 'in') continue;
          if (!caller || (Number(sx.committedRound) || 0) > (Number(caller.committedRound) || 0)) {
            caller = sx;
          }
        }
        const callerCommitted = caller ? Number(caller.committedRound) || 0 : 0;
        const callerMax = caller ? callerCommitted + (Number(caller.chips) || 0) : Infinity;
        // 他要跟到 to，但最多只拿得出自己剩的筹码
        const callerAdds = Math.max(0, Math.min(to, callerMax) - callerCommitted);
        // 他跟不满的那部分会退还给你，所以真正有风险的只有被跟上的部分
        const matched = Math.min(risk, callerAdds);

        let f = Number(cont);
        if (!Number.isFinite(f)) f = 1;
        f = Math.max(0.02, Math.min(1, f));

        let eq;
        try {
          // 对手数固定按 1 算：底池那边也是按「只有一个人跟」推的，两边必须同一个假设。
          eq = await estimateEquityAsync({
            hole,
            board: state.table?.board || [],
            opponents: 1,
            sims,
            budgetMs,
            chunkMs,
            signal,
            opponentRange: f >= 1 ? null : f,
          });
        } catch (e) {
          return { error: `估算失败：${e.message}` };
        }
        if (!eq) return { error: '输入不合法，算不出来' };

        // 被跟以后这个注平均亏多少。E * 底池 是你能赢回来的部分，
        // 亏损为 0 说明被跟也不亏 —— 那是价值下注，弃牌率多少都无所谓。
        const potWhenCalled = pot + matched + callerAdds;
        const loss = Math.max(0, matched - (eq.pct / 100) * potWhenCalled);
        // 底池赔率的镜像：需要的弃牌率 = 亏损 / (赢到的底池 + 亏损)
        const needsFold = loss > 0 ? Math.round((loss / (pot + loss)) * 100) : 0;

        // 他实际会弃多少：当前范围里有多少比例不在续注范围里。
        // 多个对手都要弃，所以取 n 次方 —— 人越多，诈唬越难成功。
        let impliedFold = null;
        let conflict = null;
        const cur = Number(current);
        if (Number.isFinite(cur)) {
          const R = Math.max(0.02, Math.min(1, cur));
          if (f >= R) {
            conflict = `continue_range ${f} 不比 opponent_range ${R} 紧，等于假设他一张牌都不弃`;
            impliedFold = 0;
          } else {
            impliedFold = Math.round((1 - f / R) ** opponents * 100);
          }
        }

        // 这个尺度的期望收益（筹码）。只有给了 opponent_range 才算得出来，
        // 因为它要用到「他会弃多少」。
        //
        // **基线是「不下注就拿 0」**，所以这个数只能用来在几个尺度之间挑，
        // 不能拿来和过牌比 —— 过牌也能赢钱，那部分不在这个模型里。
        // 但恰恰是"挑尺度"这件事 needs_fold_pct 答不了：牌很强的时候它对
        // 任何尺度都是 0，看不出该下 1/3 池还是全下。ev_chips 能。
        let evChips = null;
        if (impliedFold !== null) {
          const pf = impliedFold / 100;
          evChips = Math.round(pf * pot + (1 - pf) * ((eq.pct / 100) * potWhenCalled - matched));
        }

        let verdict = null;
        if (loss <= 0) {
          verdict = '被跟你也不亏，这是价值下注，不依赖他弃牌'
            + (evChips !== null ? '；想挑尺度就换几个 amount 比 ev_chips' : '');
        } else if (impliedFold !== null) {
          const edge = impliedFold - needsFold;
          verdict = edge > 5 ? '按你估的范围，这个注划算'
            : edge < -5 ? '按你估的范围，这个注不划算——他弃得不够多'
            : '临界，差距在估计误差里，按对手画像定';
        }

        const notes = [];
        if (to !== want) notes.push(`amount ${want} 夹到 ${to}（区间 ${min}~${max}）`);
        if (conflict) notes.push(conflict);
        if (opponents > 1) {
          notes.push(`还有 ${opponents} 个活对手，这里按「只有一个人跟」估算；` +
            '真被两个人跟的话你的胜率会明显更低，需要的弃牌率也更高');
        }
        if (caller && callerAdds < risk) {
          notes.push(`${sanitizeName(caller.name)} 只跟得起 ${callerAdds}，多出来的 ${risk - callerAdds} 会退给你`);
        }
        if (!caller) notes.push('没有还能行动的对手了，下注没有弃牌收益');

        trace.calls.push({
          tool: 'plan_bet', amount: to, risk, continueRange: f,
          needsFold, impliedFold, ev: evChips, reason: reason || null,
        });

        return {
          action: isRaise ? 'raise' : 'bet',
          amount: to,
          risk,
          win_if_all_fold: pot,
          needs_fold_pct: needsFold,
          implied_fold_pct: impliedFold,
          equity_when_called_pct: eq.pct,
          ev_chips: evChips,
          margin: eq.margin,
          pot_when_called: potWhenCalled,
          allin: to >= max,
          verdict,
          note: notes.length ? notes.join('；') : null,
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
