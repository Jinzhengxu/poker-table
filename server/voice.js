// SPDX-License-Identifier: GPL-3.0-or-later
// 语音连麦：频道成员表 + 信令中转。
//
// 音频【不经过服务器】。浏览器之间直接建 WebRTC 连接（mesh，人人互连），
// 服务端只做两件事：维护"谁在麦上"这张表，以及转发 SDP/ICE 这些几 KB 的小纸条。
// 好处是服务器带宽成本恒定为零，延迟也是端到端最短的那条路。
// 代价是人一多连接数按 n² 涨，所以有 MAX_VOICE_MEMBERS 这个上限。
//
// 【德州和掼蛋的语音是分开的】——这是产品要求，也是这里的结构保证：
// 每个 Room 各持有一个自己的 VoiceChannel 实例，成员表各存一份，
// 转发时只在 `this.room.clients` 里找收件人。两张桌子的 clients 集合天然不相交
// （WebSocket 路径就不同：/ws 与 /gd），所以一条信令在物理上就没有串台的可能，
// 不是靠某个 if 判断守着。见 test/voice.test.js 里的隔离用例。

/** 一个频道最多几个人上麦。mesh 拓扑下每人要维持 n-1 条连接，8 人是 28 条。 */
export const MAX_VOICE_MEMBERS = 8;

/** 信令的种类。服务端不解析 SDP，只认这几个信封。 */
const SIGNAL_KINDS = new Set(['offer', 'answer', 'candidate', 'bye']);

/** SDP 有点长（音频单流约 2~4KB），给到 12000 字符，仍远小于 16KB 的整包上限 */
const MAX_SDP_CHARS = 12000;
const MAX_CANDIDATE_CHARS = 1200;

/**
 * 校验一条信令的形状。
 * 服务端不理解 WebRTC，也不该理解——这里只保证转发出去的是个规规矩矩的小对象，
 * 不让人拿信令通道当任意大小的私聊/存储用。
 * @returns {boolean}
 */
export function validSignal(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return false;
  if (!SIGNAL_KINDS.has(d.kind)) return false;
  if (d.kind === 'offer' || d.kind === 'answer') {
    return typeof d.sdp === 'string' && d.sdp.length > 0 && d.sdp.length <= MAX_SDP_CHARS;
  }
  if (d.kind === 'candidate') {
    const c = d.candidate;
    if (c === null) return true;              // null 表示 ICE 收集结束
    if (!c || typeof c !== 'object' || Array.isArray(c)) return false;
    if (typeof c.candidate !== 'string' || c.candidate.length > MAX_CANDIDATE_CHARS) return false;
    if (c.sdpMid != null && typeof c.sdpMid !== 'string') return false;
    if (c.sdpMLineIndex != null && !Number.isInteger(c.sdpMLineIndex)) return false;
    if (c.usernameFragment != null && typeof c.usernameFragment !== 'string') return false;
    return true;
  }
  return true;                                 // bye：没有负载
}

/** 只转发白名单里的字段，防止有人往信令里塞别的东西 */
function cleanSignal(d) {
  if (d.kind === 'offer' || d.kind === 'answer') return { kind: d.kind, sdp: d.sdp };
  if (d.kind === 'candidate') {
    if (d.candidate === null) return { kind: 'candidate', candidate: null };
    const c = d.candidate;
    const out = { candidate: c.candidate };
    if (c.sdpMid != null) out.sdpMid = c.sdpMid;
    if (c.sdpMLineIndex != null) out.sdpMLineIndex = c.sdpMLineIndex;
    if (c.usernameFragment != null) out.usernameFragment = c.usernameFragment;
    return { kind: 'candidate', candidate: out };
  }
  return { kind: 'bye' };
}

export class VoiceChannel {
  /**
   * @param {{players:Map, clients:Set, broadcast:Function}} room 宿主房间
   * @param {{enabled?:boolean, max?:number, iceServers?:object[], label?:string}} [opts]
   */
  constructor(room, opts = {}) {
    this.room = room;
    this.label = opts.label || '语音';
    this.enabled = opts.enabled !== false;
    this.max = Number.isInteger(opts.max) && opts.max > 0 ? opts.max : MAX_VOICE_MEMBERS;
    /** @type {object[]} 直接透给浏览器的 RTCConfiguration.iceServers */
    this.iceServers = Array.isArray(opts.iceServers) ? opts.iceServers : [];
    /** @type {Map<string,{muted:boolean, since:number}>} playerId -> 麦上状态 */
    this.members = new Map();
  }

  has(playerId) {
    return this.members.has(playerId);
  }

  get size() {
    return this.members.size;
  }

  /**
   * 上麦。幂等：已经在麦上的人重复调用只会重发一次 voiceReady
   * （断线重连之后前端就是靠这个把 ICE 配置再要一遍的）。
   */
  join(client) {
    if (!this.enabled) {
      return { ok: false, code: 'VOICE_OFF', msg: '这台服务器没有开启语音连麦' };
    }
    const id = client.playerId;
    if (!id || !this.room.players.has(id)) {
      return { ok: false, code: 'ILLEGAL_ACTION', msg: '还没有握手，请刷新页面' };
    }
    if (!this.members.has(id)) {
      if (this.members.size >= this.max) {
        return { ok: false, code: 'VOICE_FULL', msg: `麦上已经有 ${this.max} 个人了，等一位下麦再来` };
      }
      this.members.set(id, { muted: false, since: Date.now() });
    }
    client.send({
      t: 'voiceReady',
      self: id,
      max: this.max,
      iceServers: this.iceServers.map((s) => ({ ...s })),
    });
    this.room.broadcast();
    return { ok: true };
  }

  /** 主动下麦 */
  leave(client) {
    if (this.remove(client.playerId)) this.room.broadcast();
    return { ok: true };
  }

  /**
   * 把某人从麦上摘掉。不广播——调用方（detach / kick / hello）后面自己会广播。
   * @returns {boolean} 这个人本来是否在麦上
   */
  remove(playerId) {
    if (!playerId) return false;
    return this.members.delete(playerId);
  }

  /** 自己静音/取消静音。麦是在浏览器本地关的，这里只同步给别人看图标。 */
  setMuted(client, value) {
    const m = this.members.get(client.playerId);
    if (!m) return { ok: false, code: 'VOICE_OFF', msg: '你还没有上麦' };
    const v = !!value;
    if (m.muted === v) return { ok: true };
    m.muted = v;
    this.room.broadcast();
    return { ok: true };
  }

  /**
   * 转发一条信令给同频道的另一个人。
   * 收发双方都必须在【本频道】的成员表里，所以跨桌子的信令根本无从谈起。
   */
  signal(client, to, data) {
    const from = client.playerId;
    if (!from || !this.members.has(from)) {
      return { ok: false, code: 'VOICE_OFF', msg: '你还没有上麦' };
    }
    if (typeof to !== 'string' || to === from) {
      return { ok: false, code: 'ILLEGAL_ACTION', msg: '信令的收件人不合法' };
    }
    if (!validSignal(data)) {
      return { ok: false, code: 'ILLEGAL_ACTION', msg: '信令格式不合法' };
    }
    // 对方不在麦上：这是拆连接时的正常竞态（他刚下麦，我这边还没收到新名单），
    // 不该给发送方弹错误提示。丢掉就行，名单广播会告诉他对方已经走了。
    if (!this.members.has(to)) return { ok: true };

    const out = { t: 'voiceSignal', from, data: cleanSignal(data) };
    let delivered = false;
    for (const c of this.room.clients) {
      if (c.playerId === to) {
        c.send(out);
        delivered = true;
      }
    }
    // 名单里有、连接却没了：说明那条连接刚断，顺手清掉，别让别人一直往空气里发
    if (!delivered && this.remove(to)) this.room.broadcast();
    return { ok: true };
  }

  /**
   * 下发给前端的频道状态。进快照，跟着每次 broadcast 走。
   * 只有名字、座位、静音这些本来就公开的信息，没有任何私货。
   */
  publicState() {
    if (!this.enabled) return { enabled: false, max: 0, members: [] };
    const members = [];
    for (const [id, m] of this.members) {
      const p = this.room.players.get(id);
      if (!p) continue;                      // 玩家已经没了，等下一次 prune 收走
      members.push({
        playerId: id,
        seat: p.seat ?? null,
        name: p.name || '观众',
        avatar: p.avatar || null,
        muted: !!m.muted,
        since: m.since,
      });
    }
    // 按上麦先后排，名单顺序才不会每次快照都跳
    members.sort((a, b) => a.since - b.since || (a.playerId < b.playerId ? -1 : 1));
    for (const m of members) delete m.since;
    return { enabled: true, max: this.max, members };
  }

  /** 清掉已经不存在的玩家（保险丝，正常路径上 detach 就摘干净了） */
  prune() {
    let changed = false;
    for (const id of [...this.members.keys()]) {
      if (!this.room.players.has(id)) {
        this.members.delete(id);
        changed = true;
      }
    }
    return changed;
  }
}

export default VoiceChannel;
