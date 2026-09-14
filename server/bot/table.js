// SPDX-License-Identifier: GPL-3.0-or-later
//
// 五档胜率表，以及「这个局面明显到不用问模型」的判定。
//
// 两件事都是冲着**延迟**去的，先把账算清楚：
//
//   一格 20000 次蒙特卡洛只要 20~60ms（equity.js 分片跑，不卡桌）。
//   一次模型往返要 2~3s（不思考）到 5~8s（带思维链）。
//
// 也就是说蒙特卡洛不是瓶颈，**往返次数才是**。agent 版原来把胜率做成工具，
// 模型想按哪个范围算就调一次 —— 每调一次就是一整趟往返。这里改成轮到它时
// 直接把五个标准范围档的胜率全算好写进提示词（总共 100~300ms），模型只需要
// 判断「对手在哪一档」然后读那一行。原来 3~4 趟往返的决策，现在 1 趟。
//
// 「明显局面」是另一头：翻牌前拿着垃圾牌面对加注、翻牌后对任意两张牌都远远
// 跟不起价 —— 这类决策不管把对手读成什么范围结论都一样，模型的判断力在这里
// 一文不值，等它 5~20 秒纯属浪费。直接弃牌，0 趟往返。
//
// 判「明显」的原则是**宁可漏判，不可错判**：漏判只是多等一次模型，错判是
// 把一手本该打的牌自动弃掉。所以每条规则都留了余量，能过牌的局面一律不碰
// （下不下注、诈不诈唬是模型和人格的活），面对下注只在「最乐观的假设下也
// 跟不起」时才弃。

import { estimateEquityAsync, countLiveOpponents, handPercentile } from './equity.js';
import { traitBias } from './persona.js';

/** 标准范围档。1 = 任意两张（不做假设） */
export const RANGE_BUCKETS = Object.freeze([0.05, 0.15, 0.35, 0.7, 1]);

/** 范围档位的中文说明，写进提示词和工具描述里让模型有个锚 */
export const RANGE_HINT = [
  '0.05 ≈ 只玩 AA-TT / AK / AQs 这类（极紧，比如一个石头在河牌加注）',
  '0.15 ≈ 大对子 + 强 A + 同花大牌（典型紧凶玩家的开池范围）',
  '0.35 ≈ 任意对子 + 任意 A + 同花连张（普通人的开池范围）',
  '0.70 ≈ 除了纯垃圾牌都玩（松散玩家 / 大盲位跟注范围）',
  '1.00 = 任意两张（完全不做假设；对手越松、越是翻牌前，这个越接近真相）',
].join('；');

/** 「前 15%」/「任意两张」 */
export function rangeLabel(range) {
  return range >= 1 ? '任意两张' : `前 ${Math.round(range * 100)}%`;
}

/**
 * 按几个对手范围各算一次胜率。
 *
 * 串行算，不并行：Node 单核，并行只会让每一片让出事件循环的时间叠起来，
 * 总耗时一点不少。整张表的墙钟上限是 budgetMs，平均分给每一档 —— 慢机器上
 * 只是每档少算几千次（结果里 truncated 会标出来），不会拖到超过预算。
 *
 * @param {object} args
 * @param {object} args.state         Room#buildStateFor(botPlayerId) 的脱敏快照
 * @param {number[]} [args.ranges]    默认五档
 * @param {number} [args.opponents]   不给就从快照数还在牌里的对手
 * @param {number} [args.sims]
 * @param {number} [args.budgetMs]    整张表的墙钟上限
 * @param {number} [args.chunkMs]
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<Array<{range:number,pct:number,margin:number,sims:number,
 *           opponents:number,rangeExhausted:number,truncated:boolean}>|null>}
 *   按范围从紧到松排好。null = 算不了（没底牌 / 没对手 / 中途被取消）
 */
export async function equityTable(args) {
  const { state, signal } = args;
  const ranges = Array.isArray(args.ranges) && args.ranges.length ? args.ranges : RANGE_BUCKETS;
  const hole = state?.you?.cards;
  if (!Array.isArray(hole) || hole.length !== 2) return null;
  const opponents = Number.isFinite(args.opponents) ? args.opponents : countLiveOpponents(state);
  if (opponents < 1) return null;

  const sims = Math.max(1, Number(args.sims) || 20000);
  const chunkMs = Math.max(1, Number(args.chunkMs) || 8);
  const budget = Math.max(chunkMs, Math.floor((Number(args.budgetMs) || 1200) / ranges.length));

  const rows = [];
  for (const range of ranges) {
    if (signal?.aborted) return null;
    const r = await estimateEquityAsync({
      hole,
      board: state.table?.board || [],
      opponents,
      sims,
      budgetMs: budget,
      chunkMs,
      signal,
      opponentRange: range >= 1 ? null : range,
    });
    if (!r) return null;
    rows.push({
      range: range >= 1 ? 1 : Math.max(0.02, range),
      pct: r.pct,
      margin: r.margin,
      sims: r.sims,
      opponents: r.opponents,
      rangeExhausted: r.rangeExhausted,
      truncated: !!r.truncated,
    });
  }
  if (signal?.aborted) return null;
  rows.sort((a, b) => a.range - b.range);
  return rows;
}

/**
 * 跟注需要的最低胜率（百分比）。null = 现在不用跟注。
 * 底池赔率 = 跟注额 / (底池 + 跟注额)，和 decide.js / policy.js 一个口径。
 */
export function callBreakeven(state) {
  const legal = state?.you?.legal;
  const call = Number(legal?.callAmount) || 0;
  if (!legal?.canCall || call <= 0) return null;
  const pot = Number(state.table?.totalPot) || 0;
  return (call / (pot + call)) * 100;
}

/** 翻牌前有没有别人加过注（盲注不算，那是 blind 事件不进 history） */
function preflopRaised(state) {
  const history = Array.isArray(state?.table?.history) ? state.table.history : [];
  const mySeat = state?.you?.seat;
  for (const st of history) {
    if (st?.street !== 'preflop' || !Array.isArray(st.acts)) continue;
    for (const a of st.acts) {
      if (!a || a.seat === mySeat) continue;
      if (a.type === 'raise' || a.type === 'allin' || a.type === 'bet') return true;
    }
  }
  return false;
}

// 下面几个常数全是**余量**，方向都是「更难被判成明显」。
//
/** 翻牌后明显弃牌：对任意两张牌的胜率也要比底池赔率低这么多个百分点 */
const FOLD_BUFFER = 5;
/** 每多一个活对手再加这么多：多人底池里后面还有人会跟，现在的底池赔率算低了 */
const MULTIWAY_EXTRA = 3;
/** 只能跟或弃时的明显跟注：对最紧的那一档也要高出底池赔率这么多 */
const CALL_BUFFER = 15;
/** 翻牌前面对加注：起手牌排名在这之后的算垃圾（0.70 = 后 30%） */
const TRASH_VS_RAISE = 0.70;
/**
 * 翻牌前没人加注、只是要跟一个大盲：门槛松一些，后 20% 才算。
 * 小盲补盲（跟注额不到一个大盲）不判 —— 限注底池里小盲拿什么牌补都说得过去。
 */
const TRASH_UNRAISED = 0.80;

/**
 * 这个局面明显到不用问模型吗？
 *
 * 只判三种，每种都有一条**不依赖对手范围**的理由：
 *
 *   1. 翻牌前拿着垃圾起手牌。面对加注时后 30% 的牌，没人加注时后 20% 的牌
 *      （小盲补盲不判）。按 equity.js 那条「可玩性 + 胜率」的序算排名，人格里
 *      入池范围松的再放宽一成，紧的收一成。翻牌前不用胜率对底池赔率 ——
 *      多人底池里那个赔率算得太严，会把 T9s 这种牌也判成弃（见 MULTIWAY_EXTRA）。
 *   2. 翻牌后面对下注，**对手拿任意两张牌**你都跟不起价（还留了余量）。
 *      这是最乐观的假设；连它都跟不起，读成任何范围都更跟不起。
 *   3. 只能跟或弃（面对全下）而且**对最紧的那一档**都远高于价。这是最悲观的
 *      假设；连它都稳赚，读成任何范围都该跟。这种局面没有尺度可选，模型能
 *      贡献的只剩一句闲聊。
 *
 * 能过牌的局面一律返回 null：要不要下注、诈不诈唬，是模型和人格的活。
 * 「明显强牌面对下注」也不判：跟还是加、加多大，同样是模型的活。
 *
 * 人格特质会移动门槛（traitBias.callThreshold），所以「不吃诈唬」的人机
 * 更难被判成明显弃牌 —— 和规则策略里它更爱跟注是同一个偏移。
 *
 * @param {object} args
 * @param {object} args.state    脱敏快照
 * @param {Array<{range:number,pct:number}>} [args.rows]  equityTable 的输出，
 *                               可以只有部分档：缺的档对应的规则就不判
 * @param {object} [args.traits] 人格特质
 * @param {number} [args.opponents] 不给就从快照数
 * @returns {{action:{type:string}, why:string}|null}
 */
export function classifyObvious(args) {
  const { state, traits } = args;
  const legal = state?.you?.legal;
  // 能过牌就不算明显：下不下注是模型的活
  if (!legal || legal.canCheck || !legal.canCall) return null;
  const call = Number(legal.callAmount) || 0;
  if (call <= 0) return null;

  const need = callBreakeven(state);
  if (need === null) return null;
  const bias = traitBias(traits);
  const opponents = Number.isFinite(args.opponents) ? args.opponents : countLiveOpponents(state);
  const rows = Array.isArray(args.rows) ? args.rows : [];
  const row = (range) => rows.find((r) => r && r.range === range) || null;
  const phase = state.table?.phase;

  if (phase === 'preflop') {
    const hole = state.you?.cards;
    const pctl = Array.isArray(hole) && hole.length === 2 ? handPercentile(hole[0], hole[1]) : null;
    const raised = preflopRaised(state);
    const bigBlind = Number(state.config?.bigBlind) || 0;
    // 小盲补盲：跟注额不到一个大盲。没人加注时不判（见 TRASH_UNRAISED）
    const completing = !raised && bigBlind > 0 && call < bigBlind;
    if (pctl !== null && !completing) {
      let cut = raised ? TRASH_VS_RAISE : TRASH_UNRAISED;
      if (traits?.range === 'loose') cut += 0.1;
      else if (traits?.range === 'tight') cut -= 0.1;
      cut = Math.min(cut, 0.97);
      if (pctl > cut) {
        return {
          action: { type: 'fold' },
          why: `翻牌前${raised ? '面对加注' : ''}拿着排在后 ${Math.round((1 - pctl) * 100)}% 的起手牌，弃`,
        };
      }
    }
  } else {
    const optimistic = row(1);
    if (optimistic) {
      const buffer = FOLD_BUFFER + MULTIWAY_EXTRA * Math.max(0, opponents - 1);
      const adjusted = need + bias.callThreshold * 100;
      if (optimistic.pct < adjusted - buffer) {
        return {
          action: { type: 'fold' },
          why: `对手拿任意两张牌你也只有 ${optimistic.pct}% 胜率，跟注要 ${Math.round(need)}%，弃`,
        };
      }
    }
  }

  // 面对全下之类只能跟或弃的局面，大牌直接跟
  if (!legal.canRaise) {
    const pessimistic = row(RANGE_BUCKETS[0]);
    if (pessimistic) {
      const adjusted = need + bias.callThreshold * 100;
      if (pessimistic.pct > adjusted + CALL_BUFFER) {
        return {
          action: { type: 'call' },
          why: `就算对手只玩前 ${Math.round(RANGE_BUCKETS[0] * 100)}% 的牌你也有 ${pessimistic.pct}% 胜率，` +
            `跟注只要 ${Math.round(need)}%，跟`,
        };
      }
    }
  }

  return null;
}

/**
 * 单轮那路判「明显」需要哪些档。只算用得上的：翻牌前不用胜率，
 * 翻牌后要「任意两张」那一档，只能跟或弃时再加「最紧」那一档。
 * 空数组 = 一格都不用算。
 */
export function rangesForObvious(state) {
  const legal = state?.you?.legal;
  if (!legal || legal.canCheck || !legal.canCall || !(Number(legal.callAmount) > 0)) return [];
  const out = [];
  if (state.table?.phase !== 'preflop') out.push(1);
  if (!legal.canRaise) out.push(RANGE_BUCKETS[0]);
  return out;
}
