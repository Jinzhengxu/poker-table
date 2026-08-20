// SPDX-License-Identifier: GPL-3.0-or-later
// HTTP 静态服务 + WebSocket 入口（SPEC §9 与 §8）
//
// 两张桌子，都是进程内内存状态：/ws 是德州扑克，/gd 是掼蛋。
// 这里负责：静态文件、/healthz、WebSocket 握手、协议层输入校验、限流、心跳、优雅退出。
// 具体的牌桌逻辑在 room.js 与 guandan/room.js。

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Room } from './room.js';
import { MAX_SEATS } from './protocol.js';
import { BotDriver } from './bot/index.js';
import { GuandanRoom } from './guandan/room.js';
import { GD_SEATS } from './guandan/engine.js';
import { configFromEnv, guandanConfigFromEnv, voiceConfigFromEnv } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

const PORT = Number(process.env.PORT) || 8080;
const HOST = '0.0.0.0';

// 限流分两个桶。
// 先按【总条数】拦一道（在 JSON.parse 之前，最便宜），再按【类型】收紧：
// 牌桌动作仍然是每秒 20 条，语音信令单独走大桶——建连那两秒 ICE candidate
// 是成串涌出来的，7 个对端一起打洞的话 20 条根本不够，会把语音卡死在连接中。
const RATE_WINDOW_MS = 1000;
const RATE_MAX = 20;
const RATE_MAX_TOTAL = 160;
/** 心跳：30s 一次 ping，60s 没有任何响应就断开 */
const HEARTBEAT_MS = 30000;
const HEARTBEAT_TIMEOUT_MS = 60000;
/** 单条消息最大字节数 */
const MAX_MESSAGE_BYTES = 16 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

// 人机驱动：没配任何 LLM key 也能构造成功，只是所有人机退化成规则策略。
const botDriver = new BotDriver();
console.log(`[bot] 人机后端：${botDriver.describe()}`);

// 牌桌初始配置：代码默认值 -> 环境变量覆盖。房主之后仍可在设置页改，
// 但那是内存态，重启后回到这里算出来的值。
const initialConfig = configFromEnv();
console.log(
  `[config] 牌桌初始设置：盲注 ${initialConfig.smallBlind}/${initialConfig.bigBlind}，` +
  `前注 ${initialConfig.ante}，起始筹码 ${initialConfig.startingStack}，` +
  `行动时限 ${initialConfig.actionTimeoutMs / 1000}s`
);

// 语音连麦。两张桌子各建一个频道，成员表分开存，信令也只在各自的连接集合里转，
// 所以在德州桌说的话，掼蛋桌那边永远听不到。
const voiceConfig = voiceConfigFromEnv();
if (voiceConfig.enabled) {
  const stunCount = voiceConfig.iceServers
    .filter((s) => /^stuns?:/i.test([].concat(s.urls)[0] || ''))
    .reduce((n, s) => n + [].concat(s.urls).length, 0);
  console.log(
    `[voice] 语音连麦已开启：每桌最多 ${voiceConfig.maxMembers} 人上麦，` +
    `${stunCount ? `STUN ${stunCount} 个` : '没有配 STUN，只能局域网内直连'}`
  );
  if (voiceConfig.turn) {
    const mode = voiceConfig.turn.secret
      ? `临时凭据（每次上麦现签，有效期 ${voiceConfig.turn.ttlSec}s）`
      : '固定账号密码';
    console.log(`[voice] TURN 中转已配置：${voiceConfig.turn.urls.join('，')} —— ${mode}`);
  } else {
    // 这不是可有可无的提示：没有 TURN，异地的两个人多半就是"上麦成功却互相听不见"。
    // 那种失败在页面上只表现成一句"连不通"，不在启动日志里说清楚就没人查得到。
    console.warn(
      '[voice] ⚠ 没有配 TURN 中转。两边都在运营商大内网（CGNAT）里就会打不通，' +
      '表现是上麦成功、名单里有人、但互相听不见。自建 coturn 见 README「语音连麦」一节。'
    );
  }
} else {
  console.log('[voice] 语音连麦已关闭（POKER_VOICE=off）');
}
// iceFor 是个函数：TURN 临时凭据必须每次上麦现签，不能算一次存下来
const voiceOpts = { enabled: voiceConfig.enabled, max: voiceConfig.maxMembers, iceServers: voiceConfig.iceFor };

const room = new Room({ botDriver, config: initialConfig, voice: voiceOpts });

// 掼蛋是完全独立的第二张桌子：另一个 WebSocket 路径、另一份内存状态。
// 两张桌子互不影响，同一个人可以同时开两个标签页分别玩。
const guandanConfig = guandanConfigFromEnv();
const guandanRoom = new GuandanRoom({ config: guandanConfig, voice: voiceOpts });
console.log(
  `[guandan] 掼蛋牌桌已就绪：行动时限 ${guandanConfig.actionTimeoutMs / 1000}s，` +
  `下一局间隔 ${guandanConfig.autoNextDealMs / 1000}s`
);

// ==================== HTTP ====================

function sendText(res, status, body, type = 'text/plain; charset=utf-8') {
  const buf = Buffer.from(body);
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

/**
 * 把请求路径解析成 public/ 下的绝对路径，防目录穿越。
 * @returns {string|null} 越界时返回 null
 */
function resolveStatic(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  if (decoded.endsWith('/')) decoded += 'index.html';
  // 先归一化，再确认结果确实落在 PUBLIC_DIR 内部
  const full = path.resolve(PUBLIC_DIR, '.' + path.posix.normalize(decoded));
  if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + path.sep)) return null;
  return full;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendText(res, 405, '不支持的请求方法');
      return;
    }
    let pathname;
    try {
      pathname = new URL(req.url || '/', 'http://localhost').pathname;
    } catch {
      sendText(res, 400, '请求地址不合法');
      return;
    }

    if (pathname === '/healthz') {
      sendText(res, 200, 'ok');
      return;
    }

    // 掼蛋页面给一个好记的短地址
    if (pathname === '/guandan' || pathname === '/gd') pathname = '/guandan.html';

    const filePath = resolveStatic(pathname === '/' ? '/index.html' : pathname);
    if (!filePath) {
      sendText(res, 403, '禁止访问');
      return;
    }

    let data;
    try {
      data = await readFile(filePath);
    } catch {
      sendText(res, 404, '页面不存在');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const headers = {
      'Content-Type': type,
      'Content-Length': data.length,
      // HTML 不缓存；音频是几 MB 的固定资源，缓一天，不然每分钟重下一次背景音乐；其余短缓存
      'Cache-Control': ext === '.html'
        ? 'no-cache'
        : (ext === '.mp3' ? 'public, max-age=86400' : 'public, max-age=60'),
      'X-Content-Type-Options': 'nosniff',
    };
    res.writeHead(200, headers);
    if (req.method === 'HEAD') res.end();
    else res.end(data);
  } catch (err) {
    logError('[http] 处理请求出错', err);
    try {
      sendText(res, 500, '服务器内部错误');
    } catch { /* 响应可能已经发出 */ }
  }
});

// ==================== 输入校验 ====================

function isInt(v) {
  return typeof v === 'number' && Number.isInteger(v);
}

/** seat 必须是 0..7 的整数 */
function validSeat(v) {
  return isInt(v) && v >= 0 && v < MAX_SEATS;
}

/** amount 必须是非负整数 */
function validAmount(v) {
  return isInt(v) && v >= 0;
}

/** 昵称：去空白后 1..12 字符 */
function normalizeName(v) {
  if (typeof v !== 'string') return null;
  // 去掉控制字符，折叠空白
  const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  const len = [...s].length;
  if (len < 1 || len > 12) return null;
  return s;
}

const ACTION_TYPES = new Set(['fold', 'check', 'call', 'bet', 'raise', 'allin']);

// ==================== 语音连麦 ====================

/** 走"语音大桶"的消息类型（见上面的限流说明） */
const VOICE_TYPES = new Set(['voiceJoin', 'voiceLeave', 'voiceMute', 'voiceSignal']);

/** playerId 的形状，room.js 里是 'p_' + 6 位十六进制 */
const PLAYER_ID_RE = /^[pb]_[0-9a-f]{6}$/;

/**
 * 两张桌子共用的语音消息处理。
 *
 * 注意这里的 `channel` 是【调用方传进来的】——德州桌传德州的频道，掼蛋桌传掼蛋的，
 * 不存在一个全局频道让人挑。这就是"两边语音分开"这件事的落点。
 *
 * @returns {boolean} 这条消息是不是语音消息（是的话已经处理完了）
 */
function handleVoiceMessage(channel, client, msg, fail) {
  if (!VOICE_TYPES.has(msg.t)) return false;

  const reply = (res) => {
    if (res && res.ok === false) {
      client.send({ t: 'error', code: res.code || 'ILLEGAL_ACTION', msg: res.msg || '操作失败' });
    }
  };

  switch (msg.t) {
    case 'voiceJoin':
      reply(channel.join(client));
      return true;
    case 'voiceLeave':
      reply(channel.leave(client));
      return true;
    case 'voiceMute':
      reply(channel.setMuted(client, !!msg.value));
      return true;
    case 'voiceSignal': {
      if (typeof msg.to !== 'string' || !PLAYER_ID_RE.test(msg.to)) {
        fail('ILLEGAL_ACTION', '信令的收件人不合法');
        return true;
      }
      // data 的细节交给 voice.js 校验：服务端不解析 SDP，只管住形状和大小
      reply(channel.signal(client, msg.to, msg.data));
      return true;
    }
    default:
      return false;
  }
}

// ==================== WebSocket ====================

// 两张桌子各有一个 WebSocketServer：/ws 是德州，/gd 是掼蛋。
// 连接管理、限流、心跳、消息解析这一层是共用的，只有 dispatch 不同。
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
const gdWss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

/** 路径 -> 该路径对应的 WebSocketServer */
const WS_ROUTES = new Map([
  ['/ws', wss],
  ['/gd', gdWss],
]);

server.on('upgrade', (req, socket, head) => {
  let pathname;
  try {
    pathname = new URL(req.url || '/', 'http://localhost').pathname;
  } catch {
    socket.destroy();
    return;
  }
  const target = WS_ROUTES.get(pathname);
  if (!target) {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  target.handleUpgrade(req, socket, head, (ws) => {
    target.emit('connection', ws, req);
  });
});

/**
 * 把一条 ws 连接包装成房间认识的"客户端"对象，并接上限流与消息分发。
 * @param {import('ws').WebSocket} ws
 * @param {{attach:Function, detach:Function}} targetRoom 这条连接属于哪张桌子
 * @param {(client:object, msg:object, fail:Function)=>void} dispatch 该桌子的消息处理器
 * @param {string} tag 日志前缀
 */
function attachConnection(ws, targetRoom, dispatch, tag) {
  const client = {
    ws,
    playerId: null,
    lastSeen: Date.now(),
    rateStart: Date.now(),
    rateCount: 0,
    gameCount: 0,
    rateWarned: false,
    send(obj) {
      if (ws.readyState !== ws.OPEN) return;
      try {
        ws.send(JSON.stringify(obj));
      } catch (err) {
        logError(`${tag} 发送失败`, err);
      }
    },
    close() {
      try {
        ws.close();
      } catch { /* 忽略 */ }
    },
  };
  targetRoom.attach(client);

  const fail = (code, msg) => client.send({ t: 'error', code, msg });

  ws.on('pong', () => {
    client.lastSeen = Date.now();
  });

  ws.on('message', (data, isBinary) => {
    client.lastSeen = Date.now();
    if (isBinary) {
      fail('ILLEGAL_ACTION', '不支持二进制消息');
      return;
    }

    // 限流第一道：总条数。放在 parse 前面，最省。
    const now = Date.now();
    if (now - client.rateStart >= RATE_WINDOW_MS) {
      client.rateStart = now;
      client.rateCount = 0;
      client.gameCount = 0;
      client.rateWarned = false;
    }
    client.rateCount += 1;
    if (client.rateCount > RATE_MAX_TOTAL) {
      if (!client.rateWarned) {
        client.rateWarned = true;
        fail('RATE_LIMIT', '操作太快了，请稍后再试');
      }
      return;
    }

    const raw = data.toString();
    if (raw.length > MAX_MESSAGE_BYTES) {
      fail('ILLEGAL_ACTION', '消息太长');
      return;
    }
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      fail('ILLEGAL_ACTION', '消息格式错误');
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') {
      fail('ILLEGAL_ACTION', '消息格式错误');
      return;
    }

    // 限流第二道：牌桌动作仍然守着每秒 20 条这条线，语音信令不算在内
    if (!VOICE_TYPES.has(msg.t)) {
      client.gameCount = (client.gameCount || 0) + 1;
      if (client.gameCount > RATE_MAX) {
        if (!client.rateWarned) {
          client.rateWarned = true;
          fail('RATE_LIMIT', '操作太快了，请稍后再试');
        }
        return;
      }
    }

    try {
      dispatch(client, msg, fail);
    } catch (err) {
      logError(`${tag} 处理消息出错`, msg.t, err);
      fail('ILLEGAL_ACTION', '服务器无法处理这条消息');
    }
  });

  ws.on('error', (err) => {
    logError(`${tag} 连接错误`, err?.message || err);
  });

  ws.on('close', () => {
    targetRoom.detach(client);
  });
}

wss.on('connection', (ws) => attachConnection(ws, room, handleMessage, '[ws]'));
gdWss.on('connection', (ws) => attachConnection(ws, guandanRoom, handleGuandanMessage, '[gd]'));

/** 把 room 方法的返回值转成 error 消息 */
function reply(client, res) {
  if (res && res.ok === false) {
    client.send({ t: 'error', code: res.code || 'ILLEGAL_ACTION', msg: res.msg || '操作失败' });
  }
}

function handleMessage(client, msg, fail) {
  if (handleVoiceMessage(room.voice, client, msg, fail)) return;
  switch (msg.t) {
    case 'hello': {
      const token = typeof msg.token === 'string' ? msg.token : null;
      room.hello(client, token);
      return;
    }
    case 'ping': {
      client.send({ t: 'pong' });
      return;
    }
    case 'sit': {
      if (!validSeat(msg.seat)) return fail('ILLEGAL_ACTION', '座位号不合法');
      const name = normalizeName(msg.name);
      if (name === null) return fail('NAME_INVALID', '昵称需要 1 到 12 个字符');
      return reply(client, room.sit(client, msg.seat, name));
    }
    case 'stand':
      return reply(client, room.stand(client));
    case 'start':
      return reply(client, room.start(client));
    case 'action': {
      if (typeof msg.type !== 'string' || !ACTION_TYPES.has(msg.type)) {
        return fail('ILLEGAL_ACTION', '动作类型不合法');
      }
      if (msg.amount !== undefined && msg.amount !== null && !validAmount(msg.amount)) {
        return fail('ILLEGAL_ACTION', '金额必须是非负整数');
      }
      if (msg.handNo !== undefined && msg.handNo !== null && !isInt(msg.handNo)) {
        return fail('ILLEGAL_ACTION', '手牌编号不合法');
      }
      return reply(client, room.action(client, msg));
    }
    case 'sitOut':
      return reply(client, room.sitOut(client, !!msg.value));
    case 'config': {
      if (!msg.patch || typeof msg.patch !== 'object' || Array.isArray(msg.patch)) {
        return fail('ILLEGAL_ACTION', '配置格式错误');
      }
      return reply(client, room.setConfig(client, msg.patch));
    }
    case 'addChips': {
      if (!validSeat(msg.seat)) return fail('ILLEGAL_ACTION', '座位号不合法');
      if (!validAmount(msg.amount)) return fail('ILLEGAL_ACTION', '金额必须是非负整数');
      return reply(client, room.addChips(client, msg.seat, msg.amount));
    }
    case 'kick': {
      if (!validSeat(msg.seat)) return fail('ILLEGAL_ACTION', '座位号不合法');
      return reply(client, room.kick(client, msg.seat));
    }
    case 'showCards':
      return reply(client, room.showCards(client));
    case 'botConfig': {
      if (!msg.patch || typeof msg.patch !== 'object' || Array.isArray(msg.patch)) {
        return fail('ILLEGAL_ACTION', '配置格式错误');
      }
      // key 可能很长，但也不该无限长
      if (msg.patch.apiKey !== undefined && typeof msg.patch.apiKey !== 'string') {
        return fail('ILLEGAL_ACTION', 'apiKey 必须是字符串');
      }
      if (typeof msg.patch.apiKey === 'string' && msg.patch.apiKey.length > 400) {
        return fail('ILLEGAL_ACTION', 'apiKey 过长');
      }
      return reply(client, room.setBotConfig(client, msg.patch));
    }
    case 'addBot': {
      // seat 可省略，表示"随便找个空位"
      if (msg.seat !== undefined && msg.seat !== null && !validSeat(msg.seat)) {
        return fail('ILLEGAL_ACTION', '座位号不合法');
      }
      return reply(client, room.addBot(client, msg.seat ?? null));
    }
    case 'reset':
      return reply(client, room.reset(client));
    case 'chat': {
      if (typeof msg.text !== 'string') return fail('ILLEGAL_ACTION', '聊天内容不合法');
      if ([...msg.text].length > 200) return fail('ILLEGAL_ACTION', '消息最长 200 字');
      return reply(client, room.sendChat(client, msg.text));
    }
    default:
      return fail('ILLEGAL_ACTION', '未知的消息类型');
  }
}

// ==================== 掼蛋消息处理 ====================

/** 一张掼蛋牌：点数+花色，或 jb（小王）/ jr（大王） */
const GD_CARD_RE = /^([23456789TJQKA][cdhs]|jb|jr)$/;

/** GD_SEATS 个座位，0..3 */
function validGdSeat(v) {
  return isInt(v) && v >= 0 && v < GD_SEATS;
}

/** cards 必须是 1..27 张合法牌 */
function validCards(v) {
  if (!Array.isArray(v) || v.length < 1 || v.length > 27) return false;
  return v.every((c) => typeof c === 'string' && GD_CARD_RE.test(c));
}

const GD_COMBO_TYPES = new Set([
  'single', 'pair', 'triple', 'full', 'straight', 'tube', 'plate', 'bomb', 'sflush', 'jokers',
]);

/** as：前端声明的牌型。可以不传（服务端自己挑），传了就必须长得对 */
function validDeclared(v) {
  if (v === undefined || v === null) return true;
  if (typeof v !== 'object' || Array.isArray(v)) return false;
  return GD_COMBO_TYPES.has(v.type) && isInt(v.rank) && isInt(v.size)
    && v.rank >= 0 && v.rank <= 100 && v.size >= 1 && v.size <= 27;
}

function handleGuandanMessage(client, msg, fail) {
  if (handleVoiceMessage(guandanRoom.voice, client, msg, fail)) return;
  const reply = (res) => {
    if (res && res.ok === false) {
      client.send({ t: 'error', code: res.code || 'ILLEGAL_ACTION', msg: res.msg || '操作失败' });
    }
  };

  switch (msg.t) {
    case 'hello': {
      const token = typeof msg.token === 'string' ? msg.token : null;
      guandanRoom.hello(client, token);
      return;
    }
    case 'ping':
      client.send({ t: 'pong' });
      return;
    case 'sit': {
      if (!validGdSeat(msg.seat)) return fail('ILLEGAL_ACTION', '座位号不合法');
      const name = normalizeName(msg.name);
      if (name === null) return fail('NAME_INVALID', '昵称需要 1 到 12 个字符');
      return reply(guandanRoom.sit(client, msg.seat, name));
    }
    case 'stand':
      return reply(guandanRoom.stand(client));
    case 'start':
      return reply(guandanRoom.start(client));
    case 'reset':
      return reply(guandanRoom.reset(client));
    case 'play': {
      if (!validCards(msg.cards)) return fail('ILLEGAL_ACTION', '出的牌不合法');
      if (!validDeclared(msg.as)) return fail('ILLEGAL_ACTION', '牌型声明不合法');
      if (msg.dealNo !== undefined && msg.dealNo !== null && !isInt(msg.dealNo)) {
        return fail('ILLEGAL_ACTION', '局号不合法');
      }
      return reply(guandanRoom.play(client, msg));
    }
    case 'pass': {
      if (msg.dealNo !== undefined && msg.dealNo !== null && !isInt(msg.dealNo)) {
        return fail('ILLEGAL_ACTION', '局号不合法');
      }
      return reply(guandanRoom.pass(client, msg));
    }
    case 'returnTribute': {
      if (typeof msg.card !== 'string' || !GD_CARD_RE.test(msg.card)) {
        return fail('ILLEGAL_ACTION', '还贡的牌不合法');
      }
      return reply(guandanRoom.returnTribute(client, msg.card));
    }
    case 'addBot': {
      if (msg.seat !== undefined && msg.seat !== null && !validGdSeat(msg.seat)) {
        return fail('ILLEGAL_ACTION', '座位号不合法');
      }
      return reply(guandanRoom.addBot(client, msg.seat ?? null));
    }
    case 'kick': {
      if (!validGdSeat(msg.seat)) return fail('ILLEGAL_ACTION', '座位号不合法');
      return reply(guandanRoom.kick(client, msg.seat));
    }
    case 'config': {
      if (!msg.patch || typeof msg.patch !== 'object' || Array.isArray(msg.patch)) {
        return fail('ILLEGAL_ACTION', '配置格式错误');
      }
      return reply(guandanRoom.setConfig(client, msg.patch));
    }
    case 'chat': {
      if (typeof msg.text !== 'string') return fail('ILLEGAL_ACTION', '聊天内容不合法');
      if ([...msg.text].length > 200) return fail('ILLEGAL_ACTION', '消息最长 200 字');
      return reply(guandanRoom.sendChat(client, msg.text));
    }
    default:
      return fail('ILLEGAL_ACTION', '未知的消息类型');
  }
}

// 心跳：每 30s 给所有连接发一次 ping；超过 60s 没有任何响应（pong 或业务消息）就断开
const heartbeat = setInterval(() => {
  const now = Date.now();
  for (const r of [room, guandanRoom]) {
    for (const c of [...r.clients]) {
      if (now - c.lastSeen > HEARTBEAT_TIMEOUT_MS) {
        try {
          c.ws.terminate();
        } catch { /* 忽略 */ }
        r.detach(c);
        continue;
      }
      if (c.ws.readyState !== c.ws.OPEN) continue;
      try {
        c.ws.ping();
      } catch { /* 忽略 */ }
    }
  }
}, HEARTBEAT_MS);
heartbeat.unref?.();

// ==================== 进程级兜底 ====================

// 日志管道断掉（比如父进程退出）不应该拖垮服务
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

/** 永远不会抛异常的日志 */
function log(...args) {
  try {
    console.log(...args);
  } catch { /* 忽略 */ }
}
function logError(...args) {
  try {
    console.error(...args);
  } catch { /* 忽略 */ }
}

process.on('uncaughtException', (err) => {
  logError('[fatal] 未捕获异常', err);
});
process.on('unhandledRejection', (reason) => {
  logError('[fatal] 未处理的 Promise 拒绝', reason);
});

// ==================== 优雅退出 ====================

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  // 先挂上兜底定时器：无论后面出什么岔子，5 秒内一定退出
  const force = setTimeout(() => {
    log('[server] 强制退出');
    process.exit(0);
  }, 5000);
  force.unref?.();

  log(`[server] 收到 ${signal}，正在关闭……`);
  try {
    clearInterval(heartbeat);
    room.shutdown();
    guandanRoom.shutdown();
    for (const server of [wss, gdWss]) {
      for (const ws of server.clients) {
        try {
          ws.close(1001, 'server shutdown');
        } catch { /* 忽略 */ }
      }
      server.close(() => {});
    }
  } catch (err) {
    logError('[server] 关闭时出错', err);
  }
  server.close(() => {
    log('[server] 已关闭');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.on('error', (err) => {
  logError('[server] 监听失败', err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  log(`[server] 德州扑克牌桌已启动： http://${HOST}:${PORT}`);
  log(`[server] 掼蛋牌桌：           http://${HOST}:${PORT}/guandan`);
});

export { server, wss, gdWss, room, guandanRoom };
