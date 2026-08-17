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
        } else if (msg.t === 'error') {
          this.errors.push(msg);
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

  const page = await fetch(`${BASE}/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<html/i);
  // 只检查真正会发起网络请求的属性（src/href），内联 data: URI 里的 SVG xmlns 不算外部资源
  const externalRef = /(?:src|href)\s*=\s*["']\s*(?:https?:)?\/\//i.exec(html);
  assert.equal(externalRef, null,
    `index.html 不应引用任何外部资源，发现：${externalRef?.[0]}`);

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
  for (const entry of result.showdown) {
    assert.equal(entry.cards.length, 2);
    assert.ok(entry.handName, '摊牌要有中文牌型名');
    assert.equal(entry.best.length, 5);
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
