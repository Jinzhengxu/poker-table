// SPDX-License-Identifier: GPL-3.0-or-later
// 掼蛋牌型库 —— 前后端共用的唯一真相来源。
//
// 这个文件被两边同时 import：
//   服务端 server/guandan/engine.js  用它判合法性与大小
//   前端   public/gd.js              用它做选牌预览与按钮可用性
// 所以它必须是【纯函数 + 零依赖】：不能出现 node: 内置模块，也不能碰 DOM。
// 两边共用同一份代码，才不会出现"前端说能出、服务端说不合法"的错位。
//
// 牌的表示（沿用德州那套 2 字符风格）：
//   普通牌 = 点数字符 + 花色字符   例："As" 黑桃A，"Th" 红桃10
//   点数    2 3 4 5 6 7 8 9 T J Q K A
//   花色    c(♣) d(♦) h(♥) s(♠)
//   小王 = "jb"（black joker）  大王 = "jr"（red joker）
// 一副掼蛋牌 = 两副扑克 = 108 张，所以同一个字符串会出现两次，
// 不能拿字符串当唯一 id 用（客户端选牌一律按下标）。

export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
export const SUITS = ['c', 'd', 'h', 's'];
export const JOKER_SMALL = 'jb';
export const JOKER_BIG = 'jr';

/** 牌型标识 */
export const TYPE = Object.freeze({
  SINGLE: 'single',      // 单张
  PAIR: 'pair',          // 对子
  TRIPLE: 'triple',      // 三张（不带）
  FULL: 'full',          // 三带二（三张 + 一对）
  STRAIGHT: 'straight',  // 顺子（5 张连号）
  TUBE: 'tube',          // 连对 / 木板（3 组连号对子）
  PLATE: 'plate',        // 钢板（2 组连号三张）
  BOMB: 'bomb',          // 炸弹（4 张及以上同点）
  SFLUSH: 'sflush',      // 同花顺（火箭）
  JOKERS: 'jokers',      // 四王炸（天王炸）
});

/** 炸弹类牌型：可以压任何非炸弹牌型 */
const BOMB_TYPES = new Set([TYPE.BOMB, TYPE.SFLUSH, TYPE.JOKERS]);

const TYPE_CN = {
  [TYPE.SINGLE]: '单张',
  [TYPE.PAIR]: '对子',
  [TYPE.TRIPLE]: '三张',
  [TYPE.FULL]: '三带二',
  [TYPE.STRAIGHT]: '顺子',
  [TYPE.TUBE]: '连对',
  [TYPE.PLATE]: '钢板',
  [TYPE.SFLUSH]: '同花顺',
  [TYPE.JOKERS]: '天王炸',
};

// ==================== 单张牌 ====================

export function isJoker(card) {
  return card === JOKER_SMALL || card === JOKER_BIG;
}

/** 点数字符；王返回 null */
export function rankChar(card) {
  return isJoker(card) ? null : card[0];
}

/** 花色字符；王返回 null */
export function suitChar(card) {
  return isJoker(card) ? null : card[1];
}

/**
 * 自然点数：2..14（A=14）。顺子 / 连对 / 钢板用这个值，级牌在这里【不】升位。
 * 王没有自然点数（不能进顺子），返回 16/17 只是为了排序稳定。
 */
export function naturalValue(card) {
  if (card === JOKER_SMALL) return 16;
  if (card === JOKER_BIG) return 17;
  const i = RANKS.indexOf(card[0]);
  return i < 0 ? 0 : i + 2;
}

/**
 * 比较点数：单张 / 对子 / 三张 / 三带二 / 炸弹用这个值。
 * 级牌升到 15（仅次于王），小王 16，大王 17。
 * @param {string} card
 * @param {number} level 当前打的级数 2..14
 */
export function powerValue(card, level) {
  const v = naturalValue(card);
  if (v === 16 || v === 17) return v;
  return v === level ? 15 : v;
}

/** 当前级数对应的逢人配（红桃级牌），如 level=5 -> "5h" */
export function wildCard(level) {
  const i = level - 2;
  return (RANKS[i] || 'A') + 'h';
}

/** 级数 -> 显示名，14 -> "A" */
export function levelName(level) {
  return RANKS[level - 2] || '?';
}

/** 点数字符 -> 显示名，'T' -> "10" */
export function rankName(ch) {
  return ch === 'T' ? '10' : ch;
}

/** 一张牌的中文短名，用于日志 */
export function cardName(card) {
  if (card === JOKER_SMALL) return '小王';
  if (card === JOKER_BIG) return '大王';
  const suit = { c: '♣', d: '♦', h: '♥', s: '♠' }[card[1]] || '';
  return suit + rankName(card[0]);
}

/** 一副掼蛋牌：两副 54 张，顺序固定（洗牌由调用方负责） */
export function freshDeck() {
  const deck = [];
  for (let copy = 0; copy < 2; copy++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) deck.push(rank + suit);
    }
    deck.push(JOKER_SMALL, JOKER_BIG);
  }
  return deck;
}

/** 52 张不含王的牌面（逢人配的候选替身） */
function nonJokerUniverse() {
  const out = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) out.push(rank + suit);
  }
  return out;
}
const UNIVERSE = nonJokerUniverse();

/**
 * 理牌排序：按比较点数从大到小，同点数按花色聚拢。逢人配单独排到最前面。
 * @param {string[]} cards
 * @param {number} level
 */
export function sortHand(cards, level) {
  const wild = wildCard(level);
  return [...cards].sort((a, b) => {
    const aw = a === wild ? 1 : 0;
    const bw = b === wild ? 1 : 0;
    if (aw !== bw) return bw - aw;              // 逢人配置顶
    const d = powerValue(b, level) - powerValue(a, level);
    if (d !== 0) return d;
    return SUITS.indexOf(suitChar(b)) - SUITS.indexOf(suitChar(a));
  });
}

// ==================== 牌型识别（不含逢人配替换） ====================

/**
 * 一串连号的最高位。A 可以当 1（A2345 / AA2233 / AAA222），
 * 但不能绕回（KA234 不成立）。
 * @param {number[]} vals 去重后的自然点数
 * @returns {number|null} 最高位，不成立返回 null
 */
function seqTop(vals) {
  const s = [...vals].sort((a, b) => a - b);
  const run = (arr) => {
    for (let i = 1; i < arr.length; i++) {
      if (arr[i] !== arr[i - 1] + 1) return null;
    }
    return arr[arr.length - 1];
  };
  const hi = run(s);
  if (hi !== null) return hi;
  // A 当 1 再试一次
  if (s[s.length - 1] === 14) {
    const low = [1, ...s.slice(0, -1)].sort((a, b) => a - b);
    return run(low);
  }
  return null;
}

/** 按点数字符分组计数 */
function countByRank(cards) {
  const m = new Map();
  for (const c of cards) m.set(c[0], (m.get(c[0]) || 0) + 1);
  return m;
}

/**
 * 识别一组【具体牌】（逢人配已经替换成实牌）构成的牌型。
 * @param {string[]} cards
 * @param {number} level 当前级数
 * @returns {{type:string, rank:number, size:number}|null} 不成型返回 null
 */
export function classify(cards, level) {
  const n = cards.length;
  if (n === 0) return null;

  // ---- 王：只能单出、成对，或四张凑天王炸 ----
  const jokers = cards.filter(isJoker);
  if (jokers.length) {
    if (jokers.length !== n) return null;        // 王不能和别的牌混
    if (n === 1) return { type: TYPE.SINGLE, rank: powerValue(cards[0], level), size: 1 };
    if (n === 2 && cards[0] === cards[1]) {
      return { type: TYPE.PAIR, rank: powerValue(cards[0], level), size: 2 };
    }
    if (n === 4) {
      const small = cards.filter((c) => c === JOKER_SMALL).length;
      if (small === 2) return { type: TYPE.JOKERS, rank: 0, size: 4 };
    }
    return null;
  }

  const counts = countByRank(cards);
  const ranks = [...counts.keys()];

  // ---- 同点数：单/对/三/炸 ----
  if (ranks.length === 1) {
    const pv = powerValue(cards[0], level);
    if (n === 1) return { type: TYPE.SINGLE, rank: pv, size: 1 };
    if (n === 2) return { type: TYPE.PAIR, rank: pv, size: 2 };
    if (n === 3) return { type: TYPE.TRIPLE, rank: pv, size: 3 };
    return { type: TYPE.BOMB, rank: pv, size: n };   // 4 张及以上
  }

  // ---- 三带二 ----
  if (n === 5 && ranks.length === 2) {
    const three = ranks.find((r) => counts.get(r) === 3);
    const two = ranks.find((r) => counts.get(r) === 2);
    if (three && two) {
      return { type: TYPE.FULL, rank: powerValue(three + 'c', level), size: 5 };
    }
    return null;
  }

  // ---- 顺子 / 同花顺 ----
  if (n === 5 && ranks.length === 5) {
    const top = seqTop(ranks.map((r) => naturalValue(r + 'c')));
    if (top === null) return null;
    const flush = cards.every((c) => c[1] === cards[0][1]);
    return { type: flush ? TYPE.SFLUSH : TYPE.STRAIGHT, rank: top, size: 5 };
  }

  // ---- 连对（3 组）/ 钢板（2 组）----
  if (n === 6) {
    if (ranks.length === 3 && ranks.every((r) => counts.get(r) === 2)) {
      const top = seqTop(ranks.map((r) => naturalValue(r + 'c')));
      return top === null ? null : { type: TYPE.TUBE, rank: top, size: 6 };
    }
    if (ranks.length === 2 && ranks.every((r) => counts.get(r) === 3)) {
      const top = seqTop(ranks.map((r) => naturalValue(r + 'c')));
      return top === null ? null : { type: TYPE.PLATE, rank: top, size: 6 };
    }
  }

  return null;
}

/** 组合的去重键 */
function comboKey(c) {
  return `${c.type}:${c.rank}:${c.size}`;
}

/**
 * 识别一组【玩家实际选中的牌】可能构成的所有牌型。
 * 逢人配（红桃级牌）会被穷举替换成 52 张普通牌里的任意一张。
 * 两张逢人配时是 52×52=2704 次识别，牌不多，这个量级毫无压力。
 * @param {string[]} cards
 * @param {number} level
 * @returns {{type:string, rank:number, size:number}[]} 可能为空
 */
export function interpret(cards, level) {
  const wild = wildCard(level);
  const wilds = cards.filter((c) => c === wild).length;
  if (wilds === 0) {
    const c = classify(cards, level);
    return c ? [c] : [];
  }
  const rest = cards.filter((c) => c !== wild);
  const out = new Map();
  const add = (arr) => {
    const c = classify(arr, level);
    if (c) out.set(comboKey(c), c);
  };
  if (wilds === 1) {
    for (const a of UNIVERSE) add([...rest, a]);
  } else {
    // 逢人配只有两张，不会有第三层
    for (let i = 0; i < UNIVERSE.length; i++) {
      for (let j = i; j < UNIVERSE.length; j++) add([...rest, UNIVERSE[i], UNIVERSE[j]]);
    }
  }
  return [...out.values()];
}

// ==================== 大小比较 ====================

export function isBomb(combo) {
  return !!combo && BOMB_TYPES.has(combo.type);
}

/**
 * 炸弹类的统一战力档位。掼蛋的炸弹顺序是：
 *   4 张 < 5 张 < 同花顺 < 6 张 < 7 张 < 8 张 … < 天王炸
 * 同档位再比点数。
 */
export function bombPower(combo) {
  if (!combo) return 0;
  if (combo.type === TYPE.JOKERS) return 1000;
  if (combo.type === TYPE.SFLUSH) return 30;
  if (combo.type !== TYPE.BOMB) return 0;
  if (combo.size <= 4) return 20;
  if (combo.size === 5) return 25;
  return 30 + (combo.size - 5) * 10;   // 6 张 40，7 张 50，8 张 60 …
}

/**
 * a 能否压过 b。b 为 null 表示这一轮由 a 领出，任意牌型都合法。
 * @returns {boolean}
 */
export function beats(a, b) {
  if (!a) return false;
  if (!b) return true;
  const ab = isBomb(a);
  const bb = isBomb(b);
  if (ab && bb) {
    const pa = bombPower(a);
    const pb = bombPower(b);
    if (pa !== pb) return pa > pb;
    return a.rank > b.rank;
  }
  if (ab) return true;
  if (bb) return false;
  if (a.type !== b.type || a.size !== b.size) return false;
  return a.rank > b.rank;
}

/**
 * 从一组选牌的所有解释里，挑出能压过 req 的那个。
 * 挑【最弱的合法解释】——比如 3♠4♠5♥6♠7♠（红桃5 是逢人配）既能当顺子也能当同花顺，
 * 跟牌时优先按顺子算，免得平白把一手同花顺当炸弹花掉。
 * @param {string[]} cards
 * @param {number} level
 * @param {object|null} req 需要压过的牌型
 * @returns {{type:string,rank:number,size:number}|null}
 */
export function pickPlay(cards, level, req) {
  const legal = interpret(cards, level).filter((c) => beats(c, req));
  if (!legal.length) return null;
  legal.sort((a, b) => {
    const d = (isBomb(a) ? bombPower(a) : -1) - (isBomb(b) ? bombPower(b) : -1);
    if (d !== 0) return d;
    return a.rank - b.rank;
  });
  return legal[0];
}

/** 领出时的默认解释：反过来取最强的，这样单独甩同花顺不会被降级成顺子 */
export function pickLead(cards, level) {
  const all = interpret(cards, level);
  if (!all.length) return null;
  all.sort((a, b) => {
    const d = (isBomb(b) ? bombPower(b) : -1) - (isBomb(a) ? bombPower(a) : -1);
    if (d !== 0) return d;
    return b.rank - a.rank;
  });
  return all[0];
}

/** 牌型的中文名，用于日志与提示 */
export function comboName(combo, level) {
  if (!combo) return '';
  if (combo.type === TYPE.JOKERS) return '天王炸';
  if (combo.type === TYPE.BOMB) return `${combo.size} 张炸弹`;
  const base = TYPE_CN[combo.type] || combo.type;
  let r;
  if (combo.rank === 17) r = '大王';
  else if (combo.rank === 16) r = '小王';
  else if (combo.rank === 15) r = `${levelName(level)}（级牌）`;
  else if (combo.rank === 1) r = 'A';
  else r = rankName(RANKS[combo.rank - 2] || String(combo.rank));
  return `${base} ${r}`;
}
