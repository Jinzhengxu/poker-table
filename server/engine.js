// SPDX-License-Identifier: GPL-3.0-or-later
// server/engine.js —— 单手牌状态机（无限注德州扑克）
//
// 本模块只负责「一手牌」：盲注/前注、四条街下注轮、边池分层、摊牌比牌与分配。
// 不涉及 WebSocket、计时器、持久玩家（那些是 room.js 的职责）。
//
// 几个本文件定下的约定（SPEC 未明确规定，其他模块请以此为准）：
//   1. 发底牌顺序：从「按钮左手第一位」开始按座位号顺时针轮流发，一人一张，共发两轮。
//      因此注入牌堆的前 2N 张是底牌（第 1..N 张是每人的第一张，第 N+1..2N 张是第二张），
//      紧接着 3 张翻牌、1 张转牌、1 张河牌。**不烧牌**。
//   2. 事件/lastAction 中的 amount：
//        bet / raise / allin -> 该玩家本轮的**总投入额**（TO 语义，和 legalActions 的
//                               minRaiseTo/maxRaiseTo 一致）
//        call               -> 本次**额外投入**的增量（和 legalActions.callAmount 一致）
//        fold / check       -> 0
//   3. result.payouts 含「退还的未被跟注部分」（见 SPEC §6 对该字段的说明），
//      而 result.winners[].amount 只统计真正从底池赢取的部分，两者相差即 uncalledReturned。
//      恒等式：sum(payouts) === sum(pots) + (uncalledReturned?.amount ?? 0) === 全部投入总额。

import { PHASES, DEFAULT_CONFIG, MAX_SEATS } from './protocol.js';
import { evaluate, compareHands } from './evaluator.js';
import { freshDeck, shuffle } from './deck.js';

/** 玩家展示名（昵称为空时退化为座位号） */
function nameOf(p) {
  return p.name && String(p.name).length > 0 ? p.name : `座位${p.seat}`;
}

const SUIT_GLYPH = { c: '♣', d: '♦', h: '♥', s: '♠' };

/** 把 "Td" 这类内部牌码转成给人看的 "10♦"，用于牌局日志 */
function fmtCard(card) {
  if (typeof card !== 'string' || card.length < 2) return String(card ?? '');
  const rank = card[0] === 'T' ? '10' : card[0];
  return rank + (SUIT_GLYPH[card[1]] || card[1]);
}

/** 多张牌用空格连起来 */
function fmtCards(cards) {
  return (Array.isArray(cards) ? cards : []).map(fmtCard).join(' ');
}

/** 两个已排序的座位数组是否相同 */
function sameSeats(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export class Hand {
  /**
   * @param {object} opts
   * @param {{seat:number,name:string,chips:number}[]} opts.players 参与本手牌的玩家（筹码需 > 0）
   * @param {{smallBlind:number,bigBlind:number,ante:number}} opts.config
   * @param {number} opts.buttonSeat 按钮座位（必须是 players 中某个 seat）
   * @param {string[]} [opts.deck] 注入的已洗好牌堆（测试用），不传则内部 freshDeck + shuffle
   * @param {number} [opts.handNo] 手牌编号
   */
  constructor(opts = {}) {
    const list = opts.players;
    if (!Array.isArray(list) || list.length < 2) {
      throw new Error('至少需要 2 名玩家才能开始一手牌');
    }
    const c = opts.config || {};
    this.config = {
      smallBlind: Number(c.smallBlind ?? DEFAULT_CONFIG.smallBlind),
      bigBlind: Number(c.bigBlind ?? DEFAULT_CONFIG.bigBlind),
      ante: Number(c.ante ?? 0)
    };
    if (!(this.config.bigBlind > 0)) throw new Error('大盲注必须大于 0');

    this._handNo = opts.handNo ?? 0;
    this._players = new Map();
    this._seats = [];
    for (const raw of list) {
      const seat = raw.seat;
      if (!Number.isInteger(seat) || seat < 0 || seat >= MAX_SEATS) {
        throw new Error(`非法座位号: ${seat}`);
      }
      if (this._players.has(seat)) throw new Error(`座位 ${seat} 重复`);
      const chips = raw.chips;
      if (!Number.isInteger(chips) || chips <= 0) {
        throw new Error(`座位 ${seat} 的筹码必须是正整数`);
      }
      this._players.set(seat, {
        seat,
        name: raw.name ?? '',
        chips,
        startingChips: chips,
        holeCards: [],
        folded: false,
        allIn: false,
        committedRound: 0,
        committedTotal: 0,
        hasActed: false,
        lastAction: null,
        // 内部字段：因「不足一次完整加注的全下」而被剥夺加注权
        raiseBlocked: false
      });
      this._seats.push(seat);
    }
    this._seats.sort((a, b) => a - b);

    this._buttonSeat = opts.buttonSeat;
    if (!this._players.has(this._buttonSeat)) {
      throw new Error('按钮座位必须是参与本手牌的玩家之一');
    }

    this._deck = Array.isArray(opts.deck) ? opts.deck.slice() : shuffle(freshDeck());
    this._deckIndex = 0;
    this._board = [];
    this._events = [];

    this._phase = PHASES.PREFLOP;
    this._currentBet = 0;
    this._lastRaiseSize = this.config.bigBlind;
    this._actingSeat = null;
    this._complete = false;
    this._result = null;
    this._finalPots = null;
    this._refunds = new Map();      // seat -> 退还总额
    this._uncalled = null;          // { seat, amount }

    // 位置：单挑时按钮即小盲
    if (this._seats.length === 2) {
      this._sbSeat = this._buttonSeat;
      this._bbSeat = this._nextSeat(this._buttonSeat);
    } else {
      this._sbSeat = this._nextSeat(this._buttonSeat);
      this._bbSeat = this._nextSeat(this._sbSeat);
    }

    this._begin();
  }

  // ---------------------------------------------------------------- 只读接口

  get phase() { return this._phase; }
  get isComplete() { return this._complete; }
  get actingSeat() { return this._actingSeat; }
  get board() { return this._board.slice(); }
  get handNo() { return this._handNo; }
  /** Map<seat, 运行时玩家数据>（只读用途，请勿修改） */
  get players() { return this._players; }
  get events() { return this._events; }
  get result() { return this._result; }

  // 额外暴露的位置信息（room.js 生成快照的 isButton/isSB/isBB 用得上）
  get buttonSeat() { return this._buttonSeat; }
  get sbSeat() { return this._sbSeat; }
  get bbSeat() { return this._bbSeat; }

  /** 当前底池结构：[{amount, eligibleSeats}]，主池在前。本轮尚未归池的筹码不计入。 */
  get pots() {
    if (this._finalPots) return this._finalPots.map((p) => ({ amount: p.amount, eligibleSeats: p.eligibleSeats.slice() }));
    return this._computePots();
  }

  /** 所有 pots 之和 + 本轮已投入但尚未归池的筹码 */
  get totalPot() {
    let sum = 0;
    for (const pot of this.pots) sum += pot.amount;
    for (const p of this._players.values()) sum += p.committedRound;
    return sum;
  }

  get currentBet() { return this._currentBet; }

  /** 合法的最小「加注到」金额（TO 语义） */
  get minRaiseTo() {
    const base = this._currentBet + this._lastRaiseSize;
    if (this._phase === PHASES.PREFLOP) return Math.max(base, this.config.bigBlind * 2);
    return base;
  }

  // ---------------------------------------------------------------- 座位工具

  /** 顺时针方向的下一个参与座位 */
  _nextSeat(seat) {
    const n = this._seats.length;
    let idx = this._seats.indexOf(seat);
    if (idx < 0) {
      // seat 不在牌局中：取第一个比它大的座位（环绕）
      idx = this._seats.findIndex((s) => s > seat);
      return idx < 0 ? this._seats[0] : this._seats[idx];
    }
    return this._seats[(idx + 1) % n];
  }

  /** 从 startSeat（含）开始顺时针的全部座位 */
  _orderFrom(startSeat) {
    const n = this._seats.length;
    let idx = this._seats.indexOf(startSeat);
    if (idx < 0) idx = 0;
    const out = [];
    for (let i = 0; i < n; i++) out.push(this._seats[(idx + i) % n]);
    return out;
  }

  /** 按「按钮左手第一位」起的顺序排列给定座位集合（分零头、摊牌展示用） */
  _orderByButton(seats) {
    const order = this._orderFrom(this._nextSeat(this._buttonSeat));
    return order.filter((s) => seats.includes(s));
  }

  /** 未弃牌的座位 */
  _aliveSeats() {
    const out = [];
    for (const seat of this._seats) if (!this._players.get(seat).folded) out.push(seat);
    return out;
  }

  /** 仍可以行动的玩家（未弃牌、未全下、还有筹码） */
  _actors() {
    const out = [];
    for (const p of this._players.values()) if (!p.folded && !p.allIn && p.chips > 0) out.push(p);
    return out;
  }

  // ---------------------------------------------------------------- 开局

  _draw() {
    if (this._deckIndex >= this._deck.length) throw new Error('牌堆已耗尽');
    return this._deck[this._deckIndex++];
  }

  /**
   * @param {object} [extra] 追加字段。action 事件用它带上具体动作类型
   *   （`type`: fold/check/call/bet/raise/allin），前端只用 text，
   *   但人机需要结构化的行动历史，从 text 反解中文太脆。
   */
  _pushEvent(kind, seat, amount, text, extra) {
    const ev = { kind, text };
    if (seat !== null && seat !== undefined) ev.seat = seat;
    if (amount !== null && amount !== undefined) ev.amount = amount;
    if (extra) Object.assign(ev, extra);
    this._events.push(ev);
    return ev;
  }

  /**
   * 投入筹码。
   * @param countInRound false 表示前注：进池但不算作本轮下注额
   */
  _commit(p, amount, countInRound = true) {
    const amt = Math.min(amount, p.chips);
    if (amt <= 0) return 0;
    p.chips -= amt;
    p.committedTotal += amt;
    if (countInRound) p.committedRound += amt;
    if (p.chips <= 0) {
      p.chips = 0;
      p.allIn = true;
    }
    return amt;
  }

  _begin() {
    const { ante, smallBlind, bigBlind } = this.config;

    // 前注：从按钮左手第一位开始收，直接入池（不计入本轮下注额）
    if (ante > 0) {
      for (const seat of this._orderFrom(this._nextSeat(this._buttonSeat))) {
        const p = this._players.get(seat);
        const paid = this._commit(p, ante, false);
        if (paid > 0) this._pushEvent('ante', seat, paid, `${nameOf(p)} 前注 ${paid}`);
      }
    }

    // 盲注（不足则全下，不视为加注）
    const sb = this._players.get(this._sbSeat);
    const sbPaid = this._commit(sb, smallBlind);
    if (sbPaid > 0) this._pushEvent('blind', sb.seat, sbPaid, `${nameOf(sb)} 下小盲 ${sbPaid}`);
    const bb = this._players.get(this._bbSeat);
    const bbPaid = this._commit(bb, bigBlind);
    if (bbPaid > 0) this._pushEvent('blind', bb.seat, bbPaid, `${nameOf(bb)} 下大盲 ${bbPaid}`);

    this._currentBet = 0;
    for (const p of this._players.values()) {
      if (p.committedRound > this._currentBet) this._currentBet = p.committedRound;
    }
    this._lastRaiseSize = bigBlind;

    // 发底牌：从按钮左手第一位开始，一人一张，发两轮
    const dealOrder = this._orderFrom(this._nextSeat(this._buttonSeat));
    for (let round = 0; round < 2; round++) {
      for (const seat of dealOrder) this._players.get(seat).holeCards.push(this._draw());
    }
    this._pushEvent('deal', null, null, '发底牌');

    // 翻牌前从大盲左手第一位开始行动（单挑时该位置即按钮/小盲）
    this._progress(this._nextSeat(this._bbSeat));
  }

  // ---------------------------------------------------------------- 下注轮流转

  _needsAction(p) {
    if (p.folded || p.allIn || p.chips <= 0) return false;
    return !p.hasActed || p.committedRound < this._currentBet;
  }

  /** 本轮下注是否结束 */
  _roundComplete() {
    const actors = this._actors();
    if (actors.length === 0) return true;
    if (actors.length === 1) {
      // 只剩一个人能行动：他已跟平最高注就无需再行动（其余人全下或弃牌）
      return actors[0].committedRound === this._currentBet;
    }
    return actors.every((p) => p.hasActed && p.committedRound === this._currentBet);
  }

  /** 从 startSeat（含）起找第一个需要行动的玩家 */
  _findNext(startSeat) {
    for (const seat of this._orderFrom(startSeat)) {
      if (this._needsAction(this._players.get(seat))) return seat;
    }
    return null;
  }

  /** 推进牌局：结束/换街/换人 */
  _progress(startSeat) {
    if (this._complete) return;
    if (this._aliveSeats().length <= 1) {
      this._finishHand();
      return;
    }
    if (this._roundComplete()) {
      this._endBettingRound();
      return;
    }
    const seat = this._findNext(startSeat);
    if (seat === null) {
      this._endBettingRound();
      return;
    }
    this._actingSeat = seat;
  }

  /** 归池：退还未被跟注的部分，然后清空本轮投入 */
  _collectRound() {
    const arr = [...this._players.values()];
    let topAmt = -1;
    let secondAmt = -1;
    let top = null;
    for (const p of arr) {
      if (p.committedTotal > topAmt) {
        secondAmt = topAmt;
        topAmt = p.committedTotal;
        top = p;
      } else if (p.committedTotal > secondAmt) {
        secondAmt = p.committedTotal;
      }
    }
    // 唯一的最高投入者（且未弃牌）超出第二高的部分没人跟 -> 原样退还
    if (top && !top.folded && topAmt > secondAmt && secondAmt >= 0) {
      const back = topAmt - secondAmt;
      top.chips += back;
      top.committedTotal -= back;
      top.committedRound = Math.max(0, top.committedRound - back);
      if (top.chips > 0) top.allIn = false; // 退还后又有筹码了
      const total = (this._refunds.get(top.seat) || 0) + back;
      this._refunds.set(top.seat, total);
      this._uncalled = { seat: top.seat, amount: total };
      this._pushEvent('return', top.seat, back, `${nameOf(top)} 收回未被跟注的 ${back}`);
    }
    for (const p of arr) p.committedRound = 0;
  }

  /** 新一条街的下注轮初始化 */
  _resetRound() {
    this._currentBet = 0;
    this._lastRaiseSize = this.config.bigBlind;
    for (const p of this._players.values()) {
      p.committedRound = 0;
      p.hasActed = false;
      p.raiseBlocked = false;
      p.lastAction = null;
    }
  }

  /** 发下一条街的公共牌 */
  _dealStreet() {
    if (this._phase === PHASES.PREFLOP) {
      const cards = [this._draw(), this._draw(), this._draw()];
      this._board.push(...cards);
      this._phase = PHASES.FLOP;
      this._pushEvent('flop', null, null, `翻牌 ${fmtCards(cards)}`);
    } else if (this._phase === PHASES.FLOP) {
      const card = this._draw();
      this._board.push(card);
      this._phase = PHASES.TURN;
      this._pushEvent('turn', null, null, `转牌 ${fmtCard(card)}`);
    } else if (this._phase === PHASES.TURN) {
      const card = this._draw();
      this._board.push(card);
      this._phase = PHASES.RIVER;
      this._pushEvent('river', null, null, `河牌 ${fmtCard(card)}`);
    }
  }

  /** 本轮下注结束：归池并推进到下一条街（若无人需要行动就一路发到河牌） */
  _endBettingRound() {
    this._actingSeat = null;
    this._collectRound();
    while (!this._complete) {
      if (this._aliveSeats().length <= 1) {
        this._finishHand();
        return;
      }
      if (this._phase === PHASES.RIVER) {
        this._finishHand();
        return;
      }
      this._dealStreet();
      this._resetRound();
      if (this._roundComplete()) {
        // 全下跑马：没人需要行动，继续发下一条街
        this._collectRound();
        continue;
      }
      // 翻牌后从按钮左手第一位（还在牌里的）开始
      const seat = this._findNext(this._nextSeat(this._buttonSeat));
      if (seat === null) {
        this._collectRound();
        continue;
      }
      this._actingSeat = seat;
      return;
    }
  }

  // ---------------------------------------------------------------- 底池

  /** 按 committedTotal 分层生成底池（只统计已归池部分） */
  _computePots() {
    const contrib = [];
    for (const p of this._players.values()) {
      contrib.push({ seat: p.seat, amount: p.committedTotal - p.committedRound, folded: p.folded });
    }
    const levels = [...new Set(contrib.filter((c) => c.amount > 0).map((c) => c.amount))].sort((a, b) => a - b);
    const pots = [];
    let prev = 0;
    let carry = 0; // 还没有任何池可以归属的死钱（弃牌者留下的）
    for (const lv of levels) {
      let amount = 0;
      const eligible = [];
      for (const c of contrib) {
        if (c.amount >= lv) {
          amount += lv - prev;
          if (!c.folded) eligible.push(c.seat);
        }
      }
      prev = lv;
      if (amount <= 0) continue;
      eligible.sort((a, b) => a - b);
      const last = pots[pots.length - 1];
      if (eligible.length === 0) {
        // 该层全是弃牌者的死钱：并入上一个池；还没有池就先攒着
        if (last) last.amount += amount;
        else carry += amount;
        continue;
      }
      amount += carry;
      carry = 0;
      if (last && sameSeats(last.eligibleSeats, eligible)) {
        last.amount += amount;
      } else {
        pots.push({ amount, eligibleSeats: eligible });
      }
    }
    if (carry > 0) {
      // 全部投入都来自弃牌者（例如没投过筹码的玩家赢下盲注）
      pots.push({ amount: carry, eligibleSeats: this._aliveSeats() });
    }
    return pots;
  }

  // ---------------------------------------------------------------- 结算

  _finishHand() {
    this._collectRound();
    this._actingSeat = null;

    const alive = this._aliveSeats();
    // 保险：多人未弃牌但公共牌没发完（全下跑马）时补齐
    if (alive.length > 1) {
      while (this._board.length < 5) this._dealStreet();
    }

    const pots = this._computePots();
    this._finalPots = pots.map((p) => ({ amount: p.amount, eligibleSeats: p.eligibleSeats.slice() }));

    const winnings = new Map();
    const winners = [];
    let showdown = [];
    const wentToShowdown = alive.length > 1;

    pots.forEach((pot, i) => {
      const label = i === 0 ? '主池' : `边池${i}`;
      this._pushEvent('pot', null, pot.amount, `${label} ${pot.amount}`);
    });

    if (!wentToShowdown) {
      // 只剩一人：不摊牌、不揭示底牌，直接收池
      const seat = alive[0];
      if (seat === undefined) {
        // 防御分支：理论上不会出现（最后一个还在牌里的玩家不会被弃掉）。
        // 万一发生，原样退还各自投入以保证筹码守恒。
        for (const p of this._players.values()) {
          if (p.committedTotal > 0) winnings.set(p.seat, p.committedTotal);
        }
      } else {
        pots.forEach((pot, i) => {
          winnings.set(seat, (winnings.get(seat) || 0) + pot.amount);
          winners.push({
            seat, amount: pot.amount, potIndex: i,
            handName: null, handNameEn: null, handRank: null, best: null
          });
        });
      }
    } else {
      const evals = new Map();
      for (const seat of alive) {
        const p = this._players.get(seat);
        evals.set(seat, evaluate([...p.holeCards, ...this._board]));
      }
      showdown = this._orderByButton(alive).map((seat) => {
        const p = this._players.get(seat);
        const e = evals.get(seat);
        return {
          seat,
          cards: p.holeCards.slice(),
          handName: e.name,
          handNameEn: e.nameEn,
          handRank: e.cat,
          best: e.best.slice(),
          score: e.score
        };
      });
      for (const s of showdown) {
        const p = this._players.get(s.seat);
        this._pushEvent('showdown', s.seat, null, `${nameOf(p)} 亮牌 ${fmtCards(s.cards)}（${s.handName}）`);
      }

      pots.forEach((pot, i) => {
        const contenders = pot.eligibleSeats.filter((s) => evals.has(s));
        if (contenders.length === 0) return;
        let best = [contenders[0]];
        for (let k = 1; k < contenders.length; k++) {
          const cmp = compareHands(evals.get(contenders[k]), evals.get(best[0]));
          if (cmp > 0) best = [contenders[k]];
          else if (cmp === 0) best.push(contenders[k]);
        }
        // 零头从按钮左手第一位开始依次多分 1 枚
        const ordered = this._orderByButton(best);
        const base = Math.floor(pot.amount / ordered.length);
        const rem = pot.amount - base * ordered.length;
        ordered.forEach((seat, idx) => {
          const amount = base + (idx < rem ? 1 : 0);
          if (amount <= 0) return;
          winnings.set(seat, (winnings.get(seat) || 0) + amount);
          const e = evals.get(seat);
          winners.push({
            seat, amount, potIndex: i,
            handName: e.name, handNameEn: e.nameEn, handRank: e.cat, best: e.best.slice()
          });
        });
      });
    }

    // 派彩
    for (const [seat, amount] of winnings) {
      const p = this._players.get(seat);
      p.chips += amount;
      this._pushEvent(
        'win',
        seat,
        amount,
        wentToShowdown
          ? `${nameOf(p)} 赢得 ${amount}`
          : `${nameOf(p)} 赢得 ${amount}（其他人已弃牌）`
      );
    }

    const payouts = {};
    const chipsAfter = {};
    for (const p of this._players.values()) {
      const won = winnings.get(p.seat) || 0;
      const back = this._refunds.get(p.seat) || 0;
      if (won + back > 0) payouts[p.seat] = won + back;
      chipsAfter[p.seat] = p.chips;
    }

    this._result = {
      payouts,
      chipsAfter,
      winners,
      showdown,
      uncalledReturned: this._uncalled ? { ...this._uncalled } : null,
      wentToShowdown
    };
    this._phase = PHASES.HAND_OVER;
    this._complete = true;
  }

  // ---------------------------------------------------------------- 动作

  /**
   * @returns {null|{canFold:boolean,canCheck:boolean,canCall:boolean,callAmount:number,
   *                 canBet:boolean,minBet:number,canRaise:boolean,minRaiseTo:number,
   *                 maxRaiseTo:number,isAllInCall:boolean}}
   */
  legalActions(seat) {
    if (this._complete) return null;
    if (this._actingSeat === null || this._actingSeat !== seat) return null;
    const p = this._players.get(seat);
    if (!p || p.folded || p.allIn || p.chips <= 0) return null;

    const toCall = Math.max(0, this._currentBet - p.committedRound);
    const callAmount = Math.min(toCall, p.chips);
    const maxRaiseTo = p.committedRound + p.chips;
    // 是否还有对手能对下注做出反应（都全下了就不能再加注）
    const opponentsCanAct = this._actors().some((o) => o.seat !== seat);
    const minRaiseTo = this.minRaiseTo;

    return {
      canFold: true,
      canCheck: toCall === 0,
      canCall: toCall > 0 && p.chips > 0,
      callAmount,
      canBet: this._currentBet === 0 && p.chips > 0 && opponentsCanAct,
      minBet: Math.min(this.config.bigBlind, maxRaiseTo),
      canRaise: this._currentBet > 0 && !p.raiseBlocked && opponentsCanAct && maxRaiseTo >= minRaiseTo,
      minRaiseTo,
      maxRaiseTo,
      isAllInCall: toCall > 0 && p.chips <= toCall
    };
  }

  /**
   * 执行一个动作。非法动作不改变任何状态。
   * @param {number} seat
   * @param {{type:string, amount?:number}} action
   * @returns {{ok:true, events:object[]}|{ok:false, error:string}}
   */
  act(seat, action) {
    if (this._complete) return { ok: false, error: '本手牌已结束' };
    const p = this._players.get(seat);
    if (!p) return { ok: false, error: '该座位不在本手牌中' };
    if (this._actingSeat !== seat) return { ok: false, error: '现在不是你的行动回合' };
    const legal = this.legalActions(seat);
    if (!legal) return { ok: false, error: '现在不是你的行动回合' };

    const type = action && action.type;
    const amount = action && action.amount;
    const mark = this._events.length;

    switch (type) {
      case 'fold': {
        p.folded = true;
        p.hasActed = true;
        p.lastAction = { type: 'fold', amount: 0 };
        this._pushEvent('action', seat, 0, `${nameOf(p)} 弃牌`, { type: 'fold' });
        break;
      }
      case 'check': {
        if (!legal.canCheck) return { ok: false, error: '当前有下注，不能过牌' };
        p.hasActed = true;
        p.lastAction = { type: 'check', amount: 0 };
        this._pushEvent('action', seat, 0, `${nameOf(p)} 过牌`, { type: 'check' });
        break;
      }
      case 'call': {
        if (!legal.canCall) return { ok: false, error: '当前无需跟注，可以过牌' };
        const paid = this._commit(p, legal.callAmount);
        p.hasActed = true;
        p.lastAction = { type: 'call', amount: paid };
        this._pushEvent('action', seat, paid, `${nameOf(p)} 跟注 ${paid}`, { type: 'call' });
        break;
      }
      case 'bet': {
        if (this._currentBet !== 0) return { ok: false, error: '本轮已有下注，请使用加注' };
        if (!legal.canBet) return { ok: false, error: '当前不能下注' };
        if (!Number.isInteger(amount)) return { ok: false, error: '下注金额必须是整数' };
        if (amount < legal.minBet) return { ok: false, error: `下注不能少于 ${legal.minBet}` };
        if (amount > legal.maxRaiseTo) return { ok: false, error: '下注金额超过你的筹码' };
        this._applyAggression(p, amount, 'bet');
        break;
      }
      case 'raise': {
        if (this._currentBet === 0) return { ok: false, error: '本轮尚无下注，请使用下注' };
        if (p.raiseBlocked) return { ok: false, error: '本轮加注权未被重开，只能跟注或弃牌' };
        if (!legal.canRaise) return { ok: false, error: '筹码不足以完成最小加注，只能跟注或全下' };
        if (!Number.isInteger(amount)) return { ok: false, error: '加注金额必须是整数' };
        if (amount < legal.minRaiseTo) return { ok: false, error: `加注至少要到 ${legal.minRaiseTo}` };
        if (amount > legal.maxRaiseTo) return { ok: false, error: '加注金额超过你的筹码' };
        this._applyAggression(p, amount, 'raise');
        break;
      }
      case 'allin': {
        if (p.chips <= 0) return { ok: false, error: '你已经没有筹码了' };
        const to = p.committedRound + p.chips;
        if (to <= this._currentBet) {
          // 筹码不够跟注：全下当作跟注
          this._commit(p, p.chips);
          p.hasActed = true;
          p.lastAction = { type: 'allin', amount: p.committedRound };
          this._pushEvent('action', seat, p.committedRound, `${nameOf(p)} 全下 ${p.committedRound}`, { type: 'allin' });
        } else {
          this._applyAggression(p, to, 'allin');
        }
        break;
      }
      default:
        return { ok: false, error: '未知的动作类型' };
    }

    this._progress(this._nextSeat(seat));
    return { ok: true, events: this._events.slice(mark) };
  }

  /**
   * 主动加注/下注的统一处理。
   * @param {number} to 本轮总投入额（TO 语义）
   */
  _applyAggression(p, to, kind) {
    const prevBet = this._currentBet;
    const minRaiseTo = this.minRaiseTo;
    const isFullRaise = to >= minRaiseTo;
    const delta = to - p.committedRound;
    this._commit(p, delta);
    p.hasActed = true;

    if (to > prevBet) {
      this._currentBet = to;
      if (isFullRaise) {
        // 完整加注：重开所有人的加注权
        this._lastRaiseSize = to - prevBet;
        for (const o of this._players.values()) o.raiseBlocked = false;
      } else {
        // 不足一次完整加注的全下：不重开已行动玩家的加注权
        for (const o of this._players.values()) {
          if (o.seat !== p.seat && o.hasActed) o.raiseBlocked = true;
        }
      }
    }

    const allIn = p.allIn;
    p.lastAction = { type: allIn ? 'allin' : kind, amount: p.committedRound };
    let text;
    if (allIn) text = `${nameOf(p)} 全下 ${p.committedRound}`;
    else if (kind === 'bet') text = `${nameOf(p)} 下注 ${p.committedRound}`;
    else text = `${nameOf(p)} 加注到 ${p.committedRound}`;
    this._pushEvent('action', p.seat, p.committedRound, text, { type: p.lastAction.type });
  }

  /** 超时自动动作：能过牌就过牌，否则弃牌 */
  timeoutAction(seat) {
    const legal = this.legalActions(seat);
    if (!legal) return { ok: false, error: '现在不是该座位的行动回合' };
    return legal.canCheck ? this.act(seat, { type: 'check' }) : this.act(seat, { type: 'fold' });
  }

  /** 断线/离桌：等价于自动弃牌（可在非其回合时调用） */
  forceFold(seat) {
    if (this._complete) return { ok: false, error: '本手牌已结束' };
    const p = this._players.get(seat);
    if (!p) return { ok: false, error: '该座位不在本手牌中' };
    if (p.folded) return { ok: true, events: [] };
    // 全下的玩家没有可弃的筹码，保持在牌局中直到摊牌
    if (p.allIn) return { ok: true, events: [] };
    // 防御：最后一个还在牌里的玩家不弃牌（他直接收池）
    if (this._aliveSeats().length <= 1) return { ok: true, events: [] };
    if (this._actingSeat === seat) return this.act(seat, { type: 'fold' });

    const mark = this._events.length;
    p.folded = true;
    p.hasActed = true;
    p.lastAction = { type: 'fold', amount: 0 };
    this._pushEvent('action', seat, 0, `${nameOf(p)} 弃牌`, { type: 'fold' });
    this._progress(this._actingSeat !== null ? this._actingSeat : this._nextSeat(seat));
    return { ok: true, events: this._events.slice(mark) };
  }
}

export default Hand;
