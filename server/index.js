// SPDX-License-Identifier: GPL-3.0-or-later
// HTTP 静态服务 + WebSocket 入口（SPEC §9 与 §8）
//
// 只有一张桌子，进程内内存状态。
// 这里负责：静态文件、/healthz、/ws 握手、协议层输入校验、限流、心跳、优雅退出。
// 具体的牌桌逻辑全部在 room.js。

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Room } from './room.js';
import { MAX_SEATS } from './protocol.js';
import { BotDriver } from './bot/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

const PORT = Number(process.env.PORT) || 8080;
const HOST = '0.0.0.0';

/** 限流：单连接每秒最多 20 条消息 */
const RATE_WINDOW_MS = 1000;
const RATE_MAX = 20;
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
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

// 人机驱动：没配任何 LLM key 也能构造成功，只是所有人机退化成规则策略。
const botDriver = new BotDriver();
console.log(`[bot] 人机后端：${botDriver.describe()}`);

const room = new Room({ botDriver });

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
      // HTML 不缓存，其余短缓存
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=60',
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

// ==================== WebSocket ====================

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

server.on('upgrade', (req, socket, head) => {
  let pathname;
  try {
    pathname = new URL(req.url || '/', 'http://localhost').pathname;
  } catch {
    socket.destroy();
    return;
  }
  if (pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  const client = {
    ws,
    playerId: null,
    lastSeen: Date.now(),
    rateStart: Date.now(),
    rateCount: 0,
    rateWarned: false,
    send(obj) {
      if (ws.readyState !== ws.OPEN) return;
      try {
        ws.send(JSON.stringify(obj));
      } catch (err) {
        logError('[ws] 发送失败', err);
      }
    },
    close() {
      try {
        ws.close();
      } catch { /* 忽略 */ }
    },
  };
  room.attach(client);

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

    // 限流
    const now = Date.now();
    if (now - client.rateStart >= RATE_WINDOW_MS) {
      client.rateStart = now;
      client.rateCount = 0;
      client.rateWarned = false;
    }
    client.rateCount += 1;
    if (client.rateCount > RATE_MAX) {
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

    try {
      handleMessage(client, msg, fail);
    } catch (err) {
      logError('[ws] 处理消息出错', msg.t, err);
      fail('ILLEGAL_ACTION', '服务器无法处理这条消息');
    }
  });

  ws.on('error', (err) => {
    logError('[ws] 连接错误', err?.message || err);
  });

  ws.on('close', () => {
    room.detach(client);
  });
});

/** 把 room 方法的返回值转成 error 消息 */
function reply(client, res) {
  if (res && res.ok === false) {
    client.send({ t: 'error', code: res.code || 'ILLEGAL_ACTION', msg: res.msg || '操作失败' });
  }
}

function handleMessage(client, msg, fail) {
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

// 心跳：每 30s 给所有连接发一次 ping；超过 60s 没有任何响应（pong 或业务消息）就断开
const heartbeat = setInterval(() => {
  const now = Date.now();
  for (const c of [...room.clients]) {
    if (now - c.lastSeen > HEARTBEAT_TIMEOUT_MS) {
      try {
        c.ws.terminate();
      } catch { /* 忽略 */ }
      room.detach(c);
      continue;
    }
    if (c.ws.readyState !== c.ws.OPEN) continue;
    try {
      c.ws.ping();
    } catch { /* 忽略 */ }
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
    for (const ws of wss.clients) {
      try {
        ws.close(1001, 'server shutdown');
      } catch { /* 忽略 */ }
    }
    wss.close(() => {});
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
});

export { server, wss, room };
