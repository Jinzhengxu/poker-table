// SPDX-License-Identifier: GPL-3.0-or-later
// 掼蛋：一局（一副牌）的状态机。
//
// 边界：这个类只管【一副牌】——发牌、进贡还贡、出牌轮转、算出名次。
// 升级、级数、座位、断线、计时器全在 room.js 里，engine 不认识 WebSocket 也不认识玩家。
//
// 座位固定 4 个：0/1/2/3 顺时针。0 与 2 一队，1 与 3 一队（对家是队友）。

import { randomInt } from 'node:crypto';
import {
  freshDeck, wildCard, powerValue, naturalValue, sortHand, cardName,
  interpret, beats, comboName, isBomb, JOKER_BIG,
} from '../../public/gd-combos.js';

/** 座位数 */
export const GD_SEATS = 4;

/** 每人手牌数：108 / 4 */
export const HAND_SIZE = 27;

/** 局面阶段 */
export const GD_PHASE = Object.freeze({
  TRIBUTE: 'tribute',   // 进贡已完成，等收贡方还贡
  PLAYING: 'playing',   // 正常出牌
  OVER: 'over',         // 本局结束
});

/** 座位 -> 队伍（0 或 1） */
export function teamOf(seat) {
  return seat % 2;
}

/** 座位 -> 对家（队友） */
export function partnerOf(seat) {
  return (seat + 2) % GD_SEATS;
}

/** 洗牌：Fisher-Yates + crypto.randomInt，和德州那边用的是同一套无偏做法 */
export function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    const tmp = deck[i];
    deck[i] = deck[j];
    deck[j] = tmp;
  }
  return deck;
}

/** 还贡牌上限：自然点数不超过 10 */
const RETURN_MAX = 10;

export class GuandanDeal {
  /**
   * @param {object} opts
   * @param {number} opts.level             本局打的级数 2..14
   * @param {number} [opts.firstSeat=0]     无进贡时的首出座位
   * @param {string[]} [opts.deck]          注入已洗好的牌堆（测试用），不传则内部洗
   * @param {object|null} [opts.tributePlan] 进贡方案，见 room.js #planTribute
   *        { double:boolean, payers:number[], receivers:number[], headSeat:number }
   */
  constructor(opts = {}) {
    this.level = opts.level ?? 2;
    this.wild = wildCard(this.level);

    /** @type {Map<number,string[]>} 座位 -> 手牌 */
    this.hands = new Map();
    /** @type {number[]} 出完牌的座位，按先后顺序 */
    this.finished = [];
    /** @type {number|null} 当前该出牌的座位 */
    this.turn = null;
    /** @type {{seat:number, combo:object, cards:string[]}|null} 当前需要压过的牌 */
    this.req = null;
    /** @type {Set<number>} 本轮已经"要不起"的座位 */
    this.passers = new Set();
    /** 本轮领出的座位 */
    this.leadSeat = null;
    /** @type {{type:string, seat:number|null, text:string, cards?:string[]}[]} */
    this.events = [];
    /** 本局结束后的名次（长度 4） */
    this.finishOrder = null;
    /** 本局最后一手牌（给前端展示"桌面上的牌"） */
    this.table = null;

    /** @type {{double:boolean, resisted:boolean, moves:{from:number,to:number,card:string}[],
     *          returns:{from:number,to:number,card:string|null}[]}} */
    this.tribute = { double: false, resisted: false, moves: [], returns: [] };

    const deck = Array.isArray(opts.deck) ? opts.deck.slice() : shuffle(freshDeck());
    if (deck.length < GD_SEATS * HAND_SIZE) throw new Error('牌堆不足 108 张');
    for (let s = 0; s < GD_SEATS; s++) {
      this.hands.set(s, deck.slice(s * HAND_SIZE, (s + 1) * HAND_SIZE));
    }
    this.#sortAll();
    this.#push('deal', null, `发牌完毕，本局打 ${cardName(this.wild).slice(1)}，逢人配是 ${cardName(this.wild)}`);

    const plan = opts.tributePlan || null;
    if (plan && plan.payers?.length) {
      this.phase = GD_PHASE.TRIBUTE;
      this.#runTribute(plan);
    } else {
      this.phase = GD_PHASE.PLAYING;
      this.leadSeat = this.turn = opts.firstSeat ?? 0;
    }
  }

  // ==================== 内部小工具 ====================

  #sortAll() {
    for (const [s, h] of this.hands) this.hands.set(s, sortHand(h, this.level));
  }

  #push(type, seat, text, cards) {
    this.events.push(cards ? { type, seat, text, cards } : { type, seat, text });
  }

  /** 还有手牌的座位 */
  activeSeats() {
    const out = [];
    for (let s = 0; s < GD_SEATS; s++) {
      if ((this.hands.get(s) || []).length > 0) out.push(s);
    }
    return out;
  }

  #nextActive(seat) {
    for (let i = 1; i <= GD_SEATS; i++) {
      const s = (seat + i) % GD_SEATS;
      if ((this.hands.get(s) || []).length > 0) return s;
    }
    return null;
  }

  get isComplete() {
    return this.phase === GD_PHASE.OVER;
  }

  // ==================== 进贡 / 还贡 ====================

  /**
   * 执行进贡。上贡是强制的（自动交出最大的一张，红桃级牌除外），
   * 还贡要玩家自己选，所以这里只做到"贡牌已经易手"，然后停在 TRIBUTE 阶段等还贡。
   */
  #runTribute(plan) {
    this.tribute.double = !!plan.double;

    // 抗贡：进贡方手里合计有两张大王，可以拒绝进贡
    const bigJokers = plan.payers.reduce(
      (n, s) => n + this.hands.get(s).filter((c) => c === JOKER_BIG).length, 0
    );
    if (bigJokers >= 2) {
      this.tribute.resisted = true;
      this.phase = GD_PHASE.PLAYING;
      this.leadSeat = this.turn = plan.headSeat;
      const who = plan.payers.map((s) => `${s + 1} 号`).join('、');
      this.#push('tribute', null, `${who}手握两张大王，抗贡成功，本局不进贡`);
      return;
    }

    // 每个进贡者交出最大的一张（不能贡逢人配）
    const picks = plan.payers.map((seat) => ({ seat, card: this.#tributeCardOf(seat) }));
    // 双下时贡牌大的那张给头游，小的给二游；一样大就按原顺序（三游在前）
    picks.sort((a, b) => powerValue(b.card, this.level) - powerValue(a.card, this.level));

    picks.forEach((pick, i) => {
      const to = plan.receivers[Math.min(i, plan.receivers.length - 1)];
      this.#move(pick.seat, to, pick.card);
      this.tribute.moves.push({ from: pick.seat, to, card: pick.card });
      this.tribute.returns.push({ from: to, to: pick.seat, card: null });
      this.#push('tribute', pick.seat, `${pick.seat + 1} 号向 ${to + 1} 号进贡 ${cardName(pick.card)}`);
    });

    // 进贡方先出牌，贡牌最大的那位打第一手；抗贡时才轮到上局头游
    this.leadSeat = this.turn = picks[0].seat;
    this.#sortAll();
  }

  /** 某座位该上贡哪张：比较点数最大的一张，逢人配除外 */
  #tributeCardOf(seat) {
    const hand = this.hands.get(seat);
    const usable = hand.filter((c) => c !== this.wild);
    const pool = usable.length ? usable : hand;   // 27 张全是逢人配不可能，兜底而已
    let best = pool[0];
    for (const c of pool) {
      if (powerValue(c, this.level) > powerValue(best, this.level)) best = c;
    }
    return best;
  }

  #move(from, to, card) {
    const src = this.hands.get(from);
    const i = src.indexOf(card);
    if (i < 0) return false;
    src.splice(i, 1);
    this.hands.get(to).push(card);
    return true;
  }

  /** 还贡候选：自然点数 ≤ 10 的牌；一张都没有时退化成全部手牌 */
  returnCandidates(seat) {
    const hand = this.hands.get(seat) || [];
    const ok = hand.filter((c) => naturalValue(c) <= RETURN_MAX);
    return ok.length ? ok : hand.slice();
  }

  /** 还贡还没还完的座位 */
  pendingReturns() {
    return this.tribute.returns.filter((r) => r.card === null).map((r) => r.from);
  }

  /**
   * 还贡。
   * @param {number} seat 收贡方座位
   * @param {string} card 要还回去的牌，必须是 returnCandidates 里的
   */
  returnTribute(seat, card) {
    if (this.phase !== GD_PHASE.TRIBUTE) {
      return { ok: false, msg: '现在不是还贡阶段' };
    }
    const entry = this.tribute.returns.find((r) => r.from === seat && r.card === null);
    if (!entry) return { ok: false, msg: '你不需要还贡' };
    if (!this.returnCandidates(seat).includes(card)) {
      return { ok: false, msg: `还贡只能还 10 以内的牌，${cardName(card)} 不行` };
    }
    this.#move(seat, entry.to, card);
    entry.card = card;
    this.#push('tribute', seat, `${seat + 1} 号还贡 ${cardName(card)} 给 ${entry.to + 1} 号`);
    this.#sortAll();
    if (!this.pendingReturns().length) {
      this.phase = GD_PHASE.PLAYING;
      this.#push('phase', null, `进贡结束，由 ${this.leadSeat + 1} 号先出牌`);
    }
    return { ok: true };
  }

  // ==================== 出牌 ====================

  /** 手牌里是否真的有这几张（按重复张数算） */
  #ownsAll(seat, cards) {
    const pool = [...(this.hands.get(seat) || [])];
    for (const c of cards) {
      const i = pool.indexOf(c);
      if (i < 0) return false;
      pool.splice(i, 1);
    }
    return true;
  }

  /**
   * 出牌。
   * @param {number} seat
   * @param {string[]} cards 选中的牌
   * @param {{type:string,rank:number,size:number}|null} [declared]
   *        逢人配可能有多种解释时，前端把想要的那种带上来；不带就自动选。
   */
  play(seat, cards, declared = null) {
    if (this.phase !== GD_PHASE.PLAYING) return { ok: false, msg: '现在不能出牌' };
    if (seat !== this.turn) return { ok: false, msg: '还没轮到你' };
    if (!Array.isArray(cards) || cards.length === 0) return { ok: false, msg: '没有选牌' };
    if (cards.length > HAND_SIZE) return { ok: false, msg: '选的牌太多了' };
    if (!this.#ownsAll(seat, cards)) return { ok: false, msg: '你手里没有这些牌' };

    const options = interpret(cards, this.level);
    if (!options.length) return { ok: false, msg: '这几张牌凑不成合法牌型' };

    let combo = null;
    if (declared) {
      combo = options.find(
        (c) => c.type === declared.type && c.rank === declared.rank && c.size === declared.size
      ) || null;
      if (!combo) return { ok: false, msg: '牌型对不上' };
      if (!beats(combo, this.req?.combo || null)) {
        return { ok: false, msg: `${comboName(combo, this.level)} 压不过上家` };
      }
    } else {
      const legal = options.filter((c) => beats(c, this.req?.combo || null));
      if (!legal.length) {
        return { ok: false, msg: this.req ? '压不过上家的牌' : '这几张牌凑不成合法牌型' };
      }
      // 跟牌取最弱的合法解释（别把同花顺当普通炸弹花掉），领出取最强
      legal.sort((a, b) => {
        const d = (isBomb(a) ? 1 : 0) - (isBomb(b) ? 1 : 0);
        if (d !== 0) return this.req ? d : -d;
        return this.req ? a.rank - b.rank : b.rank - a.rank;
      });
      combo = legal[0];
    }

    // 从手牌里扣掉
    const hand = this.hands.get(seat);
    for (const c of cards) hand.splice(hand.indexOf(c), 1);

    this.req = { seat, combo, cards: [...cards] };
    this.table = { seat, combo, cards: [...cards] };
    this.passers.clear();
    const bombTag = isBomb(combo) ? '💥 ' : '';
    this.#push('play', seat, `${bombTag}${seat + 1} 号出 ${comboName(combo, this.level)}`, [...cards]);

    if (hand.length === 0) {
      this.finished.push(seat);
      const place = ['头游', '二游', '三游'][this.finished.length - 1] || '';
      this.#push('finish', seat, `🎉 ${seat + 1} 号出完了，${place}`);
      if (this.#checkOver()) return { ok: true, combo };
    }

    this.turn = this.#nextActive(seat);
    return { ok: true, combo };
  }

  /** 要不起 */
  pass(seat) {
    if (this.phase !== GD_PHASE.PLAYING) return { ok: false, msg: '现在不能操作' };
    if (seat !== this.turn) return { ok: false, msg: '还没轮到你' };
    if (!this.req) return { ok: false, msg: '你是本轮第一个出牌的，必须出牌' };

    this.passers.add(seat);
    this.#push('pass', seat, `${seat + 1} 号要不起`);

    const others = this.activeSeats().filter((s) => s !== this.req.seat);
    if (others.every((s) => this.passers.has(s))) {
      this.#startNewTrick();
    } else {
      this.turn = this.#nextActive(seat);
    }
    return { ok: true };
  }

  /** 一轮打完：确定下一轮由谁领出（含"接风"） */
  #startNewTrick() {
    const winner = this.req.seat;
    const alive = new Set(this.activeSeats());
    let lead;
    if (alive.has(winner)) {
      lead = winner;
    } else {
      // 接风：出完牌的人这一轮没人管得住，轮空的牌权交给他的对家
      const mate = partnerOf(winner);
      if (alive.has(mate)) {
        lead = mate;
        this.#push('relay', mate, `${winner + 1} 号已走，${mate + 1} 号接风`);
      } else {
        lead = this.#nextActive(winner);
      }
    }
    this.req = null;
    this.passers.clear();
    this.table = null;
    this.leadSeat = this.turn = lead;
    this.#push('trick', lead, `新一轮，${lead + 1} 号先出`);
  }

  /**
   * 结束判定：3 人出完，或者同一队两人都出完（双下，立即结束）。
   * @returns {boolean} 是否已经结束
   */
  #checkOver() {
    const doubleOut =
      this.finished.length >= 2 && teamOf(this.finished[0]) === teamOf(this.finished[1]);
    if (this.finished.length < 3 && !doubleOut) return false;

    const rest = this.activeSeats();
    // 双下提前结束时还剩两个人：手上牌少的算三游
    rest.sort((a, b) => {
      const d = this.hands.get(a).length - this.hands.get(b).length;
      return d !== 0 ? d : a - b;
    });
    this.finishOrder = [...this.finished, ...rest];
    this.phase = GD_PHASE.OVER;
    this.turn = null;
    this.req = null;
    this.#push('over', null, `本局结束：${this.finishOrder.map((s) => `${s + 1} 号`).join(' → ')}`);
    return true;
  }

  /** 剩余张数快照，前端用来画别人手上还有几张 */
  counts() {
    const out = new Array(GD_SEATS).fill(0);
    for (let s = 0; s < GD_SEATS; s++) out[s] = (this.hands.get(s) || []).length;
    return out;
  }
}
