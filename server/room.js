// SPDX-License-Identifier: GPL-3.0-or-later
// 房间：座位、令牌、断线重连、计时器、状态快照下发（SPEC §7 与 §8.3）
//
// 一个进程只有一张桌子，所有状态都在内存里。
// Room 不认识 WebSocket，它只认识"客户端"对象：{ send(obj), close(), playerId }。
// index.js 负责把真正的 ws 包装成这样的对象，并做协议层的输入校验与限流。

import { randomBytes } from 'node:crypto';
import { PHASES, SEAT_STATE, DEFAULT_CONFIG, MAX_SEATS } from './protocol.js';
import { Hand } from './engine.js';
import { PERSONAS } from './bot/index.js';

/** 日志与聊天保留条数（SPEC §8.3） */
const MAX_LOG = 40;
const MAX_CHAT = 50;

/** 断线玩家保留座位的时长：超过之后自动站起，避免死人占座 */
const DISCONNECT_GRACE_MS = 15 * 60 * 1000;

/** 头像底色调色板（深色系，配白色文字） */
const AVATAR_BG = [
  '#b91c1c', '#c2410c', '#b45309', '#4d7c0f',
  '#15803d', '#0f766e', '#0e7490', '#1d4ed8',
  '#4338ca', '#6d28d9', '#a21caf', '#be123c',
];

/** FNV-1a 字符串哈希，保证同一昵称永远得到同一头像 */
function hashString(str) {
  let h = 2166136261 >>> 0;
  for (const ch of String(str)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * 由昵称确定性生成头像（SPEC §7）
 * @param {string} name
 * @returns {{bg:string, fg:string, glyph:string, shape:number}}
 */
export function makeAvatar(name) {
  const s = String(name || '');
  const h = hashString(s);
  return {
    bg: AVATAR_BG[h % AVATAR_BG.length],
    fg: '#ffffff',
    glyph: [...s][0] || '?',
    shape: (h >>> 8) % 4,
  };
}

/** 把引擎的 lastAction 翻译成中文标签（SPEC §6.2 的用词） */
function actionLabel(a) {
  if (!a || typeof a !== 'object') return null;
  const n = Number.isFinite(a.amount) ? a.amount : 0;
  switch (a.type) {
    case 'fold': return '弃牌';
    case 'check': return '过牌';
    case 'call': return `跟注 ${n}`;
    case 'bet': return `下注 ${n}`;
    case 'raise': return `加注到 ${n}`;
    case 'allin': return `全下 ${n}`;
    default: return String(a.type || '');
  }
}

/** 生成 32 位 hex 令牌（SPEC §7） */
function newToken() {
  return randomBytes(16).toString('hex');
}

function clampInt(v, lo, hi) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return null;
  if (n < lo || n > hi) return null;
  return n;
}

export class Room {
  /**
   * @param {object} [opts]
   * @param {object} [opts.config] 覆盖 DEFAULT_CONFIG 的初始配置
   * @param {import('./bot/index.js').BotDriver} [opts.botDriver] 人机驱动，不传则不能加人机
   */
  constructor(opts = {}) {
    /** @type {typeof DEFAULT_CONFIG} */
    this.config = { ...DEFAULT_CONFIG, ...(opts.config || {}) };

    /** @type {import('./bot/index.js').BotDriver|null} */
    this.botDriver = opts.botDriver || null;
    /** 当前正在思考的人机决策键，防止同一个决策点重复触发 */
    this.botPending = null;
    /** 取消正在飞行中的人机请求（手牌结束 / 被踢 / 重置时用） */
    this.botAbort = null;

    /** 座位 -> playerId，长度恒为 8 */
    this.seats = new Array(MAX_SEATS).fill(null);
    /** playerId -> 持久玩家记录 */
    this.players = new Map();
    /** token -> playerId */
    this.tokens = new Map();
    /** 当前所有连接 */
    this.clients = new Set();

    /** @type {Hand|null} 当前（或刚结束的）手牌 */
    this.hand = null;
    this.handNo = 0;
    this.buttonSeat = 0;
    this.sbSeat = null;
    this.bbSeat = null;
    /** 本手牌开局时 座位 -> playerId 的绑定，用于安全地回写筹码 */
    this.handSeatOwners = new Map();
    /** 已经处理过的 hand.events 下标 */
    this.eventCursor = 0;
    /** 结算是否已处理，避免重复结算 */
    this.handFinished = true;
    /** @type {object|null} 当前手牌结算结果 */
    this.result = null;

    this.actionTimer = null;
    this.actionDeadline = null;
    this.nextHandTimer = null;
    this.nextHandAt = null;

    /** @type {{ts:number,text:string}[]} */
    this.log = [];
    /** @type {{ts:number,seat:number|null,name:string,text:string}[]} */
    this.chat = [];

    /** 本手牌里主动亮牌的座位（每手牌开始时清空） */
    this.shownSeats = new Set();
  }

  // ==================== 连接管理 ====================

  /** 新连接接入（此时还没有身份，等 hello） */
  attach(client) {
    client.playerId = null;
    this.clients.add(client);
  }

  /** 连接断开：保留座位与筹码，只把 connected 置 false */
  detach(client) {
    this.clients.delete(client);
    const p = client.playerId ? this.players.get(client.playerId) : null;
    client.playerId = null;
    if (!p) return;
    if (this.#hasClient(p.id)) return; // 同一玩家还有别的连接
    p.connected = false;
    if (p.seat === null) {
      // 没入座的观众直接回收，避免内存无限增长
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
    if (!p) return;
    p.dropTimer = null;
    if (p.connected || p.seat === null) return;
    this.#pushLog(`${p.name} 长时间掉线，已自动离座`);
    this.#vacate(p);
    this.broadcast();
  }

  #deletePlayer(p) {
    this.#clearDropTimer(p);
    this.players.delete(p.id);
    this.tokens.delete(p.token);
  }

  #newPlayer() {
    let id;
    do {
      id = 'p_' + randomBytes(3).toString('hex');
    } while (this.players.has(id));
    const token = newToken();
    const p = {
      id,
      token,
      seat: null,
      name: '',
      avatar: null,
      chips: 0,
      connected: true,
      sittingOut: false,
      isHost: false,
      dropTimer: null,
    };
    this.players.set(id, p);
    this.tokens.set(token, id);
    return p;
  }

  /**
   * 处理 hello：用 token 恢复身份，或建立新身份。
   * 会直接向该连接下发 welcome，并广播一次状态。
   */
  hello(client, token) {
    let player = null;
    if (typeof token === 'string' && /^[0-9a-f]{32}$/.test(token)) {
      const id = this.tokens.get(token);
      if (id) player = this.players.get(id) || null;
    }
    if (!player) player = this.#newPlayer();

    // 同一身份只保留最新的一个连接，避免两个标签页互相打架
    for (const c of [...this.clients]) {
      if (c !== client && c.playerId === player.id) {
        c.playerId = null;
        this.clients.delete(c);
        try {
          c.send({ t: 'error', code: 'ILLEGAL_ACTION', msg: '你在另一个窗口打开了牌桌，这个窗口已断开' });
          c.close?.();
        } catch { /* 忽略关闭异常 */ }
      }
    }

    client.playerId = player.id;
    player.connected = true;
    this.#clearDropTimer(player);
    client.send({ t: 'welcome', playerId: player.id, token: player.token, seat: player.seat });
    // 有人回来了：如果之前因为没观众停在等待状态（比如一桌人机），现在可以继续
    this.#maybeAutoStart();
    this.broadcast();
    return { ok: true };
  }

  #playerOf(client) {
    return client.playerId ? this.players.get(client.playerId) || null : null;
  }

  // ==================== 座位操作 ====================

  /** 入座（SPEC §8.1 sit）。name 已由调用方做过长度校验，这里再兜底一次。 */
  sit(client, seat, name) {
    const p = this.#playerOf(client);
    if (!p) return { ok: false, code: 'ILLEGAL_ACTION', msg: '还没有握手，请刷新页面' };
    const s = clampInt(seat, 0, MAX_SEATS - 1);
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

    p.seat = s;
    p.name = nick;
    p.avatar = makeAvatar(nick);
    p.chips = this.config.startingStack;
    p.sittingOut = false;
    p.connected = true;
    this.seats[s] = p.id;
    this.#ensureHost();
    this.#pushLog(`${p.name} 坐到 ${s + 1} 号座位`);
    client.send({ t: 'welcome', playerId: p.id, token: p.token, seat: p.seat });
    this.#maybeAutoStart();
    this.broadcast();
    return { ok: true };
  }

  /** 站起离座（牌局中先自动弃牌） */
  stand(client) {
    const p = this.#playerOf(client);
    if (!p || p.seat === null) return { ok: false, code: 'NOT_SEATED', msg: '你还没有入座' };
    this.#pushLog(`${p.name} 离开了牌桌`);
    this.#vacate(p);
    this.broadcast();
    return { ok: true };
  }

  /** 把玩家从座位上摘掉：牌局中先弃牌，然后转移房主 */
  #vacate(p) {
    const seat = p.seat;
    if (seat === null) return;
    // 离座的正好是那个正在思考的人机，就把飞行中的请求撤了
    if (p.bot) this.#cancelBot();
    if (this.#handLive() && this.handSeatOwners.get(seat) === p.id) {
      const hp = this.hand.players?.get?.(seat);
      if (hp && !hp.folded) {
        try {
          this.hand.forceFold(seat);
        } catch (err) {
          console.error('[room] forceFold 失败', err);
        }
      }
      // 让弃牌产生的推进（可能直接结束本手牌）立即生效
      this.#pump({ silent: true });
    }
    if (this.seats[seat] === p.id) this.seats[seat] = null;
    this.handSeatOwners.delete(seat);
    p.seat = null;
    p.sittingOut = false;
    this.#clearDropTimer(p);
    const wasHost = p.isHost;
    p.isHost = false;
    if (wasHost) this.#ensureHost();
    if (!p.connected) this.#deletePlayer(p);
  }

  /** 房主不存在时，转给座位号最小的在座玩家（SPEC §7） */
  #ensureHost() {
    for (const id of this.seats) {
      if (id) {
        const p = this.players.get(id);
        if (p && p.isHost) return;
      }
    }
    // 人机不能当房主——它不会改设置也不会加人机，房主落到它头上牌桌就锁死了。
    // 全桌只剩人机时干脆没有房主，等下一个真人入座时由 sit() 再调用本方法接管。
    for (const id of this.seats) {
      if (id) {
        const p = this.players.get(id);
        if (p && !p.bot) {
          p.isHost = true;
          this.#pushLog(`${p.name} 成为房主`);
          return;
        }
      }
    }
  }

  /** 坐出 / 回座 */
  sitOut(client, value) {
    const p = this.#playerOf(client);
    if (!p || p.seat === null) return { ok: false, code: 'NOT_SEATED', msg: '你还没有入座' };
    const v = !!value;
    if (p.sittingOut !== v) {
      p.sittingOut = v;
      this.#pushLog(`${p.name} ${v ? '暂时坐出' : '回到牌局'}`);
      if (!v) this.#maybeAutoStart();
    }
    this.broadcast();
    return { ok: true };
  }

  // ==================== 房主操作 ====================

  #requireHost(client) {
    const p = this.#playerOf(client);
    if (!p || p.seat === null) return { err: { ok: false, code: 'NOT_SEATED', msg: '你还没有入座' } };
    if (!p.isHost) return { err: { ok: false, code: 'NOT_HOST', msg: '只有房主可以这么做' } };
    return { p };
  }

  /** 房主手动开始下一手 */
  start(client) {
    const { err } = this.#requireHost(client);
    if (err) return err;
    if (this.#handLive()) return { ok: false, code: 'HAND_IN_PROGRESS', msg: '本手牌还没结束' };
    return this.startHand();
  }

  /** 修改配置：仅房主、仅两手牌之间 */
  setConfig(client, patch) {
    const { err } = this.#requireHost(client);
    if (err) return err;
    if (this.#handLive()) return { ok: false, code: 'HAND_IN_PROGRESS', msg: '牌局进行中不能改设置' };
    if (!patch || typeof patch !== 'object') {
      return { ok: false, code: 'ILLEGAL_ACTION', msg: '配置格式错误' };
    }
    const next = { ...this.config };
    if ('smallBlind' in patch) {
      const v = clampInt(patch.smallBlind, 1, 1000000);
      if (v === null) return { ok: false, code: 'ILLEGAL_ACTION', msg: '小盲注不合法' };
      next.smallBlind = v;
    }
    if ('bigBlind' in patch) {
      const v = clampInt(patch.bigBlind, 1, 2000000);
      if (v === null) return { ok: false, code: 'ILLEGAL_ACTION', msg: '大盲注不合法' };
      next.bigBlind = v;
    }
    if ('ante' in patch) {
      const v = clampInt(patch.ante, 0, 1000000);
      if (v === null) return { ok: false, code: 'ILLEGAL_ACTION', msg: '前注不合法' };
      next.ante = v;
    }
    if ('startingStack' in patch) {
      const v = clampInt(patch.startingStack, 1, 100000000);
      if (v === null) return { ok: false, code: 'ILLEGAL_ACTION', msg: '起始筹码不合法' };
      next.startingStack = v;
    }
    if ('actionTimeoutMs' in patch) {
      const v = clampInt(patch.actionTimeoutMs, 5000, 300000);
      if (v === null) return { ok: false, code: 'ILLEGAL_ACTION', msg: '行动时限需要在 5 到 300 秒之间' };
      next.actionTimeoutMs = v;
    }
    if ('autoNextHandMs' in patch) {
      const v = clampInt(patch.autoNextHandMs, 1000, 60000);
      if (v === null) return { ok: false, code: 'ILLEGAL_ACTION', msg: '自动开局间隔需要在 1 到 60 秒之间' };
      next.autoNextHandMs = v;
    }
    if ('autoNextHand' in patch) next.autoNextHand = !!patch.autoNextHand;
    if (next.bigBlind < next.smallBlind) {
      return { ok: false, code: 'ILLEGAL_ACTION', msg: '大盲注不能小于小盲注' };
    }
    this.config = next;
    this.#pushLog(`房主更新了设置：盲注 ${next.smallBlind}/${next.bigBlind}，前注 ${next.ante}`);
    this.broadcast();
    return { ok: true };
  }

  /** 给某个座位补充筹码：仅房主，仅两手牌之间 */
  addChips(client, seat, amount) {
    const { err } = this.#requireHost(client);
    if (err) return err;
    if (this.#handLive()) return { ok: false, code: 'HAND_IN_PROGRESS', msg: '牌局进行中不能补充筹码' };
    const s = clampInt(seat, 0, MAX_SEATS - 1);
    if (s === null) return { ok: false, code: 'ILLEGAL_ACTION', msg: '座位号不合法' };
    const amt = clampInt(amount, 1, 100000000);
    if (amt === null) return { ok: false, code: 'ILLEGAL_ACTION', msg: '补充数量不合法' };
    const id = this.seats[s];
    const p = id ? this.players.get(id) : null;
    if (!p) return { ok: false, code: 'NOT_SEATED', msg: '该座位没有人' };
    p.chips += amt;
    this.#pushLog(`房主给 ${p.name} 补充了 ${amt} 筹码`);
    this.#maybeAutoStart();
    this.broadcast();
    return { ok: true };
  }

  /** 踢人：仅房主 */
  kick(client, seat) {
    const { err, p: host } = this.#requireHost(client);
    if (err) return err;
    const s = clampInt(seat, 0, MAX_SEATS - 1);
    if (s === null) return { ok: false, code: 'ILLEGAL_ACTION', msg: '座位号不合法' };
    const id = this.seats[s];
    const target = id ? this.players.get(id) : null;
    if (!target) return { ok: false, code: 'NOT_SEATED', msg: '该座位没有人' };
    if (target.id === host.id) return { ok: false, code: 'ILLEGAL_ACTION', msg: '不能踢自己，请用离座' };
    this.#pushLog(`${target.name} 被房主请出了牌桌`);
    for (const c of this.clients) {
      if (c.playerId === target.id) {
        c.send({ t: 'error', code: 'ILLEGAL_ACTION', msg: '你被房主请出了牌桌' });
      }
    }
    this.#vacate(target);
    this.broadcast();
    return { ok: true };
  }

  // ==================== 亮牌 ====================

  /**
   * 当前这个座位能不能主动亮牌。
   *
   * 只给**本手牌的赢家**，且只在没摊牌的时候——也就是"所有人都弃牌、
   * 你不用亮牌就把池收了"这个场景。想不想让大家看到你诈唬还是真有牌，
   * 是这个功能的全部意义。
   *
   * 摊牌赢的牌本来就已经亮了；弃牌的人不给亮，免得拖慢牌桌节奏。
   */
  #canShowCards(p) {
    if (!p || p.seat === null) return false;
    if (this.phase !== PHASES.HAND_OVER) return false;
    if (!this.hand) return false;
    if (this.handSeatOwners.get(p.seat) !== p.id) return false;
    if (this.shownSeats.has(p.seat)) return false;

    const hp = this.hand.players?.get?.(p.seat);
    if (!hp || !Array.isArray(hp.holeCards) || hp.holeCards.length !== 2) return false;
    if (hp.folded) return false;

    // 摊牌时已经亮过的就不用再亮了
    const sd = this.result?.showdown;
    if (Array.isArray(sd) && sd.some((e) => e && e.seat === p.seat)) return false;

    // 必须是这手牌的赢家
    const winners = this.result?.winners;
    if (!Array.isArray(winners) || !winners.some((w) => w && w.seat === p.seat)) return false;

    return true;
  }

  /** 主动亮牌：把自己的底牌摊给全桌看 */
  showCards(client) {
    const p = this.#playerOf(client);
    if (!p || p.seat === null) return { ok: false, code: 'NOT_SEATED', msg: '你还没有入座' };
    if (!this.#canShowCards(p)) {
      return { ok: false, code: 'ILLEGAL_ACTION', msg: '现在不能亮牌' };
    }
    const hp = this.hand.players.get(p.seat);
    this.shownSeats.add(p.seat);
    this.#pushLog(`${p.name} 亮牌：${hp.holeCards.join(' ')}`);
    this.broadcast();
    return { ok: true };
  }

  // ==================== 人机 ====================

  /**
   * 房主配置人机用的 LLM。
   *
   * **安全**：patch.apiKey 只会转交给 BotDriver 存在内存里，
   * 绝对不写进 this.config，也绝对不进任何快照——快照是广播给全桌的。
   */
  setBotConfig(client, patch) {
    const { err } = this.#requireHost(client);
    if (err) return err;
    if (!this.botDriver) {
      return { ok: false, code: 'ILLEGAL_ACTION', msg: '本服务没有启用人机' };
    }
    if (!patch || typeof patch !== 'object') {
      return { ok: false, code: 'ILLEGAL_ACTION', msg: '配置格式错误' };
    }

    if (patch.remove) {
      this.botDriver.removeProvider(String(patch.provider || '').toLowerCase());
      this.#pushLog('房主移除了一个人机后端');
      this.broadcast();
      return { ok: true };
    }

    const res = this.botDriver.configure(patch);
    if (!res.ok) return { ok: false, code: 'ILLEGAL_ACTION', msg: res.msg };

    // 日志里只提供应商名字，不提 key 的任何部分
    this.#pushLog(`房主配置了人机后端：${this.botDriver.describe()}`);
    this.broadcast();
    return { ok: true };
  }

  /** 人机玩家：不占 token（没人需要用它重连），connected 恒为 true */
  #newBotPlayer(persona) {
    let id;
    do {
      id = 'bot_' + randomBytes(3).toString('hex');
    } while (this.players.has(id));
    const p = {
      id,
      token: null,
      seat: null,
      name: persona.name,
      avatar: makeAvatar(persona.name),
      chips: 0,
      connected: true,
      sittingOut: false,
      isHost: false,
      dropTimer: null,
      bot: true,
      persona,
    };
    this.players.set(id, p);
    return p;
  }

  /** 当前已经在座的人机用掉了哪些人格 */
  #usedPersonas() {
    const used = new Set();
    for (const id of this.seats) {
      const p = id ? this.players.get(id) : null;
      if (p?.bot) used.add(p.persona.name);
    }
    return used;
  }

  /**
   * 房主往指定座位加一个人机。seat 传 null 表示挑第一个空位。
   * @returns {{ok:true, seat:number}|{ok:false, code:string, msg:string}}
   */
  addBot(client, seat = null) {
    const { err } = this.#requireHost(client);
    if (err) return err;
    if (!this.botDriver) {
      return { ok: false, code: 'ILLEGAL_ACTION', msg: '本服务没有启用人机' };
    }

    let s;
    if (seat === null || seat === undefined) {
      s = this.seats.findIndex((x) => x === null);
      if (s === -1) return { ok: false, code: 'TABLE_FULL', msg: '牌桌已坐满' };
    } else {
      s = clampInt(seat, 0, MAX_SEATS - 1);
      if (s === null) return { ok: false, code: 'ILLEGAL_ACTION', msg: '座位号不合法' };
      if (this.seats[s] !== null) return { ok: false, code: 'SEAT_TAKEN', msg: '该座位已被占用' };
    }

    const used = this.#usedPersonas();
    const persona = PERSONAS.find((x) => !used.has(x.name));
    if (!persona) return { ok: false, code: 'TABLE_FULL', msg: '人机人格已经用完了' };

    const p = this.#newBotPlayer(persona);
    p.seat = s;
    p.chips = this.config.startingStack;
    this.seats[s] = p.id;
    this.#pushLog(`房主在 ${s + 1} 号座位加入了人机「${p.name}」`);
    this.#maybeAutoStart();
    this.broadcast();
    return { ok: true, seat: s };
  }

  /** 取消正在飞行中的人机请求（手牌结束、被踢、重置时） */
  #cancelBot() {
    if (this.botAbort) {
      this.botAbort.abort();
      this.botAbort = null;
    }
    this.botPending = null;
  }

  /**
   * 轮到人机时触发一次决策。
   *
   * 幂等性靠 botPending：键里带上 events.length，这样同一个座位在同一手牌里
   * 多次行动（过牌后又面对加注）会得到不同的键，而重复的 #pump 不会重复触发。
   */
  #maybeTriggerBot() {
    if (!this.botDriver || !this.#handLive()) return;
    const seat = this.hand.actingSeat;
    if (seat === null || seat === undefined) return;
    const id = this.seats[seat];
    const p = id ? this.players.get(id) : null;
    if (!p?.bot) return;
    // 座位在本手牌开局后换过人的话，引擎里的数据不属于他
    if (this.handSeatOwners.get(seat) !== p.id) return;

    const key = `${this.hand.handNo}:${seat}:${this.hand.events?.length ?? 0}`;
    if (this.botPending === key) return;

    this.botPending = key;
    const ac = new AbortController();
    this.botAbort = ac;

    const state = this.buildStateFor(p.id);
    // 快照里没有 legal 说明这不是它的回合，防御性退出
    if (!state?.you?.legal) {
      this.botPending = null;
      this.botAbort = null;
      return;
    }

    this.botDriver
      .decide(state, p.persona, ac.signal)
      .then((out) => this.#applyBotAction(key, p, out))
      .catch((e) => {
        console.error('[room] 人机决策异常', e);
        this.botPending = null;
      });
  }

  /** 把人机的决策落到引擎上。到这一步局面可能已经变了，所以要重新校验。 */
  #applyBotAction(key, p, out) {
    if (this.botPending !== key) return; // 已经被取消或局面变了
    this.botPending = null;
    this.botAbort = null;

    if (!this.#handLive()) return;
    if (this.hand.actingSeat !== p.seat) return;
    if (this.handSeatOwners.get(p.seat) !== p.id) return;

    let res;
    try {
      res = this.hand.act(p.seat, out.action);
    } catch (e) {
      console.error('[room] 人机动作抛错', e);
      res = null;
    }

    if (!res || res.ok !== true) {
      // coerceAction 已经校验过一轮，走到这里说明局面在飞行途中变了。
      // 交给超时逻辑处理（能过牌就过牌，否则弃牌），不要卡住牌桌。
      console.error(`[room] 人机 ${p.name} 动作被拒：${res?.error || '未知'}，改用超时动作`);
      try {
        this.hand.timeoutAction(p.seat);
      } catch (e) {
        console.error('[room] 人机兜底动作也失败', e);
        return;
      }
    }

    if (out.say) this.#botSay(p, out.say);
    this.#pump();
  }

  /** 人机的一句话进聊天区。注意：聊天内容不会回流进任何提示词。 */
  #botSay(p, text) {
    const clean = String(text).replace(/[\r\n]/g, ' ').trim().slice(0, 60);
    if (!clean) return;
    this.chat.push({ ts: Date.now(), seat: p.seat, name: p.name, text: clean });
    if (this.chat.length > MAX_CHAT) this.chat.splice(0, this.chat.length - MAX_CHAT);
  }

  /** 重置牌桌：清空牌局，所有人筹码回到 startingStack */
  reset(client) {
    const { err } = this.#requireHost(client);
    if (err) return err;
    this.#cancelBot();
    this.#clearActionTimer();
    this.#clearNextHandTimer();
    this.hand = null;
    this.handFinished = true;
    this.result = null;
    this.handNo = 0;
    this.buttonSeat = 0;
    this.sbSeat = null;
    this.bbSeat = null;
    this.handSeatOwners = new Map();
    this.eventCursor = 0;
    for (const id of this.seats) {
      if (!id) continue;
      const p = this.players.get(id);
      if (p) p.chips = this.config.startingStack;
    }
    this.log = [];
    this.#pushLog('房主重置了牌桌，所有人筹码已还原');
    this.broadcast();
    return { ok: true };
  }

  // ==================== 聊天 ====================

  // 注意：字段名 this.chat 已被聊天记录数组占用，所以方法叫 sendChat
  sendChat(client, text) {
    const p = this.#playerOf(client);
    if (!p) return { ok: false, code: 'ILLEGAL_ACTION', msg: '还没有握手，请刷新页面' };
    const s = typeof text === 'string' ? text.trim() : '';
    if (!s) return { ok: false, code: 'ILLEGAL_ACTION', msg: '不能发送空消息' };
    if ([...s].length > 200) return { ok: false, code: 'ILLEGAL_ACTION', msg: '消息最长 200 字' };
    this.chat.push({
      ts: Date.now(),
      seat: p.seat,
      name: p.name || '观众',
      text: s,
    });
    if (this.chat.length > MAX_CHAT) this.chat.splice(0, this.chat.length - MAX_CHAT);
    this.broadcast();
    return { ok: true };
  }

  // ==================== 牌局 ====================

  /** 当前是否有进行中的手牌 */
  #handLive() {
    return !!this.hand && !this.hand.isComplete;
  }

  /** 有筹码且未坐出的在座玩家（下一手的参与者），按座位号排序 */
  #eligiblePlayers() {
    const out = [];
    for (let s = 0; s < MAX_SEATS; s++) {
      const id = this.seats[s];
      if (!id) continue;
      const p = this.players.get(id);
      if (p && p.chips > 0 && !p.sittingOut) out.push(p);
    }
    return out;
  }

  /** 按钮推进到下一个"有筹码且未坐出"的座位（SPEC §7） */
  #advanceButton(seatSet) {
    const start = this.handNo === 0 ? this.buttonSeat : this.buttonSeat + 1;
    for (let i = 0; i < MAX_SEATS; i++) {
      const s = ((start + i) % MAX_SEATS + MAX_SEATS) % MAX_SEATS;
      if (seatSet.has(s)) return s;
    }
    return this.buttonSeat;
  }

  /** 记录本手牌的 SB / BB 座位，供快照标记（单挑时按钮即小盲） */
  #computeBlinds(seatSet) {
    const order = [];
    for (let i = 1; i <= MAX_SEATS; i++) {
      const s = (this.buttonSeat + i) % MAX_SEATS;
      if (seatSet.has(s)) order.push(s);
    }
    if (seatSet.size === 2) {
      this.sbSeat = this.buttonSeat;
      this.bbSeat = order[0] ?? null;
    } else {
      this.sbSeat = order[0] ?? null;
      this.bbSeat = order[1] ?? null;
    }
  }

  /** 开一手新牌 */
  startHand() {
    if (this.#handLive()) return { ok: false, code: 'HAND_IN_PROGRESS', msg: '本手牌还没结束' };
    const elig = this.#eligiblePlayers();
    if (elig.length < 2) {
      return { ok: false, code: 'NOT_ENOUGH_PLAYERS', msg: '至少需要 2 位有筹码的玩家' };
    }
    this.#clearNextHandTimer();
    this.#clearActionTimer();

    const seatSet = new Set(elig.map((p) => p.seat));
    this.buttonSeat = this.#advanceButton(seatSet);
    this.#computeBlinds(seatSet);
    this.handNo += 1;
    this.handSeatOwners = new Map(elig.map((p) => [p.seat, p.id]));
    this.result = null;
    this.handFinished = false;
    this.eventCursor = 0;
    this.shownSeats.clear();

    try {
      this.hand = new Hand({
        players: elig.map((p) => ({ seat: p.seat, name: p.name, chips: p.chips })),
        config: {
          smallBlind: this.config.smallBlind,
          bigBlind: this.config.bigBlind,
          ante: this.config.ante,
        },
        buttonSeat: this.buttonSeat,
        handNo: this.handNo,
      });
    } catch (e) {
      console.error('[room] 开局失败', e);
      this.hand = null;
      this.handFinished = true;
      this.handNo -= 1;
      this.broadcast();
      return { ok: false, code: 'ILLEGAL_ACTION', msg: '开局失败：' + (e?.message || '未知错误') };
    }

    // 引擎自己也算了盲注位置，以它为准（单挑时按钮即小盲）
    if (Number.isInteger(this.hand.sbSeat)) this.sbSeat = this.hand.sbSeat;
    if (Number.isInteger(this.hand.bbSeat)) this.bbSeat = this.hand.bbSeat;
    if (Number.isInteger(this.hand.buttonSeat)) this.buttonSeat = this.hand.buttonSeat;

    this.#pushLog(`—— 第 ${this.handNo} 手 ——`);
    this.#pump();
    return { ok: true };
  }

  /** 玩家行动（SPEC §8.1 action） */
  action(client, msg) {
    const p = this.#playerOf(client);
    if (!p || p.seat === null) return { ok: false, code: 'NOT_SEATED', msg: '你还没有入座' };
    if (!this.#handLive()) return { ok: false, code: 'ILLEGAL_ACTION', msg: '现在没有进行中的牌局' };
    // 过期点击静默忽略
    if (msg.handNo !== undefined && msg.handNo !== null && Number(msg.handNo) !== this.hand.handNo) {
      return { ok: true, ignored: true };
    }
    if (this.hand.actingSeat !== p.seat) {
      return { ok: false, code: 'NOT_YOUR_TURN', msg: '还没轮到你' };
    }
    const action = { type: msg.type };
    if (msg.amount !== undefined && msg.amount !== null) action.amount = Math.floor(Number(msg.amount));

    let res;
    try {
      res = this.hand.act(p.seat, action);
    } catch (e) {
      console.error('[room] act 抛错', e);
      return { ok: false, code: 'ILLEGAL_ACTION', msg: '动作无法执行' };
    }
    if (!res || res.ok !== true) {
      return { ok: false, code: 'ILLEGAL_ACTION', msg: (res && res.error) || '这个动作不合法' };
    }
    this.#pump();
    return { ok: true };
  }

  /**
   * 处理一次引擎状态推进：广播新事件 -> 结算或重置计时器 -> 广播状态
   * @param {{silent?:boolean}} [opts] silent 时不广播状态（由调用方稍后统一广播）
   */
  #pump(opts = {}) {
    this.#flushEvents();
    if (this.hand && this.hand.isComplete) {
      if (!this.handFinished) this.#finishHand();
    } else {
      this.#resetActionTimer();
    }
    if (!opts.silent) this.broadcast();
  }

  /** 把引擎新产生的事件写进日志并推送给所有客户端 */
  #flushEvents() {
    const evts = this.hand?.events;
    if (!Array.isArray(evts)) return;
    while (this.eventCursor < evts.length) {
      const raw = evts[this.eventCursor++];
      if (!raw || typeof raw !== 'object') continue;
      const e = this.#sanitizeEvent(raw);
      if (e.text) this.#pushLog(e.text);
      const out = { t: 'event', kind: e.kind, text: e.text };
      if (e.seat !== undefined && e.seat !== null) out.seat = e.seat;
      if (e.amount !== undefined && e.amount !== null) out.amount = e.amount;
      for (const c of this.clients) {
        if (c.playerId) c.send(out);
      }
    }
  }

  /**
   * 安全兜底：deal 事件可能带有底牌信息，统一改写成不含牌面的中文文案，
   * 保证任何时候都不会通过事件广播泄露未揭示的底牌。
   */
  #sanitizeEvent(e) {
    if (e.kind === 'deal') {
      return { kind: 'deal', seat: e.seat, amount: null, text: '发底牌' };
    }
    return {
      kind: e.kind,
      seat: e.seat,
      amount: e.amount,
      text: typeof e.text === 'string' ? e.text : '',
    };
  }

  /** 结算：回写筹码、进入 handOver、安排下一手 */
  #finishHand() {
    this.handFinished = true;
    this.#cancelBot();
    this.#clearActionTimer();
    let result = null;
    try {
      result = this.hand.result;
    } catch (e) {
      console.error('[room] 读取结算结果失败', e);
    }
    this.result = result || null;
    if (result && result.chipsAfter) {
      for (const [key, chips] of Object.entries(result.chipsAfter)) {
        const seat = Number(key);
        const ownerId = this.handSeatOwners.get(seat);
        // 只有本手牌开局时占据该座位、且现在还在座位上的玩家才能拿到筹码
        if (!ownerId || this.seats[seat] !== ownerId) continue;
        const p = this.players.get(ownerId);
        if (p && Number.isFinite(chips)) p.chips = Math.max(0, Math.floor(chips));
      }
    }
    this.#scheduleNextHand();
  }

  /**
   * 牌桌前面还有没有人。
   *
   * 人机没有连接，所以 clients 里全是真人（在座的或纯观战的）。
   * 一个连接都没有 = 没有任何人在看，这时候还继续自动开局的话，
   * 一桌人机会自己打到进程重启为止——接了 LLM 就是持续烧钱。
   */
  #hasAudience() {
    return this.clients.size > 0;
  }

  #scheduleNextHand() {
    this.#clearNextHandTimer();
    if (!this.config.autoNextHand) return;
    if (this.#eligiblePlayers().length < 2) return;
    // 没人看就不开新的一手。等有人连上来（hello）会重新触发。
    if (!this.#hasAudience()) return;
    const delay = this.config.autoNextHandMs;
    this.nextHandAt = Date.now() + delay;
    this.nextHandTimer = setTimeout(() => {
      this.nextHandTimer = null;
      this.nextHandAt = null;
      // 等待期间人可能全走了，落地前再确认一次
      if (this.#eligiblePlayers().length >= 2 && !this.#handLive() && this.#hasAudience()) {
        this.startHand();
      } else {
        this.broadcast();
      }
    }, delay);
    this.nextHandTimer.unref?.();
  }

  /** 有人补筹码 / 回座后，若正处于等待状态且人够了，自动安排下一手 */
  #maybeAutoStart() {
    if (this.#handLive()) return;
    if (this.nextHandTimer) return;
    if (!this.config.autoNextHand) return;
    if (this.#eligiblePlayers().length < 2) return;
    this.#scheduleNextHand();
  }

  // ==================== 计时器 ====================

  #clearActionTimer() {
    if (this.actionTimer) {
      clearTimeout(this.actionTimer);
      this.actionTimer = null;
    }
    this.actionDeadline = null;
  }

  #clearNextHandTimer() {
    if (this.nextHandTimer) {
      clearTimeout(this.nextHandTimer);
      this.nextHandTimer = null;
    }
    this.nextHandAt = null;
  }

  /** 每次行动者变化都重置行动计时器 */
  #resetActionTimer() {
    this.#clearActionTimer();
    if (!this.#handLive()) return;
    const seat = this.hand.actingSeat;
    if (seat === null || seat === undefined) return;
    const handNo = this.hand.handNo;
    const ms = this.config.actionTimeoutMs;
    this.actionDeadline = Date.now() + ms;
    this.actionTimer = setTimeout(() => {
      this.actionTimer = null;
      this.actionDeadline = null;
      this.#onActionTimeout(handNo, seat);
    }, ms);
    this.actionTimer.unref?.();

    // 轮到人机就让它开始思考。超时计时器照常跑着——人机卡住时
    // 会被和真人一样的超时逻辑接管，不需要额外的保险。
    this.#maybeTriggerBot();
  }

  #onActionTimeout(handNo, seat) {
    if (!this.#handLive()) return;
    if (this.hand.handNo !== handNo) return;
    if (this.hand.actingSeat !== seat) {
      this.#resetActionTimer();
      return;
    }
    try {
      const res = this.hand.timeoutAction(seat);
      if (!res || res.ok !== true) {
        console.error('[room] 超时动作失败', res && res.error);
      }
    } catch (e) {
      console.error('[room] 超时动作抛错', e);
    }
    this.#pump();
  }

  // ==================== 日志 / 广播 ====================

  #pushLog(text) {
    if (!text) return;
    this.log.push({ ts: Date.now(), text: String(text) });
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);
  }

  /** 给每个连接单独生成脱敏快照（每人看到的底牌不同） */
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

  /** 只给一个连接发快照 */
  sendStateTo(client) {
    if (!client.playerId) return;
    client.send(this.buildStateFor(client.playerId));
  }

  /** 当前应展示的阶段 */
  get phase() {
    if (!this.hand) return PHASES.WAITING;
    return this.hand.isComplete ? PHASES.HAND_OVER : this.hand.phase;
  }

  /** 摊牌中被揭示的座位集合（只有这些座位的底牌可以下发给别人） */
  #revealedSeats() {
    const set = new Set();
    const sd = this.result?.showdown;
    if (Array.isArray(sd)) {
      for (const e of sd) {
        if (e && Number.isInteger(e.seat)) set.add(e.seat);
      }
    }
    // 主动亮牌的座位也算揭示。只在 handOver 阶段生效，
    // 下一手 startHand() 会清空 shownSeats。
    for (const s of this.shownSeats) set.add(s);
    return set;
  }

  /**
   * 生成 SPEC §8.3 的脱敏状态快照。
   * 安全红线：除 viewer 本人以外，只有 result.showdown 里被揭示的座位才下发真实底牌，
   * 其余一律 ["??","??"]。
   * @param {string|null} viewerPlayerId
   */
  buildStateFor(viewerPlayerId) {
    const viewer = viewerPlayerId ? this.players.get(viewerPlayerId) || null : null;
    const hand = this.hand;
    const live = this.#handLive();
    const revealed = this.#revealedSeats();
    const handPlayers = hand?.players instanceof Map ? hand.players : null;

    const seats = new Array(MAX_SEATS).fill(null);
    for (let s = 0; s < MAX_SEATS; s++) {
      const id = this.seats[s];
      if (!id) continue;
      const p = this.players.get(id);
      if (!p) continue;
      // 只有本手牌开局时就在这个座位上的人，才对应引擎里的运行时数据
      const inThisHand = this.handSeatOwners.get(s) === p.id;
      const hp = inThisHand && handPlayers ? handPlayers.get(s) || null : null;

      let state;
      if (hp) {
        if (hp.folded) state = SEAT_STATE.FOLDED;
        else if (hp.allIn) state = SEAT_STATE.ALLIN;
        else state = SEAT_STATE.IN;
      } else if (p.sittingOut) {
        state = SEAT_STATE.SITTING_OUT;
      } else {
        state = SEAT_STATE.SITTING;
      }

      let cards = null;
      if (hp && Array.isArray(hp.holeCards) && hp.holeCards.length === 2) {
        if (viewer && viewer.id === p.id) {
          cards = [...hp.holeCards];
        } else if (revealed.has(s)) {
          // 摊牌揭示的以 result.showdown 为准；主动亮牌的座位不在 showdown 里
          // （没摊牌就赢了），这时回退到引擎里的底牌。
          const entry = this.result?.showdown?.find((e) => e && e.seat === s);
          cards = Array.isArray(entry?.cards) ? [...entry.cards] : [...hp.holeCards];
        } else {
          cards = ['??', '??'];
        }
      }

      // wonThisHand 只统计「从底池赢到的」金额，不含未被跟注而退还给自己的下注，
      // 否则一个下注没人跟、拿回自己筹码的玩家会被显示成赢了钱。
      const payout = Array.isArray(this.result?.winners)
        ? this.result.winners.reduce((sum, w) => (w && w.seat === s ? sum + (w.amount || 0) : sum), 0)
        : 0;
      const showdownEntry = revealed.has(s)
        ? this.result.showdown.find((e) => e && e.seat === s)
        : null;

      seats[s] = {
        seat: s,
        name: p.name,
        avatar: p.avatar || makeAvatar(p.name || '?'),
        chips: hp ? hp.chips : p.chips,
        committedRound: hp ? hp.committedRound : 0,
        committedTotal: hp ? hp.committedTotal : 0,
        state,
        connected: !!p.connected,
        isHost: !!p.isHost,
        bot: !!p.bot,
        sittingOut: !!p.sittingOut,
        isButton: this.handNo > 0 && s === this.buttonSeat,
        isSB: !!hand && s === this.sbSeat,
        isBB: !!hand && s === this.bbSeat,
        cards,
        lastAction: hp && hp.lastAction
          ? { type: hp.lastAction.type, amount: hp.lastAction.amount ?? 0, label: actionLabel(hp.lastAction) }
          : null,
        wonThisHand: Number.isFinite(payout) ? payout : 0,
        isWinner: Array.isArray(this.result?.winners)
          ? this.result.winners.some((w) => w && w.seat === s)
          : false,
        handName: showdownEntry?.handName ?? null,
      };
    }

    // 自己的信息
    const mySeat = viewer && viewer.seat !== null ? viewer.seat : null;
    const myHp = mySeat !== null && handPlayers && this.handSeatOwners.get(mySeat) === viewer.id
      ? handPlayers.get(mySeat) || null
      : null;
    let legal = null;
    if (live && myHp && hand.actingSeat === mySeat) {
      try {
        legal = hand.legalActions(mySeat) || null;
      } catch (e) {
        console.error('[room] legalActions 失败', e);
        legal = null;
      }
    }

    const you = {
      playerId: viewer ? viewer.id : null,
      seat: mySeat,
      isHost: !!(viewer && viewer.isHost),
      sittingOut: !!(viewer && viewer.sittingOut),
      cards: myHp && Array.isArray(myHp.holeCards) ? [...myHp.holeCards] : null,
      legal,
      canShowCards: this.#canShowCards(viewer),
    };

    let seatedCount = 0;
    for (const id of this.seats) if (id) seatedCount++;

    const table = {
      phase: this.phase,
      handNo: this.handNo,
      buttonSeat: this.buttonSeat,
      board: hand && Array.isArray(hand.board) ? [...hand.board] : [],
      pots: hand && Array.isArray(hand.pots)
        ? hand.pots.map((pot) => ({
            amount: pot.amount,
            eligibleSeats: Array.isArray(pot.eligibleSeats) ? [...pot.eligibleSeats] : [],
          }))
        : [],
      totalPot: hand ? hand.totalPot || 0 : 0,
      currentBet: live ? hand.currentBet || 0 : 0,
      minRaiseTo: live ? hand.minRaiseTo || 0 : 0,
      actingSeat: live ? (hand.actingSeat ?? null) : null,
      actionDeadline: live ? this.actionDeadline : null,
      nextHandAt: this.nextHandAt,
      canStart: !live && this.#eligiblePlayers().length >= 2,
      seatedCount,
    };

    return {
      t: 'state',
      serverNow: Date.now(),
      config: { ...this.config },
      // 人机后端状态。botDriver.status() 已经脱敏（只有打码后的 key），
      // 这里再收一道：打码后的尾 4 位只给房主看，其他人只需要知道有没有启用。
      bot: this.#botInfoFor(viewer),
      table,
      seats,
      you,
      result: this.#publicResult(),
      log: this.log.slice(-MAX_LOG),
      chat: this.chat.slice(-MAX_CHAT),
    };
  }

  /**
   * 下发给某个观看者的人机后端信息。
   * 真实 apiKey 永远不在这里；打码后的尾 4 位也只给房主，
   * 其他人只需要知道人机是不是接了大模型。
   */
  #botInfoFor(viewer) {
    if (!this.botDriver) return { hasLLM: false, providers: [] };
    const st = this.botDriver.status();
    if (viewer?.isHost) return st;
    return {
      hasLLM: st.hasLLM,
      providers: st.providers.map((p) => ({
        provider: p.provider,
        label: p.label,
        model: p.model,
        cooling: p.cooling,
      })),
    };
  }

  /** handOver 阶段的结算结果，winner 上补一个 name 字段（SPEC §8.3） */
  #publicResult() {
    if (!this.result || this.phase !== PHASES.HAND_OVER) return null;
    const r = this.result;
    const nameOf = (seat) => {
      const ownerId = this.handSeatOwners.get(seat);
      const p = ownerId ? this.players.get(ownerId) : null;
      if (p) return p.name;
      const hp = this.hand?.players?.get?.(seat);
      return hp?.name || '';
    };
    return {
      payouts: { ...(r.payouts || {}) },
      chipsAfter: { ...(r.chipsAfter || {}) },
      winners: Array.isArray(r.winners)
        ? r.winners.map((w) => ({ ...w, name: nameOf(w.seat) }))
        : [],
      showdown: Array.isArray(r.showdown)
        ? r.showdown.map((e) => ({ ...e, name: nameOf(e.seat) }))
        : [],
      uncalledReturned: r.uncalledReturned || null,
      wentToShowdown: !!r.wentToShowdown,
    };
  }

  /** 关闭房间：清掉所有计时器 */
  shutdown() {
    this.#cancelBot();
    this.#clearActionTimer();
    this.#clearNextHandTimer();
    for (const p of this.players.values()) this.#clearDropTimer(p);
  }
}

export default Room;
