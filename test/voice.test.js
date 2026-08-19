// SPDX-License-Identifier: GPL-3.0-or-later
// 语音连麦：频道成员表、信令中转、两张桌子之间的隔离。
//
// 这里不碰 WebRTC——服务端本来也不碰。测的是"谁在麦上"这张表，
// 以及信令有没有可能串到另一张桌子去（产品要求：德扑和掼蛋的语音分开）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../server/room.js';
import { GuandanRoom } from '../server/guandan/room.js';
import { VoiceChannel, validSignal } from '../server/voice.js';

/** 一个假的连接：把收到的消息全存下来 */
function fakeClient() {
  const c = {
    playerId: null,
    inbox: [],
    send(obj) { c.inbox.push(obj); },
    close() { c.closed = true; },
    last(type) {
      for (let i = c.inbox.length - 1; i >= 0; i--) if (c.inbox[i].t === type) return c.inbox[i];
      return null;
    },
    all(type) { return c.inbox.filter((m) => m.t === type); },
  };
  return c;
}

/** 接进房间并握手，返回这个连接 */
function seatIn(room, name, seat) {
  const c = fakeClient();
  room.attach(c);
  room.hello(c, null);
  if (seat !== undefined && seat !== null) room.sit(c, seat, name);
  return c;
}

test('上麦之后出现在名单里，下麦之后消失', () => {
  const room = new Room();
  const a = seatIn(room, '小明', 0);
  const b = seatIn(room, '小红', 1);

  assert.equal(a.last('state').voice.members.length, 0);

  assert.deepEqual(room.voice.join(a), { ok: true });
  const ready = a.last('voiceReady');
  assert.ok(ready, '上麦要收到 voiceReady');
  assert.equal(ready.self, a.playerId);
  assert.ok(Array.isArray(ready.iceServers));

  // 别人也要在自己的快照里看到麦上多了个人
  const m = b.last('state').voice.members;
  assert.equal(m.length, 1);
  assert.equal(m[0].playerId, a.playerId);
  assert.equal(m[0].seat, 0);
  assert.equal(m[0].name, '小明');
  assert.equal(m[0].muted, false);

  room.voice.leave(a);
  assert.equal(b.last('state').voice.members.length, 0);
  room.shutdown();
});

test('静音状态会同步给其他人', () => {
  const room = new Room();
  const a = seatIn(room, '小明', 0);
  const b = seatIn(room, '小红', 1);
  room.voice.join(a);

  room.voice.setMuted(a, true);
  assert.equal(b.last('state').voice.members[0].muted, true);
  room.voice.setMuted(a, false);
  assert.equal(b.last('state').voice.members[0].muted, false);

  // 没上麦的人不能设静音
  assert.equal(room.voice.setMuted(b, true).ok, false);
  room.shutdown();
});

test('信令只发给指定的那个人', () => {
  const room = new Room();
  const a = seatIn(room, 'A', 0);
  const b = seatIn(room, 'B', 1);
  const c = seatIn(room, 'C', 2);
  room.voice.join(a); room.voice.join(b); room.voice.join(c);

  const sdp = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n';
  assert.deepEqual(room.voice.signal(a, b.playerId, { kind: 'offer', sdp }), { ok: true });

  const got = b.last('voiceSignal');
  assert.ok(got);
  assert.equal(got.from, a.playerId);
  assert.equal(got.data.sdp, sdp);
  assert.equal(c.last('voiceSignal'), null, '第三个人不该收到');
  room.shutdown();
});

test('没上麦就发信令会被拒；发给已经下麦的人静默丢弃', () => {
  const room = new Room();
  const a = seatIn(room, 'A', 0);
  const b = seatIn(room, 'B', 1);

  const r = room.voice.signal(a, b.playerId, { kind: 'bye' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'VOICE_OFF');

  room.voice.join(a);
  // b 不在麦上：这是拆连接时的正常竞态，不该给 a 报错
  assert.deepEqual(room.voice.signal(a, b.playerId, { kind: 'bye' }), { ok: true });
  assert.equal(b.last('voiceSignal'), null);
  room.shutdown();
});

test('信令的形状会被校验，SDP 不能无限长', () => {
  assert.equal(validSignal({ kind: 'offer', sdp: 'v=0' }), true);
  assert.equal(validSignal({ kind: 'answer', sdp: 'v=0' }), true);
  assert.equal(validSignal({ kind: 'candidate', candidate: { candidate: 'candidate:1 1 udp' } }), true);
  assert.equal(validSignal({ kind: 'candidate', candidate: null }), true);
  assert.equal(validSignal({ kind: 'bye' }), true);

  assert.equal(validSignal(null), false);
  assert.equal(validSignal({ kind: 'chat', text: 'hi' }), false);
  assert.equal(validSignal({ kind: 'offer' }), false);
  assert.equal(validSignal({ kind: 'offer', sdp: 'x'.repeat(20000) }), false);
  assert.equal(validSignal({ kind: 'candidate', candidate: { candidate: 'x'.repeat(5000) } }), false);
  assert.equal(validSignal({ kind: 'candidate', candidate: { candidate: 'a', sdpMLineIndex: 1.5 } }), false);

  // 白名单转发：塞进去的多余字段不会被转出去
  const room = new Room();
  const a = seatIn(room, 'A', 0);
  const b = seatIn(room, 'B', 1);
  room.voice.join(a); room.voice.join(b);
  room.voice.signal(a, b.playerId, { kind: 'offer', sdp: 'v=0', 偷渡: '不该出现' });
  assert.deepEqual(b.last('voiceSignal').data, { kind: 'offer', sdp: 'v=0' });
  room.shutdown();
});

test('人数封顶', () => {
  const room = new Room({ voice: { max: 2 } });
  const a = seatIn(room, 'A', 0);
  const b = seatIn(room, 'B', 1);
  const c = seatIn(room, 'C', 2);
  assert.equal(room.voice.join(a).ok, true);
  assert.equal(room.voice.join(b).ok, true);
  const r = room.voice.join(c);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'VOICE_FULL');
  // 已经在麦上的人重复上麦不算新名额
  assert.equal(room.voice.join(a).ok, true);
  assert.equal(room.voice.members.size, 2);
  room.shutdown();
});

test('关掉语音之后谁都上不了麦', () => {
  const room = new Room({ voice: { enabled: false } });
  const a = seatIn(room, 'A', 0);
  const r = room.voice.join(a);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'VOICE_OFF');
  assert.equal(a.last('state').voice.enabled, false);
  room.shutdown();
});

test('断线、被踢、重新握手都会把人从麦上摘掉', () => {
  const room = new Room();
  const host = seatIn(room, '房主', 0);
  const a = seatIn(room, 'A', 1);
  const b = seatIn(room, 'B', 2);
  room.voice.join(a); room.voice.join(b);
  assert.equal(room.voice.members.size, 2);

  // 断线
  room.detach(b);
  assert.equal(room.voice.has(b.playerId), false, '断线要下麦');
  assert.equal(host.last('state').voice.members.length, 1);

  // 重新握手（刷新页面）：旧的 WebRTC 连接已经作废，先摘掉
  room.voice.join(a);
  assert.equal(room.voice.has(a.playerId), true);
  const a2 = fakeClient();
  room.attach(a2);
  room.hello(a2, a.token || room.players.get(a.playerId).token);
  assert.equal(room.voice.has(a.playerId), false, '重新握手要下麦');

  // 被踢
  room.voice.join(a2);
  assert.equal(room.voice.has(a2.playerId), true);
  room.kick(host, room.players.get(a2.playerId).seat);
  assert.equal(room.voice.has(a2.playerId), false, '被踢要下麦');
  room.shutdown();
});

test('观众也能上麦，名单里标成观众', () => {
  const room = new Room();
  const seated = seatIn(room, '小明', 0);
  const watcher = seatIn(room, null, null);   // 只握手不入座
  assert.equal(room.voice.join(watcher).ok, true);
  const m = seated.last('state').voice.members[0];
  assert.equal(m.seat, null);
  assert.equal(m.name, '观众');
  room.shutdown();
});

test('德扑和掼蛋是两条完全独立的语音频道', () => {
  const holdem = new Room();
  const guandan = new GuandanRoom();

  const ha = seatIn(holdem, '德州甲', 0);
  const hb = seatIn(holdem, '德州乙', 1);
  const ga = seatIn(guandan, '掼蛋甲', 0);

  holdem.voice.join(ha);
  holdem.voice.join(hb);
  guandan.voice.join(ga);

  // 名单各算各的
  assert.equal(holdem.voice.members.size, 2);
  assert.equal(guandan.voice.members.size, 1);
  assert.equal(ha.last('state').voice.members.length, 2);
  assert.equal(ga.last('state').voice.members.length, 1);

  // 德州的人拿着掼蛋那位的 playerId 也发不过去：他不在德州这张表里
  const before = ga.inbox.length;
  assert.deepEqual(holdem.voice.signal(ha, ga.playerId, { kind: 'offer', sdp: 'v=0' }), { ok: true });
  assert.equal(ga.inbox.length, before, '信令绝不能跨桌');
  assert.equal(ga.last('voiceSignal'), null);

  // 反过来也一样
  guandan.voice.join(ga);
  assert.deepEqual(guandan.voice.signal(ga, hb.playerId, { kind: 'offer', sdp: 'v=0' }), { ok: true });
  assert.equal(hb.last('voiceSignal'), null);

  // 同一个人在两张桌子上麦，互不影响
  holdem.voice.leave(ha);
  assert.equal(holdem.voice.members.size, 1);
  assert.equal(guandan.voice.members.size, 1);

  holdem.shutdown();
  guandan.shutdown();
});

test('掼蛋桌的语音同样能上麦、静音、下麦', () => {
  const room = new GuandanRoom();
  const a = seatIn(room, '甲', 0);
  const b = seatIn(room, '乙', 1);
  assert.equal(room.voice.join(a).ok, true);
  assert.equal(b.last('state').voice.members[0].name, '甲');
  room.voice.setMuted(a, true);
  assert.equal(b.last('state').voice.members[0].muted, true);
  room.detach(a);
  assert.equal(b.last('state').voice.members.length, 0);
  room.shutdown();
});

test('名单里的人被删掉之后 publicState 不会漏出幽灵成员', () => {
  const room = new Room();
  const a = seatIn(room, 'A', 0);
  room.voice.join(a);
  // 绕过正常路径直接删玩家，模拟任何漏摘的情况
  room.players.delete(a.playerId);
  const ch = room.voice;
  assert.equal(ch.publicState().members.length, 0);
  assert.equal(ch.prune(), true);
  assert.equal(ch.members.size, 0);
  room.shutdown();
});

test('VoiceChannel 可以脱离 Room 单独用（只依赖 players/clients/broadcast）', () => {
  const room = { players: new Map(), clients: new Set(), broadcast() { room.broadcasts++; } };
  room.broadcasts = 0;
  const ch = new VoiceChannel(room, { max: 3 });
  const c = fakeClient();
  c.playerId = 'p_abc123';
  room.players.set('p_abc123', { id: 'p_abc123', name: '甲', seat: 3, avatar: null });
  room.clients.add(c);
  assert.equal(ch.join(c).ok, true);
  assert.equal(room.broadcasts, 1);
  assert.deepEqual(ch.publicState().members, [
    { playerId: 'p_abc123', seat: 3, name: '甲', avatar: null, muted: false },
  ]);
});
