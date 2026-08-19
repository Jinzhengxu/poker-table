// SPDX-License-Identifier: GPL-3.0-or-later
// 掼蛋：从一手牌里枚举"能出的牌"。
//
// 和 gd-combos.js 一样是前后端共用的纯函数模块，两边都要它：
//   前端 —— "提示"按钮循环展示可出的牌
//   服务端 —— 人机出牌、以及超时托管时自动走一步
// 共用同一份枚举逻辑，人机和玩家看到的候选就永远是同一套标准。
//
// 每个生成器都【自己声明】拼出来的是什么牌型，不走 interpret 的穷举，
// 所以枚举一手 27 张牌是毫秒级的。声明出来的牌型保证能被 interpret 复现，
// 服务端才不会反过来说"牌型对不上"。

import {
  RANKS, SUITS, TYPE, JOKER_SMALL, JOKER_BIG,
  wildCard, powerValue, isJoker, classify, beats, isBomb, bombPower,
} from './gd-combos.js';

/** 自然点数 -> 点数字符，1 当 A（A2345 里的那个 A） */
function valueChar(v) {
  return v === 1 ? 'A' : RANKS[v - 2];
}

/** 长度为 len 的所有连号窗口 */
function windows(len) {
  const out = [];
  for (let v = 1; v + len - 1 <= 14; v++) {
    const ranks = [];
    for (let k = 0; k < len; k++) ranks.push(valueChar(v + k));
    out.push({ ranks, top: v + len - 1 });
  }
  return out;
}
const W_STRAIGHT = windows(5);   // 顺子：A2345 … 10JQKA
const W_TUBE = windows(3);       // 连对：AA2233 … QQKKAA
const W_PLATE = windows(2);      // 钢板：AAA222 … KKKAAA

/** 按点数分桶；逢人配和王单独放 */
function bucket(hand, wild) {
  const byRank = new Map();
  const wilds = [];
  const jb = [];
  const jr = [];
  for (const c of hand) {
    if (c === wild) { wilds.push(c); continue; }
    if (c === JOKER_SMALL) { jb.push(c); continue; }
    if (c === JOKER_BIG) { jr.push(c); continue; }
    if (!byRank.has(c[0])) byRank.set(c[0], []);
    byRank.get(c[0]).push(c);
  }
  return { byRank, wilds, jb, jr };
}

/**
 * 按 specs 抓牌，不够的用逢人配补。逢人配是共享预算，同一手里不会被重复分配。
 * @returns {{cards:string[], used:number}|null} 抓不齐返回 null
 */
function grab(byRank, wilds, specs) {
  const cards = [];
  let wi = 0;
  for (const { rank, n } of specs) {
    const avail = byRank.get(rank) || [];
    const nat = Math.min(avail.length, n);
    const need = n - nat;
    if (wi + need > wilds.length) return null;
    cards.push(...avail.slice(0, nat), ...wilds.slice(wi, wi + need));
    wi += need;
  }
  return { cards, used: wi };
}

/** 同花色分桶，给同花顺用 */
function bySuit(hand, wild) {
  const m = new Map();
  for (const s of SUITS) m.set(s, new Map());
  for (const c of hand) {
    if (c === wild || isJoker(c)) continue;
    const bag = m.get(c[1]);
    if (!bag.has(c[0])) bag.set(c[0], []);
    bag.get(c[0]).push(c);
  }
  return m;
}

/**
 * 枚举这手牌能打出的所有牌型。
 * @param {string[]} hand
 * @param {number} level 当前级数 2..14
 * @param {object|null} req 需要压过的牌型；null 表示自己领出
 * @returns {{cards:string[], combo:{type:string,rank:number,size:number}}[]} 从弱到强
 */
export function findPlays(hand, level, req = null) {
  const wild = wildCard(level);
  const { byRank, wilds, jb, jr } = bucket(hand, wild);
  const out = [];
  const seen = new Set();

  const offer = (cards, combo) => {
    if (!cards || !combo) return;
    if (!beats(combo, req)) return;
    const key = `${combo.type}:${combo.rank}:${combo.size}:${[...cards].sort().join(',')}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ cards, combo });
  };

  const lead = !req;
  /** 跟牌时只找同型；req 本身是炸弹时，非炸弹一律不用找 */
  const match = (t) => lead || req.type === t;
  const pv = (rank) => powerValue(rank + 'c', level);
  /** 手上真有的点数（含只靠逢人配也能凑的情况） */
  const liveRanks = RANKS.filter((r) => (byRank.get(r) || []).length > 0 || wilds.length > 0);

  // ---------------- 单张 ----------------
  if (match(TYPE.SINGLE)) {
    for (const [rank, cards] of byRank) offer([cards[0]], { type: TYPE.SINGLE, rank: pv(rank), size: 1 });
    if (jb.length) offer([jb[0]], { type: TYPE.SINGLE, rank: 16, size: 1 });
    if (jr.length) offer([jr[0]], { type: TYPE.SINGLE, rank: 17, size: 1 });
    if (wilds.length) offer([wilds[0]], { type: TYPE.SINGLE, rank: 15, size: 1 });
  }

  // ---------------- 对子 / 三张 / 炸弹 ----------------
  for (const rank of liveRanks) {
    const have = (byRank.get(rank) || []).length;
    if (match(TYPE.PAIR)) {
      const g = grab(byRank, wilds, [{ rank, n: 2 }]);
      if (g) offer(g.cards, { type: TYPE.PAIR, rank: pv(rank), size: 2 });
    }
    if (match(TYPE.TRIPLE)) {
      const g = grab(byRank, wilds, [{ rank, n: 3 }]);
      if (g) offer(g.cards, { type: TYPE.TRIPLE, rank: pv(rank), size: 3 });
    }
    // 炸弹任何时候都能出。张数越多越大，所以每个长度各给一个候选。
    for (let n = 4; n <= Math.min(have + wilds.length, 8); n++) {
      const g = grab(byRank, wilds, [{ rank, n }]);
      if (g) offer(g.cards, { type: TYPE.BOMB, rank: pv(rank), size: n });
    }
  }
  if (match(TYPE.PAIR)) {
    if (jb.length >= 2) offer([jb[0], jb[1]], { type: TYPE.PAIR, rank: 16, size: 2 });
    if (jr.length >= 2) offer([jr[0], jr[1]], { type: TYPE.PAIR, rank: 17, size: 2 });
  }

  // ---------------- 三带二 ----------------
  if (match(TYPE.FULL)) {
    for (const three of liveRanks) {
      const t = grab(byRank, wilds, [{ rank: three, n: 3 }]);
      if (!t) continue;
      const leftWild = wilds.slice(t.used);
      for (const two of liveRanks) {
        if (two === three) continue;
        const p = grab(byRank, leftWild, [{ rank: two, n: 2 }]);
        if (p) offer([...t.cards, ...p.cards], { type: TYPE.FULL, rank: pv(three), size: 5 });
      }
    }
  }

  // ---------------- 顺子 / 连对 / 钢板 ----------------
  const seqs = [
    [TYPE.STRAIGHT, W_STRAIGHT, 1, 5],
    [TYPE.TUBE, W_TUBE, 2, 6],
    [TYPE.PLATE, W_PLATE, 3, 6],
  ];
  for (const [type, wins, per, size] of seqs) {
    if (!match(type)) continue;
    for (const w of wins) {
      const g = grab(byRank, wilds, w.ranks.map((r) => ({ rank: r, n: per })));
      if (!g) continue;
      // 顺子且一张逢人配都没用时，可能整手同花 —— 那它就是同花顺，得按同花顺声明
      let combo = { type, rank: w.top, size };
      if (type === TYPE.STRAIGHT && g.used === 0) {
        combo = classify(g.cards, level) || combo;
      }
      offer(g.cards, combo);
    }
  }

  // ---------------- 同花顺（炸弹，任何时候都能出）----------------
  for (const [, bag] of bySuit(hand, wild)) {
    for (const w of W_STRAIGHT) {
      const cards = [];
      let need = 0;
      for (const r of w.ranks) {
        const a = bag.get(r);
        if (a && a.length) cards.push(a[0]);
        else need++;
      }
      if (need > wilds.length) continue;
      offer([...cards, ...wilds.slice(0, need)], { type: TYPE.SFLUSH, rank: w.top, size: 5 });
    }
  }

  // ---------------- 天王炸 ----------------
  if (jb.length >= 2 && jr.length >= 2) {
    offer([jb[0], jb[1], jr[0], jr[1]], { type: TYPE.JOKERS, rank: 0, size: 4 });
  }

  // 弱在前：非炸弹排在炸弹前，同档比点数，再比"少用逢人配"
  out.sort((a, b) => {
    const ab = isBomb(a.combo) ? bombPower(a.combo) : -1;
    const bb = isBomb(b.combo) ? bombPower(b.combo) : -1;
    if (ab !== bb) return ab - bb;
    if (a.combo.rank !== b.combo.rank) return a.combo.rank - b.combo.rank;
    const aw = a.cards.filter((c) => c === wild).length;
    const bw = b.cards.filter((c) => c === wild).length;
    if (aw !== bw) return aw - bw;
    return a.cards.length - b.cards.length;
  });
  return out;
}

/**
 * 挑一手最该出的牌（人机与超时托管用）。
 * 策略很朴素，但够打：能一把走完就走完，队友领先就不抢，炸弹留到关键时刻。
 * @param {string[]} hand
 * @param {number} level
 * @param {object|null} req 需要压过的牌型
 * @param {object} [ctx] { myCount, oppMin, mateLeading }
 * @returns {{cards:string[], combo:object}|null} null 表示要不起 / 选择不出
 */
export function choosePlay(hand, level, req, ctx = {}) {
  const plays = findPlays(hand, level, req);
  if (!plays.length) return null;
  const plain = plays.filter((p) => !isBomb(p.combo));
  const bombs = plays.filter((p) => isBomb(p.combo));
  const myCount = ctx.myCount ?? hand.length;
  const oppMin = ctx.oppMin ?? 27;          // 两个对手里最少还剩几张
  const mateLeading = !!ctx.mateLeading;    // 当前这手牌是队友打的

  if (!req) {
    // 领出：一把能走完就走完；否则出最小的，牌多时优先甩长牌型减手数
    const finisher = plays.find((p) => p.cards.length === hand.length);
    if (finisher) return finisher;
    if (!plain.length) return plays[0];
    if (myCount > 10) {
      const long = plain.filter((p) => p.cards.length >= 5);
      if (long.length) return long[0];
    }
    return plain[0];
  }

  // 队友正领先就别压自己人，除非压完这手自己就能走
  if (mateLeading && myCount > 2) return null;

  if (plain.length) {
    const pick = plain[0];
    // 手上还很多牌时，不值得为压一张单牌就拆掉级牌或王
    if (myCount > 6 && pick.cards.length === 1 && pick.combo.rank >= 15 && oppMin > 5) return null;
    return pick;
  }

  // 只剩炸弹能压：对手快走完了，或者炸完自己也就剩一两张，才值得炸
  if (bombs.length && (oppMin <= 3 || myCount - bombs[0].cards.length <= 2)) return bombs[0];
  return null;
}
