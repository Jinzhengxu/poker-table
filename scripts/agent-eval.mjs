#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// 单点决策题库跑分：量人机的**判断力**，不量牌运。
//
//   node scripts/agent-eval.mjs                       # 默认 agent 模式，每题跑 1 次
//   node scripts/agent-eval.mjs --repeat 3            # 每题 3 次，看稳定性
//   node scripts/agent-eval.mjs --mode rule           # 纯规则基线，不花钱
//   node scripts/agent-eval.mjs --mode single         # 旧版单轮 LLM
//   node scripts/agent-eval.mjs --model deepseek-v4-pro
//   node scripts/agent-eval.mjs --tag range           # 只跑某一类
//   node scripts/agent-eval.mjs --json > out.json
//   node scripts/agent-eval.mjs --trace runs.jsonl    # 每次决策的完整轨迹落盘
//
// 三种模式跑的是**同一套题**，所以能直接横向比：
//
//   rule    规则策略。免费、确定性，是"不用模型能做到多好"的地板。
//   single  旧版：我们算好一个胜率塞进提示词，模型单轮出 JSON。
//   agent   这版：胜率、画像、下注尺度都是工具，模型自己多轮调。
//
// 只有三条线都在同一套题上跑过，"agent 这轮改造值多少钱"才有答案。
//
// 环境变量（和线上人机同一套读法，见 server/agent/model.js）：
//   DEEPSEEK_API_KEY      必填（rule 模式除外）
//   POKER_BOT_BASE_URL    接入点，默认走 DeepSeek 官方
//   POKER_AGENT_MODEL     模型名，--model 优先

import { writeFileSync, appendFileSync } from 'node:fs';

import { SPOTS, TAGS, pairsOf, TRIVIAL, scoreTrivial, modelAnswered } from '../server/eval/spots.js';
import { PokerAgent } from '../server/agent/index.js';
import { buildModel } from '../server/agent/model.js';
import { BotDriver } from '../server/bot/index.js';
import { LLMClient } from '../server/bot/provider.js';

// ---------------------------------------------------------------- 参数

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i === process.argv.length - 1) return dflt;
  return process.argv[i + 1];
}
const flag = (n) => process.argv.includes(`--${n}`);

const mode = String(arg('mode', 'agent'));
const repeat = Math.max(1, Number(arg('repeat', 1)));
const concurrency = Math.max(1, Number(arg('concurrency', 4)));
const tagFilter = arg('tag', null);
const idFilter = arg('id', null);
const asJson = flag('json');
const tracePath = arg('trace', null);
const modelName = arg('model', process.env.POKER_AGENT_MODEL || 'deepseek-chat');
const baseUrl = arg('base-url', process.env.POKER_BOT_BASE_URL || undefined);
const apiKey = process.env.DEEPSEEK_API_KEY || '';
// 题库模式下墙钟给得比线上大方：这里不赶 45 秒的行动时限，
// 要的是"模型想清楚能答成什么样"，被半路掐断的样本没有意义。
const maxThinkMs = Number(arg('max-ms', 60_000));
// 消融：--exclude plan_bet 把某个工具从工具集和提示词里一起摘掉，
// 跑同一套题看差多少。这是回答"这个工具值不值"的唯一办法。
const excludeTools = String(arg('exclude', '')).split(',').map((x) => x.trim()).filter(Boolean);

if (!['agent', 'single', 'rule'].includes(mode)) {
  console.error(`--mode 只能是 agent / single / rule，收到 ${mode}`);
  process.exit(2);
}
if (mode !== 'rule' && !apiKey) {
  console.error('缺少 DEEPSEEK_API_KEY（rule 模式不需要）');
  process.exit(2);
}

let spots = SPOTS;
if (tagFilter) spots = spots.filter((s) => s.tag === tagFilter);
if (idFilter) spots = spots.filter((s) => s.id.includes(idFilter));
if (!spots.length) {
  console.error(`没有匹配的题目（tag=${tagFilter} id=${idFilter}），可用分类：${TAGS.join(' / ')}`);
  process.exit(2);
}

const quiet = { error() {}, log() {}, warn() {} };

/**
 * 收集一次决策里驱动打出来的错误行。
 *
 * 不收的话，单轮那条线**兜底的原因会被整个吞掉**：`BotDriver#decide` 调用失败时
 * 只是 `logger.error(...)` 一句然后改用规则，返回值里除了 `source:'rule'` 什么都
 * 没有。v4 那一轮就是这么被坑的——单轮 92 次决策里 30 次其实是规则策略答的，
 * 而报告把它们算进了"单轮的正确率"。
 */
function recorder() {
  const lines = [];
  return { lines, error(m) { lines.push(String(m)); }, log() {}, warn() {} };
}

// ---------------------------------------------------------------- 驱动

/**
 * 每次决策都造一个新的驱动。
 *
 * 不是浪费：agent 的对手记忆会被 decide() 就地更新，共用一个实例的话，
 * 前面的题会污染后面的题，跑分就不可复现了。造一个驱动只是几个对象引用，
 * 真正贵的（模型对象）是共享的。
 */
function makeDriver(sharedModel, logger = quiet) {
  const rule = new BotDriver({ clients: [], minThinkMs: 0, logger: quiet });
  if (mode === 'rule') return rule;

  if (mode === 'single') {
    const client = new LLMClient({
      provider: 'deepseek', apiKey, model: modelName, baseUrl,
      // 带思维链的模型单轮也要十几秒，默认 8 秒会把每一题都打成兜底，
      // 那测的就不是模型而是超时。
      timeoutMs: maxThinkMs,
    });
    return new BotDriver({ clients: [client], minThinkMs: 0, maxThinkMs, logger });
  }

  return new PokerAgent({
    models: [sharedModel],
    excludeTools,
    fallback: rule,          // 兜底走纯规则：这样 fallback 一眼可见，不会又偷偷打一次模型
    minThinkMs: 0,
    maxThinkMs,
    logger,
  });
}

const sharedModel = mode === 'agent'
  ? buildModel({ provider: 'deepseek', apiKey, model: modelName, baseUrl })
  : null;

// ---------------------------------------------------------------- 判分

/** 动作的激进程度。成对题比的就是这个序 */
const RANK = { fold: 0, check: 1, call: 2, bet: 3, raise: 3, allin: 4 };

/**
 * 判一次决策。
 *
 * 判据的取舍见 spots.js 顶上的说明：能用 forbid 就不用 allow。
 */
function grade(spot, out) {
  const type = out?.action?.type || '(无)';
  const e = spot.expect || {};
  const tools = (out.trace || []).map((c) => c.tool);

  const notes = [];
  let ok = true;

  if (e.soft) {
    ok = null;                                  // 不判对错，只收指标
  } else if (Array.isArray(e.allow) && !e.allow.includes(type)) {
    ok = false; notes.push(`应该 ${e.allow.join('/')}，实际 ${type}`);
  } else if (Array.isArray(e.forbid) && e.forbid.includes(type)) {
    ok = false; notes.push(`不该 ${type}`);
  }

  // 尺度只在真的开火了的时候才检查。allin 没有 amount，它由 forbid 单独管
  if (ok !== false && (type === 'bet' || type === 'raise')) {
    const amt = Number(out.action.amount) || 0;
    if (e.amountAtLeast && amt < e.amountAtLeast) {
      ok = false; notes.push(`尺度太小：${amt} < ${e.amountAtLeast}`);
    }
    if (e.amountAtMost && amt > e.amountAtMost) {
      ok = false; notes.push(`尺度太大：${amt} > ${e.amountAtMost}`);
    }
  }

  // 工具用没用对：单独的指标，不并进正确率。
  // 消融掉的工具当然不该要求它调，否则整张表变成"摘了工具所以工具没用对"。
  const want = Array.isArray(e.tools) ? e.tools.filter((t) => !excludeTools.includes(t)) : null;
  const toolOk = !want || !want.length
    ? null
    : (type === 'bet' || type === 'raise' || !want.includes('plan_bet'))
      ? want.every((t) => tools.includes(t))
      : null;   // 没开火就不要求它算开火的账

  // 动作被 coerceAction 夹过 = 模型给了个不合法或越界的东西
  const adjusted = out.adjusted || out.note || null;
  if (e.mustNotAdjust && adjusted) {
    ok = false; notes.push(`动作被修正：${adjusted}`);
  }

  return { ok, toolOk, notes, type, tools, adjusted };
}

// ---------------------------------------------------------------- 跑

/** 把一次决策连同判分打包成一条记录 */
async function runOnce(spot, iter) {
  const log = recorder();
  const driver = makeDriver(sharedModel, log);

  // 画像题要先把历史手牌喂进记忆（rule / single 没有记忆，跳过）
  if (spot.priorHands.length && typeof driver.observe === 'function') {
    for (const h of spot.priorHands) driver.observe(h);
  }

  const t0 = Date.now();
  let out;
  try {
    out = await driver.decide(spot.state, spot.persona);
  } catch (e) {
    out = { action: { type: '(异常)' }, source: 'throw', error: e.message };
  }
  const ms = Date.now() - t0;

  const g = grade(spot, out);
  const st = driver.stats || {};
  return {
    id: spot.id, tag: spot.tag, iter, ms,
    action: g.type,
    amount: out.action?.amount ?? null,
    source: out.source || null,
    fellBack: !modelAnswered(mode, out.source),
    fallbackReason: log.lines.find((l) => /调用失败|内容审查|兜底/.test(l)) || null,
    ok: g.ok, toolOk: g.toolOk, notes: g.notes, adjusted: g.adjusted,
    tools: g.tools,
    ranges: (out.trace || []).filter((c) => c.tool === 'estimate_equity').map((c) => c.range),
    steps: st.steps ?? null,
    toolCalls: st.toolCalls ?? null,
    filtered: st.filtered ?? (log.lines.some((l) => /内容审查|content_filter|451/.test(l)) ? 1 : 0),
    inputTokens: st.inputTokens ?? 0,
    outputTokens: st.outputTokens ?? 0,
    say: out.say || null,
    error: out.error || null,
  };
}

/** 固定并发的任务池。题目之间没有依赖，唯一的约束是别把网关打爆 */
async function pool(tasks, n, onDone) {
  const results = new Array(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(n, tasks.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= tasks.length) return;
      results[i] = await tasks[i]();
      onDone?.(results[i], i + 1, tasks.length);
    }
  });
  await Promise.all(workers);
  return results;
}

const jobs = [];
for (let it = 0; it < repeat; it++) {
  for (const s of spots) jobs.push(() => runOnce(s, it));
}

if (!asJson) {
  console.error(`模式 ${mode}${mode === 'rule' ? '' : ` × ${modelName}`}` +
                `${excludeTools.length ? `（摘掉 ${excludeTools.join('/')}）` : ''}，` +
                `${spots.length} 题 × ${repeat} 遍 = ${jobs.length} 次决策，并发 ${concurrency}`);
}

const t0 = Date.now();
const runs = await pool(jobs, concurrency, (r, done, total) => {
  if (asJson) return;
  const mark = r.ok === false ? '✗' : r.ok === null ? '·' : '✓';
  process.stderr.write(`\r  ${String(done).padStart(3)}/${total} ${mark} ${r.id.padEnd(22)}`);
});
const seconds = Number(((Date.now() - t0) / 1000).toFixed(1));
if (!asJson) process.stderr.write('\r' + ' '.repeat(60) + '\r');

if (tracePath) {
  writeFileSync(tracePath, '');
  for (const r of runs) appendFileSync(tracePath, JSON.stringify(r) + '\n');
}

// ---------------------------------------------------------------- 汇总

const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
const scored = runs.filter((r) => r.ok !== null);
const correct = scored.filter((r) => r.ok).length;

function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

const byTag = new Map();
for (const r of runs) {
  const v = byTag.get(r.tag) || { n: 0, scored: 0, ok: 0, steps: 0, tools: 0, ms: [] };
  v.n++;
  if (r.ok !== null) { v.scored++; if (r.ok) v.ok++; }
  v.steps += r.steps || 0;
  v.tools += r.toolCalls || 0;
  v.ms.push(r.ms);
  byTag.set(r.tag, v);
}

// 成对题：紧的那边必须比松的那边更保守（动作更靠 fold 一侧），
// 而且传给 estimate_equity 的对手范围也该更窄。
const pairRows = [];
for (const [key, sides] of pairsOf(spots)) {
  for (let it = 0; it < repeat; it++) {
    const t = runs.find((r) => r.id === sides.tight.id && r.iter === it);
    const l = runs.find((r) => r.id === sides.loose.id && r.iter === it);
    if (!t || !l) continue;
    const minRange = (r) => (r.ranges.length ? Math.min(...r.ranges) : null);
    pairRows.push({
      key, iter: it,
      tight: t.action, loose: l.action,
      reversed: (RANK[t.action] ?? 9) < (RANK[l.action] ?? 9),
      tightRange: minRange(t), looseRange: minRange(l),
      rangeOk: minRange(t) !== null && minRange(l) !== null ? minRange(t) < minRange(l) : null,
    });
  }
}

const summary = {
  mode, model: mode === 'rule' ? null : modelName, baseUrl: baseUrl || null,
  excludeTools,
  spots: spots.length, repeat, decisions: runs.length, seconds,
  correct, scored: scored.length,
  accuracy: scored.length ? Number((correct / scored.length).toFixed(3)) : null,
  fellBack: runs.filter((r) => r.fellBack).length,
  filtered: runs.filter((r) => r.filtered > 0).length,
  adjusted: runs.filter((r) => r.adjusted).length,
  toolOk: runs.filter((r) => r.toolOk === true).length,
  toolChecked: runs.filter((r) => r.toolOk !== null).length,
  // 开火率和全下率。**判对错的那套判据看不见过度激进** —— 拿着听牌把 600 推进
  // 100 的底池，"不该弃牌"这条判据照样给过。所以单列出来看。
  fired: runs.filter((r) => ['bet', 'raise', 'allin'].includes(r.action)).length,
  shoved: runs.filter((r) => r.action === 'allin').length,
  p50ms: percentile(runs.map((r) => r.ms), 0.5),
  p95ms: percentile(runs.map((r) => r.ms), 0.95),
  inputTokens: runs.reduce((s, r) => s + r.inputTokens, 0),
  outputTokens: runs.reduce((s, r) => s + r.outputTokens, 0),
  pairs: pairRows,
};

if (asJson) {
  console.log(JSON.stringify({ summary, runs }, null, 2));
  process.exit(0);
}

console.log(`## ${mode}${mode === 'rule' ? '' : ` · ${modelName}`}` +
            `${excludeTools.length ? ` · 摘掉 ${excludeTools.join('/')}` : ''}\n`);
console.log(`| 指标 | 值 |`);
console.log(`| --- | --- |`);
console.log(`| 正确率 | **${pct(correct, scored.length)}**（${correct}/${scored.length}，另有 ${runs.length - scored.length} 题不判对错） |`);
// 兜底走的是规则策略。混在一起算出来的正确率既不是模型的也不是规则的，
// 而兜底率一高，开火率、全下率还会被规则策略（它从不全下）机械地稀释。
// 所以只要有兜底，就把「模型自己答的那部分」单独列一行。
if (summary.fellBack) {
  const m = runs.filter((r) => !r.fellBack);
  const ms = m.filter((r) => r.ok !== null);
  const mc = ms.filter((r) => r.ok).length;
  const mf = m.filter((r) => ['bet', 'raise', 'allin'].includes(r.action)).length;
  const ma = m.filter((r) => r.action === 'allin').length;
  console.log(`| 　只算模型自己答的 | ${pct(mc, ms.length)}（${mc}/${ms.length}），` +
              `开火 ${pct(mf, m.length)} / 全下 ${pct(ma, m.length)}　**要比就比这一行** |`);
}
console.log(`| 动作被修正 | ${summary.adjusted} 次（${pct(summary.adjusted, runs.length)}） |`);
console.log(`| 开火 / 其中全下 | ${summary.fired}（${pct(summary.fired, runs.length)}） / ` +
            `**${summary.shoved}**（${pct(summary.shoved, runs.length)}）—— 全下率高说明它在过度激进，` +
            `而对错判据看不见这一点 |`);
if (mode !== 'rule') {
  console.log(`| 退回兜底 | ${summary.fellBack} 次（${pct(summary.fellBack, runs.length)}）${summary.filtered ? `，其中内容审查拦截 ${summary.filtered} 次` : ''}` +
              `${summary.fellBack ? ' —— 兜底走的是规则策略，正确率里要把它们摘出去看' : ''} |`);
}
if (mode === 'agent') {
  console.log(`| 工具用对 | ${summary.toolOk}/${summary.toolChecked} |`);
}
console.log(`| 延迟 p50 / p95 | ${(summary.p50ms / 1000).toFixed(1)}s / ${(summary.p95ms / 1000).toFixed(1)}s |`);
if (summary.inputTokens) {
  console.log(`| token（入/出） | ${summary.inputTokens} / ${summary.outputTokens}，` +
              `每次决策 ${Math.round(summary.inputTokens / runs.length)} / ${Math.round(summary.outputTokens / runs.length)} |`);
}
console.log(`| 总耗时 | ${seconds}s |`);

// 傻子基线：不给这个数，上面那个正确率是不可读的
const trivialRows = Object.entries(TRIVIAL)
  .map(([name, pick]) => ({ name, ...scoreTrivial(pick, spots) }))
  .sort((a, b) => b.pct - a.pct);
const best = trivialRows[0];
console.log(`\n### 对照：不看牌的傻子策略\n`);
console.log(`| 策略 | 得分 |`);
console.log(`| --- | ---: |`);
for (const r of trivialRows) console.log(`| ${r.name} | ${Math.round(r.pct * 100)}%（${r.ok}/${r.n}）|`);
console.log(`\n上面那个正确率要**减掉这条地板**再读：` +
            `最好的傻子能拿 ${Math.round(best.pct * 100)}%（${best.name}），` +
            `所以真正有区分度的只有 ${Math.round(best.pct * 100)}% 到 100% 这一段。`);

console.log(`\n### 分类\n`);
console.log(`| 分类 | 决策数 | 正确率 | 平均步数 | 平均工具调用 | 中位延迟 |`);
console.log(`| --- | ---: | ---: | ---: | ---: | ---: |`);
for (const tag of TAGS) {
  const v = byTag.get(tag);
  if (!v) continue;
  console.log(`| ${tag} | ${v.n} | ${pct(v.ok, v.scored)} | ${(v.steps / v.n).toFixed(1)} | ` +
              `${(v.tools / v.n).toFixed(1)} | ${(percentile(v.ms, 0.5) / 1000).toFixed(1)}s |`);
}

if (pairRows.length) {
  console.log(`\n### 成对题：同一手牌、同样的赔率，只有对手不同\n`);
  console.log(`| 题对 | 遍 | 对手紧 | 对手松 | 分开了吗 | 估的范围（紧/松） |`);
  console.log(`| --- | ---: | --- | --- | --- | --- |`);
  for (const p of pairRows) {
    const r = (x) => (x === null ? '—' : x.toFixed(2));
    console.log(`| ${p.key} | ${p.iter + 1} | ${p.tight} | ${p.loose} | ` +
                `${p.reversed ? '✓ 分开了' : '✗ 一样'} | ${r(p.tightRange)} / ${r(p.looseRange)}` +
                `${p.rangeOk === true ? ' ✓' : p.rangeOk === false ? ' ✗' : ''} |`);
  }
  const sep = pairRows.filter((p) => p.reversed).length;
  const dir = pairRows.filter((p) => p.rangeOk === true).length;
  const dirN = pairRows.filter((p) => p.rangeOk !== null).length;
  console.log(`\n动作分开了 ${sep}/${pairRows.length}，估的范围方向对了 ${dir}/${dirN}。`);
  console.log('**这是范围建模有没有在起作用的唯一直接证据**——两边答案一样，说明模型没读出对手的差别。');
  console.log('但要小心反过来读：**分开了不等于打对了**。题库里这几个牌面的弃牌只在' +
              '「把对手读成前 5%」时才划算，读成前 10% 就该跟了——门槛附近很窄。' +
              '所以这张表回答的是"它有没有反应"，不是"它反应得对不对"。');
}

const wrong = runs.filter((r) => r.ok === false);
if (wrong.length) {
  console.log(`\n### 错题（${wrong.length}）\n`);
  for (const r of wrong) {
    const s = spots.find((x) => x.id === r.id);
    console.log(`- **${r.id}**（第 ${r.iter + 1} 遍）：${r.notes.join('；')}` +
                `${r.source && r.source !== 'agent' ? `　[${r.source}]` : ''}`);
    console.log(`  - 题意：${s.why}`);
    if (r.ranges.length) console.log(`  - 它估的对手范围：${r.ranges.join(' / ')}`);
  }
}

console.log(`\n> 每题只跑 ${repeat} 遍时，一两道错题基本是噪声；` +
            `要下结论就把 --repeat 提到 3 以上，看的是**哪些题稳定地错**。`);
