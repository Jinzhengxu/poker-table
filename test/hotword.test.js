// SPDX-License-Identifier: GPL-3.0-or-later
// 热词：词向量层、一局状态机、房间与快照脱敏的测试。
//
// 引擎里所有时间都是参数传进去的，所以这些测试不用 sleep 就能把冷却、
// 偷看冻结、提示解锁全部跑一遍。

import test from 'node:test';
import assert from 'node:assert/strict';

import { WordVectors } from '../server/hotword/vectors.js';
import {
  HotwordRound, HW_PHASE, HW_SEATS, GUESS_COOLDOWN_MS, PEEK_FREEZE_MS,
  PEEK_LIMIT, ROUND_LIMIT_MS, ROUND_LIMIT_MIN_MS, ROUND_LIMIT_MAX_MS, HINT_TIERS,
  tempOf, heatOf, normalizeWord,
} from '../server/hotword/engine.js';
import { HotwordRoom } from '../server/hotword/room.js';

// 词库是 11MB 的生成产物。仓库里带着，但万一有人清掉了，
// 别让整个测试套件红一片——跳过并说清楚原因。
const V = WordVectors.load();
const noData = V ? false : '没有 server/hotword/data/，先跑 scripts/build-hotword-data.mjs';

/** 造一个房间认识的假客户端 */
function fakeClient() {
  const sent = [];
  return {
    playerId: null,
    sent,
    send(obj) { sent.push(obj); },
    close() {},
    last(type) { return [...sent].reverse().find((m) => m.t === type) || null; },
  };
}

/** 开一个房间，两个人上擂台，返回 { room, a, b } */
function seatedRoom(answerWord) {
  const room = new HotwordRoom({ vectors: V });
  const a = fakeClient();
  const b = fakeClient();
  room.attach(a);
  room.attach(b);
  room.hello(a, null);
  room.hello(b, null);
  room.sit(a, 0, '阿甲');
  room.sit(b, 1, '阿乙');
  if (answerWord) {
    // 把答案钉死，测试才好写
    room.vectors = Object.create(V);
    room.vectors.answers = [{ word: answerWord, category: '测试' }];
  }
  return { room, a, b };
}

// ==================== 温度映射 ====================

test('温度：第 1 名 100 度，越往后越低，末位是 0', () => {
  const N = 52728;
  assert.equal(tempOf(1, N), 100);
  assert.equal(tempOf(N, N), 0);
  const t10 = tempOf(10, N);
  const t100 = tempOf(100, N);
  const t1000 = tempOf(1000, N);
  assert.ok(t10 > t100 && t100 > t1000, `应该单调递减，实际 ${t10}/${t100}/${t1000}`);
  assert.ok(t10 > 70 && t10 < 85, `第 10 名应该在 70-85 度之间，实际 ${t10}`);
});

test('档位：排名落在正确的冷热档', () => {
  assert.equal(heatOf(1), 'hit');
  assert.equal(heatOf(10), 'burning');
  assert.equal(heatOf(50), 'hot');
  assert.equal(heatOf(200), 'warm');
  assert.equal(heatOf(1000), 'mild');
  assert.equal(heatOf(5000), 'cool');
  assert.equal(heatOf(40000), 'cold');
});

test('输入规整：去掉空格和全角空格', () => {
  assert.equal(normalizeWord('  咖啡 '), '咖啡');
  assert.equal(normalizeWord('咖　啡'), '咖啡');
  assert.equal(normalizeWord(null), '');
});

// ==================== 词向量 ====================

test('词向量：排名表把近义词排在前面，无关词排在后面', { skip: noData }, () => {
  const rank = V.rankTable('医生');
  const r = (w) => rank[V.index.get(w)] + 1;
  assert.equal(r('医生'), 1, '目标词自己必须是第 1 名');
  assert.ok(r('护士') < 50, `护士该很近，实际第 ${r('护士')} 名`);
  assert.ok(r('医院') < 50, `医院该很近，实际第 ${r('医院')} 名`);
  assert.ok(r('西瓜') > 1000, `西瓜该很远，实际第 ${r('西瓜')} 名`);
  assert.ok(r('汽车') > 1000, `汽车该很远，实际第 ${r('汽车')} 名`);
});

test('词向量：答案池里的词全部在词表里', { skip: noData }, () => {
  for (const a of V.answers) {
    assert.ok(V.has(a.word), `答案「${a.word}」不在词表里，这一局会无解`);
  }
  assert.ok(V.answers.length > 100, `答案池太小了：${V.answers.length}`);
});

test('词向量：子串词能被找出来（中文版特有的漏底路径）', { skip: noData }, () => {
  const related = V.relatedForms('咖啡');
  const words = [...related].map((i) => V.words[i]);
  assert.ok(words.includes('咖啡厅'), '咖啡厅必须算子串词');
  assert.ok(words.includes('咖啡豆'), '咖啡豆必须算子串词');
  assert.ok(!words.includes('咖啡'), '目标词自己不算');
  assert.ok(!words.includes('奶茶'), '奶茶只是近义，不是子串');
});

// ==================== 一局 ====================

test('猜中就赢，本局结束', { skip: noData }, () => {
  const r = new HotwordRound({ vectors: V, answer: { word: '咖啡', category: '食物' }, now: 0 });
  const res = r.guess(0, '咖啡', 1000);
  assert.equal(res.ok, true);
  assert.equal(res.win, true);
  assert.equal(res.entry.rank, 1);
  assert.equal(r.phase, HW_PHASE.OVER);
  assert.equal(r.result.winner, 0);
  assert.equal(r.result.reason, 'guessed');
});

test('冷却：冷却里猜不了，过了就能猜', { skip: noData }, () => {
  const r = new HotwordRound({ vectors: V, answer: { word: '咖啡', category: '食物' }, now: 0 });
  assert.equal(r.guess(0, '牛奶', 1000).ok, true);

  const blocked = r.guess(0, '茶叶', 1500);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'COOLING');
  assert.equal(blocked.waitMs, GUESS_COOLDOWN_MS - 500);

  assert.equal(r.guess(0, '茶叶', 1000 + GUESS_COOLDOWN_MS).ok, true);
  // 冷却是各算各的，对手不受影响
  assert.equal(r.guess(1, '牛奶', 1200).ok, true);
});

test('生僻词不计次数也不进冷却', { skip: noData }, () => {
  const r = new HotwordRound({ vectors: V, answer: { word: '咖啡', category: '食物' }, now: 0 });
  const res = r.guess(0, '鹅鹅鹅鹅', 1000);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'NOT_IN_VOCAB');
  assert.equal(r.guesses[0].length, 0);
  // 紧接着就能正常猜，说明没被罚冷却
  assert.equal(r.guess(0, '牛奶', 1001).ok, true);
});

test('子串词被当成生僻词挡掉，不会漏底', { skip: noData }, () => {
  const r = new HotwordRound({ vectors: V, answer: { word: '咖啡', category: '食物' }, now: 0 });
  const res = r.guess(0, '咖啡厅', 1000);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'NOT_IN_VOCAB', '子串词必须表现得跟生僻词一模一样');
  assert.equal(res.msg.includes('接近'), false, '提示语里不能暗示"你很接近"');
});

test('重复猜：返回上次结果，不占次数也不罚冷却', { skip: noData }, () => {
  const r = new HotwordRound({ vectors: V, answer: { word: '咖啡', category: '食物' }, now: 0 });
  r.guess(0, '牛奶', 1000);
  const again = r.guess(0, '牛奶', 9000);
  assert.equal(again.ok, false);
  assert.equal(again.code, 'ALREADY_GUESSED');
  assert.equal(again.entry.word, '牛奶');
  assert.equal(r.guesses[0].length, 1);
});

test('提示：按时间解锁，跟谁猜了多少次无关', { skip: noData }, () => {
  const r = new HotwordRound({ vectors: V, answer: { word: '咖啡', category: '食物' }, now: 0 });
  const at = (t) => r.hints(t);

  // 第一档在 0 秒——字数几乎白给（403 个答案里 350 个是 2 字词），藏着没意义
  assert.equal(at(0)[0].locked, false);
  assert.equal(at(0)[0].value, '2 个字');
  assert.equal(at(0)[1].locked, true, '类别还没到');
  assert.equal(at(0)[2].locked, true, '首字还没到');

  const catAt = r.hintAtMs(HINT_TIERS[1]);
  const firstAt = r.hintAtMs(HINT_TIERS[2]);
  assert.equal(catAt, 23000, '类别在四分之一处，对齐到整秒');
  assert.equal(firstAt, 54000, '首字在五分之三处');
  assert.equal(catAt % 1000, 0, '档位必须落在整秒上，否则倒计时会卡半秒');
  assert.equal(firstAt % 1000, 0);

  assert.equal(at(catAt - 1)[1].locked, true, '差一毫秒都不给');
  assert.equal(at(catAt)[1].value, '食物');
  assert.equal(at(firstAt)[2].value, '咖');

  // 这是修掉"刷次数必胜"的那一刀：猜多少次都推不动提示
  for (let i = 0; i < 50; i++) r.guesses[0].push({ word: `x${i}`, rank: 999, temp: 1, heat: 'cold', at: i });
  assert.equal(at(0)[1].locked, true, '刷 50 次也提前不了一毫秒');
  assert.equal(at(0)[2].locked, true);
});

test('提示：两边看到的永远是同一份，跟谁猜的无关', { skip: noData }, () => {
  const mk = (fill) => {
    const r = new HotwordRound({ vectors: V, answer: { word: '咖啡', category: '食物' }, now: 0 });
    for (let i = 0; i < 30; i++) {
      r.guesses[fill].push({ word: `x${i}`, rank: 999, temp: 1, heat: 'cold', at: i });
    }
    return r;
  };
  const t = Math.round(0.5 * ROUND_LIMIT_MS);
  const idle = new HotwordRound({ vectors: V, answer: { word: '咖啡', category: '食物' }, now: 0 });

  // 一个人猛猜、另一个人猛猜、两个人都不猜——同一时刻的提示必须一模一样。
  // hints() 不收座位参数，这三份相等就是"没有任何一侧能私藏或独得"的证明。
  assert.deepEqual(mk(0).hints(t), idle.hints(t));
  assert.deepEqual(mk(1).hints(t), idle.hints(t));
});

test('提示：锁着的档会告诉你还有多久', { skip: noData }, () => {
  const r = new HotwordRound({ vectors: V, answer: { word: '咖啡', category: '食物' }, now: 0 });
  const catAt = r.hintAtMs(HINT_TIERS[1]);
  const h = r.hints(catAt - 4000)[1];
  assert.equal(h.locked, true);
  assert.equal(h.inMs, 4000, 'inMs 是相对时长，客户端拿它跑本地倒计时');
  assert.equal(r.hints(catAt)[1].inMs, 0, '开了之后就是 0');
});

test('提示：档位跟着回合时长一起拉开', { skip: noData }, () => {
  const long = new HotwordRound({
    vectors: V, answer: { word: '咖啡', category: '食物' }, now: 0, roundLimitMs: 300000,
  });
  // at 存的是比例不是秒数：局拉长到 5 分钟，三档得跟着走，否则等于开局全给
  assert.equal(long.hintAtMs(HINT_TIERS[1]), 75000);
  assert.equal(long.hints(60000)[1].locked, true, '90 秒局的档位不能套到 5 分钟局上');
  assert.equal(long.hints(75000)[1].value, '食物');
});

test('提示：这桌关掉提示就一条都不给', { skip: noData }, () => {
  const r = new HotwordRound({
    vectors: V, answer: { word: '咖啡', category: '食物' }, now: 0, hintsEnabled: false,
  });
  assert.deepEqual(r.hints(ROUND_LIMIT_MS), []);
});

test('猜词：不再有任何共享后果，冷却就是冷却', { skip: noData }, () => {
  const r = new HotwordRound({ vectors: V, answer: { word: '咖啡', category: '食物' }, now: 0 });
  for (let i = 0; i < 9; i++) r.guesses[0].push({ word: `x${i}`, rank: 999, temp: 1, heat: 'cold', at: i });

  const res = r.guess(0, '牛奶', 10000);
  assert.equal(res.ok, true);
  assert.equal(res.unlocked, undefined, '猜测不再推开任何东西');
  assert.equal(r.nextGuessAt[0], 10000 + GUESS_COOLDOWN_MS, '只吃普通冷却，没有额外惩罚');
  assert.equal(r.nextGuessAt[1], 0, '更不该动到对手');
});

test('回合计时：到点没人猜中就流局，公布答案', { skip: noData }, () => {
  const r = new HotwordRound({ vectors: V, answer: { word: '咖啡', category: '食物' }, now: 0 });
  assert.equal(r.roundLimitMs, ROUND_LIMIT_MS);
  assert.equal(r.msLeft(0), ROUND_LIMIT_MS);
  assert.equal(r.msLeft(30000), ROUND_LIMIT_MS - 30000);

  assert.equal(r.timeUp(ROUND_LIMIT_MS - 1), false, '还差一毫秒不能判死');
  assert.equal(r.isOver, false);

  assert.equal(r.timeUp(ROUND_LIMIT_MS), true);
  assert.equal(r.isOver, true);
  assert.equal(r.result.winner, null, '时间到是平局，没有赢家');
  assert.equal(r.result.reason, 'timeout');
  assert.equal(r.msLeft(ROUND_LIMIT_MS), 0);
  assert.equal(r.timeUp(ROUND_LIMIT_MS + 9999), false, '只判一次，不重复覆盖 result');
});

test('回合计时：到点之后落不下任何一手', { skip: noData }, () => {
  const r = new HotwordRound({ vectors: V, answer: { word: '咖啡', category: '食物' }, now: 0 });
  // 定时器慢半拍的时候动作可能先到，每个动作自己要先扫一遍时间
  const late = r.guess(0, '咖啡', ROUND_LIMIT_MS + 500);
  assert.equal(late.ok, false);
  assert.equal(late.code, 'ROUND_OVER', '过点了就算猜中也不算');
  assert.equal(r.result.reason, 'timeout');
  assert.equal(r.result.winner, null);
});

test('回合计时：时长夹在合法区间里', { skip: noData }, () => {
  const mk = (ms) => new HotwordRound({
    vectors: V, answer: { word: '咖啡', category: '食物' }, now: 0, roundLimitMs: ms,
  }).roundLimitMs;
  assert.equal(mk(1000), ROUND_LIMIT_MIN_MS, '太短的夹到下限');
  assert.equal(mk(99999999), ROUND_LIMIT_MAX_MS, '太长的夹到上限');
  assert.equal(mk(undefined), ROUND_LIMIT_MS, '没给就用默认');
  assert.equal(mk(NaN), ROUND_LIMIT_MS, '脏值也用默认，不能让 deadline 变成 NaN');
  assert.equal(mk(120000), 120000);
});

test('偷看：拿到对手最好的一手，代价是冻住自己', { skip: noData }, () => {
  const r = new HotwordRound({ vectors: V, answer: { word: '咖啡', category: '食物' }, now: 0 });

  const empty = r.peek(0, 100);
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'NOTHING_TO_PEEK');
  assert.equal(r.nextGuessAt[0], 0, '没东西可看就不该收费');

  r.guess(1, '牛奶', 1000);
  r.guess(1, '红茶', 1000 + GUESS_COOLDOWN_MS);
  const better = r.guesses[1][0].rank < r.guesses[1][1].rank ? '牛奶' : '红茶';
  const res = r.peek(0, 5000);
  assert.equal(res.ok, true);
  assert.equal(res.peeked.word, better, '偷到的应该是排名最好的那一手，不是最近的');
  assert.equal(res.left, PEEK_LIMIT - 1);
  assert.equal(r.nextGuessAt[0], 5000 + PEEK_FREEZE_MS);

  const blocked = r.guess(0, '牛奶', 6000);
  assert.equal(blocked.code, 'COOLING');

  // 连着偷看是重新计时，不是叠加
  r.peek(0, 6000);
  assert.equal(r.nextGuessAt[0], 6000 + PEEK_FREEZE_MS);
});

test('偷看：一局有次数上限，用完就不给了', { skip: noData }, () => {
  const r = new HotwordRound({ vectors: V, answer: { word: '咖啡', category: '食物' }, now: 0 });
  r.guess(1, '牛奶', 1000);
  assert.equal(r.peeksLeft(0), PEEK_LIMIT);

  for (let i = 0; i < PEEK_LIMIT; i++) {
    assert.equal(r.peek(0, 5000 + i).ok, true, `第 ${i + 1} 次该给`);
  }
  assert.equal(r.peeksLeft(0), 0);

  const over = r.peek(0, 9000);
  assert.equal(over.ok, false);
  assert.equal(over.code, 'PEEK_USED_UP');
  assert.equal(r.peekCount[0], PEEK_LIMIT, '被挡下来的这次不该计数');
  assert.equal(r.peeksLeft(1), PEEK_LIMIT, '次数是各算各的');
});

test('认输：对手赢', { skip: noData }, () => {
  const r = new HotwordRound({ vectors: V, answer: { word: '咖啡', category: '食物' }, now: 0 });
  assert.equal(r.resign(1, 100).ok, true);
  assert.equal(r.result.winner, 0);
  assert.equal(r.result.reason, 'resign');
  assert.equal(r.guess(0, '牛奶', 200).code, 'ROUND_OVER');
});

test('进行中的 publicSeat 不带精确排名', { skip: noData }, () => {
  const r = new HotwordRound({ vectors: V, answer: { word: '咖啡', category: '食物' }, now: 0 });
  r.guess(0, '牛奶', 1000);
  const pub = r.publicSeat(0);
  assert.equal(pub.bestRank, null, '打的时候不能给精确排名');
  assert.ok(pub.bestTemp > 0, '但温度要给，不然对手没有紧张感');
  r.finish(0, 'guessed', 2000);
  assert.ok(r.publicSeat(0).bestRank > 0, '局末才公布');
});

// ==================== 房间 ====================

test('房间：一个人开不了局，两个人才行', { skip: noData }, () => {
  const room = new HotwordRoom({ vectors: V });
  const a = fakeClient();
  room.attach(a);
  room.hello(a, null);
  room.sit(a, 0, '阿甲');
  assert.equal(room.start(a).code, 'NEED_TWO');

  const b = fakeClient();
  room.attach(b);
  room.hello(b, null);
  room.sit(b, 1, '阿乙');
  assert.equal(room.start(a).ok, true);
  assert.equal(room.round.phase, HW_PHASE.PLAYING);
  room.shutdown();
});

test('房间：观众不能猜、不能偷看、开不了局', { skip: noData }, () => {
  const { room, a } = seatedRoom();
  room.start(a);
  const c = fakeClient();
  room.attach(c);
  room.hello(c, null);
  assert.equal(room.guess(c, '牛奶').ok, false);
  assert.equal(room.peek(c).ok, false);
  assert.equal(room.start(c).ok, false);
  room.shutdown();
});

test('房间快照：进行中绝不泄露答案、对手的词和精确排名', { skip: noData }, () => {
  const { room, a, b } = seatedRoom('咖啡');
  room.start(a);
  room.guess(a, '牛奶');
  room.guess(b, '红茶');

  const spy = fakeClient();
  room.attach(spy);
  room.hello(spy, null);

  for (const [who, label] of [[b, '对手'], [spy, '观众']]) {
    const snap = room.buildStateFor(who.playerId);
    const json = JSON.stringify(snap);
    assert.equal(json.includes('咖啡'), false, `${label}的快照里不该出现答案`);
    assert.equal(json.includes('牛奶'), false, `${label}的快照里不该出现对手猜的词`);
    assert.equal(snap.seats[0].bestRank, null, `${label}不该看到精确排名`);
    assert.ok(snap.seats[0].bestTemp > 0, `${label}应该看得到温度`);
    assert.equal(snap.result, null);
  }

  // 自己那份要带上自己的词和排名
  const mine = room.buildStateFor(a.playerId);
  assert.equal(mine.my.guesses[0].word, '牛奶');
  assert.ok(mine.my.guesses[0].rank > 1);
  assert.equal(JSON.stringify(mine).includes('红茶'), false, '自己也看不到对手的词');
  room.shutdown();
});

test('房间快照：局末才公布答案和双方记录', { skip: noData }, () => {
  const { room, a, b } = seatedRoom('咖啡');
  room.start(a);
  room.guess(b, '红茶');
  room.guess(a, '咖啡');

  const snap = room.buildStateFor(b.playerId);
  assert.equal(snap.result.answer, '咖啡');
  assert.equal(snap.result.winner, 0);
  assert.equal(snap.result.guesses[1][0].word, '红茶');
  assert.deepEqual(snap.score, [1, 0]);
  room.shutdown();
});

test('房间：中途下擂台这局作废', { skip: noData }, () => {
  const { room, a, b } = seatedRoom('咖啡');
  room.start(a);
  room.guess(a, '牛奶');
  room.stand(a);
  assert.equal(room.round.isOver, true);
  assert.equal(room.round.result.winner, null);
  assert.equal(room.round.result.reason, 'abandoned');
  assert.deepEqual(room.score, [0, 0], '作废不该计分');
  const snap = room.buildStateFor(b.playerId);
  assert.equal(snap.result.answer, '咖啡', '作废也要公布答案');
  room.shutdown();
});

test('房间：设置只能房主改，而且只能在两局之间', { skip: noData }, () => {
  const { room, a, b } = seatedRoom();
  assert.equal(room.setConfig(b, { guessCooldownMs: 5000 }).code, 'NOT_HOST');
  assert.equal(room.setConfig(a, { guessCooldownMs: 5000 }).ok, true);
  assert.equal(room.config.guessCooldownMs, 5000);
  assert.equal(room.setConfig(a, { guessCooldownMs: 999999 }).ok, false, '超范围要挡住');

  room.start(a);
  assert.equal(room.setConfig(a, { guessCooldownMs: 1000 }).ok, false, '局中不能改');
  room.shutdown();
});

test('房间：房主改的冷却真的作用到下一局', { skip: noData }, () => {
  const { room, a } = seatedRoom();
  room.setConfig(a, { guessCooldownMs: 7000 });
  room.start(a);
  assert.equal(room.round.cooldownMs, 7000);
  room.shutdown();
});

test('房间：短时间内不出重样的答案', { skip: noData }, () => {
  const room = new HotwordRoom({ vectors: V });
  const a = fakeClient();
  const b = fakeClient();
  for (const c of [a, b]) { room.attach(c); room.hello(c, null); }
  room.sit(a, 0, '阿甲');
  room.sit(b, 1, '阿乙');

  const seen = [];
  for (let i = 0; i < 15; i++) {
    room.start(a);
    seen.push(room.round.answer);
    room.round.finish(0, 'guessed');
  }
  assert.equal(new Set(seen).size, seen.length, `15 局里出了重样的：${seen.join(' ')}`);
  room.shutdown();
});

test('房间：答案池只有一个词也不会卡死', { skip: noData }, () => {
  const { room, a } = seatedRoom('咖啡');
  for (let i = 0; i < 3; i++) {
    assert.equal(room.start(a).ok, true);
    assert.equal(room.round.answer, '咖啡');
    room.round.finish(0, 'guessed');
  }
  room.shutdown();
});

test('房间：没有词库时页面能开，但开不了局', () => {
  const room = new HotwordRoom({ vectors: null });
  const a = fakeClient();
  room.attach(a);
  room.hello(a, null);
  assert.equal(room.ready, false);
  room.sit(a, 0, '阿甲');
  assert.equal(room.start(a).code, 'NOT_READY');
  const snap = room.buildStateFor(a.playerId);
  assert.equal(snap.ready, false);
  assert.equal(snap.phase, HW_PHASE.WAITING);
  room.shutdown();
});

test('擂台就两个位子', () => {
  assert.equal(HW_SEATS, 2);
});
