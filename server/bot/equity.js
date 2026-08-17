// SPDX-License-Identifier: GPL-3.0-or-later
//
// 蒙特卡洛胜率估算。
//
// 提示词里原来只有「你需要多少胜率才划算」（底池赔率，纯算术），
// 缺的是「你实际有多少胜率」—— 这个 LLM 自己算不出来，只能我们算给它。
//
// 明确的建模假设（必须让模型知道，否则它会过度信任这个数）：
//   对手底牌按**剩余牌堆里随机两张**发。真实对手是有范围的（跟到河牌的人
//   通常不拿垃圾牌），所以这个数**系统性偏乐观**，对紧的对手尤其如此。
//   做范围建模是另一个量级的工程，这里不做。
//
// 不做的事：这不是 solver。GTO 需要对整棵牌树求近似纳什均衡，
// 翻牌后的解是 TB 级数据且以「走到该节点的双方范围」为条件，
// 200MB 容器里放不下也算不了。详见 README 的说明。

import { randomInt } from 'node:crypto';
import { fastScore7 } from './fastscore.js';

const RANKS = '23456789TJQKA';
const SUITS = 'cdhs';

/** 完整 52 张牌 */
function fullDeck() {
  const out = [];
  for (const r of RANKS) for (const s of SUITS) out.push(r + s);
  return out;
}

const FULL_DECK = Object.freeze(fullDeck());

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
 * @param {() => number} [args.rng]   注入随机源（测试用），返回 [0,1)
 * @returns {{pct:number, margin:number, sims:number, opponents:number, truncated:boolean}|null}
 *   pct     胜率百分比（0~100，含平分底池的折算）
 *   margin  95% 置信半宽（百分点），用来告诉模型这个数有多糙
 *   null    输入不合法（没底牌、对手数 < 1 等）
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

  // 预分配，循环里不再新建数组
  const myCards = new Array(7);
  const oppCards = new Array(7);
  myCards[0] = hole[0];
  myCards[1] = hole[1];
  for (let i = 0; i < board.length; i++) {
    myCards[2 + i] = board[i];
    oppCards[2 + i] = board[i];
  }

  let equitySum = 0;
  let done = 0;
  // 每 32 次查一下时间，Date.now() 本身也有成本
  const CHECK_EVERY = 32;

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

        // 部分 Fisher-Yates：只洗出需要的前 draws 张
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

        const mine = fastScore7(myCards);
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
      };
    },
  };
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
