// SPDX-License-Identifier: GPL-3.0-or-later
// test/engine.test.js —— 单手牌状态机测试
//
// 所有确定性用例都注入固定牌堆。牌堆约定（见 engine.js 顶部注释）：
//   从「按钮左手第一位」开始顺时针，一人一张发两轮，然后 3 张翻牌 + 1 张转牌 + 1 张河牌，不烧牌。

import test from 'node:test';
import assert from 'node:assert/strict';

import { Hand } from '../server/engine.js';
import { PHASES } from '../server/protocol.js';

const CFG = { smallBlind: 5, bigBlind: 10, ante: 0 };

/**
 * 按发牌顺序拼一副牌。
 * @param {string[][]} holes 按「按钮左手第一位」起的顺序，每人两张
 * @param {string[]} board  5 张公共牌
 */
function makeDeck(holes, board) {
  const deck = [];
  for (let r = 0; r < 2; r++) for (const h of holes) deck.push(h[r]);
  deck.push(...board);
  return deck;
}

function seats(...specs) {
  return specs.map(([seat, chips, name]) => ({ seat, chips, name: name ?? `P${seat}` }));
}

function sumValues(obj) {
  return Object.values(obj).reduce((a, b) => a + b, 0);
}

// --------------------------------------------------------------------------- 3 人局

test('3 人局：盲注就位、行动顺序、一路过牌到河牌并摊牌分池', () => {
  const deck = makeDeck(
    [['As', 'Ad'], ['Ks', 'Kd'], ['2c', '3d']], // 座位 1、2、0（按钮 0 的左手起）
    ['2h', '5c', '9d', 'Qh', '4s']
  );
  const hand = new Hand({
    players: seats([0, 1000, '甲'], [1, 1000, '乙'], [2, 1000, '丙']),
    config: CFG,
    buttonSeat: 0,
    deck,
    handNo: 1
  });

  // 盲注就位
  assert.equal(hand.sbSeat, 1);
  assert.equal(hand.bbSeat, 2);
  assert.equal(hand.players.get(1).committedRound, 5);
  assert.equal(hand.players.get(2).committedRound, 10);
  assert.equal(hand.players.get(1).chips, 995);
  assert.equal(hand.players.get(2).chips, 990);
  assert.equal(hand.currentBet, 10);
  assert.equal(hand.minRaiseTo, 20);
  assert.equal(hand.phase, PHASES.PREFLOP);
  assert.equal(hand.totalPot, 15);
  // 底牌按约定发出
  assert.deepEqual(hand.players.get(1).holeCards, ['As', 'Ad']);
  assert.deepEqual(hand.players.get(2).holeCards, ['Ks', 'Kd']);
  assert.deepEqual(hand.players.get(0).holeCards, ['2c', '3d']);

  // 翻牌前从大盲左手第一位（这里是按钮）开始
  assert.equal(hand.actingSeat, 0);
  assert.equal(hand.act(0, { type: 'call' }).ok, true);
  assert.equal(hand.actingSeat, 1);
  assert.equal(hand.act(1, { type: 'call' }).ok, true);
  assert.equal(hand.actingSeat, 2);
  assert.equal(hand.act(2, { type: 'check' }).ok, true);

  // 翻牌：从按钮左手第一位开始
  assert.equal(hand.phase, PHASES.FLOP);
  assert.deepEqual(hand.board, ['2h', '5c', '9d']);
  assert.equal(hand.actingSeat, 1);
  assert.deepEqual(hand.pots, [{ amount: 30, eligibleSeats: [0, 1, 2] }]);

  for (const s of [1, 2, 0]) assert.equal(hand.act(s, { type: 'check' }).ok, true);
  assert.equal(hand.phase, PHASES.TURN);
  assert.equal(hand.board.length, 4);
  assert.equal(hand.actingSeat, 1);

  for (const s of [1, 2, 0]) assert.equal(hand.act(s, { type: 'check' }).ok, true);
  assert.equal(hand.phase, PHASES.RIVER);
  assert.deepEqual(hand.board, ['2h', '5c', '9d', 'Qh', '4s']);
  assert.equal(hand.actingSeat, 1);

  for (const s of [1, 2, 0]) assert.equal(hand.act(s, { type: 'check' }).ok, true);

  // 摊牌
  assert.equal(hand.isComplete, true);
  assert.equal(hand.phase, PHASES.HAND_OVER);
  assert.equal(hand.actingSeat, null);
  const r = hand.result;
  assert.equal(r.wentToShowdown, true);
  assert.equal(r.showdown.length, 3);
  assert.deepEqual(r.payouts, { 1: 30 });
  assert.deepEqual(r.chipsAfter, { 0: 990, 1: 1020, 2: 990 });
  assert.equal(r.winners.length, 1);
  assert.equal(r.winners[0].seat, 1);
  assert.equal(r.winners[0].amount, 30);
  assert.equal(r.winners[0].potIndex, 0);
  assert.equal(typeof r.winners[0].handName, 'string');
  assert.equal(r.winners[0].best.length, 5);
  assert.equal(r.uncalledReturned, null);
  assert.equal(sumValues(r.chipsAfter), 3000);
});

// --------------------------------------------------------------------------- 单挑

test('单挑：按钮即小盲，翻牌前按钮先动，翻牌后大盲先动', () => {
  const deck = makeDeck(
    [['Ah', 'Kh'], ['2c', '7d']], // 座位 3（大盲，按钮左手第一位）、座位 0（按钮/小盲）
    ['3s', '8c', 'Jd', '4h', '9s']
  );
  const hand = new Hand({
    players: seats([0, 1000, '甲'], [3, 1000, '丁']),
    config: CFG,
    buttonSeat: 0,
    deck
  });

  assert.equal(hand.sbSeat, 0); // 按钮即小盲
  assert.equal(hand.bbSeat, 3);
  assert.equal(hand.players.get(0).committedRound, 5);
  assert.equal(hand.players.get(3).committedRound, 10);
  assert.deepEqual(hand.players.get(3).holeCards, ['Ah', 'Kh']);
  assert.deepEqual(hand.players.get(0).holeCards, ['2c', '7d']);

  // 翻牌前按钮先动
  assert.equal(hand.actingSeat, 0);
  assert.equal(hand.act(0, { type: 'call' }).ok, true);
  // 大盲还有选择权
  assert.equal(hand.actingSeat, 3);
  assert.equal(hand.legalActions(3).canCheck, true);
  assert.equal(hand.act(3, { type: 'check' }).ok, true);

  // 翻牌后大盲先动
  assert.equal(hand.phase, PHASES.FLOP);
  assert.equal(hand.actingSeat, 3);
  assert.equal(hand.act(3, { type: 'check' }).ok, true);
  assert.equal(hand.actingSeat, 0);
  assert.equal(hand.act(0, { type: 'check' }).ok, true);
  assert.equal(hand.phase, PHASES.TURN);
  assert.equal(hand.actingSeat, 3);
});

// --------------------------------------------------------------------------- 大盲 option

test('大盲 option：所有人跟注后轮到大盲，仍可过牌或加注', () => {
  const deck = makeDeck(
    [['As', 'Ad'], ['Ks', 'Kd'], ['2c', '3d']],
    ['2h', '5c', '9d', 'Qh', '4s']
  );
  const hand = new Hand({
    players: seats([0, 1000], [1, 1000], [2, 1000]),
    config: CFG,
    buttonSeat: 0,
    deck
  });

  hand.act(0, { type: 'call' });
  hand.act(1, { type: 'call' });

  assert.equal(hand.actingSeat, 2); // 大盲
  const legal = hand.legalActions(2);
  assert.equal(legal.canCheck, true);
  assert.equal(legal.canRaise, true);
  assert.equal(legal.canCall, false);
  assert.equal(legal.callAmount, 0);
  assert.equal(legal.minRaiseTo, 20);
  assert.equal(legal.maxRaiseTo, 1000);
  assert.equal(legal.isAllInCall, false);
  assert.equal(hand.phase, PHASES.PREFLOP); // 没有因为「已投入等于 currentBet」提前结束

  // 大盲行使加注权
  assert.equal(hand.act(2, { type: 'raise', amount: 40 }).ok, true);
  assert.equal(hand.currentBet, 40);
  assert.equal(hand.actingSeat, 0);
});

// --------------------------------------------------------------------------- 不足完整加注的全下

test('短码全下不足一次完整加注：已行动玩家不重开加注权，未行动玩家不受影响', () => {
  const deck = makeDeck(
    [['2c', '2d'], ['3c', '3d'], ['Kc', 'Qd'], ['As', 'Ah']], // 座位 1、2、3、0
    ['7h', '8s', '9c', 'Jd', '4d']
  );
  const hand = new Hand({
    players: seats([0, 45, '短码'], [1, 1000], [2, 1000], [3, 1000]),
    config: CFG,
    buttonSeat: 0,
    deck
  });

  // 翻牌前从大盲(座位2)左手第一位开始 = 座位 3
  assert.equal(hand.actingSeat, 3);
  assert.equal(hand.act(3, { type: 'raise', amount: 30 }).ok, true); // 完整加注
  assert.equal(hand.currentBet, 30);
  assert.equal(hand.minRaiseTo, 50);

  // 短码全下 45 < 50，不是完整加注
  assert.equal(hand.actingSeat, 0);
  assert.equal(hand.legalActions(0).canRaise, false); // 筹码不足以完成最小加注
  assert.equal(hand.act(0, { type: 'allin' }).ok, true);
  assert.equal(hand.currentBet, 45);
  assert.equal(hand.players.get(0).allIn, true);

  // 尚未行动过的玩家仍可加注
  assert.equal(hand.actingSeat, 1);
  const legal1 = hand.legalActions(1);
  assert.equal(legal1.canRaise, true);
  assert.equal(legal1.minRaiseTo, 65); // 45 + 上一次完整加注的 20
  assert.equal(hand.act(1, { type: 'fold' }).ok, true);

  assert.equal(hand.actingSeat, 2);
  assert.equal(hand.legalActions(2).canRaise, true);
  assert.equal(hand.act(2, { type: 'fold' }).ok, true);

  // 已经行动过的座位 3 再次面对行动：只能跟注/弃牌
  assert.equal(hand.actingSeat, 3);
  const legal3 = hand.legalActions(3);
  assert.equal(legal3.canRaise, false);
  assert.equal(legal3.canCall, true);
  assert.equal(legal3.callAmount, 15);
  assert.equal(hand.act(3, { type: 'raise', amount: 100 }).ok, false);
  assert.equal(hand.currentBet, 45); // 非法动作没有改变状态

  assert.equal(hand.act(3, { type: 'call' }).ok, true);
  assert.equal(hand.isComplete, true);

  const r = hand.result;
  assert.deepEqual(hand.pots, [{ amount: 105, eligibleSeats: [0, 3] }]);
  assert.deepEqual(r.chipsAfter, { 0: 105, 1: 995, 2: 990, 3: 955 });
  assert.equal(sumValues(r.chipsAfter), 45 + 1000 * 3);
});

test('之后出现一次完整加注时，被剥夺的加注权重新打开', () => {
  const deck = makeDeck(
    [['2c', '2d'], ['3c', '3d'], ['Kc', 'Qd'], ['As', 'Ah']],
    ['7h', '8s', '9c', 'Jd', '4d']
  );
  const hand = new Hand({
    players: seats([0, 45, '短码'], [1, 1000], [2, 1000], [3, 1000]),
    config: CFG,
    buttonSeat: 0,
    deck
  });

  hand.act(3, { type: 'raise', amount: 30 });
  hand.act(0, { type: 'allin' });                    // 45，不足完整加注
  assert.equal(hand.players.get(3).raiseBlocked, true);
  assert.equal(hand.act(1, { type: 'raise', amount: 65 }).ok, true); // 完整加注，重开加注权
  assert.equal(hand.players.get(3).raiseBlocked, false);
  assert.equal(hand.act(2, { type: 'fold' }).ok, true);

  assert.equal(hand.actingSeat, 3);
  const legal3 = hand.legalActions(3);
  assert.equal(legal3.canRaise, true);
  assert.equal(legal3.minRaiseTo, 85); // 65 + 上一次完整加注的 20
});

// --------------------------------------------------------------------------- 边池

test('三人不同筹码全下：主池 + 边池、未跟注部分退还、各池分别结算', () => {
  const deck = makeDeck(
    [['As', 'Ad'], ['Ks', 'Kd'], ['2c', '3h']], // 座位 1(100)、2(200)、0(300)
    ['2s', '5c', '9d', 'Qh', '4s']
  );
  const hand = new Hand({
    players: seats([0, 300, '大'], [1, 100, '小'], [2, 200, '中']),
    config: CFG,
    buttonSeat: 0,
    deck
  });

  assert.equal(hand.actingSeat, 0);
  assert.equal(hand.act(0, { type: 'allin' }).ok, true);
  assert.equal(hand.currentBet, 300);
  assert.equal(hand.act(1, { type: 'allin' }).ok, true);
  assert.equal(hand.act(2, { type: 'allin' }).ok, true);

  // 全员全下：自动发完公共牌直接摊牌
  assert.equal(hand.isComplete, true);
  assert.equal(hand.board.length, 5);

  assert.deepEqual(hand.pots, [
    { amount: 300, eligibleSeats: [0, 1, 2] }, // 主池 100 * 3
    { amount: 200, eligibleSeats: [0, 2] }     // 边池 100 * 2
  ]);

  const r = hand.result;
  assert.deepEqual(r.uncalledReturned, { seat: 0, amount: 100 });
  assert.equal(r.wentToShowdown, true);
  assert.equal(r.showdown.length, 3);
  // 主池 AA 拿下，边池 KK 拿下
  assert.deepEqual(r.winners.map((w) => [w.seat, w.amount, w.potIndex]), [
    [1, 300, 0],
    [2, 200, 1]
  ]);
  assert.deepEqual(r.payouts, { 0: 100, 1: 300, 2: 200 });
  assert.deepEqual(r.chipsAfter, { 0: 100, 1: 300, 2: 200 });
  assert.equal(sumValues(r.chipsAfter), 600);
});

// --------------------------------------------------------------------------- 未被跟注的退还 / 全弃牌

test('全部弃牌只剩一人：不摊牌，未被跟注的下注退还', () => {
  const deck = makeDeck([['Ah', 'Kh'], ['2c', '7d']], ['3s', '8c', 'Jd', '4h', '9s']);
  const hand = new Hand({
    players: seats([0, 1000, '甲'], [3, 1000, '丁']),
    config: CFG,
    buttonSeat: 0,
    deck
  });

  assert.equal(hand.act(0, { type: 'raise', amount: 100 }).ok, true);
  assert.equal(hand.actingSeat, 3);
  assert.equal(hand.act(3, { type: 'fold' }).ok, true);

  assert.equal(hand.isComplete, true);
  const r = hand.result;
  assert.equal(r.wentToShowdown, false);
  assert.deepEqual(r.showdown, []);
  assert.deepEqual(r.uncalledReturned, { seat: 0, amount: 90 });
  assert.deepEqual(hand.pots, [{ amount: 20, eligibleSeats: [0] }]);
  assert.deepEqual(r.winners, [{
    seat: 0, amount: 20, potIndex: 0,
    handName: null, handNameEn: null, handRank: null, best: null
  }]);
  assert.deepEqual(r.payouts, { 0: 110 }); // 20 赢取 + 90 退还
  assert.deepEqual(r.chipsAfter, { 0: 1010, 3: 990 });
  assert.equal(sumValues(r.chipsAfter), 2000);
  // 没有揭示任何底牌
  assert.equal(hand.events.some((e) => e.kind === 'showdown'), false);
});

// --------------------------------------------------------------------------- 平分底池

test('平分奇数底池：零头给按钮左手第一位', () => {
  const deck = makeDeck(
    [['2c', '3d'], ['2h', '3s'], ['5c', '6d']], // 座位 1、2、0
    ['As', 'Ks', 'Qd', 'Jh', 'Tc']              // 公共牌就是最大的顺子，两人平分
  );
  const hand = new Hand({
    players: seats([0, 1000], [1, 1000], [2, 1000]),
    config: { smallBlind: 5, bigBlind: 10, ante: 5 },
    buttonSeat: 0,
    deck
  });

  // 前注 3 * 5 = 15 已入池，且不计入本轮下注额
  assert.equal(hand.players.get(0).committedTotal, 5);
  assert.equal(hand.players.get(0).committedRound, 0);
  assert.equal(hand.players.get(1).committedRound, 5);
  assert.equal(hand.currentBet, 10);

  assert.equal(hand.act(0, { type: 'fold' }).ok, true);
  assert.equal(hand.act(1, { type: 'call' }).ok, true);
  assert.equal(hand.act(2, { type: 'check' }).ok, true);

  for (const street of [0, 1, 2]) {
    assert.equal(hand.actingSeat, 1, `第 ${street} 条街应由座位 1 先动`);
    assert.equal(hand.act(1, { type: 'check' }).ok, true);
    assert.equal(hand.act(2, { type: 'check' }).ok, true);
  }

  assert.equal(hand.isComplete, true);
  const r = hand.result;
  assert.deepEqual(hand.pots, [{ amount: 35, eligibleSeats: [1, 2] }]);
  assert.equal(r.winners.length, 2);
  // 35 / 2 = 17 ... 1 枚零头给按钮(0)左手第一位 = 座位 1
  assert.deepEqual(r.payouts, { 1: 18, 2: 17 });
  assert.deepEqual(r.chipsAfter, { 0: 995, 1: 1003, 2: 1002 });
  assert.equal(sumValues(r.chipsAfter), 3000);
});

// --------------------------------------------------------------------------- 非法动作

test('非法动作被拒绝且完全不改变状态', () => {
  const deck = makeDeck(
    [['As', 'Ad'], ['Ks', 'Kd'], ['2c', '3d']],
    ['2h', '5c', '9d', 'Qh', '4s']
  );
  const hand = new Hand({
    players: seats([0, 1000], [1, 1000], [2, 1000]),
    config: CFG,
    buttonSeat: 0,
    deck
  });

  const snapshot = () => ({
    acting: hand.actingSeat,
    bet: hand.currentBet,
    pot: hand.totalPot,
    events: hand.events.length,
    chips: [0, 1, 2].map((s) => hand.players.get(s).chips),
    committed: [0, 1, 2].map((s) => hand.players.get(s).committedRound)
  });

  const before = snapshot();
  const bad = [
    [1, { type: 'check' }],                  // 不到自己回合
    [2, { type: 'call' }],                   // 不到自己回合
    [0, { type: 'raise', amount: 15 }],      // 小于 minRaiseTo(20)
    [0, { type: 'raise', amount: 5000 }],    // 超过筹码
    [0, { type: 'bet', amount: 50 }],        // 本轮已有下注
    [0, { type: 'check' }],                  // 面对下注不能过牌
    [0, { type: 'raise', amount: 20.5 }],    // 非整数
    [0, { type: 'shove' }],                  // 未知类型
    [7, { type: 'fold' }]                    // 不在本手牌中的座位
  ];
  for (const [seat, action] of bad) {
    const res = hand.act(seat, action);
    assert.equal(res.ok, false, `${seat} ${JSON.stringify(action)} 应当被拒绝`);
    assert.equal(typeof res.error, 'string');
    assert.ok(res.error.length > 0);
    assert.deepEqual(snapshot(), before, `${seat} ${JSON.stringify(action)} 不应改变状态`);
  }

  // 非行动座位拿不到 legalActions
  assert.equal(hand.legalActions(1), null);
  assert.equal(hand.legalActions(0).canFold, true);

  // 合法动作照常工作
  assert.equal(hand.act(0, { type: 'raise', amount: 20 }).ok, true);
  assert.equal(hand.currentBet, 20);
});

// --------------------------------------------------------------------------- 超时 / 断线

test('timeoutAction 能过牌就过牌否则弃牌；forceFold 可在非其回合调用', () => {
  const deck = makeDeck(
    [['As', 'Ad'], ['Ks', 'Kd'], ['2c', '3d']],
    ['2h', '5c', '9d', 'Qh', '4s']
  );
  const hand = new Hand({
    players: seats([0, 1000], [1, 1000], [2, 1000]),
    config: CFG,
    buttonSeat: 0,
    deck
  });

  // 座位 0 面对大盲，超时 = 弃牌
  assert.equal(hand.timeoutAction(0).ok, true);
  assert.equal(hand.players.get(0).folded, true);

  // 座位 1 跟注后轮到大盲座位 2，超时 = 过牌
  assert.equal(hand.act(1, { type: 'call' }).ok, true);
  assert.equal(hand.actingSeat, 2);
  assert.equal(hand.timeoutAction(2).ok, true);
  assert.equal(hand.players.get(2).folded, false);
  assert.equal(hand.phase, PHASES.FLOP);

  // 轮到座位 1 行动时，让座位 2 断线弃牌 -> 直接结束本手牌
  assert.equal(hand.actingSeat, 1);
  assert.equal(hand.forceFold(2).ok, true);
  assert.equal(hand.isComplete, true);
  assert.equal(hand.result.wentToShowdown, false);
  assert.equal(sumValues(hand.result.chipsAfter), 3000);
});

// --------------------------------------------------------------------------- 模糊测试

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const SUITS = ['c', 'd', 'h', 's'];

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomDeck(rng) {
  const deck = [];
  for (const r of RANKS) for (const s of SUITS) deck.push(r + s);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

test('模糊测试：200 局随机合法动作，筹码守恒且必然走到结束', () => {
  for (let iter = 0; iter < 200; iter++) {
    const rng = mulberry32(0x9e3779b9 ^ (iter * 2654435761));
    const count = randInt(rng, 2, 6);
    const allSeats = [0, 1, 2, 3, 4, 5, 6, 7];
    // 随机挑选座位
    for (let i = allSeats.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [allSeats[i], allSeats[j]] = [allSeats[j], allSeats[i]];
    }
    const chosen = allSeats.slice(0, count).sort((a, b) => a - b);
    const players = chosen.map((seat) => ({ seat, name: `P${seat}`, chips: randInt(rng, 12, 2000) }));
    const buttonSeat = chosen[randInt(rng, 0, count - 1)];
    const ante = rng() < 0.25 ? 5 : 0;
    const startTotal = players.reduce((a, p) => a + p.chips, 0);
    const startChips = new Map(players.map((p) => [p.seat, p.chips]));

    const hand = new Hand({
      players,
      config: { smallBlind: 5, bigBlind: 10, ante },
      buttonSeat,
      deck: randomDeck(rng),
      handNo: iter + 1
    });

    let steps = 0;
    while (!hand.isComplete) {
      assert.ok(steps++ < 500, `第 ${iter} 局：动作过多，疑似死循环`);
      const seat = hand.actingSeat;
      assert.notEqual(seat, null, `第 ${iter} 局：未结束却没有行动者`);
      const legal = hand.legalActions(seat);
      assert.notEqual(legal, null, `第 ${iter} 局：行动者没有合法动作`);
      const p = hand.players.get(seat);

      const options = [{ type: 'fold' }];
      if (legal.canCheck) options.push({ type: 'check' });
      if (legal.canCall) options.push({ type: 'call' });
      if (legal.canBet) options.push({ type: 'bet', amount: randInt(rng, legal.minBet, legal.maxRaiseTo) });
      if (legal.canRaise) options.push({ type: 'raise', amount: randInt(rng, legal.minRaiseTo, legal.maxRaiseTo) });
      if (p.chips > 0) options.push({ type: 'allin' });

      const action = options[randInt(rng, 0, options.length - 1)];
      const res = hand.act(seat, action);
      assert.equal(res.ok, true, `第 ${iter} 局：合法动作被拒绝 ${JSON.stringify(action)} -> ${res.error}`);
      assert.ok(Array.isArray(res.events));

      // 过程中的不变量（手牌结束时已经派彩，另行校验）
      let live = 0;
      for (const q of hand.players.values()) {
        assert.ok(q.chips >= 0, `第 ${iter} 局：出现负筹码`);
        live += q.chips + q.committedTotal;
      }
      if (!hand.isComplete) {
        assert.equal(live, startTotal, `第 ${iter} 局：过程中筹码不守恒`);
      }
    }

    // 结束后的不变量
    const r = hand.result;
    assert.notEqual(r, null);
    assert.equal(hand.actingSeat, null);
    assert.equal(hand.phase, PHASES.HAND_OVER);

    let committed = 0;
    for (const q of hand.players.values()) {
      assert.ok(q.chips >= 0, `第 ${iter} 局：结束后出现负筹码`);
      committed += q.committedTotal;
    }
    const potSum = hand.pots.reduce((a, pot) => a + pot.amount, 0);
    assert.equal(potSum, committed, `第 ${iter} 局：底池总额与玩家投入不一致`);

    const refunded = r.uncalledReturned ? r.uncalledReturned.amount : 0;
    assert.equal(sumValues(r.payouts), potSum + refunded, `第 ${iter} 局：payouts 与底池不一致`);
    assert.equal(sumValues(r.chipsAfter), startTotal, `第 ${iter} 局：筹码不守恒`);

    for (const [seat, chips] of Object.entries(r.chipsAfter)) {
      assert.ok(chips >= 0);
      const s = Number(seat);
      const q = hand.players.get(s);
      // payouts 含退还部分，而 committedTotal 已经扣掉了退还，逐项对账时要把退还去掉
      const back = r.uncalledReturned && r.uncalledReturned.seat === s ? r.uncalledReturned.amount : 0;
      const won = (r.payouts[s] || 0) - back;
      assert.ok(won >= 0, `第 ${iter} 局：座位 ${s} 的赢取额为负`);
      assert.equal(chips, startChips.get(s) - q.committedTotal + won, `第 ${iter} 局：座位 ${s} 账目不平`);
    }

    // 每个底池的资格座位都必须还在牌里
    for (const pot of hand.pots) {
      assert.ok(pot.amount > 0);
      for (const s of pot.eligibleSeats) assert.equal(hand.players.get(s).folded, false);
    }

    // 摊牌一致性
    const alive = [...hand.players.values()].filter((q) => !q.folded);
    if (alive.length > 1) {
      assert.equal(r.wentToShowdown, true);
      assert.equal(r.showdown.length, alive.length);
      assert.equal(hand.board.length, 5);
    } else {
      assert.equal(r.wentToShowdown, false);
      assert.deepEqual(r.showdown, []);
    }
  }
});
