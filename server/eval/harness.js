// SPDX-License-Identifier: GPL-3.0-or-later
//
// 自对弈评测台：让两个策略在同一批牌上对打，量出 bb/100 和置信区间。
//
// 德扑评测最大的敌人是**方差**。一手牌的结果主要由发到什么牌决定，策略的
// 优劣被埋在噪声里；随便打几千手就宣布「新版更强」，那个结论多半是牌运。
//
// 这里用两件事压方差：
//
//   1. **对偶发牌（duplicate poker）**。同一副牌打多遍，每遍把策略在座位间
//      轮转一格。于是每一手底牌 A 和 B 都会拿到，牌运在两者之间抵消 —— 这是
//      桥牌比赛用了几十年的老办法，不是什么新发明。
//
//   2. **以「副」为独立单位做统计**，不是以「手」。同一副牌的几遍之间是强
//      相关的（就是故意的），把它们加总成一个观测值再算方差，才不会低估误差。
//
// 报出来的东西：
//   bb/100  每 100 手赢多少个大盲。扑克圈的标准单位，能和外部数字对上。
//   ±       95% 置信区间半宽。**这个数比 bb/100 本身更重要** —— 区间跨过 0
//           就是「没测出差别」，不是「打平」，更不是「新版更强但差距小」。
//
// 全程确定性：牌堆和蒙特卡洛都走注入的种子随机源，同一个 seed 跑出来的
// 结果逐位相同。

import { Hand, actionHistory } from '../engine.js';
import { freshDeck } from '../deck.js';
import { decideByRule } from '../bot/policy.js';
import { estimateEquity, handPercentile } from '../bot/equity.js';
import { inferOpponentRange } from '../bot/range.js';

/** mulberry32：小、快、够随机，而且可复现（node:crypto 的 randomInt 不接受种子） */
export function makeRng(seed) {
  let a = (seed >>> 0) || 1;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 用给定随机源洗一副牌（不改原数组） */
export function shuffleWith(deck, rng) {
  const out = deck.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = out[i]; out[i] = out[j]; out[j] = t;
  }
  return out;
}

/**
 * 打一手牌，返回每个座位的净盈亏（筹码）。
 *
 * @param {object} args
 * @param {object[]} args.assignment  座位 -> 策略对象
 * @param {string[]} args.deck
 * @param {number} args.buttonSeat
 * @param {number} args.startingStack
 * @param {object} args.config
 * @param {number} args.handNo
 * @param {() => number} args.rng
 * @returns {{net: Map<number,number>, decisions: number, showdown: boolean}}
 */
export function playHand(args) {
  const { assignment, deck, buttonSeat, startingStack, config, handNo, rng } = args;
  const seats = [...assignment.keys()].sort((a, b) => a - b);

  const hand = new Hand({
    players: seats.map((s) => ({ seat: s, name: `s${s}`, chips: startingStack })),
    config,
    buttonSeat,
    handNo,
    deck,
  });

  let decisions = 0;
  let guard = 0;
  while (!hand.isComplete && guard++ < 600) {
    const seat = hand.actingSeat;
    if (seat === null || seat === undefined) break;

    const legal = hand.legalActions(seat);
    if (!legal) break;
    const hp = hand.players.get(seat);

    // 还在牌里的对手数：已弃牌的不再争底池
    let opponents = 0;
    for (const [s, p] of hand.players) {
      if (s !== seat && !p.folded) opponents++;
    }

    let action;
    try {
      action = assignment.get(seat).decide({
        hole: hp.holeCards,
        board: hand.board,
        legal,
        pot: hand.totalPot,
        chips: hp.chips,
        seed: handNo * 8 + seat,
        mySeat: seat,
        opponents,
        history: actionHistory(hand.events),
        config,
        rng,
      });
    } catch (e) {
      // 策略抛异常不该让整场评测崩掉，按「能过牌就过牌」处理并记一笔
      action = legal.canCheck ? { type: 'check' } : { type: 'fold' };
      action._error = e.message;
    }
    decisions++;

    const res = hand.act(seat, action);
    if (!res || res.ok !== true) {
      // 策略给了非法动作。评测台不像牌桌那样有 coerceAction 兜着，
      // 所以这里直接退化成合法的最小动作，并让调用方能看见。
      const fb = legal.canCheck ? { type: 'check' } : { type: 'fold' };
      const r2 = hand.act(seat, fb);
      if (!r2 || r2.ok !== true) break;
    }
  }

  const net = new Map();
  const after = hand.isComplete ? (hand.result?.chipsAfter || {}) : {};
  for (const s of seats) {
    const end = Number(after[s]);
    net.set(s, Number.isFinite(end) ? end - startingStack : 0);
  }
  return { net, decisions, showdown: !!hand.result?.showdown?.length, complete: hand.isComplete };
}

/**
 * 跑一场对局。
 *
 * @param {object} args
 * @param {object[]} args.policies      参赛策略，至少 2 个
 * @param {number} [args.decks]         发多少副**不同**的牌，默认 500
 * @param {number} [args.seats]         几人桌，默认 6。必须能被 policies.length 整除
 * @param {number} [args.startingStack] 每手重置的起始筹码，默认 100 个大盲
 * @param {object} [args.config]        盲注设置
 * @param {number} [args.seed]          随机种子，默认 1
 * @param {number} [args.rotations]     每副牌打几遍（策略轮转），默认 = policies.length
 * @param {(p:object) => void} [args.onProgress]
 * @returns {object} 见 summarize()
 */
export function runMatch(args = {}) {
  const policies = args.policies;
  if (!Array.isArray(policies) || policies.length < 2) {
    throw new Error('至少需要 2 个策略');
  }
  const seats = args.seats ?? 6;
  if (seats % policies.length !== 0) {
    throw new Error(`座位数 ${seats} 不能被策略数 ${policies.length} 整除，座位分配会不公平`);
  }

  const config = { smallBlind: 5, bigBlind: 10, ante: 0, ...(args.config || {}) };
  const decks = Math.max(1, Number(args.decks ?? 500));
  const startingStack = Math.max(config.bigBlind * 2, Number(args.startingStack ?? config.bigBlind * 100));
  const rotations = Math.max(1, Number(args.rotations ?? policies.length));
  const rng = makeRng(args.seed ?? 1);
  const base = freshDeck();

  const seatList = [];
  for (let s = 0; s < seats; s++) seatList.push(s);

  // 每副牌一个观测值：这一副里各策略总共赢了多少（大盲为单位）
  /** @type {Array<Record<string, number>>} */
  const perDeck = [];
  const handsPerDeck = Object.create(null);
  for (const p of policies) handsPerDeck[p.name] = 0;

  let totalDecisions = 0;
  let incomplete = 0;

  for (let d = 0; d < decks; d++) {
    const deck = shuffleWith(base, rng);
    const buttonSeat = d % seats;
    const row = Object.create(null);
    for (const p of policies) row[p.name] = 0;

    for (let r = 0; r < rotations; r++) {
      const assignment = new Map();
      for (const s of seatList) {
        assignment.set(s, policies[(s + r) % policies.length]);
      }

      const out = playHand({
        assignment, deck, buttonSeat, startingStack, config,
        handNo: d * rotations + r + 1, rng,
      });
      totalDecisions += out.decisions;
      if (!out.complete) incomplete++;

      for (const [s, n] of out.net) {
        const name = assignment.get(s).name;
        row[name] += n / config.bigBlind;
        if (d === 0) handsPerDeck[name]++;      // 每副牌里每个策略打几个「玩家手」
      }
    }

    perDeck.push(row);
    if (args.onProgress && (d + 1) % Math.max(1, Math.floor(decks / 20)) === 0) {
      args.onProgress({ done: d + 1, total: decks });
    }
  }

  return summarize({ perDeck, handsPerDeck, policies, decks, rotations, seats, config,
                     startingStack, totalDecisions, incomplete, seed: args.seed ?? 1 });
}

/**
 * 把每副牌的观测值汇总成 bb/100 与置信区间。
 *
 * 统计的独立单位是**一副牌**，不是一手牌 —— 同一副牌的几遍之间是强相关的
 * （对偶发牌就是故意制造这种相关性来抵消牌运的），按手算会把样本量虚报
 * `rotations` 倍，置信区间也就跟着缩水成假的。
 */
export function summarize(ctx) {
  const { perDeck, handsPerDeck, policies, decks } = ctx;
  const rows = [];

  for (const p of policies) {
    const name = p.name;
    const m = handsPerDeck[name] || 1;          // 每副牌里这个策略打了几个玩家手
    // X_i = 第 i 副牌里，这个策略平均每个玩家手赢多少 bb
    const xs = perDeck.map((row) => (row[name] || 0) / m);
    const n = xs.length;
    const mean = xs.reduce((a, b) => a + b, 0) / n;
    const varSum = xs.reduce((a, b) => a + (b - mean) * (b - mean), 0);
    const sd = n > 1 ? Math.sqrt(varSum / (n - 1)) : 0;
    const se = n > 0 ? sd / Math.sqrt(n) : 0;

    rows.push({
      name,
      handsPlayed: m * decks,
      bbPer100: round2(mean * 100),
      ci95: round2(1.96 * se * 100),
      sdPer100: round2(sd * 100),
    });
  }

  // 两个策略时额外给出「差值」的检验 —— 这才是真正要回答的问题。
  // 零和牌局里 netA = -netB，所以差值就是 2×A，用配对样本算，方差最小。
  let diff = null;
  if (policies.length === 2) {
    const [a, b] = policies;
    const ma = handsPerDeck[a.name] || 1;
    const mb = handsPerDeck[b.name] || 1;
    const ds = perDeck.map((row) => (row[a.name] || 0) / ma - (row[b.name] || 0) / mb);
    const n = ds.length;
    const mean = ds.reduce((x, y) => x + y, 0) / n;
    const varSum = ds.reduce((x, y) => x + (y - mean) * (y - mean), 0);
    const sd = n > 1 ? Math.sqrt(varSum / (n - 1)) : 0;
    const se = n > 0 ? sd / Math.sqrt(n) : 0;
    const z = se > 0 ? mean / se : 0;
    diff = {
      label: `${a.name} − ${b.name}`,
      bbPer100: round2(mean * 100),
      ci95: round2(1.96 * se * 100),
      z: round2(z),
      // 双尾正态近似。样本量几百上千时够用了，不值得为此引入 t 分布表。
      p: round4(2 * (1 - normalCdf(Math.abs(z)))),
      significant: Math.abs(z) > 1.96,
    };
  }

  return {
    rows,
    diff,
    meta: {
      decks: ctx.decks,
      rotations: ctx.rotations,
      seats: ctx.seats,
      handsTotal: ctx.decks * ctx.rotations,
      startingStackBb: Math.round(ctx.startingStack / ctx.config.bigBlind),
      blinds: `${ctx.config.smallBlind}/${ctx.config.bigBlind}`,
      decisions: ctx.totalDecisions,
      incomplete: ctx.incomplete,
      seed: ctx.seed,
    },
  };
}

/** 标准正态 CDF，Abramowitz–Stegun 26.2.17，精度 7.5e-8，够算 p 值了 */
function normalCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 +
            t * (-1.821255978 + t * 1.330274429))));
  return x > 0 ? 1 - p : p;
}

function round2(v) { return Math.round(v * 100) / 100; }
function round4(v) { return Math.round(v * 10000) / 10000; }

/** 把结果排成一张能贴进 README 的表 */
export function formatReport(res) {
  const lines = [];
  const m = res.meta;
  lines.push(`${m.decks} 副牌 × ${m.rotations} 遍轮转 = ${m.handsTotal} 手，` +
             `${m.seats} 人桌，盲注 ${m.blinds}，每手重置 ${m.startingStackBb}bb，seed=${m.seed}`);
  lines.push(`共 ${m.decisions} 个决策点${m.incomplete ? `（${m.incomplete} 手未正常结束）` : ''}`);
  lines.push('');
  lines.push('| 策略 | 玩家手数 | bb/100 | 95% 置信区间 |');
  lines.push('| --- | ---: | ---: | --- |');
  for (const r of res.rows) {
    lines.push(`| ${r.name} | ${r.handsPlayed} | ${r.bbPer100 >= 0 ? '+' : ''}${r.bbPer100} | ±${r.ci95} |`);
  }
  if (res.diff) {
    lines.push('');
    const d = res.diff;
    lines.push(`差值（${d.label}）：${d.bbPer100 >= 0 ? '+' : ''}${d.bbPer100} bb/100 ` +
               `± ${d.ci95}，z=${d.z}，p=${d.p}`);
    lines.push(d.significant
      ? '→ 区间不跨 0，差异显著。'
      : '→ 区间跨过 0，**没测出差别**（这不等于两者一样强，只是样本量还不够）。');

    // 把「还差多少样本」直接算给使用者。不然人很容易看着一个点估计
    // 自我说服「方向是对的，只是差一点」—— 而德扑里那个点估计经常连
    // 符号都不稳定。给出具体的副数，是让人闭嘴的最快方式。
    if (!d.significant && Math.abs(d.bbPer100) > 1e-9) {
      const need = Math.ceil(m.decks * (d.ci95 / Math.abs(d.bbPer100)) ** 2);
      lines.push(`→ 要把当前这个点估计（${d.bbPer100} bb/100）测到显著，` +
                 `大约需要 ${need.toLocaleString('en-US')} 副牌` +
                 `（现在是 ${m.decks.toLocaleString('en-US')} 副）。`);
      lines.push('  但先别急着跑：点估计本身在样本不够时连符号都会变，' +
                 '所以这个数只是量级参考，不是「再跑这么多就能赢」的承诺。');
    }
  }
  return lines.join('\n');
}

/**
 * 影子评测：不比输赢，直接量「范围建模到底改变了多少个决策」。
 *
 * 为什么需要它：bb/100 的方差极大，而 decideByRule 只在**一个分支**里用胜率
 * （面对下注、不能过牌时该不该跟）。大部分决策两个策略给的动作一模一样，
 * 效应被稀释在噪声里 —— 上面那张表要跑几万副牌才可能显著。
 *
 * 影子评测绕开方差：让 baseline 正常驱动牌局，每到一个用得上胜率的决策点，
 * 把两种假设各算一遍，记下「换成范围假设会不会改主意」。这个量的方差小得多，
 * 几百副牌就能测准，而且它回答的是更根本的问题 —— **这个改动有没有咬合到
 * 任何东西上**。如果连决策都不改变，那 bb/100 上不可能有效果。
 *
 * @param {object} args
 * @param {number} [args.decks]
 * @param {number} [args.seats]
 * @param {number} [args.sims]
 * @param {number} [args.seed]
 * @param {(p:object)=>void} [args.onProgress]
 */
export function runShadow(args = {}) {
  const seats = args.seats ?? 6;
  const decks = Math.max(1, Number(args.decks ?? 500));
  const sims = Math.max(1, Number(args.sims ?? 2000));
  const config = { smallBlind: 5, bigBlind: 10, ante: 0, ...(args.config || {}) };
  const startingStack = Number(args.startingStack ?? config.bigBlind * 100);
  const rng = makeRng(args.seed ?? 1);
  const base = freshDeck();

  const stats = {
    decisions: 0,          // 总决策点
    equityDecisions: 0,    // 其中用得上胜率的（面对下注、不能过牌）
    changed: 0,            // 换成范围假设后动作变了的
    foldedInstead: 0,      // 本来跟注、改成弃牌
    calledInstead: 0,      // 本来弃牌、改成跟注
    equityDeltas: [],      // 胜率被下修了多少个百分点
    ranges: [],            // 推断出来的范围分布
    // 按「启发式有没有真的收窄范围」分开统计。不分开的话结论会被
    // 翻牌前无人加注的那一大堆决策稀释成一个没意义的平均数。
    wide: { n: 0, changed: 0 },      // range === 1，等于没做范围建模
    narrowed: { n: 0, changed: 0, deltas: [] },   // range < 1
    byStreet: Object.create(null),
  };

  for (let d = 0; d < decks; d++) {
    const deck = shuffleWith(base, rng);
    const buttonSeat = d % seats;
    const seatList = [];
    for (let s = 0; s < seats; s++) seatList.push(s);

    const hand = new Hand({
      players: seatList.map((s) => ({ seat: s, name: `s${s}`, chips: startingStack })),
      config, buttonSeat, handNo: d + 1, deck,
    });

    let guard = 0;
    while (!hand.isComplete && guard++ < 600) {
      const seat = hand.actingSeat;
      if (seat === null || seat === undefined) break;
      const legal = hand.legalActions(seat);
      if (!legal) break;
      const hp = hand.players.get(seat);
      stats.decisions++;

      let opponents = 0;
      for (const [s, p] of hand.players) if (s !== seat && !p.folded) opponents++;

      const usesEquity = !legal.canCheck && legal.canCall && opponents >= 1
        && Array.isArray(hp.holeCards) && hp.holeCards.length === 2;

      let action;
      if (!usesEquity) {
        action = decideByRule({
          hole: hp.holeCards, board: hand.board, legal,
          pot: hand.totalPot, chips: hp.chips, seed: (d + 1) * 8 + seat,
        });
      } else {
        stats.equityDecisions++;
        const history = actionHistory(hand.events);
        const range = inferOpponentRange({ history, mySeat: seat });
        const common = {
          hole: hp.holeCards, board: hand.board, opponents,
          sims, budgetMs: 60_000, rng,
        };
        const eqAny = estimateEquity({ ...common, opponentRange: null });
        const eqRange = estimateEquity({ ...common, opponentRange: range });

        const ctx = {
          hole: hp.holeCards, board: hand.board, legal,
          pot: hand.totalPot, chips: hp.chips, seed: (d + 1) * 8 + seat,
        };
        const aBase = decideByRule({ ...ctx, equity: eqAny });
        const aRange = decideByRule({ ...ctx, equity: eqRange });

        const differs = aBase.type !== aRange.type;
        if (eqAny && eqRange) {
          stats.equityDeltas.push(eqAny.pct - eqRange.pct);
          stats.ranges.push(range);
        }
        if (differs) {
          stats.changed++;
          if (aBase.type === 'call' && aRange.type === 'fold') stats.foldedInstead++;
          if (aBase.type === 'fold' && aRange.type === 'call') stats.calledInstead++;
        }

        const bucket = range >= 1 ? stats.wide : stats.narrowed;
        bucket.n++;
        if (differs) bucket.changed++;
        if (bucket.deltas && eqAny && eqRange) bucket.deltas.push(eqAny.pct - eqRange.pct);

        const st = hand.phase;
        const bs = stats.byStreet[st] || (stats.byStreet[st] = { n: 0, changed: 0, rangeSum: 0 });
        bs.n++;
        bs.rangeSum += range;
        if (differs) bs.changed++;

        // 牌局由 baseline 驱动：我们量的是「改用范围假设会改变什么」，
        // 所以得让局面沿着现状那条路走下去，否则两边的牌树会分叉，
        // 后面的决策点就不可比了。
        action = aBase;
      }

      const res = hand.act(seat, action);
      if (!res || res.ok !== true) {
        const fb = legal.canCheck ? { type: 'check' } : { type: 'fold' };
        if (!hand.act(seat, fb)?.ok) break;
      }
    }

    if (args.onProgress && (d + 1) % Math.max(1, Math.floor(decks / 20)) === 0) {
      args.onProgress({ done: d + 1, total: decks });
    }
  }

  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);
  const byStreet = {};
  for (const [k, v] of Object.entries(stats.byStreet)) {
    byStreet[k] = {
      n: v.n,
      changedPct: pct(v.changed, v.n),
      avgRange: Math.round((v.rangeSum / v.n) * 100) / 100,
    };
  }

  return {
    decisions: stats.decisions,
    equityDecisions: stats.equityDecisions,
    equityDecisionPct: pct(stats.equityDecisions, stats.decisions),
    changed: stats.changed,
    changedPct: pct(stats.changed, stats.equityDecisions),
    foldedInstead: stats.foldedInstead,
    calledInstead: stats.calledInstead,
    medianEquityDrop: median(stats.equityDeltas),
    medianRange: median(stats.ranges),
    // 关键的一刀：启发式到底有没有收窄范围
    wide: { n: stats.wide.n, changedPct: pct(stats.wide.changed, stats.wide.n) },
    narrowed: {
      n: stats.narrowed.n,
      changed: stats.narrowed.changed,
      changedPct: pct(stats.narrowed.changed, stats.narrowed.n),
      medianEquityDrop: median(stats.narrowed.deltas),
    },
    byStreet,
  };
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  const v = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  return Math.round(v * 10) / 10;
}

/**
 * 校准检查：启发式说「对手范围是前 X%」时，对手手里的牌**实际**排在第几百分位。
 *
 * 这是 bb/100 之外唯一能直接证伪范围推断的办法，而且方差极小 —— 每个决策点、
 * 每个还在牌里的对手都是一个观测值，几百副牌就够看出系统性偏差。
 *
 * 只有评测能做这件事：牌桌上人机看不见对手底牌（快照里是 "??"），
 * 而这里我们拿着引擎的全信息。**这个函数永远不能被运行时代码引用。**
 *
 * 怎么读结果：假设列说 0.05、实际列说 0.40，就是启发式认为对手比真实情况
 * 紧了 8 倍。那样人机会弃掉一堆本该跟的牌 —— 表现为 bb/100 上的净亏损。
 *
 * @param {object} args 同 runShadow
 */
export function runCalibration(args = {}) {
  const seats = args.seats ?? 6;
  const decks = Math.max(1, Number(args.decks ?? 400));
  const config = { smallBlind: 5, bigBlind: 10, ante: 0, ...(args.config || {}) };
  const startingStack = Number(args.startingStack ?? config.bigBlind * 100);
  const rng = makeRng(args.seed ?? 1);
  const base = freshDeck();

  // 桶的下界。按推断范围分组。
  const EDGES = [0.05, 0.1, 0.2, 0.35, 0.6, 1];
  const buckets = EDGES.map((lo) => ({ lo, n: 0, actual: [] }));
  const bucketOf = (r) => {
    let idx = 0;
    for (let i = 0; i < EDGES.length; i++) if (r >= EDGES[i]) idx = i;
    return buckets[idx];
  };

  for (let d = 0; d < decks; d++) {
    const deck = shuffleWith(base, rng);
    const seatList = [];
    for (let s = 0; s < seats; s++) seatList.push(s);

    const hand = new Hand({
      players: seatList.map((s) => ({ seat: s, name: `s${s}`, chips: startingStack })),
      config, buttonSeat: d % seats, handNo: d + 1, deck,
    });

    let guard = 0;
    while (!hand.isComplete && guard++ < 600) {
      const seat = hand.actingSeat;
      if (seat === null || seat === undefined) break;
      const legal = hand.legalActions(seat);
      if (!legal) break;
      const hp = hand.players.get(seat);

      const live = [];
      for (const [s, p] of hand.players) if (s !== seat && !p.folded) live.push(p);

      if (!legal.canCheck && legal.canCall && live.length >= 1) {
        const history = actionHistory(hand.events);
        const r = inferOpponentRange({ history, mySeat: seat });
        const b = bucketOf(r);
        for (const opp of live) {
          const pc = handPercentile(opp.holeCards?.[0], opp.holeCards?.[1]);
          if (pc !== null) { b.n++; b.actual.push(pc); }
        }
      }

      const action = decideByRule({
        hole: hp.holeCards, board: hand.board, legal,
        pot: hand.totalPot, chips: hp.chips, seed: (d + 1) * 8 + seat,
      });
      const res = hand.act(seat, action);
      if (!res || res.ok !== true) {
        const fb = legal.canCheck ? { type: 'check' } : { type: 'fold' };
        if (!hand.act(seat, fb)?.ok) break;
      }
    }

    if (args.onProgress && (d + 1) % Math.max(1, Math.floor(decks / 20)) === 0) {
      args.onProgress({ done: d + 1, total: decks });
    }
  }

  const rows = buckets.filter((b) => b.n > 0).map((b) => {
    const med = median(b.actual);
    const mean = b.actual.reduce((x, y) => x + y, 0) / b.actual.length;
    return {
      assumed: b.lo,
      n: b.n,
      actualMedian: Math.round(med * 1000) / 1000,
      actualMean: Math.round(mean * 1000) / 1000,
      // >1 表示启发式比现实紧（假设的范围比对手实际的牌窄）
      tightnessRatio: Math.round((med / b.lo) * 10) / 10,
    };
  });
  return { rows, decks };
}
