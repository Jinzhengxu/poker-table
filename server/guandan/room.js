// SPDX-License-Identifier: GPL-3.0-or-later
// 掼蛋房间：座位、令牌、断线重连、计时器、升级与状态快照下发。
//
// 和德州那张桌子完全独立：另一个 WebSocket 路径、另一份内存状态，互不影响。
// Room 不认识 WebSocket，只认识 { send(obj), close(), playerId } 这样的"客户端"对象。
//
// 队伍：座位 0/2 一队（红队），1/3 一队（蓝队）。对家就是队友。

import { randomBytes, randomInt } from 'node:crypto';
import { GuandanDeal, GD_PHASE, GD_SEATS, teamOf, partnerOf } from './engine.js';
import { choosePlay } from '../../public/gd-hints.js';
import { comboName, cardName, levelName, wildCard, sortHand } from '../../public/gd-combos.js';
import { makeAvatar } from '../room.js';
import { VoiceChannel } from '../voice.js';

const MAX_LOG = 40;
const MAX_CHAT = 50;
/** 断线后保留座位的时长 */
const DISCONNECT_GRACE_MS = 15 * 60 * 1000;
/** 人机"思考"时间，纯粹是为了别瞬间出牌看着吓人 */
const BOT_DELAY_MS = [900, 2200];

export const DEFAULT_GD_CONFIG = Object.freeze({
  actionTimeoutMs: 40000,
  autoNextDeal: true,
  autoNextDealMs: 8000,
});

const TEAM_NAME = ['红队', '蓝队'];
const PLACE_NAME = ['头游', '二游', '三游', '末游'];

const BOT_NAMES = ['小贡', '阿炸', '老连', '钢板哥', '接风侠', '逢人配', '大王杯', '不出手'];

function newToken() {
  return randomBytes(16).toString('hex');
}

function clampInt(v, lo, hi) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return null;
  if (n < lo || n > hi) return null;
  return n;
}

export class GuandanRoom {
  constructor(opts = {}) {
    this.config = { ...DEFAULT_GD_CONFIG, ...(opts.config || {}) };

    /** 座位 -> playerId */
    this.seats = new Array(GD_SEATS).fill(null);
    this.players = new Map();
    this.tokens = new Map();
    this.clients = new Set();

    /** 两队当前打到几（2..14，14 就是 A） */
    this.levels = [2, 2];
    /** 本局由哪一队"坐庄"——打的是这一队的级 */
    this.dealingTeam = 0;
    /** 打 A 失败次数，各队独立，攒够 3 次退回打 2 */
    this.aFail = [0, 0];

    /** @type {GuandanDeal|null} */
    this.deal = null;
    /** 本局开局时 座位 -> playerId 的绑定。本局结束后有人离座、新人坐进同一个
     *  座位时，靠它认出"这手牌不是你的"，别把上一位玩家的剩牌当成新人的手牌发过去。 */
    this.dealSeatOwners = new Map();
    this.dealNo = 0;
    this.eventCursor = 0;
    /** 上一局的名次，用来算下一局进贡 */
    this.lastFinishOrder = null;
    /** @type {object|null} 上一局结算 */
    this.result = null;
    /** @type {object|null} 整场比赛的结果（有人过 A） */
    this.matchOver = null;

    this.actionTimer = null;
    this.actionDeadline = null;
    this.nextDealTimer = null;
    this.nextDealAt = null;
    this.botTimer = null;

    this.log = [];
    this.chat = [];

    /** 这张桌子的语音频道。和德州那张桌子的完全是两份，声音不会串过去。 */
    this.voice = new VoiceChannel(this, { label: '掼蛋语音', ...(opts.voice || {}) });
  }

  // ==================== 连接与身份 ====================

  attach(client) {
    client.playerId = null;
    this.clients.add(client);
  }

  detach(client) {
    this.clients.delete(client);
    const p = client.playerId ? this.players.get(client.playerId) : null;
    client.playerId = null;
    if (!p) return;
    if (this.#hasClient(p.id)) return;
    // 人走了，麦也得下——他那些 WebRTC 连接已经跟着页面一起没了
    this.voice.remove(p.id);
    p.connected = false;
    if (p.seat === null) {
      this.#deletePlayer(p);
    } else {
      this.#clearDropTimer(p);
      p.dropTimer = setTimeout(() => this.#dropDisconnected(p.id), DISCONNECT_GRACE_MS);
      p.dropTimer.unref?.();
    }
    this.broadcast();
  }

  #hasClient(playerId) {
    for (const c of this.clients) if (c.playerId === playerId) return true;
    return false;
  }

  #clearDropTimer(p) {
    if (p.dropTimer) {
      clearTimeout(p.dropTimer);
      p.dropTimer = null;
    }
  }

  #dropDisconnected(playerId) {
    const p = this.players.get(playerId);
    if (!p || p.connected || p.seat === null) return;
    p.dropTimer = null;
    this.#pushLog(`${p.name} 长时间掉线，已自动离座`);
    this.#vacate(p);
    this.broadcast();
  }

  #deletePlayer(p) {
    this.#clearDropTimer(p);
    this.voice.remove(p.id);
    this.players.delete(p.id);
    this.tokens.delete(p.token);
  }

  #newPlayer(isBot = false) {
    let id;
    do {
      id = (isBot ? 'b_' : 'p_') + randomBytes(3).toString('hex');
    } while (this.players.has(id));
    const p = {
      id,
      token: newToken(),
      seat: null,
      name: '',
      avatar: null,
      connected: true,
      isBot,
      isHost: false,
      dropTimer: null,
    };
    this.players.set(id, p);
    if (!isBot) this.tokens.set(p.token, id);
    return p;
  }

  hello(client, token) {
    let player = null;
    if (typeof token === 'string' && /^[0-9a-f]{32}$/.test(token)) {
      const id = this.tokens.get(token);
      if (id) player = this.players.get(id) || null;
    }
    if (!player) player = this.#newPlayer();

    // 同一身份只留最新的连接，两个标签页不会互相打架
    for (const c of [...this.clients]) {
      if (c !== client && c.playerId === player.id) {
        c.playerId = null;
        this.clients.delete(c);
        try {
          c.send({ t: 'error', code: 'ILLEGAL_ACTION', msg: '你在另一个窗口打开了牌桌，这个窗口已断开' });
          c.close?.();
        } catch { /* 忽略 */ }
      }
    }

    client.playerId = player.id;
    player.connected = true;
    this.#clearDropTimer(player);
    // 新连接意味着旧的 WebRTC 连接已经作废（刷新页面、或断线重连）。
    // 先把人从麦上摘掉，让别人拆干净；前端本来在连麦的话，会自己再上一次麦。
    this.voice.remove(player.id);
    client.send({ t: 'welcome', playerId: player.id, token: player.token, seat: player.seat });
    this.broadcast();
    return { ok: true };
  }

  #playerOf(client) {
    return client.playerId ? this.players.get(client.playerId) || null : null;
  }

  #seatPlayer(seat) {
    const id = this.seats[seat];
    return id ? this.players.get(id) || null : null;
  }

  // ==================== 座位 ====================

  sit(client, seat, name) {
    const p = this.#playerOf(client);
    if (!p) return { ok: false, code: 'ILLEGAL_ACTION', msg: '还没有握手，请刷新页面' };
    const s = clampInt(seat, 0, GD_SEATS - 1);
    if (s === null) return { ok: false, code: 'ILLEGAL_ACTION', msg: '座位号不合法' };
    const nick = typeof name === 'string' ? name.trim() : '';
    if (nick.length < 1 || [...nick].length > 12) {
      return { ok: false, code: 'NAME_INVALID', msg: '昵称需要 1 到 12 个字符' };
    }
    if (p.seat !== null) return { ok: false, code: 'ILLEGAL_ACTION', msg: '你已经在座位上了' };
    if (this.seats[s] !== null) {
      const full = this.seats.every((x) => x !== null);
      return full
        ? { ok: false, code: 'TABLE_FULL', msg: '牌桌已坐满' }
        : { ok: false, code: 'SEAT_TAKEN', msg: '该座位已被占用' };
    }
    if (this.deal && !this.deal.isComplete) {
      return { ok: false, code: 'ILLEGAL_ACTION', msg: '这一局正在进行，等这局打完再坐' };
    }

    p.seat = s;
    p.name = nick;
    p.avatar = makeAvatar(nick);
    p.connected = true;
    this.seats[s] = p.id;
    this.#ensureHost();
    this.#pushLog(`${nick} 坐到 ${s + 1} 号位（${TEAM_NAME[teamOf(s)]}）`);
    client.send({ t: 'welcome', playerId: p.id, token: p.token, seat: p.seat });
    this.#maybeAutoStart();
    this.broadcast();
    return { ok: true };
  }

  stand(client) {
    const p = this.#playerOf(client);
    if (!p || p.seat === null) return { ok: false, code: 'NOT_SEATED', msg: '你还没有入座' };
    this.#pushLog(`${p.name} 离开了牌桌`);
    this.#vacate(p);
    this.broadcast();
    return { ok: true };
  }

  /** 把玩家摘出座位。牌局中途走人就整局作废——4 个人少一个没法继续。 */
  #vacate(p) {
    const seat = p.seat;
    if (seat === null) return;
    this.seats[seat] = null;
    p.seat = null;
    p.isHost = false;
    if (this.deal && !this.deal.isComplete) {
      this.#abortDeal(`${p.name} 中途离座，本局作废`);
    }
    if (p.isBot) this.#deletePlayer(p);
    this.#ensureHost();
    this.#sweepBotsIfEmpty();
  }

  /** 真人全走光就把人机也一并清掉，别让机器人自己在空桌上打一晚上 */
  #sweepBotsIfEmpty() {
    const humans = this.seats.some((id) => id && !this.players.get(id)?.isBot);
    if (humans) return;
    for (let s = 0; s < GD_SEATS; s++) {
      const p = this.#seatPlayer(s);
      if (!p) continue;
      this.seats[s] = null;
      p.seat = null;
      this.#deletePlayer(p);
    }
    this.#abortDeal(null);
    this.#resetMatch();
  }

  #ensureHost() {
    const seated = this.seats.map((id) => (id ? this.players.get(id) : null)).filter(Boolean);
    const humans = seated.filter((p) => !p.isBot);
    if (humans.some((p) => p.isHost)) return;
    for (const p of seated) p.isHost = false;
    if (humans.length) humans[0].isHost = true;
  }

  kick(client, seat) {
    const me = this.#playerOf(client);
    if (!me?.isHost) return { ok: false, code: 'NOT_HOST', msg: '只有房主能请人离座' };
    const target = this.#seatPlayer(seat);
    if (!target) return { ok: false, code: 'ILLEGAL_ACTION', msg: '那个座位是空的' };
    if (target.id === me.id) return { ok: false, code: 'ILLEGAL_ACTION', msg: '想走请点"离座"' };
    this.#pushLog(`${target.name} 被房主请下了牌桌`);
    this.voice.remove(target.id);
    this.#vacate(target);
    if (!target.isBot) {
      for (const c of this.clients) {
        if (c.playerId === target.id) c.send({ t: 'error', code: 'KICKED', msg: '你被房主请下了牌桌' });
      }
    }
    this.broadcast();
    return { ok: true };
  }

  addBot(client, seat = null) {
    const me = this.#playerOf(client);
    if (!me?.isHost) return { ok: false, code: 'NOT_HOST', msg: '只有房主能加人机' };
    if (this.deal && !this.deal.isComplete) {
      return { ok: false, code: 'ILLEGAL_ACTION', msg: '这一局正在进行，等这局打完再加' };
    }
    let s = seat;
    if (s === null || s === undefined) s = this.seats.findIndex((x) => x === null);
    if (s < 0 || s >= GD_SEATS) return { ok: false, code: 'TABLE_FULL', msg: '没有空位了' };
    if (this.seats[s] !== null) return { ok: false, code: 'SEAT_TAKEN', msg: '该座位已被占用' };

    const used = new Set(
      this.seats.map((id) => (id ? this.players.get(id)?.name : null)).filter(Boolean)
    );
    const name = BOT_NAMES.find((n) => !used.has(n)) || `人机${s + 1}`;
    const bot = this.#newPlayer(true);
    bot.seat = s;
    bot.name = name;
    bot.avatar = makeAvatar(name);
    this.seats[s] = bot.id;
    this.#pushLog(`房主在 ${s + 1} 号位加了人机「${name}」`);
    this.#maybeAutoStart();
    this.broadcast();
    return { ok: true };
  }

  setConfig(client, patch) {
    const me = this.#playerOf(client);
    if (!me?.isHost) return { ok: false, code: 'NOT_HOST', msg: '只有房主能改设置' };
    const next = { ...this.config };
    if (patch.actionTimeoutMs !== undefined) {
      const v = clampInt(patch.actionTimeoutMs, 10000, 300000);
      if (v === null) return { ok: false, code: 'ILLEGAL_ACTION', msg: '行动时限需要 10~300 秒' };
      next.actionTimeoutMs = v;
    }
    if (patch.autoNextDealMs !== undefined) {
      const v = clampInt(patch.autoNextDealMs, 2000, 60000);
      if (v === null) return { ok: false, code: 'ILLEGAL_ACTION', msg: '下一局间隔需要 2~60 秒' };
      next.autoNextDealMs = v;
    }
    if (patch.autoNextDeal !== undefined) next.autoNextDeal = !!patch.autoNextDeal;
    this.config = next;
    this.#pushLog('房主改了牌桌设置');
    this.broadcast();
    return { ok: true };
  }

  // ==================== 开局 ====================

  #seatedCount() {
    return this.seats.filter((x) => x !== null).length;
  }

  #maybeAutoStart() {
    if (this.matchOver) return;
    if (this.deal && !this.deal.isComplete) return;
    if (this.#seatedCount() !== GD_SEATS) return;
    if (this.nextDealTimer) return;
    // 第一局立刻开；后面几局给个间隔让大家看结算
    if (this.dealNo === 0) this.startDeal();
    else if (this.config.autoNextDeal) this.#armNextDeal();
  }

  start(client) {
    const me = this.#playerOf(client);
    if (!me?.isHost) return { ok: false, code: 'NOT_HOST', msg: '只有房主能开局' };
    if (this.matchOver) return { ok: false, code: 'ILLEGAL_ACTION', msg: '本场比赛已经结束，先点"再来一场"' };
    if (this.deal && !this.deal.isComplete) return { ok: false, code: 'ILLEGAL_ACTION', msg: '已经在打了' };
    if (this.#seatedCount() !== GD_SEATS) return { ok: false, code: 'NOT_ENOUGH', msg: '要 4 个人才能开局' };
    this.#clearNextDeal();
    this.startDeal();
    return { ok: true };
  }

  reset(client) {
    const me = this.#playerOf(client);
    if (!me?.isHost) return { ok: false, code: 'NOT_HOST', msg: '只有房主能重开' };
    this.#abortDeal(null);
    this.#resetMatch();
    this.#pushLog('房主重开了一场，双方都从打 2 开始');
    this.#maybeAutoStart();
    this.broadcast();
    return { ok: true };
  }

  #resetMatch() {
    this.levels = [2, 2];
    this.dealingTeam = 0;
    this.aFail = [0, 0];
    this.dealNo = 0;
    this.lastFinishOrder = null;
    this.result = null;
    this.matchOver = null;
  }

  /**
   * 根据上一局名次算这一局的进贡方案。
   * 双下（头游二游同队）：三游、末游各进贡一张，头游二游各收一张、各还一张。
   * 单下：末游给头游进贡一张，头游还一张。
   */
  #planTribute() {
    const fo = this.lastFinishOrder;
    if (!fo) return null;
    const double = teamOf(fo[0]) === teamOf(fo[1]);
    return double
      ? { double: true, payers: [fo[2], fo[3]], receivers: [fo[0], fo[1]], headSeat: fo[0] }
      : { double: false, payers: [fo[3]], receivers: [fo[0]], headSeat: fo[0] };
  }

  startDeal() {
    if (this.#seatedCount() !== GD_SEATS || this.matchOver) return;
    this.#clearNextDeal();
    this.#clearActionTimer();
    this.dealNo += 1;
    this.eventCursor = 0;
    this.result = null;

    const level = this.levels[this.dealingTeam];
    const firstSeat = this.lastFinishOrder ? this.lastFinishOrder[0] : randomInt(0, GD_SEATS);
    this.deal = new GuandanDeal({ level, firstSeat, tributePlan: this.#planTribute() });
    this.dealSeatOwners = new Map();
    for (let s = 0; s < GD_SEATS; s++) {
      if (this.seats[s]) this.dealSeatOwners.set(s, this.seats[s]);
    }

    this.#pushLog(
      `第 ${this.dealNo} 局开始 · ${TEAM_NAME[this.dealingTeam]}坐庄，打 ${levelName(level)}` +
      `（逢人配 ${cardName(wildCard(level))}）`
    );
    this.#afterMove();
  }

  #abortDeal(reason) {
    this.#clearActionTimer();
    this.#clearNextDeal();
    this.#clearBotTimer();
    if (this.deal && !this.deal.isComplete && reason) this.#pushLog(reason);
    this.deal = null;
    this.dealSeatOwners = new Map();
    this.result = null;
  }

  // ==================== 玩家动作 ====================

  /** 取出发起动作的玩家所在座位，并做基本校验 */
  #actorSeat(client) {
    const p = this.#playerOf(client);
    if (!p || p.seat === null) return { err: { ok: false, code: 'NOT_SEATED', msg: '你还没有入座' } };
    if (!this.deal || this.deal.isComplete) {
      return { err: { ok: false, code: 'ILLEGAL_ACTION', msg: '现在没有进行中的牌局' } };
    }
    return { seat: p.seat, player: p };
  }

  play(client, msg) {
    const a = this.#actorSeat(client);
    if (a.err) return a.err;
    if (msg.dealNo !== undefined && msg.dealNo !== null && msg.dealNo !== this.dealNo) {
      return { ok: false, code: 'STALE', msg: '这局已经翻篇了' };
    }
    const r = this.deal.play(a.seat, msg.cards, msg.as || null);
    if (!r.ok) return { ok: false, code: 'ILLEGAL_ACTION', msg: r.msg };
    this.#afterMove();
    return { ok: true };
  }

  pass(client, msg) {
    const a = this.#actorSeat(client);
    if (a.err) return a.err;
    if (msg?.dealNo !== undefined && msg.dealNo !== null && msg.dealNo !== this.dealNo) {
      return { ok: false, code: 'STALE', msg: '这局已经翻篇了' };
    }
    const r = this.deal.pass(a.seat);
    if (!r.ok) return { ok: false, code: 'ILLEGAL_ACTION', msg: r.msg };
    this.#afterMove();
    return { ok: true };
  }

  returnTribute(client, card) {
    const a = this.#actorSeat(client);
    if (a.err) return a.err;
    const r = this.deal.returnTribute(a.seat, card);
    if (!r.ok) return { ok: false, code: 'ILLEGAL_ACTION', msg: r.msg };
    this.#afterMove();
    return { ok: true };
  }

  sendChat(client, text) {
    const p = this.#playerOf(client);
    if (!p) return { ok: false, code: 'ILLEGAL_ACTION', msg: '还没有握手' };
    const clean = String(text).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200);
    if (!clean) return { ok: false, code: 'ILLEGAL_ACTION', msg: '说点什么吧' };
    this.chat.push({ ts: Date.now(), seat: p.seat, name: p.name || '观众', text: clean });
    if (this.chat.length > MAX_CHAT) this.chat.splice(0, this.chat.length - MAX_CHAT);
    this.broadcast();
    return { ok: true };
  }

  // ==================== 每步之后的收尾 ====================

  /** 把引擎新产生的事件搬进房间日志 */
  #drainEvents() {
    if (!this.deal) return;
    for (; this.eventCursor < this.deal.events.length; this.eventCursor++) {
      this.#pushLog(this.#nameify(this.deal.events[this.eventCursor].text));
    }
  }

  /** 把日志里的"3 号"替换成真实昵称 */
  #nameify(text) {
    return String(text).replace(/(\d) 号/g, (m, d) => {
      const p = this.#seatPlayer(Number(d) - 1);
      return p ? p.name : m;
    });
  }

  #afterMove() {
    this.#drainEvents();
    this.#clearActionTimer();
    this.#clearBotTimer();

    if (this.deal && this.deal.isComplete) {
      this.#settle();
      this.broadcast();
      return;
    }
    this.#armActionTimer();
    this.#scheduleBot();
    this.broadcast();
  }

  /** 当前在等谁：出牌阶段等 turn，还贡阶段等所有欠着还贡的人 */
  #waitingSeats() {
    if (!this.deal || this.deal.isComplete) return [];
    if (this.deal.phase === GD_PHASE.TRIBUTE) return this.deal.pendingReturns();
    return this.deal.turn === null ? [] : [this.deal.turn];
  }

  #armActionTimer() {
    const waiting = this.#waitingSeats();
    if (!waiting.length) return;
    this.actionDeadline = Date.now() + this.config.actionTimeoutMs;
    this.actionTimer = setTimeout(() => {
      this.actionTimer = null;
      this.actionDeadline = null;
      for (const seat of this.#waitingSeats()) {
        const p = this.#seatPlayer(seat);
        this.#pushLog(`${p ? p.name : `${seat + 1} 号`} 超时，自动代打`);
        this.#autoMove(seat);
      }
      this.#afterMove();
    }, this.config.actionTimeoutMs);
    this.actionTimer.unref?.();
  }

  #clearActionTimer() {
    if (this.actionTimer) clearTimeout(this.actionTimer);
    this.actionTimer = null;
    this.actionDeadline = null;
  }

  #clearBotTimer() {
    if (this.botTimer) clearTimeout(this.botTimer);
    this.botTimer = null;
  }

  #clearNextDeal() {
    if (this.nextDealTimer) clearTimeout(this.nextDealTimer);
    this.nextDealTimer = null;
    this.nextDealAt = null;
  }

  /** 轮到人机就排一个延迟动作，别瞬间出牌 */
  #scheduleBot() {
    const waiting = this.#waitingSeats();
    const seat = waiting.find((s) => this.#seatPlayer(s)?.isBot);
    if (seat === undefined) return;
    const delay = randomInt(BOT_DELAY_MS[0], BOT_DELAY_MS[1]);
    this.botTimer = setTimeout(() => {
      this.botTimer = null;
      if (!this.deal || this.deal.isComplete) return;
      if (!this.#waitingSeats().includes(seat)) return;
      this.#autoMove(seat);
      this.#afterMove();
    }, delay);
    this.botTimer.unref?.();
  }

  /**
   * 替某个座位走一步：人机出牌、以及真人超时托管都走这里。
   * 必须保证一定走得动——领出时哪怕只剩一张也得甩出去，否则牌局会卡死。
   */
  #autoMove(seat) {
    const d = this.deal;
    if (!d || d.isComplete) return;

    if (d.phase === GD_PHASE.TRIBUTE) {
      const cands = d.returnCandidates(seat);
      if (!cands.length) return;
      // 还贡还最小的那张，别把好牌白送出去
      const worst = sortHand(cands, d.level).slice(-1)[0];
      d.returnTribute(seat, worst);
      return;
    }

    const hand = d.hands.get(seat) || [];
    if (!hand.length) return;
    const foes = [0, 1, 2, 3].filter((s) => teamOf(s) !== teamOf(seat));
    const oppMin = Math.min(...foes.map((s) => (d.hands.get(s) || []).length || 99));
    const pick = choosePlay(hand, d.level, d.req?.combo || null, {
      myCount: hand.length,
      oppMin,
      mateLeading: !!d.req && d.req.seat === partnerOf(seat),
    });

    if (pick) {
      d.play(seat, pick.cards, pick.combo);
    } else if (d.req) {
      d.pass(seat);
    } else {
      // 轮到自己领出却没算出候选：兜底甩最小的一张单牌
      d.play(seat, [sortHand(hand, d.level).slice(-1)[0]]);
    }
  }

  // ==================== 结算与升级 ====================

  #settle() {
    const d = this.deal;
    const fo = d.finishOrder;
    const winTeam = teamOf(fo[0]);
    const mateIdx = fo.indexOf(partnerOf(fo[0]));
    const gain = [3, 2, 1][mateIdx - 1] ?? 1;
    const beforeLevels = [...this.levels];
    const playingAtA = this.levels[this.dealingTeam] === 14;

    let matchWin = null;
    let demoted = null;

    if (winTeam === this.dealingTeam && playingAtA) {
      // 打 A 这一局赢了 —— 过 A，整场结束
      matchWin = winTeam;
    } else {
      if (winTeam !== this.dealingTeam && playingAtA) {
        // 对方打 A 没过，记一次失败；攒够三次退回打 2
        this.aFail[this.dealingTeam] += 1;
        if (this.aFail[this.dealingTeam] >= 3) {
          this.levels[this.dealingTeam] = 2;
          this.aFail[this.dealingTeam] = 0;
          demoted = this.dealingTeam;
        }
      }
      // 升级封顶在 A：不能跳过 A 直接过关
      this.levels[winTeam] = Math.min(14, this.levels[winTeam] + gain);
      this.dealingTeam = winTeam;
    }

    const places = fo.map((seat, i) => ({
      seat,
      place: PLACE_NAME[i],
      name: this.#seatPlayer(seat)?.name || `${seat + 1} 号`,
      rest: (d.hands.get(seat) || []).slice(),
    }));

    this.result = {
      dealNo: this.dealNo,
      level: d.level,
      finishOrder: fo,
      places,
      winTeam,
      gain: matchWin === null ? gain : 0,
      doubleOut: mateIdx === 1,
      beforeLevels,
      levels: [...this.levels],
      aFail: [...this.aFail],
      demoted,
      tribute: d.tribute,
    };

    const tag = mateIdx === 1 ? '双下' : mateIdx === 2 ? '单下' : '小单下';
    // 过 A 那一局是直接赢下整场，没有"升几级"这回事，别和 result.gain 说两套话
    this.#pushLog(
      matchWin === null
        ? `${TEAM_NAME[winTeam]}${tag}，升 ${gain} 级，现在打 ${levelName(this.levels[winTeam])}`
        : `${TEAM_NAME[winTeam]}${tag}，打 A 成功`
    );
    if (demoted !== null) this.#pushLog(`${TEAM_NAME[demoted]}三次打 A 未过，退回打 2`);

    this.lastFinishOrder = fo;

    if (matchWin !== null) {
      this.matchOver = {
        team: matchWin,
        teamName: TEAM_NAME[matchWin],
        seats: [matchWin, matchWin + 2].map((s) => this.#seatPlayer(s)?.name || `${s + 1} 号`),
      };
      this.#pushLog(`🏆 ${TEAM_NAME[matchWin]}过 A，赢下整场比赛！`);
      return;
    }
    if (this.config.autoNextDeal) this.#armNextDeal();
  }

  #armNextDeal() {
    if (this.matchOver || this.#seatedCount() !== GD_SEATS) return;
    this.#clearNextDeal();
    this.nextDealAt = Date.now() + this.config.autoNextDealMs;
    this.nextDealTimer = setTimeout(() => {
      this.nextDealTimer = null;
      this.nextDealAt = null;
      this.startDeal();
    }, this.config.autoNextDealMs);
    this.nextDealTimer.unref?.();
  }

  // ==================== 快照 ====================

  #pushLog(text) {
    this.log.push({ ts: Date.now(), text });
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);
  }

  broadcast() {
    const cache = new Map();
    for (const c of this.clients) {
      if (!c.playerId) continue;
      let snap = cache.get(c.playerId);
      if (!snap) {
        snap = this.buildStateFor(c.playerId);
        cache.set(c.playerId, snap);
      }
      c.send(snap);
    }
  }

  /**
   * 生成脱敏快照。
   * 安全红线：任何时候都只把 viewer 自己的手牌发出去，别人的手牌只发张数；
   * 只有本局结束后，result.places 里才带上各家的剩牌。
   */
  buildStateFor(viewerPlayerId) {
    const viewer = viewerPlayerId ? this.players.get(viewerPlayerId) || null : null;
    const d = this.deal;
    const mySeat = viewer?.seat ?? null;
    const waiting = this.#waitingSeats();

    const seats = [];
    for (let s = 0; s < GD_SEATS; s++) {
      const p = this.#seatPlayer(s);
      const finishedIdx = d ? d.finished.indexOf(s) : -1;
      seats.push(
        p
          ? {
            seat: s,
            team: teamOf(s),
            name: p.name,
            avatar: p.avatar,
            connected: p.connected,
            isBot: p.isBot,
            isHost: p.isHost,
            count: d ? (d.hands.get(s) || []).length : 0,
            place: finishedIdx >= 0 ? PLACE_NAME[finishedIdx] : null,
            passed: d ? d.passers.has(s) : false,
            waiting: waiting.includes(s),
          }
          : { seat: s, team: teamOf(s), empty: true }
      );
    }

    const level = d ? d.level : this.levels[this.dealingTeam];
    const table = d?.table
      ? {
        seat: d.table.seat,
        cards: d.table.cards,
        combo: d.table.combo,
        name: comboName(d.table.combo, d.level),
      }
      : null;

    const you = {
      playerId: viewer?.id || null,
      seat: mySeat,
      isHost: !!viewer?.isHost,
      // 只有本局开局时就坐在这个座位上的人，手上那 27 张才算他的
      hand: d && mySeat !== null && this.dealSeatOwners.get(mySeat) === viewer?.id
        ? (d.hands.get(mySeat) || []).slice()
        : [],
      myTurn: !!d && !d.isComplete && d.phase === GD_PHASE.PLAYING && d.turn === mySeat,
      canPass: !!d && !d.isComplete && d.phase === GD_PHASE.PLAYING && d.turn === mySeat && !!d.req,
      returnOptions:
        d && !d.isComplete && d.phase === GD_PHASE.TRIBUTE && d.pendingReturns().includes(mySeat)
          ? d.returnCandidates(mySeat)
          : null,
    };

    return {
      t: 'state',
      you,
      seats,
      phase: d ? (d.isComplete ? 'over' : d.phase) : 'waiting',
      dealNo: this.dealNo,
      level,
      levelText: levelName(level),
      wild: wildCard(level),
      levels: [...this.levels],
      levelTexts: this.levels.map(levelName),
      aFail: [...this.aFail],
      dealingTeam: this.dealingTeam,
      teamNames: TEAM_NAME,
      turn: d && !d.isComplete ? d.turn : null,
      leadSeat: d ? d.leadSeat : null,
      // combo 一并下发：前端要用它在本地预判"这几张能不能压得过"，
      // 免得每选一次牌都往服务端跑一趟。服务端仍然会重新校验一次。
      req: d?.req
        ? { seat: d.req.seat, cards: d.req.cards, combo: d.req.combo, name: comboName(d.req.combo, d.level) }
        : null,
      table,
      tribute: d ? { ...d.tribute, pending: d.isComplete ? [] : d.pendingReturns() } : null,
      deadline: this.actionDeadline,
      nextDealAt: this.nextDealAt,
      result: this.result,
      matchOver: this.matchOver,
      config: { ...this.config },
      log: this.log.slice(-MAX_LOG),
      chat: this.chat.slice(-MAX_CHAT),
      voice: this.voice.publicState(),
    };
  }

  shutdown() {
    this.#clearActionTimer();
    this.#clearNextDeal();
    this.#clearBotTimer();
    for (const p of this.players.values()) this.#clearDropTimer(p);
  }
}
