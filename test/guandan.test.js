// SPDX-License-Identifier: GPL-3.0-or-later
// 掼蛋：牌型库、一局状态机、房间升级规则的测试。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  freshDeck, classify, interpret, beats, isBomb, bombPower, comboName,
  wildCard, powerValue, naturalValue, sortHand, TYPE,
} from '../public/gd-combos.js';
import { findPlays, choosePlay } from '../public/gd-hints.js';
import { GuandanDeal, GD_PHASE, GD_SEATS, HAND_SIZE, teamOf, partnerOf, shuffle } from '../server/guandan/engine.js';
import { GuandanRoom } from '../server/guandan/room.js';

// ==================== 小工具 ====================

/** 把一张牌重复到 n 张不合法（一副只有两张），这里只用来凑测试手牌 */
function pad(cards, n = HAND_SIZE, filler = '3c') {
  const out = [...cards];
  while (out.length < n) out.push(filler);
  return out.slice(0, n);
}

/** 四家手牌拼成一副 108 张的"牌堆"，顺序正好让 engine 发对 */
function deckOf(h0, h1, h2, h3) {
  return [...pad(h0), ...pad(h1), ...pad(h2), ...pad(h3)];
}

/** 直接摆一个局面：跳过发牌，手动设定四家的牌和轮次 */
function stage(level, hands, opts = {}) {
  const d = new GuandanDeal({ level, firstSeat: opts.firstSeat ?? 0 });
  for (let s = 0; s < GD_SEATS; s++) d.hands.set(s, [...hands[s]]);
  d.finished = [];
  d.passers = new Set();
  d.req = null;
  d.table = null;
  d.turn = d.leadSeat = opts.firstSeat ?? 0;
  d.events = [];
  return d;
}

// ==================== 牌与牌型 ====================

test('一副掼蛋牌是 108 张，每张正好两份', () => {
  const deck = freshDeck();
  assert.equal(deck.length, 108);
  const count = new Map();
  for (const c of deck) count.set(c, (count.get(c) || 0) + 1);
  assert.equal(count.size, 54);
  for (const [card, n] of count) assert.equal(n, 2, `${card} 应该有两张`);
});

test('洗牌不改变牌的组成', () => {
  const d = shuffle(freshDeck());
  assert.equal(d.length, 108);
  assert.deepEqual([...d].sort(), freshDeck().sort());
});

test('基本牌型识别', () => {
  const lv = 9;
  const c = (cards) => classify(cards, lv);
  assert.equal(c(['As'])?.type, TYPE.SINGLE);
  assert.equal(c(['As', 'Ah'])?.type, TYPE.PAIR);
  assert.equal(c(['As', 'Ah', 'Ad'])?.type, TYPE.TRIPLE);
  assert.equal(c(['As', 'Ah', 'Ad', '2c', '2d'])?.type, TYPE.FULL);
  assert.equal(c(['3s', '4d', '5s', '6s', '7h'])?.type, TYPE.STRAIGHT);
  assert.equal(c(['3s', '4s', '5s', '6s', '7s'])?.type, TYPE.SFLUSH);
  assert.equal(c(['3s', '3d', '4s', '4d', '5s', '5d'])?.type, TYPE.TUBE);
  assert.equal(c(['3s', '3d', '3h', '4s', '4d', '4h'])?.type, TYPE.PLATE);
  assert.equal(c(['Ks', 'Kd', 'Kh', 'Kc'])?.type, TYPE.BOMB);
  assert.equal(c(['jb', 'jb', 'jr', 'jr'])?.type, TYPE.JOKERS);
  // 不成型
  assert.equal(c(['As', 'Kd']), null);
  assert.equal(c(['jb', 'jr']), null, '小王配大王不是对子');
  assert.equal(c(['jb', 'As']), null, '王不能和别的牌混');
  assert.equal(c(['As', 'Ah', 'Ad', '2c']), null, '四张不同点数凑不成牌型');
});

test('顺子里 A 可以当 1，但不能绕回', () => {
  const lv = 9;
  assert.equal(classify(['Ac', '2d', '3s', '4s', '5h'], lv).rank, 5, 'A2345 最小，顶为 5');
  assert.equal(classify(['Tc', 'Jd', 'Qs', 'Ks', 'Ah'], lv).rank, 14, '10JQKA 最大');
  assert.equal(classify(['Kc', 'Ad', '2s', '3s', '4h'], lv), null, 'KA234 不成立');
  assert.equal(classify(['Ac', 'Ad', '2s', '2c', '3s', '3d'], lv).rank, 3, 'AA2233 是最小连对');
  assert.equal(classify(['Ac', 'Ad', 'Ah', '2s', '2c', '2d'], lv).rank, 2, 'AAA222 是最小钢板');
});

test('级牌在对子里升到 A 之上，在顺子里按原点数', () => {
  const lv = 5;
  const levelPair = classify(['5c', '5d'], lv);
  const acePair = classify(['Ac', 'Ad'], lv);
  assert.ok(beats(levelPair, acePair), '级牌对子大过 AA');
  assert.ok(beats(classify(['jb', 'jb'], lv), levelPair), '对小王大过级牌对子');
  // 顺子里的 5 还是 5
  assert.equal(classify(['3s', '4d', '5s', '6s', '7h'], lv).rank, 7);
});

test('炸弹阶梯：4 张 < 5 张 < 同花顺 < 6 张 < 天王炸', () => {
  const lv = 9;
  const b4 = classify(['Ks', 'Kd', 'Kh', 'Kc'], lv);
  const b5 = classify(['3s', '3d', '3h', '3c', '3s'], lv);
  const sf = classify(['3s', '4s', '5s', '6s', '7s'], lv);
  const b6 = classify(['2s', '2d', '2h', '2c', '2s', '2d'], lv);
  const jk = classify(['jb', 'jb', 'jr', 'jr'], lv);
  assert.ok(beats(b5, b4));
  assert.ok(beats(sf, b5));
  assert.ok(beats(b6, sf));
  assert.ok(beats(jk, b6));
  assert.ok(!beats(b4, jk));
  // 炸弹压任何非炸弹，非炸弹压不了炸弹
  const pair = classify(['As', 'Ah'], lv);
  assert.ok(beats(b4, pair));
  assert.ok(!beats(pair, b4));
  assert.ok(bombPower(jk) > bombPower(b6));
});

test('不同牌型之间互不相压', () => {
  const lv = 9;
  const straight = classify(['3s', '4d', '5s', '6s', '7h'], lv);
  const tube = classify(['3s', '3d', '4s', '4d', '5s', '5d'], lv);
  assert.ok(!beats(straight, tube));
  assert.ok(!beats(tube, straight));
  assert.ok(!beats(classify(['As'], lv), classify(['3s', '3d'], lv)));
});

test('逢人配可以顶任意一张非王的牌', () => {
  const lv = 5;                       // 逢人配 = 5h
  assert.equal(wildCard(lv), '5h');
  const asTriple = interpret(['7s', '7d', '5h'], lv);
  assert.equal(asTriple.length, 1);
  assert.equal(asTriple[0].type, TYPE.TRIPLE);
  assert.equal(asTriple[0].rank, 7);

  // 三张 K 加一张配 = 四张炸
  const asBomb = interpret(['Kc', 'Kd', 'Ks', '5h'], lv);
  assert.ok(asBomb.some((c) => c.type === TYPE.BOMB && c.size === 4));

  // 同一手牌可能既是顺子也是同花顺，两种解释都要给出来
  const both = interpret(['3s', '4s', '5h', '6s', '7s'], lv);
  assert.ok(both.some((c) => c.type === TYPE.STRAIGHT));
  assert.ok(both.some((c) => c.type === TYPE.SFLUSH));

  // 逢人配变不出王
  const two = interpret(['5h', '5h'], lv);
  assert.ok(two.every((c) => c.rank < 16), '两张配凑不出对王');
});

test('findPlays 声明的牌型，interpret 一定认得', () => {
  let checked = 0;
  for (let iter = 0; iter < 60; iter++) {
    const lv = 2 + (iter % 13);
    const hand = shuffle(freshDeck()).slice(0, HAND_SIZE);
    for (const p of findPlays(hand, lv, null)) {
      const ok = interpret(p.cards, lv).some(
        (c) => c.type === p.combo.type && c.rank === p.combo.rank && c.size === p.combo.size
      );
      assert.ok(ok, `${p.cards.join(' ')} 声明为 ${JSON.stringify(p.combo)} 但 interpret 不认`);
      // 而且这些牌必须真的在手里
      const pool = [...hand];
      for (const c of p.cards) {
        const i = pool.indexOf(c);
        assert.ok(i >= 0, `${c} 不在手牌里`);
        pool.splice(i, 1);
      }
      checked++;
    }
  }
  assert.ok(checked > 1000, `样本太少：只检查了 ${checked} 个候选`);
});

test('findPlays 跟牌时只给压得过的候选', () => {
  const lv = 9;
  const hand = ['As', 'Ah', 'Ks', 'Kh', 'Qs', 'Qh', '3s', '3d', 'jb', 'jb'];
  const req = classify(['Ks', 'Kd'], lv);   // 要压过一对 K
  for (const p of findPlays(hand, lv, req)) {
    assert.ok(beats(p.combo, req), `${comboName(p.combo, lv)} 压不过一对 K`);
  }
  // 一对 A 和一对小王都该在里面，一对 Q 不该在
  const names = findPlays(hand, lv, req).map((p) => comboName(p.combo, lv));
  assert.ok(names.includes('对子 A'));
  assert.ok(!names.includes('对子 Q'));
});

test('sortHand 把逢人配排到最前，其余按大小降序', () => {
  const lv = 5;
  const sorted = sortHand(['3c', 'jr', '5h', 'As', '5c'], lv);
  assert.equal(sorted[0], '5h', '逢人配置顶');
  assert.equal(sorted[1], 'jr', '大王次之');
  assert.equal(sorted[2], '5c', '级牌大过 A');
  assert.equal(sorted[3], 'As');
  assert.equal(sorted[4], '3c');
});

// ==================== 一局的状态机 ====================

test('发牌：四家各 27 张，一共 108 张', () => {
  const d = new GuandanDeal({ level: 2 });
  assert.equal(d.phase, GD_PHASE.PLAYING);
  let total = 0;
  for (let s = 0; s < GD_SEATS; s++) {
    assert.equal(d.hands.get(s).length, HAND_SIZE);
    total += HAND_SIZE;
  }
  assert.equal(total, 108);
});

test('座位分队：对家是队友', () => {
  assert.equal(teamOf(0), teamOf(2));
  assert.equal(teamOf(1), teamOf(3));
  assert.notEqual(teamOf(0), teamOf(1));
  assert.equal(partnerOf(0), 2);
  assert.equal(partnerOf(3), 1);
});

test('进贡：交出最大的一张，逢人配不算', () => {
  const lv = 5;                       // 逢人配 5h，级牌 5
  // 3 号手里最大的普通牌是 Ks（没有别的 5），逢人配不该被贡出去
  const payer = pad(['5h', 'Ks', '4c', '6d'], HAND_SIZE, '3c');
  const d = new GuandanDeal({
    level: lv,
    deck: deckOf(pad(['2c']), pad(['2d']), pad(['2h']), payer),
    tributePlan: { double: false, payers: [3], receivers: [0], headSeat: 0 },
  });
  assert.equal(d.phase, GD_PHASE.TRIBUTE);
  assert.equal(d.tribute.moves.length, 1);
  assert.equal(d.tribute.moves[0].card, 'Ks', '应该贡 K，不该贡逢人配');
  assert.equal(d.tribute.moves[0].from, 3);
  assert.equal(d.tribute.moves[0].to, 0);
  assert.ok(d.hands.get(0).includes('Ks'), '贡牌要真的进到收贡方手里');
  assert.ok(d.hands.get(3).includes('5h'), '逢人配还留在进贡方手里');
  assert.equal(d.leadSeat, 3, '有进贡时由进贡者先出');
});

test('抗贡：进贡方合计两张大王就免贡', () => {
  const d = new GuandanDeal({
    level: 7,
    deck: deckOf(pad(['2c']), pad(['2d']), pad(['2h']), pad(['jr', 'jr', 'As'])),
    tributePlan: { double: false, payers: [3], receivers: [0], headSeat: 1 },
  });
  assert.equal(d.tribute.resisted, true);
  assert.equal(d.tribute.moves.length, 0);
  assert.equal(d.phase, GD_PHASE.PLAYING, '抗贡后直接开打');
  assert.equal(d.leadSeat, 1, '抗贡时由上一局头游先出');
});

test('双下时贡牌大的那张给头游', () => {
  const lv = 7;   // 用 7 是为了让填充牌 3c 只是普通小牌，不是级牌
  const d = new GuandanDeal({
    level: lv,
    deck: deckOf(pad(['2c']), pad(['2d']), pad(['Qs', '4c']), pad(['As', '4d'])),
    tributePlan: { double: true, payers: [2, 3], receivers: [0, 1], headSeat: 0 },
  });
  const toHead = d.tribute.moves.find((m) => m.to === 0);
  const toSecond = d.tribute.moves.find((m) => m.to === 1);
  assert.equal(toHead.card, 'As', 'A 比 Q 大，该给头游');
  assert.equal(toSecond.card, 'Qs');
  assert.equal(d.leadSeat, 3, '贡牌最大的那位先出');
});

test('级牌比 A 大，所以进贡时该交级牌', () => {
  const lv = 3;   // 级牌是 3，逢人配是 3h
  const d = new GuandanDeal({
    level: lv,
    deck: deckOf(pad(['2c']), pad(['2d']), pad(['2h']), pad(['As', '3c', '4d'], HAND_SIZE, '2s')),
    tributePlan: { double: false, payers: [3], receivers: [0], headSeat: 0 },
  });
  assert.equal(powerValue('3c', lv), 15, '级牌升到 A 之上');
  assert.equal(d.tribute.moves[0].card, '3c', '级牌 3 比 A 大，该贡它');
});

test('还贡：只能还 10 以内的牌，还完才开打', () => {
  const d = new GuandanDeal({
    level: 7,
    deck: deckOf(pad(['As', '9c', '2c']), pad(['2d']), pad(['2h']), pad(['Ks', '4c'])),
    tributePlan: { double: false, payers: [3], receivers: [0], headSeat: 0 },
  });
  assert.equal(d.phase, GD_PHASE.TRIBUTE);
  assert.deepEqual(d.pendingReturns(), [0]);

  const bad = d.returnTribute(0, 'As');
  assert.equal(bad.ok, false, 'A 超过 10，不能拿来还贡');
  assert.equal(d.phase, GD_PHASE.TRIBUTE);

  const cands = d.returnCandidates(0);
  assert.ok(cands.every((c) => naturalValue(c) <= 10));
  const ok = d.returnTribute(0, '9c');
  assert.equal(ok.ok, true);
  assert.ok(d.hands.get(3).includes('9c'), '还的牌要进到进贡方手里');
  assert.equal(d.phase, GD_PHASE.PLAYING);
  assert.equal(d.pendingReturns().length, 0);
});

test('出牌与要不起：一轮打完由赢的那家重新领出', () => {
  const lv = 9;
  const d = stage(lv, [
    ['As', 'Ah', '3c'],
    ['Ks', 'Kh', '4c'],
    ['Qs', 'Qh', '5c'],
    ['Js', 'Jh', '6c'],
  ]);
  assert.equal(d.turn, 0);
  assert.equal(d.play(0, ['Qs']).ok, false, '手里没有的牌不能出');
  assert.equal(d.pass(0).ok, false, '本轮第一个出牌的人不能过');

  assert.equal(d.play(0, ['3c']).ok, true);
  assert.equal(d.turn, 1);
  assert.equal(d.play(1, ['4c']).ok, true);
  assert.equal(d.play(2, ['3c']).ok, false, '压不过要被拒');
  assert.equal(d.pass(2).ok, true);
  assert.equal(d.pass(3).ok, true);
  assert.equal(d.pass(0).ok, true);
  assert.equal(d.req, null, '一轮结束，重置需要压过的牌');
  assert.equal(d.turn, 1, '赢这一轮的人重新领出');
});

test('接风：出完牌的人赢下一轮，牌权交给队友', () => {
  const lv = 9;
  const d = stage(lv, [
    ['jr'],                 // 0 号只剩一张大王
    ['3c', '4c'],
    ['5c', '6c'],
    ['7c', '8c'],
  ]);
  assert.equal(d.play(0, ['jr']).ok, true);
  assert.deepEqual(d.finished, [0], '0 号出完了');
  assert.equal(d.turn, 1);
  d.pass(1);
  d.pass(2);
  d.pass(3);
  assert.equal(d.req, null);
  assert.equal(d.turn, 2, '0 号的队友 2 号接风');
});

test('同队两人都出完，本局立即结束（双下）', () => {
  const lv = 9;
  const d = stage(lv, [
    ['jr'],
    ['3c', '4c', '5c'],
    ['jb'],
    ['7c', '8c', '9c'],
  ]);
  d.play(0, ['jr']);
  d.pass(1);
  assert.equal(d.play(2, ['jb']).ok, false, '小王压不过大王');
  d.pass(2);
  d.pass(3);
  assert.equal(d.turn, 2, '接风轮到 2 号');
  d.play(2, ['jb']);
  assert.equal(d.isComplete, true, '0 和 2 同队且都出完，本局结束');
  assert.equal(d.finishOrder.length, 4);
  assert.deepEqual(d.finishOrder.slice(0, 2), [0, 2]);
  assert.equal(teamOf(d.finishOrder[0]), teamOf(d.finishOrder[1]));
});

test('手牌总数在整局中始终守恒', () => {
  const d = new GuandanDeal({ level: 7 });
  let guard = 0;
  while (!d.isComplete && guard++ < 2000) {
    const seat = d.turn;
    const hand = d.hands.get(seat);
    const pick = choosePlay(hand, d.level, d.req?.combo || null, { myCount: hand.length });
    if (pick) d.play(seat, pick.cards, pick.combo);
    else if (d.req) d.pass(seat);
    else d.play(seat, [sortHand(hand, d.level).slice(-1)[0]]);
    const total = [...d.hands.values()].reduce((n, h) => n + h.length, 0);
    assert.ok(total <= 108, '牌不会凭空多出来');
  }
  assert.equal(d.isComplete, true, '整局能正常打完，不会卡死');
  assert.equal(new Set(d.finishOrder).size, 4, '名次里四个人各出现一次');
});

// ==================== 房间与升级 ====================

function fakeClient() {
  const c = {
    playerId: null,
    sent: [],
    send(o) { c.sent.push(o); },
    close() {},
  };
  return c;
}

/** 开一张坐满 4 人的桌子，关掉自动开下一局免得测试被定时器打扰 */
function seatedRoom() {
  const room = new GuandanRoom({ config: { actionTimeoutMs: 999999, autoNextDeal: false } });
  const clients = [];
  for (let s = 0; s < GD_SEATS; s++) {
    const c = fakeClient();
    room.attach(c);
    room.hello(c, null);
    room.sit(c, s, 'P' + (s + 1));
    clients.push(c);
  }
  return { room, clients };
}

/** 摆一个"0 号和 2 号各剩一张，必然双下"的局面，然后打完 */
function forceDoubleOut(room) {
  const d = room.deal;
  d.hands.set(0, ['jr']);
  d.hands.set(1, ['3c', '4c']);
  d.hands.set(2, ['jb']);
  d.hands.set(3, ['5c', '6c']);
  d.finished = [];
  d.passers = new Set();
  d.req = null;
  d.turn = d.leadSeat = 0;
  d.phase = GD_PHASE.PLAYING;
  const cl = room.clients;
  const by = (seat) => [...cl].find((c) => room.players.get(c.playerId)?.seat === seat);
  room.play(by(0), { cards: ['jr'] });
  room.pass(by(1), {});
  room.pass(by(2), {});
  room.pass(by(3), {});
  room.play(by(2), { cards: ['jb'] });
}

test('坐满 4 人自动开局，手牌只发给本人', () => {
  const { room, clients } = seatedRoom();
  assert.equal(room.dealNo, 1, '坐满就开局');
  const snap = room.buildStateFor(clients[0].playerId);
  assert.equal(snap.you.hand.length, HAND_SIZE, '自己能看到 27 张');
  assert.deepEqual(snap.seats.map((s) => s.count), [27, 27, 27, 27]);
  const text = JSON.stringify(snap);
  assert.ok(!text.includes('"hands"'), '快照里不该出现别人的手牌容器');

  // 精确清点：刚开局、没有进贡的快照里，允许出现的牌面只有两类 ——
  // 自己的 27 张手牌，以及 wild 字段里那张公开的逢人配。多一张都算泄漏。
  const found = text.match(/"([23456789TJQKA][cdhs]|jb|jr)"/g) || [];
  const allowed = [...snap.you.hand, snap.wild].map((c) => `"${c}"`).sort();
  assert.equal(found.length, allowed.length, '快照里的牌面数量对不上');
  assert.deepEqual(found.sort(), allowed, '快照里出现了不该出现的牌');
  room.shutdown();
});

test('第 5 个人坐不下，牌局中也不让中途入座', () => {
  const { room } = seatedRoom();
  const extra = fakeClient();
  room.attach(extra);
  room.hello(extra, null);
  const r = room.sit(extra, 0, '插队的');
  assert.equal(r.ok, false);
  room.shutdown();
});

test('双下升 3 级，赢的一队接着坐庄', () => {
  const { room } = seatedRoom();
  assert.deepEqual(room.levels, [2, 2]);
  forceDoubleOut(room);
  assert.equal(room.result.doubleOut, true);
  assert.equal(room.result.gain, 3);
  assert.deepEqual(room.levels, [5, 2], '红队从打 2 升到打 5');
  assert.equal(room.dealingTeam, 0);
  assert.deepEqual(room.result.finishOrder.slice(0, 2), [0, 2]);
  room.shutdown();
});

test('升级封顶在 A，不能跳过 A', () => {
  const { room } = seatedRoom();
  room.levels = [13, 2];       // 红队打 K，双下 +3 本该到 16
  room.dealingTeam = 0;
  forceDoubleOut(room);
  assert.equal(room.levels[0], 14, '停在 A，不会越过去');
  assert.equal(room.matchOver, null, '还没打过 A，比赛没结束');
  room.shutdown();
});

test('打 A 那局赢了就过 A，整场结束', () => {
  const { room } = seatedRoom();
  room.levels = [14, 6];
  room.dealingTeam = 0;        // 红队正在打 A
  forceDoubleOut(room);        // 红队赢
  assert.ok(room.matchOver, '应该整场结束');
  assert.equal(room.matchOver.team, 0);
  room.shutdown();
});

test('三次打 A 未过，退回打 2', () => {
  const { room } = seatedRoom();
  room.levels = [6, 14];
  room.dealingTeam = 1;        // 蓝队打 A，红队赢 -> 蓝队记一次失败
  for (let i = 1; i <= 3; i++) {
    room.deal = null;
    room.lastFinishOrder = null;
    room.startDeal();
    room.dealingTeam = 1;
    room.levels[1] = 14;
    forceDoubleOut(room);      // 每次都是红队双下
    if (i < 3) {
      assert.equal(room.aFail[1], i, `第 ${i} 次打 A 未过`);
      assert.equal(room.levels[1], 14, '还留在 A');
    }
  }
  assert.equal(room.levels[1], 2, '三次不过退回打 2');
  assert.equal(room.aFail[1], 0, '失败次数清零');
  room.shutdown();
});

test('中途有人离座，本局作废', () => {
  const { room, clients } = seatedRoom();
  assert.ok(room.deal);
  room.stand(clients[1]);
  assert.equal(room.deal, null, '牌局被作废');
  assert.equal(room.seats[1], null);
  room.shutdown();
});

test('真人全走光时人机一并清场', () => {
  const room = new GuandanRoom({ config: { autoNextDeal: false } });
  const host = fakeClient();
  room.attach(host);
  room.hello(host, null);
  room.sit(host, 0, '房主');
  assert.equal(room.addBot(host, 1).ok, true);
  assert.equal(room.addBot(host, 2).ok, true);
  assert.equal(room.addBot(host, 3).ok, true);
  assert.equal(room.dealNo, 1, '加满人机就开局');
  room.stand(host);
  assert.deepEqual(room.seats, [null, null, null, null], '人机不会自己留在空桌上');
  assert.equal(room.levels[0], 2, '清场后级数也重置');
  room.shutdown();
});

test('只有房主能改设置、加人机、重开', () => {
  const { room, clients } = seatedRoom();
  const guest = clients[1];
  assert.equal(room.setConfig(guest, { actionTimeoutMs: 20000 }).code, 'NOT_HOST');
  assert.equal(room.addBot(guest, 0).code, 'NOT_HOST');
  assert.equal(room.reset(guest).code, 'NOT_HOST');
  const host = clients[0];
  assert.equal(room.setConfig(host, { actionTimeoutMs: 20000 }).ok, true);
  assert.equal(room.config.actionTimeoutMs, 20000);
  assert.equal(room.setConfig(host, { actionTimeoutMs: 1 }).ok, false, '超范围要被拒');
  room.shutdown();
});

test('本局结束后换人坐，新人不会看到上一位玩家的剩牌', () => {
  const { room, clients } = seatedRoom();
  forceDoubleOut(room);                       // 打完一局，末游手里还有剩牌
  const loser = room.result.places[3].seat;
  assert.ok(room.deal.hands.get(loser).length > 0, '末游确实有剩牌');

  const old = [...room.clients].find((c) => room.players.get(c.playerId)?.seat === loser);
  room.stand(old);                            // 本局已结束，离座不会作废牌局
  const fresh = fakeClient();
  room.attach(fresh);
  room.hello(fresh, null);
  assert.equal(room.sit(fresh, loser, '新来的').ok, true);

  const snap = room.buildStateFor(fresh.playerId);
  assert.deepEqual(snap.you.hand, [], '新人手里应该是空的，不该继承别人的牌');
  room.shutdown();
});

test('断线重连能用 token 找回座位', () => {
  const { room, clients } = seatedRoom();
  const token = clients[2].sent.find((m) => m.t === 'welcome').token;
  room.detach(clients[2]);
  assert.equal(room.seats[2] !== null, true, '掉线不立刻收座位');
  const back = fakeClient();
  room.attach(back);
  room.hello(back, token);
  const welcome = back.sent.find((m) => m.t === 'welcome');
  assert.equal(welcome.seat, 2, '拿 token 回到原座位');
  room.shutdown();
});
