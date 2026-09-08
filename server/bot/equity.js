// SPDX-License-Identifier: GPL-3.0-or-later
//
// 蒙特卡洛胜率估算。
//
// 提示词里原来只有「你需要多少胜率才划算」（底池赔率，纯算术），
// 缺的是「你实际有多少胜率」—— 这个 LLM 自己算不出来，只能我们算给它。
//
// 明确的建模假设（必须让模型知道，否则它会过度信任这个数）：
//   默认对手底牌按**剩余牌堆里随机两张**发。真实对手是有范围的（跟到河牌的人
//   通常不拿垃圾牌），所以这个默认值**系统性偏乐观**，对紧的对手尤其如此。
//
//   传 opponentRange 可以收窄这个假设：给一个 0~1 的比例，表示「对手只玩
//   最能玩的前 X 比例起手牌」。这是 agent 版人机的主要工具——它读完本手
//   行动序列，自己判断对手范围有多紧，再要一个对应假设下的胜率。
//   AKo 对随机牌 65%，对前 5% 只有 45%；而 AA 两种情况都是 82% 以上
//   （它本来就领先一切）。这个差异正是「范围」这个概念的全部价值。
//
//   排序键是两段的：**先按可玩性档位（data/ranges.js），档内再按真实胜率
//   （data/preflop.js）**。所以「前 20%」有确切含义：真实范围梯子上最紧的
//   那 20% 组合。为什么不能只按胜率排，见下面 rankedCombos 的长注释。
//
// 不做的事：这不是 solver。GTO 需要对整棵牌树求近似纳什均衡，
// 翻牌后的解是 TB 级数据且以「走到该节点的双方范围」为条件，
// 200MB 容器里放不下也算不了。详见 README 的说明。

import { randomInt } from 'node:crypto';
import { fastScore7 } from './fastscore.js';
import { PREFLOP_EQUITY, canonicalHand } from './data/preflop.js';
import { PLAY_TIER, TIER_PCT } from './data/ranges.js';

const RANKS = '23456789TJQKA';
const SUITS = 'cdhs';

/** 完整 52 张牌 */
function fullDeck() {
  const out = [];
  for (const r of RANKS) for (const s of SUITS) out.push(r + s);
  return out;
}

const FULL_DECK = Object.freeze(fullDeck());

/** 牌面 -> 0..51 的下标，范围采样时用位图标记已用牌 */
const CARD_INDEX = new Map(FULL_DECK.map((c, i) => [c, i]));

/**
 * 全部 1326 种两张牌组合，按**「人会玩哪些牌」**从紧到松排好序。第一次用到时才算，之后复用。
 *
 * 排序键是两段的：**先按可玩性档位（data/ranges.js），档内再按真实胜率（data/preflop.js）**。
 *
 * 为什么不能只按胜率排。胜率答的是「这手牌有多强」，而 opponentRange 问的是
 * 「对手会玩哪些牌」——这是两个维度，而且分歧是系统性的。拿真实开池范围和
 * 「按胜率取前 X%」对齐组合数后比较：
 *
 *     UTG  14.2%  重合 80.9%
 *     CO   26.7%  重合 75.1%     <- 四分之一是错的
 *     BTN  43.6%  重合 83.7%
 *
 * 而且错得很整齐：胜率排序多收的全是 offsuit 高牌（A9o A8o A7o K9o A5o），
 * 漏掉的全是同花连张和小对子（76s 65s 54s 98s T9s 22 33）。76s 对随机牌的胜率
 * 排第 116/169，可每一张 CO 开池表里都有它；K9o 排第 40，没人拿它在 CO 开池。
 * 同花连张能做成顺子同花、翻后好打，这部分价值胜率完全没测。
 *
 * 档位怎么来的：真实范围表是**集合**不是序，把它变成序靠的是嵌套——一手牌能在
 * 多紧的局面里出现，就说明它有多"能玩"。从「面对 4bet 还全下」（1.2%，只有
 * AA/AKs/KK）一路松到「大盲防守小盲开池」（65%），每手牌归到它第一次出现的那档。
 * 见 data/ranges.js 与 scripts/build-preflop-ranges.mjs。
 *
 * 档内为什么还要按胜率：档位只有 12 级，粒度太粗；档内没有更多的范围信息，
 * 而胜率和可玩性在档内高度相关，是现成的最好的次级键。
 *
 * 演进：Chen formula（1970 年代的手感打分）-> 真实胜率 -> 真实范围档位 + 胜率。
 */
let RANKED_COMBOS = null;
function rankedCombos() {
  if (RANKED_COMBOS) return RANKED_COMBOS;
  const out = [];
  for (let i = 0; i < 52; i++) {
    for (let j = i + 1; j < 52; j++) {
      const name = canonicalHand(FULL_DECK[i], FULL_DECK[j]);
      const pct = PREFLOP_EQUITY[name];
      if (pct === undefined) throw new Error(`起手牌表里没有 ${name}`);
      const tier = PLAY_TIER[name];
      if (tier === undefined) throw new Error(`档位表里没有 ${name}`);
      out.push([i, j, pct, tier]);
    }
  }
  out.sort((a, b) => (a[3] - b[3]) || (b[2] - a[2]));
  RANKED_COMBOS = out;
  return out;
}

/** 档位边界（累计占比 %），给文档和测试用 */
export const RANGE_TIERS = TIER_PCT;

/**
 * 把「前 f 比例」变成允许的组合列表。
 * @param {number} f 0~1
 */
function allowedCombos(f) {
  const all = rankedCombos();
  const n = Math.max(1, Math.min(all.length, Math.round(f * all.length)));
  return all.slice(0, n);
}

/**
 * 这两张牌在全部 1326 个组合里排前百分之几（0~1，越小越强）。
 *
 * 用来做**校准检查**：评测时我们看得见对手的真牌，于是可以问一句
 * 「启发式说对手范围是前 5%，那些人手里的牌实际排在第几百分位？」
 * 两个数差很远就说明范围推断没校准 —— 这是 bb/100 之外唯一能直接
 * 证伪范围推断的办法，而且方差极小。
 *
 * @param {string} a
 * @param {string} b
 * @returns {number|null} 0~1；牌面非法时 null
 */
export function handPercentile(a, b) {
  if (!isCard(a) || !isCard(b) || a === b) return null;
  const ia = CARD_INDEX.get(a);
  const ib = CARD_INDEX.get(b);
  const lo = Math.min(ia, ib);
  const hi = Math.max(ia, ib);
  const all = rankedCombos();
  for (let i = 0; i < all.length; i++) {
    if (all[i][0] === lo && all[i][1] === hi) return (i + 1) / all.length;
  }
  return null;
}

/**
 * 校验对手范围参数。
 * @returns {number|null} null 表示「任意两张」（不做范围建模）
 */
function normalizeRange(v) {
  if (v === null || v === undefined) return null;
  const f = Number(v);
  if (!Number.isFinite(f)) return null;
  if (f >= 1) return null;                 // 前 100% 就是任意两张，走快路径
  // 下限 2%：再窄下去组合数太少，和自己的底牌一撞就采不出样，
  // 而且「对手只可能拿前 1%」这个假设本身也没有信息价值。
  return Math.max(0.02, f);
}

/** 单个对手最多试多少次才放弃范围约束 */
const RANGE_MAX_ATTEMPTS = 100;

/**
 * 估算胜率。
 *
 * @param {object} args
 * @param {string[]} args.hole        自己的两张底牌
 * @param {string[]} [args.board]     已知公共牌（0/3/4/5 张）
 * @param {number}   args.opponents   还在牌里的对手数量（≥1）
 * @param {number}   [args.sims]      模拟次数，默认 2000（约 ±2% 误差）
 * @param {number}   [args.budgetMs]  墙钟上限，默认 60ms。到点就用已完成的次数算，
 *                                    保证不会因为对手多、机器慢而卡住事件循环。
 * @param {number}   [args.opponentRange] 对手范围：0~1，表示「对手只玩最强的前 X 比例
 *                                    起手牌」。省略 / null / >=1 都表示任意两张。
 *                                    小于 0.02 会被夹到 0.02（再窄就采不出样了）。
 * @param {() => number} [args.rng]   注入随机源（测试用），返回 [0,1)
 * @returns {{pct:number, margin:number, sims:number, opponents:number, truncated:boolean,
 *            range:number|null, rangeExhausted:number}|null}
 *   pct            胜率百分比（0~100，含平分底池的折算）
 *   margin         95% 置信半宽（百分点），用来告诉模型这个数有多糙
 *   range          实际用的对手范围假设，null = 任意两张。**必须跟着 pct 一起
 *                  讲给模型听**，否则它分不清这个数是对着什么假设算出来的。
 *   rangeExhausted 有多少次因为撞牌没能从范围里采到手牌、退回了任意两张。
 *                  远大于 0 说明范围窄到采不动，结果要打问号。
 *   null           输入不合法（没底牌、对手数 < 1 等）
 */
export function estimateEquity(args) {
  const run = makeRun(args);
  if (!run) return null;
  run.step(Number(args?.budgetMs) || 60);
  return run.result();
}

/**
 * 分片版：把模拟切成小片，每片之间 setImmediate 让出事件循环。
 *
 * 为什么要有它：Node 单线程，同步版跑 50ms 就意味着**全桌冻结 50ms**
 * —— 别人点按钮不被处理、计时器不走。而行动时限有 45 秒，人机本来还要等
 * LLM 一两秒，时间明明很宽裕。所以正确做法不是"冻结久一点换精度"，
 * 而是根本不冻结：单片只占 chunkMs（默认 8ms，感知不到），总时长可以放到
 * 上千毫秒，精度因此不必妥协，慢机器也不会被迫降精度。
 *
 * @param {object} args 同 estimateEquity，另加：
 * @param {number} [args.chunkMs]  单片占用的毫秒数，默认 8
 * @param {number} [args.budgetMs] 总墙钟上限，默认 1500
 * @returns {Promise<object|null>}
 */
export async function estimateEquityAsync(args) {
  const run = makeRun(args);
  if (!run) return null;

  const chunkMs = Math.max(1, Number(args?.chunkMs) || 8);
  const totalMs = Math.max(chunkMs, Number(args?.budgetMs) || 1500);
  const signal = args?.signal;
  const deadline = Date.now() + totalMs;

  while (!run.done() && Date.now() < deadline) {
    if (signal?.aborted) break;
    run.step(Math.min(chunkMs, deadline - Date.now()));
    if (!run.done()) await yieldToLoop();
  }
  return run.result();
}

/** 让事件循环处理一轮待办（别人的动作、计时器、心跳） */
function yieldToLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * 建一次模拟的运行状态。校验输入、备好牌堆与复用数组。
 * @returns {{step:(ms:number)=>void, done:()=>boolean, result:()=>object|null}|null}
 */
function makeRun(args) {
  const hole = Array.isArray(args?.hole) ? args.hole.filter(isCard) : [];
  const board = Array.isArray(args?.board) ? args.board.filter(isCard) : [];
  const opponents = Math.floor(Number(args?.opponents));
  if (hole.length !== 2) return null;
  if (!Number.isFinite(opponents) || opponents < 1) return null;
  if (board.length > 5) return null;

  const sims = Math.max(1, Math.floor(Number(args?.sims) || 2000));
  const rng = typeof args?.rng === 'function' ? args.rng : null;

  // 剩余牌堆：去掉已知的底牌和公共牌
  const known = new Set([...hole, ...board]);
  if (known.size !== hole.length + board.length) return null;   // 有重复牌
  const deck = FULL_DECK.filter((c) => !known.has(c));

  const boardNeeded = 5 - board.length;
  const draws = opponents * 2 + boardNeeded;
  if (draws > deck.length) return null;

  // 对手范围：null = 任意两张（原来的行为，也是默认）。
  // 给了范围就走另一条采样路径——先按范围发对手底牌，再补公共牌。
  const range = normalizeRange(args?.opponentRange);
  const allowed = range === null ? null : allowedCombos(range);

  // 预分配，循环里不再新建数组
  const myCards = new Array(7);
  const oppCards = new Array(7);
  myCards[0] = hole[0];
  myCards[1] = hole[1];
  for (let i = 0; i < board.length; i++) {
    myCards[2 + i] = board[i];
    oppCards[2 + i] = board[i];
  }

  // 范围采样用的位图：baseUsed 是「已知牌」的固定底子，每手复制一份再改
  let baseUsed = null;
  let used = null;
  let oppHoles = null;
  if (allowed) {
    baseUsed = new Uint8Array(52);
    for (const c of known) baseUsed[CARD_INDEX.get(c)] = 1;
    used = new Uint8Array(52);
    oppHoles = new Array(opponents * 2);
  }

  let equitySum = 0;
  let done = 0;
  // 采样时因为撞牌撞不出范围内的手牌、退回任意两张的次数。
  // 这个数大说明范围窄到采不动了，结果要打问号。
  let exhausted = 0;
  // 每 32 次查一下时间，Date.now() 本身也有成本
  const CHECK_EVERY = 32;

  /** 从范围里给每个对手发两张不冲突的底牌，写进 oppHoles */
  function dealRanged() {
    used.set(baseUsed);
    for (let o = 0; o < opponents; o++) {
      let a = -1;
      let b = -1;
      for (let t = 0; t < RANGE_MAX_ATTEMPTS; t++) {
        const combo = allowed[pickInt(allowed.length, rng)];
        if (!used[combo[0]] && !used[combo[1]]) { a = combo[0]; b = combo[1]; break; }
      }
      if (a < 0) {
        // 范围里采不出来（范围太窄 + 牌被占）。退回任意两张，并记一笔。
        exhausted++;
        a = pickFree(used, rng);
        b = pickFree(used, rng);
      }
      used[a] = 1;
      used[b] = 1;
      oppHoles[o * 2] = a;
      oppHoles[o * 2 + 1] = b;
    }
  }

  return {
    done: () => done >= sims,

    /** 最多跑 ms 毫秒，或跑到 sims 次为止 */
    step(ms) {
      const deadline = Date.now() + Math.max(0, ms);
      let sinceCheck = 0;
      while (done < sims) {
        if (sinceCheck >= CHECK_EVERY) {
          if (Date.now() >= deadline) return;
          sinceCheck = 0;
        }
        sinceCheck++;

        let mine;
        if (allowed) {
          // ---- 范围路径：先按范围发对手，再从没用过的牌里补公共牌 ----
          dealRanged();
          for (let i = 0; i < boardNeeded; i++) {
            const idx = pickFree(used, rng);
            used[idx] = 1;
            const c = FULL_DECK[idx];
            myCards[2 + board.length + i] = c;
            oppCards[2 + board.length + i] = c;
          }
          mine = fastScore7(myCards);
          let better = 0;
          let tied = 0;
          for (let o = 0; o < opponents; o++) {
            oppCards[0] = FULL_DECK[oppHoles[o * 2]];
            oppCards[1] = FULL_DECK[oppHoles[o * 2 + 1]];
            const s = fastScore7(oppCards);
            if (s > mine) { better = 1; break; }
            if (s === mine) tied++;
          }
          if (!better) equitySum += 1 / (tied + 1);
          done++;
          continue;
        }

        // ---- 任意两张路径：部分 Fisher-Yates，只洗出需要的前 draws 张 ----
        for (let i = 0; i < draws; i++) {
          const j = i + pickInt(deck.length - i, rng);
          const tmp = deck[i]; deck[i] = deck[j]; deck[j] = tmp;
        }

        // 补齐公共牌
        for (let i = 0; i < boardNeeded; i++) {
          const c = deck[opponents * 2 + i];
          myCards[2 + board.length + i] = c;
          oppCards[2 + board.length + i] = c;
        }

        mine = fastScore7(myCards);
        let better = 0;
        let tied = 0;
        for (let o = 0; o < opponents; o++) {
          oppCards[0] = deck[o * 2];
          oppCards[1] = deck[o * 2 + 1];
          const s = fastScore7(oppCards);
          if (s > mine) { better = 1; break; }
          if (s === mine) tied++;
        }

        if (!better) equitySum += 1 / (tied + 1);   // 平分底池按份数折算
        done++;
      }
    },

    result() {
      if (!done) return null;
      const p = equitySum / done;
      // 二项分布 95% 置信半宽：1.96 * sqrt(p(1-p)/n)
      const margin = 1.96 * Math.sqrt(Math.max(p * (1 - p), 0) / done);
      return {
        pct: Math.round(p * 1000) / 10,
        margin: Math.round(margin * 1000) / 10,
        sims: done,
        opponents,
        truncated: done < sims,
        // 用了什么对手假设。null = 任意两张。调用方要把它讲给模型听，
        // 否则模型分不清「61% 对随机牌」和「61% 对前 15%」——差别很大。
        range,
        rangeExhausted: exhausted,
      };
    },
  };
}

/** 从位图里随机取一张还没用过的牌，返回下标 */
function pickFree(used, rng) {
  for (let t = 0; t < 200; t++) {
    const i = pickInt(52, rng);
    if (!used[i]) return i;
  }
  // 极端兜底：线性扫一遍
  for (let i = 0; i < 52; i++) if (!used[i]) return i;
  return 0;
}

function isCard(c) {
  return typeof c === 'string' && c.length === 2
    && RANKS.includes(c[0]) && SUITS.includes(c[1]);
}

/** [0, n) 的随机整数。默认用 crypto 无偏取样；注入 rng 时走注入的 */
function pickInt(n, rng) {
  if (n <= 1) return 0;
  if (rng) return Math.min(n - 1, Math.floor(rng() * n));
  return randomInt(n);
}

/**
 * 从状态快照里数出还在牌里的对手数量。
 * 只算 in / allin —— 已弃牌的不再争底池。
 * @param {object} state buildStateFor 的输出
 */
export function countLiveOpponents(state) {
  const seats = state?.seats;
  if (!Array.isArray(seats)) return 0;
  let n = 0;
  for (const s of seats) {
    if (!s || s.seat === state.you.seat) continue;
    if (s.state === 'in' || s.state === 'allin') n++;
  }
  return n;
}
