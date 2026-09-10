// SPDX-License-Identifier: GPL-3.0-or-later
//
// 题库自检。
//
// 题库是拿来给模型打分的，所以**它自己错了最难发现** —— 一道牌面写重了的题
// 会稳定地判模型错，而报告上只显示"模型在这类题上不行"。这些检查全部离线，
// 跑得比出题快，加题时先让它们过一遍。

import test from 'node:test';
import assert from 'node:assert/strict';

import { SPOTS, TAGS, pairsOf, streetSum, TRIVIAL, scoreTrivial } from '../server/eval/spots.js';
import { buildUser, coerceAction } from '../server/bot/decide.js';
import { evaluate, CATEGORY } from '../server/evaluator.js';
import { estimateEquity } from '../server/bot/equity.js';
import { makeRng } from '../server/eval/harness.js';

const PHASE_BOARD = { preflop: 0, flop: 3, turn: 4, river: 5 };

test('题库：id 不重复，分类都在册', () => {
  const ids = SPOTS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, `有重复的 id：${ids.join(',')}`);
  for (const s of SPOTS) assert.ok(TAGS.includes(s.tag), `${s.id} 的分类 ${s.tag} 不在册`);
  assert.ok(SPOTS.length >= 15, '题太少，统计上说明不了什么');
});

test('题库：每张牌只出现一次（写重了会让蒙特卡洛算出假胜率）', () => {
  for (const s of SPOTS) {
    const cards = [...s.state.you.cards, ...s.state.table.board];
    assert.equal(new Set(cards).size, cards.length,
      `${s.id} 里有重复的牌：${cards.join(' ')}`);
    for (const c of cards) {
      assert.match(c, /^[2-9TJQKA][shdc]$/, `${s.id} 里的 ${c} 不是合法的牌`);
    }
  }
});

test('题库：公共牌张数和阶段对得上', () => {
  for (const s of SPOTS) {
    const want = PHASE_BOARD[s.state.table.phase];
    assert.equal(s.state.table.board.length, want,
      `${s.id} 是 ${s.state.table.phase}，公共牌应该 ${want} 张`);
  }
});

test('题库：每道题都有判据（allow / forbid / soft 至少一个）', () => {
  for (const s of SPOTS) {
    const e = s.expect || {};
    assert.ok(e.allow || e.forbid || e.soft,
      `${s.id} 没有判据 —— 不判对错的题要显式写 soft: true`);
  }
});

test('题库：legal 自洽 —— 面对下注不能过牌，能下注就得有上界', () => {
  for (const s of SPOTS) {
    const l = s.state.you.legal;
    assert.ok(l, `${s.id} 没有 legal`);
    assert.ok(!(l.canCheck && l.canCall), `${s.id}：能过牌又能跟注，局面不成立`);
    if (l.canCall) assert.ok(l.callAmount > 0, `${s.id}：canCall 但 callAmount 是 0`);
    // bet 的上界读的是 maxRaiseTo，不是 minBet 旁边那个（见 coerceAction）
    if (l.canBet) assert.ok(l.maxRaiseTo > l.minBet, `${s.id}：canBet 但没有可用的上界`);
    if (l.canRaise) assert.ok(l.maxRaiseTo >= l.minRaiseTo, `${s.id}：加注区间是空的`);
  }
});

test('题库：座位表里有自己，行动序列只提到在座的人', () => {
  for (const s of SPOTS) {
    const me = s.state.seats[s.state.you.seat];
    assert.ok(me, `${s.id}：you.seat 在座位表里不存在`);
    const seated = new Set(s.state.seats.map((x) => x.seat));
    for (const st of s.state.table.history) {
      for (const a of st.acts) {
        assert.ok(seated.has(a.seat), `${s.id}：行动序列里的座位 ${a.seat} 不在座`);
      }
    }
  }
});

test('题库：每道题都能渲染成提示词，而且不含聊天内容（安全红线）', () => {
  for (const s of SPOTS) {
    const text = buildUser(s.state, { forTools: true });
    assert.ok(text.includes('可选动作'), `${s.id} 渲染出来的提示词不完整`);
    for (const c of s.state.chat) {
      assert.ok(!text.includes(c.text),
        `${s.id}：聊天内容漏进了提示词 —— 这是提示注入的入口，见 decide.js 顶上的红线`);
    }
  }
});

test('题库：送分题的牌力确实如题所述（别把"坚果"写成一手空气）', () => {
  // 拿真的评牌器验一遍，免得出题人自己看错牌面 —— 这种错会稳定地判模型错。
  const catOf = (id) => {
    const s = SPOTS.find((x) => x.id === id);
    return evaluate([...s.state.you.cards, ...s.state.table.board]).cat;
  };

  assert.equal(catOf('obvious-nuts-river'), CATEGORY.STRAIGHT_FLUSH, '皇家同花顺没评出来');
  assert.equal(catOf('trap-allin-call-only'), CATEGORY.STRAIGHT_FLUSH, '同花顺没评出来');
  assert.equal(catOf('obvious-set-flop'), CATEGORY.THREE_OF_A_KIND, '暗三条没评出来');
  assert.equal(catOf('trap-raise-amount'), CATEGORY.THREE_OF_A_KIND, '三条没评出来');
  assert.equal(catOf('size-value-river'), CATEGORY.FLUSH, '同花没评出来');
  assert.equal(catOf('obvious-fold-air'), CATEGORY.HIGH_CARD, '这题应该是一手空气');
  assert.equal(catOf('size-bluff-river'), CATEGORY.HIGH_CARD, '诈唬题应该是一手空气');
  assert.equal(catOf('trap-can-check'), CATEGORY.HIGH_CARD, '这题应该是一手空气');
  assert.equal(catOf('obvious-quads-turn'), CATEGORY.FOUR_OF_A_KIND, '四条没评出来');
  assert.equal(catOf('size-nuts-multiway'), CATEGORY.STRAIGHT, '顺子没评出来');
  assert.equal(catOf('size-protect-wet'), CATEGORY.TWO_PAIR, '两对没评出来');
  assert.equal(catOf('trap-short-no-raise'), CATEGORY.TWO_PAIR, '两对没评出来');
  assert.equal(catOf('odds-combo-draw'), CATEGORY.HIGH_CARD, '同花+顺子听牌此刻还是空气');
});

test('题库：成对的题只有对手不同 —— 手牌、牌面、底池、要跟的钱必须一模一样', () => {
  const pairs = pairsOf();
  assert.ok(pairs.size >= 2, '成对题少于 2 对，范围反转就测不出来了');
  for (const [key, { tight, loose }] of pairs) {
    assert.deepEqual(tight.state.you.cards, loose.state.you.cards, `${key}：手牌不一样`);
    assert.deepEqual(tight.state.table.board, loose.state.table.board, `${key}：牌面不一样`);
    assert.equal(tight.state.table.totalPot, loose.state.table.totalPot, `${key}：底池不一样`);
    assert.equal(tight.state.you.legal.callAmount, loose.state.you.legal.callAmount,
      `${key}：要跟的钱不一样 —— 底池赔率一变，两题就没有可比性了`);
    // 昵称也不许泄题。最初画像那对叫「石头」和「疯子」，于是**没有记忆的
    // 单轮驱动也把它们分开了** —— 它读的是名字。那一版测的是模型认不认识
    // 汉语词，不是画像工具有没有用。
    assert.deepEqual(
      tight.state.seats.map((x) => x.name), loose.state.seats.map((x) => x.name),
      `${key}：两题的昵称不一样 —— 名字是进提示词的，会把答案写在脸上`);

    // 变量只能有一个：行动序列，或者画像
    const sameHistory =
      JSON.stringify(tight.state.table.history) === JSON.stringify(loose.state.table.history);
    const samePriors = tight.priorHands.length === 0 && loose.priorHands.length === 0;
    assert.ok(sameHistory !== samePriors,
      `${key}：变量必须**只有一个** —— 要么行动序列不同、要么画像不同，不能都不同也不能都相同`);
  }
});

test('题库：每道题的合法动作都能过 coerceAction（判据里的动作真的提得上去）', () => {
  for (const s of SPOTS) {
    const e = s.expect || {};
    for (const type of e.allow || []) {
      const out = coerceAction({ action: type }, s.state, {}, null);
      assert.equal(out.action.type, type,
        `${s.id}：判据允许 ${type}，但它在这个局面里提交不上去（被改成了 ${out.action.type}）`);
    }
  }
});

test('题库：成对的跟注题必须真的会翻转（否则永远分不开，看报告还以为是模型不行）', () => {
  // 这条测试是被一道坏题逼出来的。上一版的成对题是 AQ 顶对在 A-7-2-5-9 上面对
  // 河牌大注，出题时想当然："对手连开三条街，顶对该弃了"。真算一遍才发现
  // **AQ 对前 5% 的范围也有 70% 胜率** —— 那道题根本不存在弃牌点，模型两边都跟
  // 是对的，题目却永远显示"没分开"。看报告的人会把出题人的错读成模型的错。
  //
  // 所以：成对的跟注题必须验一遍**紧假设下亏、松假设下赚**。验不过就不是范围题。
  // 用注入的随机源，结果逐位可复现。
  const TIGHT = 0.05, LOOSE = 0.35, MARGIN = 3;

  for (const [key, { tight, loose }] of pairsOf()) {
    const L = tight.state.you.legal;
    if (!L.canCall) continue;                       // 开火型的成对题不适用这条

    const pot = tight.state.table.totalPot;
    const breakeven = (L.callAmount / (pot + L.callAmount)) * 100;
    const at = (r) => estimateEquity({
      hole: tight.state.you.cards,
      board: tight.state.table.board,
      opponents: 1, sims: 20000, budgetMs: 5000,
      opponentRange: r, rng: makeRng(7),
    }).pct;

    const eTight = at(TIGHT), eLoose = at(LOOSE);
    assert.ok(eTight < breakeven - MARGIN,
      `${key}：对手按前 ${TIGHT * 100}% 算，胜率 ${eTight}% 仍然高过 ${breakeven.toFixed(0)}% 的门槛 —— ` +
      '这手牌怎么估范围都该跟，两边不可能给出不同的答案，换个更边缘的牌或牌面');
    assert.ok(eLoose > breakeven + MARGIN,
      `${key}：对手按前 ${LOOSE * 100}% 算，胜率 ${eLoose}% 还是够不着 ${breakeven.toFixed(0)}% —— ` +
      '这手牌怎么估范围都该弃，同样分不开');
  }
});

test('题库：底池、行动序列、座位上的本轮投入必须三者对账（引擎口径）', () => {
  // 这三样都逐字进提示词。对不上的后果不是"有个数不太准"，而是模型同时读到
  // 「底池 150，跟注需要 50% 胜率」和一段推出来底池该是 300 的下注历史。
  //
  // 第一版 41 道题里有 26 道对不上，最狠的一道差了一整个转牌注 —— 判据是
  // 照着我以为的 33% 写的，模型看到的是 50%。所以底池现在不是手写的数，
  // 是照 engine.js#totalPot 那条公式推出来的：前面几条街 + 本轮所有人的 committedRound。
  for (const s of SPOTS) {
    const h = s.state.table.history;
    const prior = h.slice(0, -1).reduce((x, st) => x + streetSum(st), 0);
    const now = s.state.seats.reduce((x, q) => x + (Number(q?.committedRound) || 0), 0);
    assert.equal(s.state.table.totalPot, prior + (s.dead || 0) + now,
      `${s.id}：底池和它自己的行动序列对不上`);
  }
});

test('题库：座位上的本轮投入和当前这条街的动作对得上（差额只允许是盲注）', () => {
  const bb = 10;
  for (const s of SPOTS) {
    const h = s.state.table.history;
    if (!h.length) continue;
    const per = new Map();
    for (const a of h[h.length - 1].acts || []) {
      if (a.type === 'fold' || a.type === 'check') continue;
      per.set(a.seat, Math.max(per.get(a.seat) || 0, Number(a.amount) || 0));
    }
    for (const seat of s.state.seats) {
      if (!seat) continue;
      const fromActs = per.get(seat.seat) || 0;
      const gap = (Number(seat.committedRound) || 0) - fromActs;
      assert.ok(gap >= 0 && gap <= bb,
        `${s.id} 座位${seat.seat}（${seat.name}）：座位上写着投入 ${seat.committedRound}，` +
        `动作序列里只有 ${fromActs}，差 ${gap} —— 超过一个大盲就不是盲注能解释的了`);
    }
  }
});

test('题库：每道题的门槛都能从提示词自己算出来，和 why 里写的数一致', () => {
  // why 里的百分比是给读报告的人看的。它和提示词里那个数不一样时，
  // 错的多半是判据 —— 出题人按脑子里那个价格写的判据，模型按提示词里那个打。
  for (const s of SPOTS) {
    const L = s.state.you.legal;
    if (!L.canCall) continue;
    const be = Math.round((L.callAmount / (s.state.table.totalPot + L.callAmount)) * 100);
    const quoted = [...String(s.why).matchAll(/需要\s*(\d+)%|要\s*(\d+)%\s*胜率|门槛\s*(\d+)%/g)]
      .map((m) => Number(m[1] ?? m[2] ?? m[3]));
    for (const q of quoted) {
      assert.ok(Math.abs(q - be) <= 2,
        `${s.id}：题意里写"需要 ${q}%"，但按提示词里的底池和跟注额算出来是 ${be}%`);
    }
  }
});

test('题库：不看牌的傻子策略拿不到高分（否则跑分读不出东西）', () => {
  // 这条是被数字逼出来的：最初 41 道题里判据几乎都是「不许弃牌」，于是
  // 「永远最小下注」拿 75%、「永远全下」拿 71%，而模型 93~100% ——
  // 区分度只剩 75→100 那一小段，规则策略、单轮、agent 全挤在一起分不开。
  //
  // 补了一整类「过度进攻才是错的」的题之后地板降到 70%。这条测试盯住它：
  // 谁再往里加一批「不许弃牌」的题，地板一涨就会在这里炸。
  const CEILING = 0.72;
  for (const [name, pick] of Object.entries(TRIVIAL)) {
    const { ok, n, pct } = scoreTrivial(pick);
    assert.ok(pct <= CEILING,
      `「${name}」这个不看牌的策略拿了 ${Math.round(pct * 100)}%（${ok}/${n}）—— ` +
      '题库的区分度不够了，得补一批「这么打就是错」的题，而不是继续加「不许弃牌」的题');
  }
});

test('题库：每一类里都得有「进攻是错的」和「保守是错的」两种题', () => {
  // 只有一个方向的判据，测出来的就是"它敢不敢开火"，不是"它打得好不好"。
  const scored = SPOTS.filter((s) => !s.expect.soft);
  const punishAggro = scored.filter((s) => {
    const e = s.expect;
    return (e.allow && !e.allow.some((a) => ['bet', 'raise', 'allin'].includes(a)))
      || (e.forbid && e.forbid.some((a) => ['bet', 'raise', 'allin'].includes(a)));
  }).length;
  const punishPassive = scored.filter((s) => {
    const e = s.expect;
    return (e.allow && !e.allow.some((a) => ['check', 'call', 'fold'].includes(a)))
      || (e.forbid && e.forbid.some((a) => ['check', 'call', 'fold'].includes(a)));
  }).length;

  assert.ok(punishAggro >= scored.length * 0.3,
    `惩罚过度进攻的题只有 ${punishAggro}/${scored.length}，太少了`);
  assert.ok(punishPassive >= scored.length * 0.3,
    `惩罚过度保守的题只有 ${punishPassive}/${scored.length}，太少了`);
});
