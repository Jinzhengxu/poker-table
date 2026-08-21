// SPDX-License-Identifier: GPL-3.0-or-later
// 端到端集成测试：真启动 HTTP+WS 服务，用多个 WebSocket 客户端坐下打完整的牌局。
// 覆盖：入座 / 开局 / 全流程下注 / 摊牌结算 / 断线重连 / 底牌不泄露 / 静态资源可访问。
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

process.env.PORT = process.env.E2E_PORT || '8199';
const { server, room } = await import('../server/index.js');

const BASE = `http://127.0.0.1:${process.env.PORT}`;
const WS_URL = `ws://127.0.0.1:${process.env.PORT}/ws`;

/** 一个测试用客户端：自动记录收到的状态快照 */
class Client {
  constructor(label) {
    this.label = label;
    this.states = [];
    this.errors = [];
    this.events = [];
    this.voiceMsgs = [];
    this.token = null;
    this.playerId = null;
    this.seat = null;
  }

  connect(token = null) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error(`${this.label} 连接超时`)), 5000);
      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.t === 'welcome') {
          this.token = msg.token;
          this.playerId = msg.playerId;
          this.seat = msg.seat;
          clearTimeout(timer);
          resolve(this);
        } else if (msg.t === 'state') {
          this.states.push(msg);
          if (this._waiter && this._waiter.pred(msg)) {
            const w = this._waiter; this._waiter = null; clearTimeout(w.timer); w.resolve(msg);
          }
        } else if (msg.t === 'event') {
          this.events.push(msg);
        } else if (msg.t === 'error') {
          this.errors.push(msg);
        } else if (msg.t === 'voiceReady' || msg.t === 'voiceSignal') {
          this.voiceMsgs.push(msg);
        }
      });
      ws.on('error', reject);
      ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', token })));
    });
  }

  send(obj) { this.ws.send(JSON.stringify(obj)); }
  get last() { return this.states[this.states.length - 1]; }

  /** 等待一个满足条件的状态快照（已到达的最新快照也算） */
  waitFor(pred, ms = 8000, why = '') {
    if (this.last && pred(this.last)) return Promise.resolve(this.last);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._waiter = null;
        reject(new Error(`${this.label} 等待超时: ${why}`));
      }, ms);
      this._waiter = { pred, resolve, timer };
    });
  }

  close() { try { this.ws.close(); } catch { /* 忽略 */ } }
}

const clients = [];
async function makeClient(label, token = null) {
  const c = new Client(label);
  await c.connect(token);
  clients.push(c);
  return c;
}

test.after(() => {
  for (const c of clients) c.close();
  room.shutdown?.();
  server.close();
});

test('HTTP: healthz 与静态资源可访问，且防目录穿越', async () => {
  const health = await fetch(`${BASE}/healthz`);
  assert.equal(health.status, 200);

  // 三个页面都要守住这条：不引用任何外部资源。
  // 这既是隐私要求，也是"标签页伪装"的前提——页面一旦去拉 CDN，
  // 网络面板里就写着它到底是什么了。
  for (const [path, name] of [['/', 'index.html'], ['/guandan', 'guandan.html'], ['/hotword', 'hotword.html']]) {
    const page = await fetch(BASE + path);
    assert.equal(page.status, 200, `${path} 应可访问`);
    const html = await page.text();
    assert.match(html, /<html/i);
    // 只检查真正会发起网络请求的属性（src/href），内联 data: URI 里的 SVG xmlns 不算外部资源
    const externalRef = /(?:src|href)\s*=\s*["']\s*(?:https?:)?\/\//i.exec(html);
    assert.equal(externalRef, null,
      `${name} 不应引用任何外部资源，发现：${externalRef?.[0]}`);
  }

  for (const p of ['/style.css', '/app.js']) {
    const r = await fetch(BASE + p);
    assert.equal(r.status, 200, `${p} 应可访问`);
  }

  const evil = await fetch(`${BASE}/../package.json`, { redirect: 'manual' });
  assert.ok(evil.status >= 400, '目录穿越必须被拒绝');
});

test('三人局：入座、开局、打到摊牌，筹码守恒且底牌不泄露', async () => {
  const a = await makeClient('A');
  const b = await makeClient('B');
  const c = await makeClient('C');

  a.send({ t: 'sit', seat: 0, name: '阿强' });
  b.send({ t: 'sit', seat: 3, name: '小美' });
  c.send({ t: 'sit', seat: 5, name: '老王' });

  await a.waitFor((s) => s.table.seatedCount === 3, 5000, '三人入座');
  assert.equal(a.last.you.isHost, true, '第一个入座的应是房主');
  assert.equal(a.last.seats[0].name, '阿强');
  assert.equal(a.last.seats[3].name, '小美');
  assert.equal(a.last.seats[5].name, '老王');

  const startingStack = a.last.config.startingStack;
  const totalBefore = [0, 3, 5].reduce((n, s) => n + a.last.seats[s].chips, 0);
  assert.equal(totalBefore, startingStack * 3);

  a.send({ t: 'start' });
  await a.waitFor((s) => s.table.phase === 'preflop', 5000, '开局到翻牌前');

  // 自己能看到自己的两张牌，别人的是 ??
  for (const cl of [a, b, c]) {
    await cl.waitFor((s) => s.you.seat !== null && Array.isArray(s.you.cards), 5000, '拿到底牌');
    assert.equal(cl.you_cards_len = cl.last.you.cards.length, 2);
    for (const card of cl.last.you.cards) assert.match(card, /^[2-9TJQKA][cdhs]$/);
    for (const seat of cl.last.seats) {
      if (!seat || seat.seat === cl.last.you.seat) continue;
      if (seat.cards) {
        assert.deepEqual(seat.cards, ['??', '??'], `${cl.label} 不应看到 ${seat.name} 的底牌`);
      }
    }
    // 更强的断言：整个快照的 JSON 里不能出现别人的真牌
    const json = JSON.stringify(cl.last);
    const others = [a, b, c].filter((o) => o !== cl && o.last?.you?.cards);
    for (const o of others) {
      for (const card of o.last.you.cards) {
        // 同一张牌不可能同时在两人手里，出现即为泄露
        const mine = new Set(cl.last.you.cards);
        if (!mine.has(card)) {
          assert.ok(!json.includes(`"${card}"`), `${cl.label} 的快照里泄露了 ${o.label} 的牌 ${card}`);
        }
      }
    }
  }

  // 所有人一路跟注/过牌，打到摊牌
  const bySeat = new Map([[0, a], [3, b], [5, c]]);
  const handNo = a.last.table.handNo;
  for (let guard = 0; guard < 60; guard += 1) {
    const st = a.last;
    if (st.table.phase === 'handOver') break;
    const seat = st.table.actingSeat;
    if (seat === null || seat === undefined) {
      await a.waitFor((s) => s.table.actingSeat !== null || s.table.phase === 'handOver', 5000, '等待行动权');
      continue;
    }
    const cl = bySeat.get(seat);
    await cl.waitFor((s) => s.table.actingSeat === seat && s.you.legal, 5000, `${cl.label} 拿到行动权`);
    const legal = cl.last.you.legal;
    if (legal.canCheck) cl.send({ t: 'action', handNo, type: 'check' });
    else cl.send({ t: 'action', handNo, type: 'call' });
    await a.waitFor((s) => s.table.actingSeat !== seat || s.table.phase === 'handOver', 5000, '行动被接受');
  }

  await a.waitFor((s) => s.table.phase === 'handOver' && s.result, 8000, '牌局结束');
  const result = a.last.result;
  assert.ok(result.wentToShowdown, '全员跟到底应该摊牌');
  assert.ok(result.showdown.length >= 2, '摊牌应至少两人亮牌');
  const EN_NAMES = new Set([
    'HIGH CARD', 'PAIR', 'TWO PAIR', 'THREE OF A KIND', 'STRAIGHT',
    'FLUSH', 'FULL HOUSE', 'FOUR OF A KIND', 'STRAIGHT FLUSH', 'ROYAL FLUSH',
  ]);
  for (const entry of result.showdown) {
    assert.equal(entry.cards.length, 2);
    assert.ok(entry.handName, '摊牌要有中文牌型名');
    // 结算大屏拿英文牌型当大标题，中英文和档次都得下发
    assert.ok(EN_NAMES.has(entry.handNameEn), `英文牌型名不合法：${entry.handNameEn}`);
    assert.ok(Number.isInteger(entry.handRank) && entry.handRank >= 0 && entry.handRank <= 8,
      `牌型档次应为 0..8，收到 ${entry.handRank}`);
    assert.equal(entry.best.length, 5);
  }
  for (const w of result.winners) {
    assert.ok(EN_NAMES.has(w.handNameEn), `赢家缺英文牌型名：${w.handNameEn}`);
  }
  assert.ok(result.winners.length >= 1);

  // 摊牌后所有人都能看到亮牌者的真牌（每个客户端各自等到 handOver，避免快照到达的竞态）
  for (const cl of [a, b, c]) {
    await cl.waitFor((s) => s.table.phase === 'handOver' && s.result, 8000, `${cl.label} 收到结算快照`);
    for (const entry of result.showdown) {
      assert.deepEqual(cl.last.seats[entry.seat].cards, entry.cards,
        `${cl.label} 摊牌后应看到座位 ${entry.seat} 的真牌`);
    }
  }

  const totalAfter = [0, 3, 5].reduce((n, s) => n + a.last.seats[s].chips, 0);
  assert.equal(totalAfter, totalBefore, '一手牌后筹码总量必须守恒');

  // ---- 结算大屏依赖的字段 ----
  // 前端报的"你赢了 +N / 你输了 −N"算的是本手净收支 = wonThisHand − committedTotal。
  // 这两个字段必须都在快照里，且净收支在全桌加起来要为 0（赢家赚的正好是输家赔的）。
  let netSum = 0;
  for (const seat of [0, 3, 5]) {
    const sd = a.last.seats[seat];
    assert.equal(typeof sd.wonThisHand, 'number', `座位 ${seat} 缺 wonThisHand`);
    assert.equal(typeof sd.committedTotal, 'number', `座位 ${seat} 缺 committedTotal`);
    netSum += sd.wonThisHand - sd.committedTotal;
  }
  assert.equal(netSum, 0, '全桌净收支之和必须为 0，否则前端报的输赢金额是错的');

  // ---- 事件广播 ----
  // 前端只靠 {t:'event'} 来放音效，每种动作要有各自的声音，
  // 所以 action 事件必须带上 type；漏掉 type 的话所有动作听起来一模一样。
  const kinds = new Set(a.events.map((e) => e.kind));
  for (const k of ['deal', 'blind', 'flop', 'turn', 'river', 'action', 'win']) {
    assert.ok(kinds.has(k), `事件里应该有 ${k}`);
  }
  const actions = a.events.filter((e) => e.kind === 'action');
  assert.ok(actions.length > 0, '应该有 action 事件');
  const TYPES = new Set(['fold', 'check', 'call', 'bet', 'raise', 'allin']);
  for (const e of actions) {
    assert.ok(TYPES.has(e.type), `action 事件必须带合法的 type，收到 ${JSON.stringify(e.type)}`);
  }
  // deal 事件仍然不能带牌面
  for (const e of a.events.filter((x) => x.kind === 'deal')) {
    assert.equal(JSON.stringify(e).includes('"cards"'), false, 'deal 事件不能夹带牌面');
  }
});

test('断线重连：用 token 回到原座位与原筹码', async () => {
  const target = clients[1]; // 小美
  const token = target.token;
  const seatBefore = target.last.you.seat;
  const chipsBefore = target.last.seats[seatBefore].chips;

  target.close();
  await new Promise((r) => setTimeout(r, 300));

  const back = await makeClient('B2', token);
  assert.equal(back.seat, seatBefore, '重连应回到原座位');
  await back.waitFor((s) => s.you.seat === seatBefore, 5000, '重连后拿到状态');
  assert.equal(back.last.seats[seatBefore].name, '小美');
  assert.equal(back.last.seats[seatBefore].chips, chipsBefore, '筹码不应因断线改变');
  assert.equal(back.last.seats[seatBefore].connected, true);
});

test('补码时机：没参与本手的座位随时能补，正在牌里的座位要等本手结束', async () => {
  const host = clients[0];            // 阿强，座位 0，房主
  const outsider = await makeClient('E');

  // 关掉自动开局，免得下一手在测试中途自己开起来
  host.send({ t: 'config', patch: { autoNextHand: false } });
  await host.waitFor((s) => s.config.autoNextHand === false, 5000, '关掉自动开局');

  // E 坐下并立刻坐出：坐出的人不进 #eligiblePlayers，
  // 也就不会被算进这手牌 —— 跟"输光筹码的人"走的是同一条路径
  outsider.send({ t: 'sit', seat: 6, name: '看客' });
  await outsider.waitFor((s) => s.you.seat === 6, 5000, 'E 入座');
  outsider.send({ t: 'sitOut', value: true });
  await host.waitFor((s) => s.seats[6] && s.seats[6].sittingOut === true, 5000, 'E 坐出');

  const outsiderBefore = host.last.seats[6].chips;

  host.send({ t: 'start' });
  await host.waitFor((s) => s.table.phase === 'preflop', 5000, '开一手新牌');

  // 快照里的 canRebuy 必须和服务端真正的判定一致，前端就是照它显示按钮的
  assert.equal(host.last.seats[6].canRebuy, true, '没参与本手的座位应该 canRebuy');
  assert.equal(host.last.seats[0].canRebuy, false, '正在牌里的座位不该 canRebuy');

  // 1) 牌局进行中，给没参与这手的座位补码 —— 必须成功
  host.errors.length = 0;
  host.send({ t: 'addChips', seat: 6, amount: 500 });
  await host.waitFor((s) => s.seats[6].chips === outsiderBefore + 500, 5000, '场外座位补码生效');
  assert.equal(host.errors.length, 0, '给没参与本手的座位补码不该报错');

  // 2) 同一时刻，给正在这手牌里的座位补码 —— 必须被拒
  const inHandBefore = host.last.seats[0].chips;
  host.errors.length = 0;
  host.send({ t: 'addChips', seat: 0, amount: 500 });
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(host.errors.some((e) => e.code === 'HAND_IN_PROGRESS'),
    '给正在牌里的座位补码应报 HAND_IN_PROGRESS');
  assert.equal(host.last.seats[0].chips, inHandBefore,
    '被拒之后筹码一分都不能变——加了也会在结算时被 chipsAfter 抹掉');

  // 收尾：把这手打完，把自动开局恢复回去，别影响后面的测试
  const bySeat = new Map([[0, clients[0]], [3, clients[clients.length - 2]], [5, clients[2]]]);
  for (let guard = 0; guard < 60; guard += 1) {
    const st = host.last;
    if (st.table.phase === 'handOver') break;
    const seat = st.table.actingSeat;
    if (seat === null || seat === undefined) {
      await host.waitFor((s) => s.table.actingSeat !== null || s.table.phase === 'handOver',
        5000, '等待行动权');
      continue;
    }
    const cl = bySeat.get(seat);
    if (!cl) break;
    await cl.waitFor((s) => s.table.actingSeat === seat && s.you.legal, 5000, '拿到行动权');
    cl.send({ t: 'action', handNo: st.table.handNo, type: cl.last.you.legal.canCheck ? 'check' : 'fold' });
    await host.waitFor((s) => s.table.actingSeat !== seat || s.table.phase === 'handOver',
      5000, '行动被接受');
  }
  await host.waitFor((s) => s.table.phase === 'handOver', 8000, '这手打完');

  // 3) 本手结束后，刚才被拒的座位可以补了
  assert.equal(host.last.seats[0].canRebuy, true, '本手结束后该座位应该 canRebuy');
  host.errors.length = 0;
  const after = host.last.seats[0].chips;
  host.send({ t: 'addChips', seat: 0, amount: 300 });
  await host.waitFor((s) => s.seats[0].chips === after + 300, 5000, '本手结束后可以补码');
  assert.equal(host.errors.length, 0);

  outsider.close();
});

test('非法操作被拒绝：占用座位、非房主开局、不到自己回合行动', async () => {
  const d = await makeClient('D');
  d.send({ t: 'sit', seat: 0, name: '插队的' });
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(d.errors.some((e) => e.code === 'SEAT_TAKEN'), '占用座位应报 SEAT_TAKEN');

  d.errors.length = 0;
  d.send({ t: 'sit', seat: 7, name: '' });
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(d.errors.some((e) => e.code === 'NAME_INVALID'), '空昵称应报 NAME_INVALID');

  d.errors.length = 0;
  d.send({ t: 'action', handNo: 1, type: 'fold' });
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(d.errors.length > 0, '未入座就行动应报错');
});

test('语音连麦：上麦进名单、信令点对点转发、非法信令被拒', async () => {
  const a = await makeClient('语音A');
  const b = await makeClient('语音B');
  const c = await makeClient('语音C');

  a.send({ t: 'voiceJoin' });
  await a.waitFor((s) => s.voice.members.some((m) => m.playerId === a.playerId), 4000, 'A 上麦');
  assert.ok(a.voiceMsgs.some((m) => m.t === 'voiceReady'), '上麦要收到 voiceReady');
  assert.ok(Array.isArray(a.voiceMsgs.find((m) => m.t === 'voiceReady').iceServers));

  b.send({ t: 'voiceJoin' });
  await b.waitFor((s) => s.voice.members.length === 2, 4000, 'B 上麦');
  // 没上麦的 C 也看得到名单，这样才知道"他们在语音里聊"
  await c.waitFor((s) => s.voice.members.length === 2, 4000, 'C 看到名单');

  // 信令只到 B，不会广播给 C
  a.send({ t: 'voiceSignal', to: b.playerId, data: { kind: 'offer', sdp: 'v=0\r\n' } });
  await new Promise((r) => setTimeout(r, 200));
  const got = b.voiceMsgs.filter((m) => m.t === 'voiceSignal');
  assert.equal(got.length, 1);
  assert.equal(got[0].from, a.playerId);
  assert.equal(c.voiceMsgs.filter((m) => m.t === 'voiceSignal').length, 0, '第三个人不该收到信令');

  // 收件人格式不对 / 负载不对，都要被拒
  a.errors.length = 0;
  a.send({ t: 'voiceSignal', to: '不是个 id', data: { kind: 'offer', sdp: 'v=0' } });
  a.send({ t: 'voiceSignal', to: b.playerId, data: { kind: 'chat', text: '偷渡' } });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(a.errors.length, 2, '两条非法信令都该报错');
  assert.equal(b.voiceMsgs.filter((m) => m.t === 'voiceSignal').length, 1, '非法信令不该转发');

  // 静音同步 + 下麦
  a.send({ t: 'voiceMute', value: true });
  await b.waitFor((s) => s.voice.members.some((m) => m.playerId === a.playerId && m.muted), 4000, '静音同步');
  a.send({ t: 'voiceLeave' });
  await b.waitFor((s) => s.voice.members.length === 1, 4000, 'A 下麦');

  // 断线也要自动下麦
  b.close();
  await c.waitFor((s) => s.voice.members.length === 0, 4000, 'B 断线后自动下麦');
});

test('语音信令不吃牌桌那 20 条/秒的额度', async () => {
  const a = await makeClient('限流A');
  const b = await makeClient('限流B');
  a.send({ t: 'voiceJoin' });
  b.send({ t: 'voiceJoin' });
  await a.waitFor((s) => s.voice.members.length === 2, 4000, '两个人都上麦');

  a.errors.length = 0;
  // 一口气发 60 条信令：牌桌消息这个量早就被限流打回了
  for (let i = 0; i < 60; i++) {
    a.send({ t: 'voiceSignal', to: b.playerId, data: { kind: 'candidate', candidate: { candidate: `candidate:${i}` } } });
  }
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(a.errors.filter((e) => e.code === 'RATE_LIMIT').length, 0, '语音信令不该被牌桌限流打回');
  assert.equal(b.voiceMsgs.filter((m) => m.t === 'voiceSignal').length, 60, '60 条应该全部送达');

  a.send({ t: 'voiceLeave' });
  b.send({ t: 'voiceLeave' });
});
