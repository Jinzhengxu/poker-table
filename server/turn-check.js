// SPDX-License-Identifier: GPL-3.0-or-later
// TURN / STUN 自检工具。
//
// 为什么需要它：语音打不通的时候，页面上只有一句"连不通"，
// 而中间牵扯到环境变量有没有传进容器、密钥两边对不对得上、
// UDP 端口有没有被防火墙挡住、中转地址报得对不对——
// 光看日志根本分不清是哪一环。这个脚本把这几环挨个走一遍，明说是哪儿断的。
//
// 跑法（在服务器上）：
//     docker exec poker node server/turn-check.js
//
// 它故意走 voiceConfigFromEnv()，也就是和真正下发给浏览器的完全同一条解析路径。
// 所以"这里通过"就等于"浏览器拿到的配置是能用的"，不是另写一份配置去测。
//
// 实现的是 RFC 5389（STUN）+ RFC 5766（TURN）里最小的一条路径：
// Binding 请求问公网地址，Allocate 请求真的去开一条中转通道。
// 开得起来才算数——端口开着但鉴权不过，一样是打不通。

import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { voiceConfigFromEnv } from './config.js';

const MAGIC = 0x2112a442;
const MAGIC_BUF = Buffer.from([0x21, 0x12, 0xa4, 0x42]);

/** 方法号 */
const M_BINDING = 0x001;
const M_ALLOCATE = 0x003;

/** 属性号。只列这个脚本用得到的。 */
const A = {
  USERNAME: 0x0006,
  MESSAGE_INTEGRITY: 0x0008,
  ERROR_CODE: 0x0009,
  LIFETIME: 0x000d,
  REALM: 0x0014,
  NONCE: 0x0015,
  XOR_RELAYED_ADDRESS: 0x0016,
  REQUESTED_TRANSPORT: 0x0019,
  XOR_MAPPED_ADDRESS: 0x0020,
  SOFTWARE: 0x8022,
};

/**
 * STUN 的消息类型把方法号和类别号(请求/成功/错误)拆开塞进同一个 16 位字段，
 * 中间还插着类别位——所以不能简单地按位或，得照着 RFC 5389 §6 摆。
 */
function msgType(method, cls) {
  return ((method & 0x0f80) << 2) | ((method & 0x0070) << 1) | (method & 0x000f)
    | ((cls & 0x2) << 7) | ((cls & 0x1) << 4);
}

/** 属性要 4 字节对齐，不够的补零；补的这几个字节不算进属性自身的长度 */
function padTo4(n) {
  return (4 - (n % 4)) % 4;
}

function encodeAttrs(attrs) {
  const parts = [];
  for (const [type, value] of attrs) {
    const head = Buffer.alloc(4);
    head.writeUInt16BE(type, 0);
    head.writeUInt16BE(value.length, 2);
    parts.push(head, value, Buffer.alloc(padTo4(value.length)));
  }
  return Buffer.concat(parts);
}

function encode(method, cls, txId, attrs) {
  const body = encodeAttrs(attrs);
  const head = Buffer.alloc(20);
  head.writeUInt16BE(msgType(method, cls), 0);
  head.writeUInt16BE(body.length, 2);
  head.writeUInt32BE(MAGIC, 4);
  txId.copy(head, 8);
  return Buffer.concat([head, body]);
}

function decode(buf) {
  if (buf.length < 20) return null;
  const out = { type: buf.readUInt16BE(0), txId: buf.subarray(8, 20), attrs: new Map() };
  const len = buf.readUInt16BE(2);
  let off = 20;
  const end = Math.min(20 + len, buf.length);
  while (off + 4 <= end) {
    const type = buf.readUInt16BE(off);
    const vlen = buf.readUInt16BE(off + 2);
    if (off + 4 + vlen > buf.length) break;
    out.attrs.set(type, buf.subarray(off + 4, off + 4 + vlen));
    off += 4 + vlen + padTo4(vlen);
  }
  return out;
}

/** XOR-MAPPED-ADDRESS / XOR-RELAYED-ADDRESS：地址是和 magic cookie 异或过的 */
function decodeXorAddr(v) {
  if (!v || v.length < 8) return null;
  const family = v[1];
  const port = v.readUInt16BE(2) ^ (MAGIC >>> 16);
  if (family === 0x01) {
    const ip = [];
    for (let i = 0; i < 4; i++) ip.push(v[4 + i] ^ MAGIC_BUF[i]);
    return `${ip.join('.')}:${port}`;
  }
  if (family === 0x02) return `[IPv6]:${port}`;
  return null;
}

function decodeError(v) {
  if (!v || v.length < 4) return { code: 0, reason: '' };
  const code = (v[2] & 0x07) * 100 + v[3];
  return { code, reason: v.subarray(4).toString('utf8') };
}

/**
 * 长期凭据机制的完整性校验（RFC 5389 §15.4）。
 *
 * 两个容易踩的坑，都在这儿处理掉了：
 *   1) 密钥不是密码本身，是 MD5(用户名:realm:密码)；
 *   2) 算 HMAC 的时候，消息头里的长度字段必须【已经把 MESSAGE-INTEGRITY 这个
 *      属性算进去】，但属性本身还没拼上。少算这 24 字节，签出来必然对不上。
 */
function withIntegrity(msg, username, realm, password) {
  const key = createHash('md5').update(`${username}:${realm}:${password}`).digest();
  const withLen = Buffer.from(msg);
  withLen.writeUInt16BE(msg.length - 20 + 24, 2);
  const mac = createHmac('sha1', key).update(withLen).digest();
  const attr = Buffer.alloc(4);
  attr.writeUInt16BE(A.MESSAGE_INTEGRITY, 0);
  attr.writeUInt16BE(20, 2);
  return Buffer.concat([withLen, attr, mac]);
}

/** 发一个包等一个包。超时返回 null，让调用方自己决定怎么说这件事。 */
function rpc(sock, buf, host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; clearTimeout(timer); sock.off('message', onMsg); resolve(v); } };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const onMsg = (m) => finish(m);
    sock.on('message', onMsg);
    sock.send(buf, port, host, (err) => { if (err) finish(null); });
  });
}

/**
 * 解析 turn:host:port?transport=udp 这种地址。
 * 这里只测 UDP——浏览器优先用的就是 UDP，而且 TCP 那条即便通了也不代表
 * UDP 通（防火墙经常只放行 TCP），拿 TCP 的结果去下 UDP 的结论是骗自己。
 */
function parseIceUrl(u) {
  const m = /^(stun|stuns|turn|turns):([^:?/]+)(?::(\d+))?(?:\?(.*))?$/i.exec(u.trim());
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  const params = new URLSearchParams(m[4] || '');
  const transport = (params.get('transport') || 'udp').toLowerCase();
  const port = m[3] ? Number(m[3]) : (scheme === 'stuns' || scheme === 'turns' ? 5349 : 3478);
  return { scheme, host: m[2], port, transport };
}

async function resolve4(host) {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return host;
  const r = await dns.lookup(host, { family: 4 });
  return r.address;
}

// ==================== 单项检查 ====================

async function checkStun(url) {
  const t = parseIceUrl(url);
  if (!t) return { url, ok: false, note: '地址格式不认识' };
  let ip;
  try {
    ip = await resolve4(t.host);
  } catch (e) {
    return { url, ok: false, note: `域名解析失败（${e.code || e.message}）` };
  }
  const sock = dgram.createSocket('udp4');
  try {
    const tx = randomBytes(12);
    const req = encode(M_BINDING, 0, tx, [[A.SOFTWARE, Buffer.from('poker-turn-check')]]);
    const res = await rpc(sock, req, ip, t.port);
    if (!res) return { url, ok: false, note: `${ip}:${t.port} 没有响应（超时）` };
    const msg = decode(res);
    const mapped = decodeXorAddr(msg?.attrs.get(A.XOR_MAPPED_ADDRESS));
    return { url, ok: true, note: `${ip}:${t.port} 有响应，看到我的公网地址是 ${mapped || '（没解析出来）'}` };
  } finally {
    sock.close();
  }
}

/**
 * 真的去开一条中转通道。这是唯一有意义的 TURN 检查——
 * 端口通、密钥错，浏览器一样连不上，而那种情况下 Binding 请求是会成功的。
 */
async function checkTurnAllocate(url, username, password) {
  const t = parseIceUrl(url);
  if (!t) return { url, ok: false, note: '地址格式不认识' };
  if (t.transport !== 'udp') return { url, ok: null, note: '走 TCP，本脚本只测 UDP，跳过' };
  let ip;
  try {
    ip = await resolve4(t.host);
  } catch (e) {
    return { url, ok: false, note: `域名解析失败（${e.code || e.message}）` };
  }

  const sock = dgram.createSocket('udp4');
  try {
    const tx = randomBytes(12);
    // REQUESTED-TRANSPORT：17 是 UDP，写在第一个字节，后面三个字节留空
    const rt = Buffer.alloc(4);
    rt[0] = 17;

    // 第一发必然被拒（401），目的是把服务器的 realm 和 nonce 要过来。
    // 这是长期凭据机制的规定动作，不是出错。
    const probe = encode(M_ALLOCATE, 0, tx, [[A.REQUESTED_TRANSPORT, rt]]);
    const res1 = await rpc(sock, probe, ip, t.port);
    if (!res1) {
      return {
        url,
        ok: false,
        note: `${ip}:${t.port} UDP 没有响应（超时）——多半是防火墙没放行 ${t.port}/udp，或者 coturn 没起来`,
      };
    }
    const m1 = decode(res1);
    const realm = m1?.attrs.get(A.REALM)?.toString('utf8');
    const nonce = m1?.attrs.get(A.NONCE);
    if (!realm || !nonce) {
      const err = decodeError(m1?.attrs.get(A.ERROR_CODE));
      return { url, ok: false, note: `服务器没给 realm/nonce，回的是 ${err.code} ${err.reason}` };
    }

    // 第二发带上凭据。签名细节见 withIntegrity。
    const tx2 = randomBytes(12);
    const base = encode(M_ALLOCATE, 0, tx2, [
      [A.REQUESTED_TRANSPORT, rt],
      [A.USERNAME, Buffer.from(username, 'utf8')],
      [A.REALM, Buffer.from(realm, 'utf8')],
      [A.NONCE, nonce],
    ]);
    const signed = withIntegrity(base, username, realm, password);
    const res2 = await rpc(sock, signed, ip, t.port);
    if (!res2) return { url, ok: false, note: '带凭据的 Allocate 请求超时' };

    const m2 = decode(res2);
    const cls = (m2.type & 0x0110);
    if (cls === 0x0100) {
      const relayed = decodeXorAddr(m2.attrs.get(A.XOR_RELAYED_ADDRESS));
      const lifetime = m2.attrs.get(A.LIFETIME)?.readUInt32BE(0);
      return {
        url,
        ok: true,
        note: `中转通道开成功，服务器分配的中转地址是 ${relayed || '（没解析出来）'}` +
          `${lifetime ? `，有效期 ${lifetime}s` : ''}`,
      };
    }
    const err = decodeError(m2.attrs.get(A.ERROR_CODE));
    let hint = '';
    if (err.code === 401) {
      hint = '——凭据没通过。poker 容器和 coturn 容器的 POKER_TURN_SECRET 大概率不是同一个，' +
        '两边都重启一下（deploy/deploy.sh 会自动对齐）';
    } else if (err.code === 486 || err.code === 508) {
      hint = '——配额用满了，看 docker logs poker-turn';
    }
    return { url, ok: false, note: `Allocate 被拒：${err.code} ${err.reason} ${hint}` };
  } finally {
    sock.close();
  }
}

// ==================== 主流程 ====================

const C = process.stdout.isTTY
  ? { r: '\u001b[0m', b: '\u001b[1m', red: '\u001b[31m', grn: '\u001b[32m', ylw: '\u001b[33m', dim: '\u001b[2m' }
  : { r: '', b: '', red: '', grn: '', ylw: '', dim: '' };

async function main() {
  const cfg = voiceConfigFromEnv(process.env, console);

  console.log(`${C.b}语音连麦自检${C.r}`);
  console.log(`  语音开关：${cfg.enabled ? `${C.grn}已开启${C.r}` : `${C.red}已关闭（POKER_VOICE=off）${C.r}`}`);
  if (!cfg.enabled) {
    console.log('  语音是关的，后面不用测了。');
    return 0;
  }
  console.log(`  上麦人数上限：${cfg.maxMembers}`);

  // ---- STUN ----
  const stunUrls = cfg.iceServers
    .flatMap((s) => [].concat(s.urls))
    .filter((u) => /^stuns?:/i.test(u));
  console.log(`\n${C.b}STUN（只用来问"我的公网地址是多少"，打不通它也不影响局域网内直连）${C.r}`);
  if (!stunUrls.length) {
    console.log(`  ${C.ylw}没有配 STUN${C.r}`);
  }
  const stunResults = await Promise.all(stunUrls.map(checkStun));
  for (const r of stunResults) {
    console.log(`  ${r.ok ? `${C.grn}✔${C.r}` : `${C.red}✘${C.r}`} ${r.url}  ${C.dim}${r.note}${C.r}`);
  }
  if (stunUrls.length && !stunResults.some((r) => r.ok)) {
    console.log(`  ${C.ylw}⚠ 一个都不通。这台机器的出口 UDP 可能被封了。${C.r}`);
  }

  // ---- TURN ----
  console.log(`\n${C.b}TURN（打不通洞时的中转，异地家宽之间基本靠它）${C.r}`);
  if (!cfg.turn) {
    console.log(`  ${C.red}✘ 没有配 TURN。${C.r}`);
    console.log('    两边都在运营商大内网（CGNAT）里就会连不通，表现是');
    console.log('    上麦成功、名单里有人、但互相听不见——国内异地家宽这是常态。');
    console.log(`    ${C.dim}修：在服务器上跑 bash deploy/deploy.sh，它会自建 coturn 并配好。${C.r}`);
    return 1;
  }

  // 现签一组凭据，和浏览器拿到的是同一套算法、同一个密钥
  const ice = cfg.iceFor('selfcheck');
  const turnEntry = ice.find((s) => [].concat(s.urls).some((u) => /^turns?:/i.test(u)));
  if (!turnEntry || !turnEntry.username) {
    console.log(`  ${C.red}✘ TURN 配了地址却没算出凭据，检查 POKER_TURN_SECRET${C.r}`);
    return 1;
  }
  console.log(`  凭据方式：${cfg.turn.secret ? `临时凭据（有效期 ${cfg.turn.ttlSec}s）` : '固定账号密码'}`);
  console.log(`  ${C.dim}用户名 ${turnEntry.username}${C.r}`);

  const turnUrls = [].concat(turnEntry.urls);
  const turnResults = [];
  for (const u of turnUrls) {
    turnResults.push(await checkTurnAllocate(u, turnEntry.username, turnEntry.credential));
  }
  for (const r of turnResults) {
    const mark = r.ok === null ? `${C.dim}—${C.r}` : (r.ok ? `${C.grn}✔${C.r}` : `${C.red}✘${C.r}`);
    console.log(`  ${mark} ${r.url}  ${C.dim}${r.note}${C.r}`);
  }

  const anyOk = turnResults.some((r) => r.ok === true);
  console.log('');
  if (anyOk) {
    console.log(`${C.grn}${C.b}✔ TURN 中转可用，异地的两个人现在应该能互相听见了。${C.r}`);
    return 0;
  }
  console.log(`${C.red}${C.b}✘ TURN 不可用 —— 语音在异地之间仍然会连不通。${C.r}`);
  console.log(`${C.dim}  排查顺序：docker ps | grep poker-turn → docker logs poker-turn → 防火墙 3478/udp${C.r}`);
  return 1;
}

main().then(
  (code) => process.exit(code),
  (e) => { console.error('自检脚本本身出错了：', e); process.exit(2); }
);
