// SPDX-License-Identifier: GPL-3.0-or-later
//
// 「热词」房间：两个擂台位 + 不限人数的观众席。
//
// 跟德州、掼蛋一样是完全独立的第三张桌子：另一个 WebSocket 路径、另一份内存状态。
// Room 不认识 WebSocket，只认识 { send(obj), close(), playerId } 这样的"客户端"对象。
//
// 观众能看什么：跟对手视角一模一样——两条温度条和猜了几次，看不到具体的词。
// 这是故意的：八个人开着语音，观众要是看得见答案和词，一句"哎你往吃的方向想"
// 整局就废了。想看词就自己上擂台。

import { randomBytes, randomInt } from 'node:crypto';
import {
  HotwordRound, HW_PHASE, HW_SEATS,
  GUESS_COOLDOWN_MS, PEEK_FREEZE_MS, PEEK_LIMIT,
  ROUND_LIMIT_MS, ROUND_LIMIT_MIN_MS, ROUND_LIMIT_MAX_MS,
} from './engine.js';
import { makeAvatar } from '../room.js';
import { VoiceChannel } from '../voice.js';

const MAX_LOG = 40;
const MAX_CHAT = 50;
/** 断线后保留擂台位的时长 */
const DISCONNECT_GRACE_MS = 15 * 60 * 1000;
/** 记住最近多少个答案，用来避免短时间内重样 */
const RECENT_MEMORY = 20;

export const DEFAULT_HW_CONFIG = Object.freeze({
  guessCooldownMs: GUESS_COOLDOWN_MS,
  peekFreezeMs: PEEK_FREEZE_MS,
  peekLimit: PEEK_LIMIT,
  roundLimitMs: ROUND_LIMIT_MS,
  peekEnabled: true,
  hintsEnabled: true,
});

function newToken() {
  return randomBytes(16).toString('hex');
}

function clampInt(v, lo, hi) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return null;
  if (n < lo || n > hi) return null;
  return n;
}

export class HotwordRoom {
  /**
   * @param {object} opts
   * @param {import('./vectors.js').WordVectors|null} opts.vectors 词向量。null 表示数据文件没装好，
   *        这时房间照样能连上，只是开不了局——不能让一个缺失的数据文件拖垮整个进程。
   */
  constructor(opts = {}) {
    this.vectors = opts.vectors || null;
    this.config = { ...DEFAULT_HW_CONFIG, ...(opts.config || {}) };

    /** 擂台位 -> playerId */
    this.seats = new Array(HW_SEATS).fill(null);
    this.players = new Map();
    this.tokens = new Map();
    this.clients = new Set();

    /** @type {HotwordRound|null} */
    this.round = null;
    this.roundNo = 0;
    /** 这一场的比分，跟座位对应 */
    this.score = [0, 0];
    /** 最近出过的答案。一晚上打十几局，随机重样是真会发生的 */
    this.recent = [];

    /** 本局已经播报过的提示档，防止每秒重复写一条 */
    this.announced = new Set();

    this.log = [];
    this.chat = [];

    this.voice = new VoiceChannel(this, { label: '热词语音', ...(opts.voice || {}) });

    // 冷却结束、提示解锁这些都要让页面自己重画，但服务端也得推一次，
    // 否则玩家盯着"还剩 1 秒"看到天荒地老。1 秒一次，够用又不费。
    this.tickTimer = setInterval(() => this.#tick(), 1000);
    this.tickTimer.unref?.();
  }

  get ready() {
    return !!this.vectors;
  }

  // ==================== 连接 ====================

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
    if (p?.dropTimer) {
      clearTimeout(p.dropTimer);
      p.dropTimer = null;
    }
  }

  #dropDisconnected(playerId) {
    const p = this.players.get(playerId);
    if (!p || p.connected) return;
    this.#pushLog(`${p.name || '有人'} 掉线太久，位子空出来了`);
    this.#vacate(p);
    this.#deletePlayer(p);
    this.broadcast();
  }

  #deletePlayer(p) {
    this.#clearDropTimer(p);
    this.voice.remove(p.id);
    this.tokens.delete(p.token);
    this.players.delete(p.id);
  }

  #newPlayer() {
    const id = randomBytes(8).toString('hex');
    const token = newToken();
    const p = {
      id, token, name: null, avatar: null, seat: null,
      connected: true, isHost: false, dropTimer: null,
    };
    this.players.set(id, p);
    this.tokens.set(token, id);
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
          c.send({ t: 'error', code: 'ILLEGAL_ACTION', msg: '你在另一个窗口打开了热词，这个窗口已断开' });
          c.close?.();
        } catch { /* 忽略 */ }
      }
    }

    client.playerId = player.id;
    player.connected = true;
    this.#clearDropTimer(player);
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

  // ==================== 擂台位 ====================

  sit(client, seat, name) {
    const p = this.#playerOf(client);
    if (!p) return { ok: false, code: 'ILLEGAL_ACTION', msg: '还没有握手，请刷新页面' };
    const s = clampInt(seat, 0, HW_SEATS - 1);
    if (s === null) return { ok: false, code: 'ILLEGAL_ACTION', msg: '位子号不合法' };
    const nick = typeof name === 'string' ? name.trim() : '';
    if (nick.length < 1 || [...nick].length > 12) {
      return { ok: false, code: 'NAME_INVALID', msg: '昵称需要 1 到 12 个字符' };
    }
    if (p.seat !== null) return { ok: false, code: 'ILLEGAL_ACTION', msg: '你已经在擂台上了' };
    if (this.seats[s] !== null) return { ok: false, code: 'SEAT_TAKEN', msg: '这个位子有人了' };
    if (this.round && !this.round.isOver) {
      return { ok: false, code: 'ILLEGAL_ACTION', msg: '这一局正在打，等他们分出胜负' };
    }

    p.seat = s;
    p.name = nick;
    p.avatar = makeAvatar(nick);
    p.connected = true;
    this.seats[s] = p.id;
    this.#ensureHost();
    this.#pushLog(`${nick} 上了擂台`);
    client.send({ t: 'welcome', playerId: p.id, token: p.token, seat: p.seat });
    this.broadcast();
    return { ok: true };
  }

  stand(client) {
    const p = this.#playerOf(client);
    if (!p || p.seat === null) return { ok: false, code: 'ILLEGAL_ACTION', msg: '你不在擂台上' };
    const name = p.name;
    this.#vacate(p);
    this.#pushLog(`${name} 下了擂台`);
    this.broadcast();
    return { ok: true };
  }

  /** 把人从擂台上摘下来。局中途走人算流局——剩下那个人对着空气猜没意义 */
  #vacate(p) {
    if (p.seat === null) return;
    if (this.round && !this.round.isOver) {
      this.round.finish(null, 'abandoned');
      this.#pushLog(`${p.name} 中途下台，这局作废，答案是「${this.round.answer}」`);
    }
    this.seats[p.seat] = null;
    p.seat = null;
    p.isHost = false;
    this.#ensureHost();
  }

  #ensureHost() {
    if ([...this.players.values()].some((p) => p.isHost && p.seat !== null)) return;
    for (const s of this.seats) {
      const p = s ? this.players.get(s) : null;
      if (p) { p.isHost = true; return; }
    }
  }

  #seatedCount() {
    return this.seats.filter((s) => s !== null).length;
  }

  // ==================== 一局 ====================

  start(client) {
    const p = this.#playerOf(client);
    if (!p) return { ok: false, code: 'ILLEGAL_ACTION', msg: '还没有握手' };
    if (p.seat === null) return { ok: false, code: 'ILLEGAL_ACTION', msg: '观众开不了局，先上擂台' };
    if (!this.ready) return { ok: false, code: 'NOT_READY', msg: '词库没装好，开不了局' };
    if (this.#seatedCount() < HW_SEATS) return { ok: false, code: 'NEED_TWO', msg: '要两个人才打得起来' };
    if (this.round && !this.round.isOver) return { ok: false, code: 'ILLEGAL_ACTION', msg: '这一局还没打完' };

    this.roundNo += 1;
    const answer = this.#drawAnswer();
    this.round = new HotwordRound({
      vectors: this.vectors,
      answer,
      no: this.roundNo,
      cooldownMs: this.config.guessCooldownMs,
      peekFreezeMs: this.config.peekFreezeMs,
      peekLimit: this.config.peekLimit,
      roundLimitMs: this.config.roundLimitMs,
      hintsEnabled: this.config.hintsEnabled,
    });
    // 日志里【不能】写答案的字数、类别、首字——它们都是提示的内容，
    // 到点了自然会给两边，提前写进公共战况等于白送
    this.announced = new Set();
    this.#pushLog(`第 ${this.roundNo} 局开始，${Math.round(this.config.roundLimitMs / 1000)} 秒`);
    this.broadcast();
    return { ok: true };
  }

  /**
   * 抽一个最近没出过的答案。
   * 重试有上限：答案池要是比 RECENT_MEMORY 还小，硬要求"不重样"会死循环，
   * 抽不到就认了——重样总比卡住强。
   */
  #drawAnswer() {
    const pool = this.vectors.answers;
    let pick = pool[randomInt(pool.length)];
    for (let i = 0; i < 12 && this.recent.includes(pick.word); i++) {
      pick = pool[randomInt(pool.length)];
    }
    this.recent.push(pick.word);
    const keep = Math.min(RECENT_MEMORY, Math.max(0, pool.length - 1));
    if (this.recent.length > keep) this.recent.splice(0, this.recent.length - keep);
    return pick;
  }

  #actorSeat(client) {
    const p = this.#playerOf(client);
    if (!p || p.seat === null) return null;
    return p.seat;
  }

  guess(client, word) {
    const seat = this.#actorSeat(client);
    if (seat === null) return { ok: false, code: 'ILLEGAL_ACTION', msg: '观众不能猜，先上擂台' };
    this.#sweepTime();
    if (!this.round || this.round.isOver) return { ok: false, code: 'ILLEGAL_ACTION', msg: '现在没有进行中的局' };

    const res = this.round.guess(seat, word);
    if (!res.ok) {
      // 重复猜过的词不是错误，把上次的结果再送一遍，页面上闪一下就行
      if (res.code === 'ALREADY_GUESSED' && res.entry) {
        client.send({ t: 'guessed', repeat: true, entry: res.entry });
        return { ok: true };
      }
      return res;
    }

    if (res.win) {
      this.score[seat] += 1;
      const me = this.#seatPlayer(seat);
      this.#pushLog(`${me?.name || `${seat + 1} 号`} 猜中了「${this.round.answer}」，用了 ${this.round.guesses[seat].length} 次`);
    }
    this.broadcast();
    return { ok: true };
  }

  peek(client) {
    const seat = this.#actorSeat(client);
    if (seat === null) return { ok: false, code: 'ILLEGAL_ACTION', msg: '观众不能偷看' };
    if (!this.config.peekEnabled) return { ok: false, code: 'PEEK_OFF', msg: '这桌关掉了偷看' };
    this.#sweepTime();
    if (!this.round || this.round.isOver) return { ok: false, code: 'ILLEGAL_ACTION', msg: '现在没有进行中的局' };
    const res = this.round.peek(seat);
    if (!res.ok) return res;
    // 偷看要让对手知道——被盯着的压力是这个机制一半的乐趣
    const me = this.#seatPlayer(seat);
    this.#pushLog(
      `${me?.name || `${seat + 1} 号`} 偷看了一眼（还剩 ${res.left} 次），`
      + `接下来 ${Math.round(this.config.peekFreezeMs / 1000)} 秒不能猜`,
    );
    this.broadcast();
    return { ok: true };
  }

  resign(client) {
    const seat = this.#actorSeat(client);
    if (seat === null) return { ok: false, code: 'ILLEGAL_ACTION', msg: '你不在擂台上' };
    this.#sweepTime();
    if (!this.round || this.round.isOver) return { ok: false, code: 'ILLEGAL_ACTION', msg: '现在没有进行中的局' };
    const res = this.round.resign(seat);
    if (!res.ok) return res;
    const me = this.#seatPlayer(seat);
    this.score[seat === 0 ? 1 : 0] += 1;
    this.#pushLog(`${me?.name || `${seat + 1} 号`} 认输了，答案是「${this.round.answer}」`);
    this.broadcast();
    return { ok: true };
  }

  /** 清空比分，重新开一场 */
  reset(client) {
    const p = this.#playerOf(client);
    if (!p || !p.isHost) return { ok: false, code: 'NOT_HOST', msg: '只有房主能重置' };
    if (this.round && !this.round.isOver) this.round.finish(null, 'abandoned');
    this.round = null;
    this.roundNo = 0;
    this.score = [0, 0];
    // recent 故意不清：重置的是比分，不是"刚才出过哪些词"
    this.#pushLog('比分清零');
    this.broadcast();
    return { ok: true };
  }

  setConfig(client, patch) {
    const p = this.#playerOf(client);
    if (!p || !p.isHost) return { ok: false, code: 'NOT_HOST', msg: '只有房主能改设置' };
    if (this.round && !this.round.isOver) {
      return { ok: false, code: 'ILLEGAL_ACTION', msg: '设置只能在两局之间改' };
    }
    if (!patch || typeof patch !== 'object') return { ok: false, code: 'ILLEGAL_ACTION', msg: '设置格式不对' };

    const next = { ...this.config };
    if (patch.guessCooldownMs !== undefined) {
      const v = clampInt(patch.guessCooldownMs, 0, 30000);
      if (v === null) return { ok: false, code: 'ILLEGAL_ACTION', msg: '猜词冷却要在 0-30 秒之间' };
      next.guessCooldownMs = v;
    }
    if (patch.peekFreezeMs !== undefined) {
      const v = clampInt(patch.peekFreezeMs, 0, 120000);
      if (v === null) return { ok: false, code: 'ILLEGAL_ACTION', msg: '偷看冻结要在 0-120 秒之间' };
      next.peekFreezeMs = v;
    }
    if (patch.peekLimit !== undefined) {
      const v = clampInt(patch.peekLimit, 0, 9);
      if (v === null) return { ok: false, code: 'ILLEGAL_ACTION', msg: '偷看次数要在 0-9 之间' };
      next.peekLimit = v;
    }
    if (patch.roundLimitMs !== undefined) {
      const v = clampInt(patch.roundLimitMs, ROUND_LIMIT_MIN_MS, ROUND_LIMIT_MAX_MS);
      if (v === null) {
        return {
          ok: false,
          code: 'ILLEGAL_ACTION',
          msg: `一局时长要在 ${ROUND_LIMIT_MIN_MS / 1000}-${ROUND_LIMIT_MAX_MS / 1000} 秒之间`,
        };
      }
      next.roundLimitMs = v;
    }
    if (patch.peekEnabled !== undefined) next.peekEnabled = !!patch.peekEnabled;
    if (patch.hintsEnabled !== undefined) next.hintsEnabled = !!patch.hintsEnabled;

    this.config = next;
    this.#pushLog('房主改了设置');
    this.broadcast();
    return { ok: true };
  }

  sendChat(client, text) {
    const p = this.#playerOf(client);
    if (!p) return { ok: false, code: 'ILLEGAL_ACTION', msg: '还没有握手' };
    const clean = String(text).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200);
    if (!clean) return { ok: false, code: 'ILLEGAL_ACTION', msg: '说点什么吧' };
    // 局中途聊天不做词过滤：观众想剧透拦不住，靠的是他们看不见答案
    this.chat.push({ ts: Date.now(), seat: p.seat, name: p.name || '观众', text: clean });
    if (this.chat.length > MAX_CHAT) this.chat.splice(0, this.chat.length - MAX_CHAT);
    this.broadcast();
    return { ok: true };
  }

  #pushLog(text) {
    this.log.push({ ts: Date.now(), text });
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);
  }

  /**
   * 时间到就判流局，顺便把这一下解锁的提示写进战况。
   * 动作之前和每秒的 tick 都会调——定时器慢半拍的那零点几秒里不能还让人落一手。
   * @returns {boolean} 这一次是不是刚好把局判死了
   */
  #sweepTime(now = Date.now()) {
    const r = this.round;
    if (!r || r.isOver) return false;

    // 提示到点自己开，没有"谁推开的"这回事，所以播报里不带人名。
    // 只写档位的名字，绝不写它的值——「类别」能进战况，"食物"不行。
    for (const h of r.hints(now)) {
      if (h.locked || this.announced.has(h.key)) continue;
      this.announced.add(h.key);
      // 开局就给的那档（atMs 为 0）不单独播报，「第 N 局开始」已经带过了
      if (h.atMs > 0) this.#pushLog(`${Math.round(h.atMs / 1000)} 秒到，双方都拿到「${h.label}」提示`);
    }

    if (!r.timeUp(now)) return false;
    this.#pushLog(`时间到，两边都没猜中，答案是「${r.answer}」`);
    return true;
  }

  /**
   * 局中每秒推一次。
   *
   * 原来只在有人被冷却冻着的时候推，闲着一条不发。现在不行了：倒计时、
   * 提示解锁都是时间驱动的，不推的话页面会停在上一秒。一局才 90 秒，
   * 一个房间十来个人，这点量无所谓。
   */
  #tick() {
    if (!this.round || this.round.isOver) return;
    this.#sweepTime();
    this.broadcast();
  }

  // ==================== 快照 ====================

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
   *
   * 安全红线：进行中的局里，绝对不能把答案、对手猜过的词、对手的精确排名
   * 发给任何人。观众拿到的和对手拿到的是同一份。只有本局结束后 result 里
   * 才带上答案和双方的完整记录。
   */
  buildStateFor(viewerPlayerId) {
    const viewer = viewerPlayerId ? this.players.get(viewerPlayerId) || null : null;
    const mySeat = viewer?.seat ?? null;
    const r = this.round;
    const now = Date.now();
    const over = !r || r.isOver;

    const seats = [];
    for (let s = 0; s < HW_SEATS; s++) {
      const p = this.#seatPlayer(s);
      if (!p) {
        seats.push({ seat: s, empty: true });
        continue;
      }
      const pub = r ? r.publicSeat(s) : { guessCount: 0, bestRank: null, bestTemp: null, bestHeat: null, peekCount: 0 };
      seats.push({
        seat: s,
        name: p.name,
        avatar: p.avatar,
        connected: p.connected,
        isHost: p.isHost,
        guessCount: pub.guessCount,
        // 精确排名只在局末公布；进行中只给温度，不然对手能反推出你猜到哪儿了
        bestRank: over ? pub.bestRank : null,
        bestTemp: pub.bestTemp,
        bestHeat: pub.bestHeat,
        peekCount: pub.peekCount,
        frozenMs: r && !r.isOver ? Math.max(0, r.nextGuessAt[s] - now) : 0,
      });
    }

    let spectators = 0;
    for (const p of this.players.values()) {
      if (p.seat === null && p.connected) spectators += 1;
    }

    const my = (r && mySeat !== null)
      ? {
        guesses: r.guesses[mySeat],
        cooldownMs: Math.max(0, r.nextGuessAt[mySeat] - now),
        // 提示按时间解锁，两边拿到的永远是同一份，跟猜了多少次无关
        hints: r.hints(now),
        peeked: r.peeked[mySeat],
        peeksLeft: r.peeksLeft(mySeat),
      }
      : null;

    const result = (r && r.isOver && r.result)
      ? {
        winner: r.result.winner,
        reason: r.result.reason,
        answer: r.answer,
        category: r.category,
        guesses: { 0: r.guesses[0], 1: r.guesses[1] },
        no: r.no,
      }
      : null;

    return {
      t: 'state',
      ready: this.ready,
      phase: r ? r.phase : HW_PHASE.WAITING,
      round: r
        ? {
          no: r.no,
          startedAt: r.startedAt,
          vocabSize: this.vectors.size,
          // 倒计时给相对毫秒而不是截止时间戳：客户端的钟跟服务端不一定对得上
          msLeft: r.msLeft(now),
          limitMs: r.roundLimitMs,
        }
        : null,
      seats,
      score: this.score.slice(),
      spectators,
      you: {
        playerId: viewer?.id || null,
        seat: mySeat,
        isHost: !!viewer?.isHost,
        name: viewer?.name || null,
      },
      my,
      result,
      config: { ...this.config },
      log: this.log.slice(-MAX_LOG),
      chat: this.chat.slice(-MAX_CHAT),
      voice: this.voice.publicState(),
    };
  }

  shutdown() {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    for (const p of this.players.values()) this.#clearDropTimer(p);
  }
}
