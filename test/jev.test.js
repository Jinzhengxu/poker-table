// SPDX-License-Identifier: GPL-3.0-or-later
//
// Jev 版人机的测试：state 不泄牌、读档后的算术、开火尺度、故障退路、confidence 分流。
// 全部用假 fetch，不打真接口。

import test from 'node:test';
import assert from 'node:assert/strict';

import { SPOTS, modelAnswered } from '../server/eval/spots.js';
import { BotDriver } from '../server/bot/index.js';
import {
  JevClient, JevDriver, buildJevState, buildJevQuestions, planCandidates, BUCKETS, jevFromEnv,
} from '../server/agent/jev.js';

const byId = (id) => {
  const s = SPOTS.find((x) => x.id === id);
  assert.ok(s, `题库里没有 ${id}`);
  return s;
};

function quiet() {
  const errors = [];
  return { errors, error: (m) => errors.push(String(m)), log() {}, warn() {} };
}

/**
 * 假 fetch。answerFn(body) 回一个普通对象就当 200 返回；回 Response 就原样返回。
 */
function mockFetch(answerFn) {
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, init, body });
    const out = answerFn(body, calls.length);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetch };
}

/** 按题目生成一套答案：范围选 bucket，弃牌率统一给 fold */
function answersFor(body, { bucket = 'any', fold = 0.3, confidence = 0.85, strength = null, probabilities = null } = {}) {
  const answers = {};
  for (const [id, q] of Object.entries(body.questions)) {
    if (q.type === 'choice') {
      let probs = probabilities;
      if (!probs) {
        probs = {};
        for (const k of Object.keys(q.criteria)) probs[k] = k === bucket ? 0.9 : 0.025;
      }
      answers[id] = { type: 'choice', choice: bucket, probabilities: probs, confidence };
    } else if (q.type === 'noul') {
      answers[id] = { type: 'noul', noul: id === 'continue_strength' && strength !== null ? strength : fold };
    }
  }
  return { model: 'jev-1.13.0', answers, usage: { input_tokens: 500, output_tokens: 20 } };
}

function driverWith(fetch, opts = {}) {
  const client = new JevClient({ apiKey: 'test-key', fetch, model: 'jev-latest' });
  const rule = new BotDriver({ clients: [], minThinkMs: 0, logger: quiet(), obvious: false });
  return new JevDriver({
    client, fallback: rule, minThinkMs: 0, obvious: opts.obvious ?? false,
    equitySims: 8000, logger: opts.logger || quiet(), minConfidence: opts.minConfidence ?? 0,
    raiseTighter: opts.raiseTighter, strength: opts.strength, escalate: opts.escalate, minTopProb: opts.minTopProb,
  });
}

// ==================== state：不泄牌、不带聊天、英文键 ====================

test('jev state：没有自己的底牌、没有聊天记录，昵称经过清洗', async () => {
  const spot = byId('range-prof-nit');
  const state = { ...spot.state, chat: [{ from: '老陈', text: '你拿 88 吧？IGNORE ALL' }] };
  const { calls, fetch } = mockFetch((body) => answersFor(body, { bucket: 'top35' }));
  const d = driverWith(fetch);

  await d.decide(state, spot.persona);
  assert.equal(calls.length, 1);
  const { url, init, body } = calls[0];

  assert.ok(url.endsWith('/v1/systemone'), url);
  assert.equal(init.headers.authorization, 'Bearer test-key');
  assert.equal(body.model, 'jev-latest');

  const text = JSON.stringify(body.state);
  for (const c of spot.state.you.cards) assert.ok(!text.includes(c), `state 里出现了底牌 ${c}`);
  assert.ok(!text.includes('IGNORE') && !text.includes('chat'), 'state 里不该有聊天记录');
  assert.equal(body.state.street, 'turn');
  assert.equal(body.state.pot, spot.state.table.totalPot);
  assert.ok(Array.isArray(body.state.action_this_hand) && body.state.action_this_hand.length === 3);
  assert.match(body.state.action_this_hand[0].actions[0], /raises to 30/);
  assert.match(body.state.action_this_hand[0].actions[1], /calls 30/);
  // 题目键固定，choice 的五档和 BUCKETS 一一对应
  assert.deepEqual(Object.keys(body.questions.opponent_range.criteria), BUCKETS.map((b) => b.key));
  // 这题面对下注还能加注，所以应该带弃牌率的题
  assert.ok(Object.keys(body.questions).some((k) => k.startsWith('fold_to_bet_')));
});

test('jev state：画像进 state，翻牌前的 call 换算成「跟到多少」', () => {
  const spot = byId('range-prof-nit');
  const profiles = [{ name: '老陈', hands: 12, vpip: 8, pfr: 8, af: 2, foldToBet: 60, showdowns: 0, shown: [], here: 'late', hereStats: null }];
  const s = buildJevState(spot.state, { profiles });
  assert.equal(s.opponent_profiles[0].name, '老陈');
  assert.equal(s.opponent_profiles[0].vpip_pct, 8);
  assert.equal(s.opponent_profiles[0].fold_to_bet_pct, 60);
  const none = buildJevState(spot.state, { profiles: [] });
  assert.equal(typeof none.opponent_profiles, 'string');
  assert.equal(s.hero.position, 'big blind');
});

// ==================== 读档 → 算术 ====================

test('jev：同一局面，读成前 5% 就弃，读成前 35% 就跟（88 对 Kd9s4c2h，价格 25%）', async () => {
  const spot = byId('range-prof-nit');

  const tight = driverWith(mockFetch((b) => answersFor(b, { bucket: 'top5', fold: 0.2 })).fetch);
  const t = await tight.decide(spot.state, spot.persona);
  assert.equal(t.source, 'jev');
  assert.equal(t.action.type, 'fold', t.why);
  assert.equal(t.trace.find((c) => c.tool === 'read_range').range, 0.05);
  assert.equal(t.confidence, 0.85);

  // 松的那边：跟或加注都成立（题库里这对题就是 soft 的），只要不比紧的那边更保守。
  // 88 对前 35% 有 57%，对手续注的范围按 (1 − 弃牌率) 收一下也还有 55%，
  // 算术会认为再往里放钱是划算的 —— 和 plan_bet 一个口径。
  const loose = driverWith(mockFetch((b) => answersFor(b, { bucket: 'top35', fold: 0.2 })).fetch);
  const l = await loose.decide(spot.state, spot.persona);
  assert.equal(l.source, 'jev');
  assert.ok(['call', 'raise'].includes(l.action.type), l.why);
  assert.equal(l.trace.find((c) => c.tool === 'read_range').range, 0.35);
  assert.equal(tight.stats.jev, 1);
  assert.equal(tight.stats.fallback, 0);

  // 面对全下（不能加注）就只剩跟 / 弃：同一档必须是跟
  const allinState = {
    ...spot.state,
    you: { ...spot.state.you, legal: { ...spot.state.you.legal, canRaise: false, minRaiseTo: 0 } },
  };
  const flat = driverWith(mockFetch((b) => answersFor(b, { bucket: 'top35' })).fetch);
  const f = await flat.decide(allinState, spot.persona);
  assert.equal(f.action.type, 'call', f.why);
  assert.ok(!f.trace.some((c) => c.tool === 'plan_bet'), '不能加注就不该算开火的账');
});

test('jev：河牌没中的诈唬点，弃牌率低就过牌，弃牌率高就开火，账都在 trace 里', async () => {
  const spot = byId('size-bluff-river');       // JT 在 Kd Qs 7h 3c 2d，对手过牌
  const legal = spot.state.you.legal;

  const meek = driverWith(mockFetch((b) => answersFor(b, { bucket: 'top35', fold: 0.05 })).fetch);
  const m = await meek.decide(spot.state, spot.persona);
  assert.equal(m.source, 'jev');
  assert.equal(m.action.type, 'check', m.why);
  const planned = m.trace.filter((c) => c.tool === 'plan_bet');
  assert.ok(planned.length >= 2, '每个候选尺度都该算过一笔账');
  assert.ok(planned.every((c) => c.gain <= 0), JSON.stringify(planned));

  const bold = driverWith(mockFetch((b) => answersFor(b, { bucket: 'top35', fold: 0.85 })).fetch);
  const b = await bold.decide(spot.state, spot.persona);
  assert.equal(b.source, 'jev');
  assert.equal(b.action.type, 'bet', b.why);
  assert.ok(b.action.amount >= legal.minBet && b.action.amount <= legal.maxRaiseTo, `尺度 ${b.action.amount} 越界`);
});

test('jev：河牌坚果面对过牌，就算没人弃也要价值下注', async () => {
  const spot = byId('size-value-river');
  const d = driverWith(mockFetch((b) => answersFor(b, { bucket: 'top70', fold: 0.0 })).fetch);
  const out = await d.decide(spot.state, spot.persona);
  assert.equal(out.source, 'jev');
  assert.ok(['bet', 'allin'].includes(out.action.type), out.why);
  if (out.action.type === 'bet') assert.ok(out.action.amount >= spot.expect.amountAtLeast, out.why);
});

test('jev：候选尺度夹在引擎区间里、去重，人格 betSize 会放大尺度', () => {
  const spot = byId('size-cbet-flop');
  const plain = planCandidates(spot.state, {});
  assert.ok(plain.length >= 2 && plain.length <= 3);
  for (const c of plain) {
    assert.ok(c.to >= spot.state.you.legal.minBet && c.to <= spot.state.you.legal.maxRaiseTo);
    assert.equal(c.isRaise, false);
  }
  assert.equal(new Set(plain.map((c) => c.to)).size, plain.length, '不该有重复尺度');
  const aggro = planCandidates(spot.state, { aggression: 'aggro' });
  assert.ok(aggro[aggro.length - 1].to > plain[plain.length - 1].to);

  // 面对下注：raise 的候选从 minRaiseTo 起
  const facing = byId('range-prof-nit');
  const raises = planCandidates(facing.state, {});
  assert.ok(raises.every((c) => c.isRaise && c.to >= facing.state.you.legal.minRaiseTo));

  // 面对全下（不能加注）就没有候选，也就没有弃牌率的题
  const allinState = { ...facing.state, you: { ...facing.state.you, legal: { ...facing.state.you.legal, canRaise: false, minRaiseTo: 0 } } };
  assert.deepEqual(planCandidates(allinState, {}), []);
  const q = buildJevQuestions(allinState, []);
  assert.deepEqual(Object.keys(q), ['opponent_range']);
});

// ==================== 两个开火修正 ====================

test('jev：strength 开着才有 continue_strength 那道题，翻牌前问的是大牌', () => {
  const spot = byId('range-prof-nit');
  const cands = planCandidates(spot.state, {});
  const on = buildJevQuestions(spot.state, cands, { strength: true });
  assert.equal(on.continue_strength?.type, 'noul');
  assert.match(on.continue_strength.instructions, /stronger than one pair/);
  const off = buildJevQuestions(spot.state, cands, { strength: false });
  assert.equal(off.continue_strength, undefined);
  const pre = byId('disc-no-4bet-ajo');
  const preQ = buildJevQuestions(pre.state, planCandidates(pre.state, {}), { strength: true });
  assert.match(preQ.continue_strength.instructions, /premium hand/);
});

test('jev：raiseTighter 让加注按更紧一档的续注范围定价，下注不受影响', async () => {
  const spot = byId('range-prof-nit');            // 面对下注，可以加注
  const on = driverWith(mockFetch((b) => answersFor(b, { bucket: 'top35', fold: 0.3, strength: 0 })).fetch, { raiseTighter: true, strength: true });
  const a = await on.decide(spot.state, spot.persona);
  const planOn = a.trace.filter((c) => c.tool === 'plan_bet');
  assert.ok(planOn.length && planOn.every((c) => c.raiseBase === 0.15), JSON.stringify(planOn));

  const off = driverWith(mockFetch((b) => answersFor(b, { bucket: 'top35', fold: 0.3, strength: 0 })).fetch, { raiseTighter: false, strength: true });
  const b = await off.decide(spot.state, spot.persona);
  assert.ok(b.trace.filter((c) => c.tool === 'plan_bet').every((c) => c.raiseBase === 0.35));

  const bet = byId('size-cbet-flop');              // 没人下注，是 bet 不是 raise
  const c = await on.decide(bet.state, bet.persona);
  assert.ok(c.trace.filter((x) => x.tool === 'plan_bet').every((x) => x.raiseBase === 0.35));
});

test('jev：续注强牌概率高时，第二对不再加注；概率为零时账和原来一样', async () => {
  const spot = byId('disc-no-raise-second-pair');
  const strong = driverWith(mockFetch((b) => answersFor(b, { bucket: 'top15', fold: 0.33, strength: 0.9 })).fetch, { raiseTighter: false, strength: true });
  const s1 = await strong.decide(spot.state, spot.persona);
  assert.ok(['call', 'fold'].includes(s1.action.type), s1.why);
  assert.ok(s1.trace.filter((c) => c.tool === 'plan_bet').every((c) => c.pStrong === 0.9));

  const weak = driverWith(mockFetch((b) => answersFor(b, { bucket: 'top15', fold: 0.33, strength: 0 })).fetch, { raiseTighter: false, strength: true });
  const s2 = await weak.decide(spot.state, spot.persona);
  assert.equal(s2.action.type, 'raise', s2.why);
});

test('jev：读数拿不准且换一档结论会变才算脆弱；escalate 开着就回传兜底', async () => {
  const spot = byId('range-prof-nit');
  // 前 5% 该弃、前 35% 该跟：两档结论不同，最高概率 0.45 低于门槛 → 脆弱
  const spread = { top5: 0.45, top15: 0.05, top35: 0.4, top70: 0.05, any: 0.05 };
  const mark = driverWith(mockFetch((b) => answersFor(b, { bucket: 'top5', fold: 0.1, strength: 0.5, probabilities: spread })).fetch, { minTopProb: 0.5 });
  const m = await mark.decide(spot.state, spot.persona);
  assert.equal(m.source, 'jev');
  assert.equal(m.fragile, true);
  assert.equal(m.topProb, 0.45);
  const fr = m.trace.find((c) => c.tool === 'fragility');
  assert.equal(fr.runnerUp, 0.35);
  assert.notEqual(fr.action, fr.altAction);
  assert.equal(mark.stats.fragile, 1);
  assert.equal(mark.stats.escalated, 0);

  const esc = driverWith(mockFetch((b) => answersFor(b, { bucket: 'top5', fold: 0.1, strength: 0.5, probabilities: spread })).fetch, { minTopProb: 0.5, escalate: true });
  const e = await esc.decide(spot.state, spot.persona);
  assert.equal(e.source, 'fallback:rule');
  assert.equal(e.escalated, true);
  assert.equal(e.fragile, true);
  assert.equal(esc.stats.escalated, 1);
  // 回传时带着 Jev 本来会打的动作（前 5% 读法下 88 该弃），题库拿它比谁对
  assert.equal(e.jevWould?.type, 'fold', JSON.stringify(e.jevWould));
  assert.match(e.jevWhy, /前 5%/);

  // 拿不准但两档结论一样（前 35% 和前 70% 都该跟）→ 不脆弱，不回传
  const same = { top5: 0.05, top15: 0.05, top35: 0.45, top70: 0.4, any: 0.05 };
  const calm = driverWith(mockFetch((b) => answersFor(b, { bucket: 'top35', fold: 0.0, strength: 1, probabilities: same })).fetch, { minTopProb: 0.5, escalate: true });
  const c = await calm.decide(spot.state, spot.persona);
  assert.equal(c.source, 'jev');
  assert.equal(c.fragile, false);

  // 最高概率够高就不做脆弱度判定
  const sure = driverWith(mockFetch((b) => answersFor(b, { bucket: 'top5', fold: 0.1, strength: 0.5 })).fetch, { minTopProb: 0.5, escalate: true });
  const s = await sure.decide(spot.state, spot.persona);
  assert.equal(s.source, 'jev');
  assert.ok(!s.trace.some((x) => x.tool === 'fragility'));
});

// ==================== 故障与分流 ====================

test('jev：接口 500 退回规则并计错误；401 直接冷却，下一次不再打接口', async () => {
  const spot = byId('range-prof-nit');
  const log = quiet();

  const boom = mockFetch(() => new Response('{"error":"overloaded"}', { status: 529 }));
  const d1 = driverWith(boom.fetch, { logger: log });
  const o1 = await d1.decide(spot.state, spot.persona);
  assert.equal(o1.source, 'fallback:rule');
  assert.ok(['fold', 'call'].includes(o1.action.type));
  assert.equal(d1.stats.errors, 1);
  assert.equal(d1.stats.fallback, 1);
  assert.ok(log.errors.some((l) => /调用失败/.test(l)));
  assert.equal(modelAnswered('jev', o1.source), false);

  const denied = mockFetch(() => new Response('{"error":"bad key"}', { status: 401 }));
  const d2 = driverWith(denied.fetch);
  await d2.decide(spot.state, spot.persona);
  await d2.decide(spot.state, spot.persona);
  assert.equal(denied.calls.length, 1, '401 之后应该进冷却，不再打第二次');
  assert.equal(d2.stats.fallback, 2);
});

test('jev：答案格式不对（选了不存在的档、少答一题）也算失败，不会拿去算动作', async () => {
  const spot = byId('range-prof-nit');
  const bad = mockFetch((body) => {
    const a = answersFor(body, { bucket: 'top15' });
    a.answers.opponent_range.choice = 'top1';
    return a;
  });
  const d = driverWith(bad.fetch);
  const out = await d.decide(spot.state, spot.persona);
  assert.equal(out.source, 'fallback:rule');

  const missing = mockFetch((body) => {
    const a = answersFor(body, { bucket: 'top15' });
    delete a.answers.opponent_range;
    return a;
  });
  const d2 = driverWith(missing.fetch);
  const out2 = await d2.decide(spot.state, spot.persona);
  assert.equal(out2.source, 'fallback:rule');
});

test('jev：confidence 低于门槛就交给兜底，trace 里仍然留着它的读档', async () => {
  const spot = byId('range-prof-nit');
  const d = driverWith(mockFetch((b) => answersFor(b, { bucket: 'top5', confidence: 0.4 })).fetch, { minConfidence: 0.6 });
  const out = await d.decide(spot.state, spot.persona);
  assert.equal(out.source, 'fallback:rule');
  assert.equal(out.escalated, true);
  assert.equal(out.confidence, 0.4);
  assert.equal(out.trace.find((c) => c.tool === 'read_range').range, 0.05);
  assert.equal(d.stats.escalated, 1);
  assert.equal(d.stats.jev, 0);

  const sure = driverWith(mockFetch((b) => answersFor(b, { bucket: 'top5', confidence: 0.9 })).fetch, { minConfidence: 0.6 });
  const ok = await sure.decide(spot.state, spot.persona);
  assert.equal(ok.source, 'jev');
});

test('jev：明显局面不问模型', async () => {
  const spot = SPOTS.find((s) => s.tag === 'obvious');
  const { calls, fetch } = mockFetch((b) => answersFor(b));
  const d = driverWith(fetch, { obvious: true });
  const out = await d.decide(spot.state, spot.persona);
  assert.equal(out.source, 'obvious');
  assert.equal(calls.length, 0);
});

test('jev：外部取消不计错误、不进冷却', async () => {
  const spot = byId('range-prof-nit');
  const ac = new AbortController();
  const slow = mockFetch(() => { ac.abort(); throw new DOMException('aborted', 'AbortError'); });
  const d = driverWith(slow.fetch);
  const out = await d.decide(spot.state, spot.persona, ac.signal);
  assert.equal(out.source, 'canceled');
  assert.equal(d.stats.errors, 0);
  assert.equal(d.stats.canceled, 1);
});

test('jev：OpenRouter 当供应商时换路径、换模型名前缀、带自家 key，响应里的 cost 记进账', async () => {
  const spot = byId('range-prof-nit');
  const { calls, fetch } = mockFetch((body) => {
    const a = answersFor(body, { bucket: 'top15' });
    a.model = 'typesafe/jev-1.13-20260917';
    a.provider = 'TypeSafe';
    a.usage.cost = 0.00002;
    return a;
  });
  const client = new JevClient({ provider: 'openrouter', apiKey: 'or-key', fetch });
  assert.equal(client.model, 'typesafe/jev-1.13');
  assert.equal(client.label, 'OpenRouter');
  const rule = new BotDriver({ clients: [], minThinkMs: 0, logger: quiet(), obvious: false });
  const d = new JevDriver({ client, fallback: rule, minThinkMs: 0, obvious: false, equitySims: 8000, logger: quiet() });
  const out = await d.decide(spot.state, spot.persona);
  assert.equal(out.source, 'jev');
  assert.equal(calls[0].url, 'https://openrouter.ai/api/alpha/decisions');
  assert.equal(calls[0].init.headers.authorization, 'Bearer or-key');
  assert.equal(calls[0].init.headers['X-Title'], 'poker-table');
  assert.equal(calls[0].body.model, 'typesafe/jev-1.13');
  assert.deepEqual(Object.keys(calls[0].body).sort(), ['model', 'questions', 'state']);
  assert.equal(d.stats.cost, 0.00002);
  assert.equal(out.trace.find((c) => c.tool === 'jev').provider, 'openrouter');
  assert.match(d.describe(), /OpenRouter/);

  assert.throws(() => new JevClient({ provider: 'nope', apiKey: 'k' }), /未知的 Jev 供应商/);
});

test('jev：没配 key 时 jevFromEnv 是 null，驱动全走兜底', async () => {
  assert.equal(jevFromEnv({}), null);
  const c = jevFromEnv({ TYPESAFE_API_KEY: 'k', POKER_JEV_MODEL: 'jev-1.13.0', POKER_JEV_URL: 'https://gw.example/v1/systemone' });
  assert.equal(c.model, 'jev-1.13.0');
  assert.equal(c.url, 'https://gw.example/v1/systemone');
  assert.equal(c.provider, 'typesafe');

  // auto：哪家有 key 用哪家，两家都有时 TypeSafe 优先；指定了就只看那家
  assert.equal(jevFromEnv({ OPENROUTER_API_KEY: 'o' }).provider, 'openrouter');
  assert.equal(jevFromEnv({ OPENROUTER_API_KEY: 'o', TYPESAFE_API_KEY: 't' }).provider, 'typesafe');
  assert.equal(jevFromEnv({ POKER_JEV_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'o', TYPESAFE_API_KEY: 't' }).provider, 'openrouter');
  assert.equal(jevFromEnv({ POKER_JEV_PROVIDER: 'openrouter', TYPESAFE_API_KEY: 't' }), null);
  assert.equal(jevFromEnv({ POKER_JEV_PROVIDER: 'openrouter', POKER_JEV_API_KEY: 'x' }).provider, 'openrouter');
  const errs = [];
  const origErr = console.error; console.error = (m) => errs.push(String(m));
  try { assert.equal(jevFromEnv({ POKER_JEV_PROVIDER: 'nope', TYPESAFE_API_KEY: 't' }), null); }
  finally { console.error = origErr; }
  assert.ok(errs.some((l) => /未知的 POKER_JEV_PROVIDER/.test(l)));

  const rule = new BotDriver({ clients: [], minThinkMs: 0, logger: quiet(), obvious: false });
  const d = new JevDriver({ client: null, fallback: rule, minThinkMs: 0, logger: quiet() });
  assert.equal(d.hasLLM, false);
  const spot = byId('range-prof-nit');
  const out = await d.decide(spot.state, spot.persona);
  assert.equal(out.source, 'fallback:rule');
  assert.match(d.describe(), /Jev 未配置/);
});

// ==================== 线上接法：配置 / 状态 / 闲聊 / 读人笔记 ====================

import { LLMClient } from '../server/bot/provider.js';
import { buildTalkUser, shouldTalk } from '../server/agent/talk.js';
import { OpponentNotes, buildNotesUser } from '../server/agent/notes.js';

/** 假的 LLMClient：completeJSON 回固定对象，记下收到的提示词 */
function fakeLLM(provider, reply) {
  const c = new LLMClient({ provider, apiKey: `${provider}-shared-key-123456`, timeoutMs: 5000 });
  c.calls = [];
  c.completeJSON = async ({ system, user }) => {
    c.calls.push({ system, user });
    if (reply instanceof Error) throw reply;
    return typeof reply === 'function' ? reply() : reply;
  };
  return c;
}

test('jev 线上：configure 带 jev 的配 Jev，不带的转给大模型那层；key 留空可以借同一家大模型的', () => {
  const llm = fakeLLM('openrouter', { say: '' });
  const rule = new BotDriver({ clients: [llm], minThinkMs: 0, logger: quiet(), obvious: false });
  const d = new JevDriver({ client: null, fallback: rule, minThinkMs: 0, logger: quiet() });

  assert.equal(d.status().jev.enabled, false);
  assert.equal(d.status().hasLLM, true, '大模型在就算有 LLM');

  // 借 key
  const r1 = d.configure({ jev: true, provider: 'openrouter' });
  assert.equal(r1.ok, true, r1.msg);
  assert.equal(d.client.apiKey, llm.apiKey);
  assert.equal(d.client.model, 'typesafe/jev-1.13');
  const st = d.status();
  assert.equal(st.jev.enabled, true);
  assert.equal(st.jev.provider, 'openrouter');
  assert.match(st.jev.maskedKey, /^ope…3456$/);
  assert.ok(!JSON.stringify(st).includes(llm.apiKey), '状态里不能有明文 key');
  assert.equal(st.jev.talk, true);
  assert.equal(st.jev.notes, true);
  assert.match(d.describe(), /闲聊和读人笔记交给大模型/);

  // 换模型、给新 key
  assert.equal(d.configure({ jev: true, provider: 'typesafe', apiKey: 'ts-key-abcdefgh', model: 'jev-1.13.0' }).ok, true);
  assert.equal(d.client.provider, 'typesafe');
  assert.equal(d.client.model, 'jev-1.13.0');

  // TypeSafe 没有同名大模型可借
  const d2 = new JevDriver({ client: null, fallback: rule, minThinkMs: 0, logger: quiet() });
  assert.equal(d2.configure({ jev: true, provider: 'typesafe' }).ok, false);
  assert.equal(d2.configure({ jev: true, provider: 'nope', apiKey: 'x' }).ok, false);

  // 停用
  assert.equal(d.configure({ jev: true, remove: true }).ok, true);
  assert.equal(d.status().jev.enabled, false);

  // 不带 jev 的 patch 原样转给大模型那层
  const r2 = d.configure({ provider: 'deepseek', apiKey: 'sk-deepseek-1234567890', model: 'deepseek-chat' });
  assert.equal(r2.ok, true, r2.msg);
  assert.ok(d.status().providers.some((p) => p.provider === 'deepseek'));
  assert.equal(d.removeProvider('deepseek').ok, true);
});

test('jev 线上：闲聊在动作之后异步问大模型，提示词里没有底牌，话风决定开不开口', async () => {
  const spot = byId('range-prof-nit');
  const llm = fakeLLM('openrouter', { say: '你这注下得心虚啊' });
  const rule = new BotDriver({ clients: [llm], minThinkMs: 0, logger: quiet(), obvious: false });
  const persona = { ...spot.persona, traits: { talk: 'chatty' } };

  const always = new JevDriver({ client: null, fallback: rule, minThinkMs: 0, logger: quiet(), talkRand: () => 0 });
  const out = { action: { type: 'raise', amount: 300 }, say: null, source: 'jev' };
  const text = await always.talk(spot.state, persona, out);
  assert.equal(text, '你这注下得心虚啊');
  assert.equal(always.stats.talked, 1);
  const { user } = llm.calls[0];
  for (const c of spot.state.you.cards) assert.ok(!user.includes(c) && !user.includes('8♥') && !user.includes('8♦'), `闲聊提示词里出现了底牌 ${c}`);
  assert.match(user, /加注 300/);
  assert.match(user, /老陈/);

  // 兜底链答的自带 say，不重复问；已经有 say 的也不问
  assert.equal(await always.talk(spot.state, persona, { ...out, source: 'fallback:agent' }), null);
  assert.equal(await always.talk(spot.state, persona, { ...out, say: '已经说过了' }), null);
  // 明显局面（规则出手）可以说
  assert.equal(await always.talk(spot.state, persona, { ...out, source: 'obvious' }), '你这注下得心虚啊');

  // 话风：quiet 概率低，开火翻倍
  assert.equal(shouldTalk({ traits: { talk: 'quiet' } }, { type: 'call' }, () => 0.2), false);
  assert.equal(shouldTalk({ traits: { talk: 'quiet' } }, { type: 'raise' }, () => 0.2), true);
  assert.equal(shouldTalk({ traits: { talk: 'chatty' } }, { type: 'call' }, () => 0.5), true);
  const never = new JevDriver({ client: null, fallback: rule, minThinkMs: 0, logger: quiet(), talkRand: () => 1 });
  assert.equal(await never.talk(spot.state, persona, out), null);

  // 亮牌的话会被 cleanSay 丢掉；大模型挂了也只是不说
  const leaky = fakeLLM('openrouter', { say: '我顶对稳了' });
  const d3 = new JevDriver({ client: null, fallback: new BotDriver({ clients: [leaky], minThinkMs: 0, logger: quiet(), obvious: false }), minThinkMs: 0, logger: quiet(), talkRand: () => 0 });
  assert.equal(await d3.talk(spot.state, persona, out), null);
  const dead = fakeLLM('openrouter', new Error('boom'));
  const d4 = new JevDriver({ client: null, fallback: new BotDriver({ clients: [dead], minThinkMs: 0, logger: quiet(), obvious: false }), minThinkMs: 0, logger: quiet(), talkRand: () => 0 });
  assert.equal(await d4.talk(spot.state, persona, out), null);

  // 没配大模型就没得聊
  const mute = new JevDriver({ client: null, fallback: new BotDriver({ clients: [], minThinkMs: 0, logger: quiet(), obvious: false }), minThinkMs: 0, logger: quiet(), talkRand: () => 0 });
  assert.equal(await mute.talk(spot.state, persona, out), null);
  assert.equal(typeof buildTalkUser(spot.state, persona, out.action), 'string');
});

test('jev 线上：读人笔记只在手牌结束时、只给有新摊牌的真人写，写好了进 Jev 的 state', async () => {
  const llm = fakeLLM('openrouter', { note: 'Tight-passive; only raises with premium hands, folds to river pressure.' });
  const profile = {
    name: '老陈', hands: 12, vpip: 8, pfr: 8, af: 2, foldToBet: 60, showdowns: 1,
    shown: [{ hand: 'Ah Kd', handName: '一对', won: true, wasAggressor: 'turn' }], byPos: null,
  };
  const memory = { size: 1, observe() {}, forget() {}, profile: (n) => (n === '老陈' ? profile : null) };
  const notes = new OpponentNotes({ clients: () => [llm], memory, everyHands: 4, logger: quiet() });

  const seats = [{ seat: 0, name: '老王', bot: true, state: 'in' }, { seat: 1, name: '老陈', bot: false, state: 'in' }];
  notes.onHandEnd({ seats });
  assert.equal(notes.pending.size, 1);
  await new Promise((r) => setTimeout(r, 10));
  assert.match(notes.get('老陈') || '', /Tight-passive/);
  assert.equal(notes.get('老王'), null, '人机不写笔记');
  assert.equal(notes.stats.written, 1);
  assert.match(llm.calls[0].user, /Ah Kd/);
  assert.match(llm.calls[0].system, /JSON/);

  // 没有新摊牌就不重写；隔够手数也不写
  profile.hands = 20;
  notes.onHandEnd({ seats });
  assert.equal(notes.pending.size, 0);
  assert.equal(llm.calls.length, 1);
  // 有新摊牌但没隔够手数也不写
  profile.showdowns = 2; profile.hands = 14;
  notes.onHandEnd({ seats });
  assert.equal(llm.calls.length, 1);
  profile.hands = 16;
  notes.onHandEnd({ seats });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(llm.calls.length, 2);

  // 进 Jev 的 state：有笔记才带 coach_note
  const spot = byId('range-prof-nit');
  const withNote = buildJevState(spot.state, { profiles: [profile], notes: (n) => notes.get(n) });
  assert.match(withNote.opponent_profiles[0].coach_note, /Tight-passive/);
  const without = buildJevState(spot.state, { profiles: [profile], notes: () => null });
  assert.equal('coach_note' in without.opponent_profiles[0], false);
  assert.match(buildNotesUser(profile), /VPIP 8%/);

  // 驱动层：决策中的 observe 不写笔记，手牌结束（旁观者快照，没有 you.legal）才写
  const rule = new BotDriver({ clients: [llm], minThinkMs: 0, logger: quiet(), obvious: false });
  const d = new JevDriver({ client: null, fallback: rule, minThinkMs: 0, logger: quiet() });
  d.notes = notes;
  llm.calls.length = 0;
  profile.showdowns = 3; profile.hands = 30;
  d.observe({ ...spot.state, seats });                       // 有 you.legal → 决策中
  assert.equal(llm.calls.length, 0);
  d.observe({ table: spot.state.table, seats, you: null, config: spot.state.config });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(llm.calls.length, 1);
  d.forget('老陈');
  assert.equal(notes.get('老陈'), null);
});

test('Room：走 Jev 的人机动作先落地，闲聊几秒后才进聊天区', async () => {
  const { Room } = await import('../server/room.js');
  const { fallbackAction } = await import('../server/bot/decide.js');
  const talks = [];
  const driver = {
    hasLLM: true,
    async decide(state) {
      return { action: fallbackAction(state, {}, null), say: null, source: 'jev', note: null, trace: [] };
    },
    async talk(state, persona, out) {
      talks.push({ name: persona.name, action: out.action.type, hasCards: JSON.stringify(state.you.cards) });
      await new Promise((r) => setTimeout(r, 30));      // 模拟大模型慢几拍
      return `${persona.name}说：来呀`;
    },
    observe() {}, forget() {}, describe() { return 'fake'; },
    status() { return { hasLLM: true, providers: [] }; },
  };
  const room = new Room({ botDriver: driver, config: { autoNextHand: false, actionTimeoutMs: 60000 } });
  const host = { sent: [], send(o) { this.sent.push(o); }, close() {}, playerId: null };
  room.attach(host); room.hello(host, null); room.sit(host, 0, '房主');
  room.addBot(host, 1); room.addBot(host, 2);
  assert.equal(room.startHand().ok, true);

  // 等人机动过、闲聊也到了。轮到真人时替他过牌 / 跟注，让人机有机会行动
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (room.chat.some((c) => /来呀/.test(c.text))) break;
    if (room.hand && !room.hand.isComplete && room.hand.actingSeat === 0) {
      const lg = room.hand.legalActions(0);
      room.action(host, { type: lg.canCheck ? 'check' : 'call', handNo: room.hand.handNo });
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(talks.length >= 1, '动作落地后应该问过一次闲聊');
  const line = room.chat.find((c) => /来呀/.test(c.text));
  assert.ok(line, `闲聊该进聊天区，现在是 ${JSON.stringify(room.chat)}`);
  assert.equal(line.name, talks[0].name);
  // 聊天区那句话是广播出去的：房主收到的快照里能看到
  const last = [...host.sent].reverse().find((m) => m.t === 'state');
  assert.ok(last && last.chat.some((c) => /来呀/.test(c.text)), '广播的快照里该有这句话');
  room.shutdown();
});
