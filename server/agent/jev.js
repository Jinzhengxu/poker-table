// SPDX-License-Identifier: GPL-3.0-or-later
//
// Jev 版人机：判断交给决策模型，算术留在代码里。
//
// Jev（TypeSafe AI 的 System One 模型）和 LLM 的差别只有一句话：**它不生成文字**。
// 你给它一份 state 和几道类型化的题，它一趟并行算完，回来的是带概率的答案：
// choice 回选项 + 每个选项的概率 + confidence，noul 回「是」的概率。官方延迟
// 几百毫秒，输入 $0.042 / M token，输出免费。
//
// 这正好是 agent 版改造到今天剩下的形状。五档胜率表进提示词之后，模型要做的事
// 已经收敛成两个判断：
//
//   1. 对手落在五档范围的哪一档 —— 读表用；
//   2. 面对某个尺度的下注，他会不会弃 —— 开火算术用。
//
// 跟注 / 弃牌比的是胜率和底池赔率，开火比的是弃牌率和需要的弃牌率，尺度比的是
// 各档的 EV。这三样在 bot/table.js 和 agent/tools.js（plan_bet）里都已经是代码，
// 原来只是让 LLM 去读那些数再拍板。这里把「读数拍板」也收回代码，模型只剩判断。
// TypeSafe 自己的 jaggedness 页写得很直白：它不做算术，别让它比数。
//
// 所以这条路的结构是：
//
//   JevDriver.decide()
//     ├─ 五档胜率表（100~300ms，本地）
//     ├─ 明显局面 → 规则直接出手（和 PokerAgent 同一套判定）
//     ├─ 一趟 Jev：opponent_range（choice）+ 每个候选尺度一道 fold_to_bet（noul）
//     ├─ confidence 低于门槛 → 交给 fallback（题库里是规则；线上可以是 DeepSeek 的 agent）
//     └─ 代码算动作：读表 → 底池赔率 → 各尺度 EV → 人格偏移 → 出手
//
// **Jev 看不到自己的底牌。** 它答的两道题都是关于对手的：他有多紧、他会不会弃。
// 这两件事和我们拿什么无关，而把底牌塞进去只是「无关内容拉低准确率」（官方原话）。
// 顺带的好处是这条路上根本不存在泄牌的可能。聊天记录同样不进 state（防提示注入，
// 和 decide.js 那两条红线一致），昵称经 sanitizeName 清洗。
//
// state 和题目都用**英文**写：官方说英文是主要训练语言，CJK「能处理但不一样好」。
// 昵称是原样带过去的不透明字符串，不翻译。
//
// 它做不了的，交给语言模型，但都挪出决策路径：
//   - `say` 闲聊：动作落地后异步问一次 LLM（talk.js），话晚几秒到，牌桌不等它；
//   - 读人笔记：手牌之间让 LLM 从画像和摊牌里归纳一句「这人怎么打」（notes.js），
//     下一手写进 Jev 的 state。Jev 是一秒内的直觉，归纳是 LLM 的活；
//   - 兜底：Jev 挂了、或读数脆弱且开了回传，交给下面那层（PokerAgent → BotDriver → 规则）。

import { ProviderError, isRetryable } from '../bot/provider.js';
import { BotDriver } from '../bot/index.js';
import { fallbackAction, sanitizeName, positionName } from '../bot/decide.js';
import { equityTable, classifyObvious } from '../bot/table.js';
import { estimateEquityAsync } from '../bot/equity.js';
import { traitBias } from '../bot/persona.js';
import { OpponentMemory } from './memory.js';
import { collectProfiles } from './tools.js';
import { askForSay, shouldTalk } from './talk.js';
import { OpponentNotes } from './notes.js';

/** 连续失败多少次后暂时不走 Jev */
const FAIL_THRESHOLD = 3;
/** 退避时长 */
const COOLDOWN_MS = 60_000;

/**
 * 能调到 Jev 的两家。请求体三个字段（model / state / questions）和答案结构两家一样，
 * 差别只在路径、模型名前缀、key 和响应里多不多一个 usage.cost。
 *
 *   typesafe    原生接口 POST /v1/systemone，key 在 typesafe.ai 控制台申请（early access）。
 *   openrouter  OpenRouter 的 decisions 路由 POST /api/alpha/decisions（还是 alpha，
 *               路径和它家 /api/v1 的 OpenAI 兼容接口不是一回事）。模型名带 typesafe/ 前缀，
 *               key 是 OpenRouter 自己的，按用量从余额里扣，响应里带 cost。
 */
export const JEV_PROVIDERS = Object.freeze({
  typesafe: {
    label: 'TypeSafe',
    url: 'https://api.typesafe.ai/v1/systemone',
    model: 'jev-latest',
    keyEnv: 'TYPESAFE_API_KEY',
  },
  openrouter: {
    label: 'OpenRouter',
    url: 'https://openrouter.ai/api/alpha/decisions',
    // 锁 1.13：alias 一漂移，题库跑分就没法和上一次比
    model: 'typesafe/jev-1.13',
    keyEnv: 'OPENROUTER_API_KEY',
    // OpenRouter 建议带上，用来在它的排行里标识应用；不带也能用
    headers: { 'HTTP-Referer': 'https://github.com/Jinzhengxu/poker-table', 'X-Title': 'poker-table' },
  },
});
export const DEFAULT_MODEL = JEV_PROVIDERS.typesafe.model;

/**
 * 五档范围，和 bot/table.js#RANGE_BUCKETS 一一对应。
 *
 * 描述是给 Jev 读的 criteria。官方的第一条忠告是「它按字面理解，把每个选项的
 * 条件写清楚」，所以每档都写了具体的牌和典型的人，不只写"紧 / 松"。
 */
export const BUCKETS = Object.freeze([
  {
    key: 'top5', range: 0.05,
    text: 'Extremely tight: roughly the top 5% of starting hands, such as AA, KK, QQ, JJ, TT, ' +
      'AK and AQ suited. Typical of a very tight player who raises again on a late street, ' +
      'or a passive player who suddenly starts raising.',
  },
  {
    key: 'top15', range: 0.15,
    text: 'Tight: roughly the top 15% of starting hands. Big pairs, strong aces, suited broadway ' +
      'cards. A typical tight-aggressive player\'s raising range.',
  },
  {
    key: 'top35', range: 0.35,
    text: 'Medium: roughly the top 35% of starting hands. Any pair, any ace, suited connectors, ' +
      'broadway cards. An ordinary player\'s range for entering the pot.',
  },
  {
    key: 'top70', range: 0.7,
    text: 'Loose: roughly the top 70% of starting hands, everything except pure junk. A loose ' +
      'player who plays most hands, or a big blind that just calls to see a flop.',
  },
  {
    key: 'any', range: 1,
    text: 'Any two cards: nothing can be assumed about their hands. Use this when the opponent has ' +
      'only checked or called passively, plays almost every hand, or the action so far tells you nothing.',
  },
]);

/** 候选尺度：底池的几分之几。人格的 betSize 会再乘上去 */
const BET_FRACTIONS = [0.5, 0.75, 1.0];
/** 超过底池这么多倍的注不定价（同 plan_bet 的理由：弃牌率在超池尺度上系统性高估） */
const EV_MAX_POT_RATIO = 1.5;

// ---------------------------------------------------------------- 客户端

/**
 * Jev 的客户端，只有一个方法。自己拼 fetch，不引 SDK：
 * 请求体就是三个字段，SDK 那 200KB 换不来什么。
 */
export class JevClient {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey
   * @param {'typesafe'|'openrouter'} [opts.provider] 默认 typesafe
   * @param {string} [opts.url]       覆盖接入点（完整的 URL），走兼容网关时用
   * @param {string} [opts.model]     默认取供应商预设；要复现就锁版本
   * @param {number} [opts.timeoutMs] 默认 8000
   * @param {typeof fetch} [opts.fetch] 测试注入
   */
  constructor(opts = {}) {
    const name = String(opts.provider || 'typesafe').toLowerCase();
    const preset = JEV_PROVIDERS[name];
    if (!preset) throw new Error(`未知的 Jev 供应商: ${name}`);
    if (!opts.apiKey) throw new Error(`${preset.label} 缺少 API key（${preset.keyEnv}）`);
    this.provider = name;
    this.label = preset.label;
    this.apiKey = opts.apiKey;
    this.url = String(opts.url || preset.url);
    this.model = opts.model || preset.model;
    this.headers = { ...(preset.headers || {}) };
    this.timeoutMs = Math.max(500, Number(opts.timeoutMs) || 8000);
    this.fetch = opts.fetch || globalThis.fetch;
  }

  /**
   * 问一次。TypeSafe 叫 systemone，OpenRouter 叫 decisions，形状一样。
   *
   * @param {object} args
   * @param {object|string} args.state
   * @param {object} args.questions  {id: {type, instructions, criteria}}
   * @param {AbortSignal} [args.signal]
   * @returns {Promise<{model:string, answers:object,
   *           usage:{input_tokens?:number, output_tokens?:number, cost?:number}}>}
   * @throws {ProviderError} 分类同 LLMClient：timeout / network / http / format
   */
  async systemOne({ state, questions, signal }) {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const composed = signal ? AbortSignal.any([timeout, signal]) : timeout;

    let res;
    try {
      res = await this.fetch(this.url, {
        method: 'POST',
        headers: {
          ...this.headers,
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.model, state, questions }),
        signal: composed,
      });
    } catch (e) {
      if (signal?.aborted) throw e;                      // 外部取消，原样往上抛
      if (timeout.aborted) throw new ProviderError(`Jev 请求超时（${this.timeoutMs}ms）`, 'timeout');
      throw new ProviderError(`Jev 网络错误：${e.message}`, 'network');
    }

    const text = await res.text();
    if (!res.ok) {
      throw new ProviderError(`Jev HTTP ${res.status}：${text.slice(0, 200)}`, 'http', res.status);
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ProviderError('Jev 返回的不是 JSON', 'format');
    }
    const answers = json?.answers;
    if (!answers || typeof answers !== 'object') {
      throw new ProviderError('Jev 返回体里没有 answers', 'format');
    }
    // 官方说它「数学上不可能」答出不在选项里的东西。信，但仍然验：
    // 网关、版本漂移、或者我们自己拼错了题，都会从这里暴露出来。
    for (const [id, q] of Object.entries(questions)) {
      const a = answers[id];
      if (!a || a.type !== q.type) throw new ProviderError(`Jev 没有回答 ${id}（或类型不对）`, 'format');
      if (q.type === 'choice' && !Object.hasOwn(q.criteria, a.choice)) {
        throw new ProviderError(`Jev 的 ${id} 选了不存在的选项 ${a.choice}`, 'format');
      }
      if (q.type === 'noul' && !Number.isFinite(Number(a.noul))) {
        throw new ProviderError(`Jev 的 ${id} 没有 noul 概率`, 'format');
      }
    }
    return { model: json.model || this.model, answers, usage: json.usage || {} };
  }
}

/**
 * 从环境变量装配客户端。
 *
 *   POKER_JEV_PROVIDER   typesafe | openrouter | auto（默认 auto：哪家有 key 用哪家，TypeSafe 优先）
 *   TYPESAFE_API_KEY / OPENROUTER_API_KEY   各家自己的 key
 *   POKER_JEV_API_KEY    指定了供应商时可以用它代替上面那个
 *   POKER_JEV_URL / POKER_JEV_MODEL / POKER_JEV_TIMEOUT_MS
 *
 * @returns {JevClient|null} 没配 key（或供应商名写错）就是 null
 */
export function jevFromEnv(env = process.env) {
  const want = String(env.POKER_JEV_PROVIDER || 'auto').toLowerCase();
  const names = want === 'auto' ? Object.keys(JEV_PROVIDERS) : [want];
  for (const name of names) {
    const preset = JEV_PROVIDERS[name];
    if (!preset) {
      console.error(`[jev] 未知的 POKER_JEV_PROVIDER: ${name}（只认 ${Object.keys(JEV_PROVIDERS).join(' / ')}）`);
      return null;
    }
    const apiKey = env[preset.keyEnv] || (want !== 'auto' ? env.POKER_JEV_API_KEY : '');
    if (!apiKey) continue;
    return new JevClient({
      provider: name,
      apiKey,
      url: env.POKER_JEV_URL || undefined,
      model: env.POKER_JEV_MODEL || undefined,
      timeoutMs: Number(env.POKER_JEV_TIMEOUT_MS) || undefined,
    });
  }
  return null;
}

// ---------------------------------------------------------------- state 与题目

const POS_EN = {
  '按钮/小盲': 'button (also small blind, heads-up)',
  '大盲': 'big blind',
  '按钮': 'button',
  '小盲': 'small blind',
  '前位': 'early position (first to act preflop)',
  '关煞位': 'cutoff',
  '劫位': 'hijack',
  '中位': 'middle position',
};

const VERB_EN = { bet: 'bets', raise: 'raises to', allin: 'goes all-in for' };

/**
 * 给 Jev 看的 state。**没有自己的底牌，没有聊天记录。**
 *
 * 结构化 JSON 而不是一段散文：官方建议 state 只放题目用得上的字段，键名直接被
 * 题目用反引号引用。行动序列写成英文短句，call 统一换算成「跟到多少」
 * （理由同 decide.js#buildUser：引擎里 call 的 amount 是增量，混排会误导）。
 *
 * @param {object} state  Room#buildStateFor(botPlayerId) 的脱敏快照
 * @param {object} [opts]
 * @param {object[]} [opts.profiles] collectProfiles 的输出
 */
export function buildJevState(state, opts = {}) {
  const { table, seats, you, config } = state;
  const mySeat = you.seat;
  const me = seats[mySeat];

  const inHand = seats
    .filter((s) => s && ['in', 'folded', 'allin'].includes(s.state))
    .map((s) => s.seat);
  const posOf = (seat) => {
    const cn = positionName(seat, inHand, table.buttonSeat);
    return POS_EN[cn] || cn || 'unknown';
  };
  const nameOf = (seat) => {
    const s = seats[seat];
    return s ? sanitizeName(s.name) : `seat ${seat + 1}`;
  };
  const who = (seat) => `${nameOf(seat)} (${seat === mySeat ? 'hero' : posOf(seat)})`;

  const opponents = [];
  for (const s of seats) {
    if (!s || s.seat === mySeat) continue;
    if (!['in', 'folded', 'allin'].includes(s.state)) continue;
    opponents.push({
      name: sanitizeName(s.name),
      position: posOf(s.seat),
      chips_behind: s.chips,
      committed_this_street: s.committedRound,
      status: s.state === 'in' ? 'still in the hand' : s.state === 'allin' ? 'all-in' : 'folded',
    });
  }

  const history = [];
  for (const st of Array.isArray(table.history) ? table.history : []) {
    let level = st.street === 'preflop' ? (config?.bigBlind || 0) : 0;
    const acts = [];
    for (const a of st.acts || []) {
      if (a.type === 'fold') acts.push(`${who(a.seat)} folds`);
      else if (a.type === 'check') acts.push(`${who(a.seat)} checks`);
      else if (a.type === 'call') acts.push(`${who(a.seat)} calls ${level}`);
      else {
        level = Math.max(level, Number(a.amount) || 0);
        acts.push(`${who(a.seat)} ${VERB_EN[a.type] || a.type} ${a.amount}`);
      }
    }
    history.push({ street: st.street, actions: acts });
  }

  const profiles = (Array.isArray(opts.profiles) ? opts.profiles : []).map((p) => ({
    name: sanitizeName(p.name),
    hands_observed: p.hands,
    vpip_pct: p.vpip,
    preflop_raise_pct: p.pfr,
    postflop_aggression_factor: p.af,
    fold_to_bet_pct: p.foldToBet,
    position_this_hand: p.here || null,
    stats_in_this_position: p.hereStats
      ? { hands: p.hereStats.hands, vpip_pct: p.hereStats.vpip, preflop_raise_pct: p.hereStats.pfr }
      : null,
    recent_showdowns: (Array.isArray(p.shown) ? p.shown : []).map((s) => ({
      hand: s.hand,
      result: s.won ? 'won' : 'lost',
      hand_name: s.handName || null,
      was_aggressor_on: s.wasAggressor || null,
    })),
    // LLM 在手牌之间写的一句读人笔记（notes.js）。没有就不带这个键：无关内容拉低准确率
    ...(typeof opts.notes === 'function' && opts.notes(p.name) ? { coach_note: opts.notes(p.name) } : {}),
  }));

  return {
    game: "No-limit Texas Hold'em, a friendly home game",
    blinds: { small: config?.smallBlind ?? null, big: config?.bigBlind ?? null },
    street: table.phase,
    board: Array.isArray(table.board) && table.board.length ? table.board.join(' ') : 'no community cards yet',
    pot: table.totalPot,
    hero: {
      name: me ? sanitizeName(me.name) : 'hero',
      position: posOf(mySeat),
      chips_behind: me ? me.chips : 0,
      committed_this_street: me ? me.committedRound : 0,
    },
    opponents,
    action_this_hand: history,
    opponent_profiles: profiles.length
      ? profiles
      : 'no reliable statistics on these opponents yet (too few hands observed)',
  };
}

/**
 * 候选尺度。bet 是底池的几分之几；raise 是「跟到当前注 + 跟完之后底池的几分之几」。
 * 夹进引擎允许的区间，去重。人格的 betSize 乘在比例上。
 *
 * @returns {{to:number, fraction:number, isRaise:boolean}[]} 下不了注就是空数组
 */
export function planCandidates(state, traits) {
  const legal = state?.you?.legal;
  if (!legal || (!legal.canBet && !legal.canRaise)) return [];
  const pot = Number(state.table?.totalPot) || 0;
  const me = state.seats?.[state.you.seat];
  const myCommitted = Number(me?.committedRound) || 0;
  const call = legal.canCall ? Number(legal.callAmount) || 0 : 0;
  const isRaise = !!legal.canRaise;
  const min = isRaise ? legal.minRaiseTo : legal.minBet;
  const max = legal.maxRaiseTo;
  if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) return [];

  const bias = traitBias(traits);
  const out = [];
  for (const f of BET_FRACTIONS) {
    const scaled = f * bias.betSize;
    const want = isRaise
      ? myCommitted + call + Math.round(scaled * (pot + call))
      : Math.round(scaled * pot);
    const to = Math.max(min, Math.min(max, want));
    if (!out.some((c) => c.to === to)) out.push({ to, fraction: f, isRaise });
  }
  return out;
}

/**
 * 题目。一道 choice 问范围，每个候选尺度一道 noul 问弃牌率；开了 strength 再加一道
 * noul 问「他续注的牌强不强」。全部并行算，多问几道几乎不加延迟（官方叫 speculative fan-out）。
 *
 * @param {object} state
 * @param {ReturnType<typeof planCandidates>} candidates
 * @param {object} [opts]
 * @param {boolean} [opts.strength] 加 continue_strength 那道题
 */
export function buildJevQuestions(state, candidates, opts = {}) {
  const pot = Number(state.table?.totalPot) || 0;
  const me = state.seats?.[state.you.seat];
  const myCommitted = Number(me?.committedRound) || 0;

  const criteria = {};
  for (const b of BUCKETS) criteria[b.key] = b.text;

  const questions = {
    opponent_range: {
      type: 'choice',
      instructions:
        'Based on `action_this_hand` and `opponent_profiles`, how tight is the range of hands ' +
        'that the opponents who are still in the hand are likely holding right now? ' +
        'If more than one opponent remains, judge the one who has shown the most aggression in this hand. ' +
        'Weigh the betting so far, the street, and each player\'s profile. A single bet or raise ' +
        'does not by itself mean a player is tight; repeated aggression on later streets does.',
      criteria,
    },
  };

  candidates.forEach((c, i) => {
    const extra = Math.max(0, c.to - myCommitted);
    const pct = pot > 0 ? Math.round((extra / pot) * 100) : 0;
    questions[`fold_to_bet_${i}`] = {
      type: 'noul',
      instructions:
        `The hero now ${c.isRaise ? 'raises to' : 'bets'} ${c.to} chips into a pot of ${pot} chips ` +
        `(about ${pct}% of the pot). Will every opponent still in the hand fold? ` +
        'Judge from their actions in `action_this_hand`, the board, and their `opponent_profiles`.',
      criteria: {
        true: 'All remaining opponents fold and the hero wins the pot without a showdown.',
        false: 'At least one opponent calls or raises.',
      },
    };
  });

  // 「被跟时的胜率」是开火算术里最不可靠的数：起手牌序不认牌面，K 高面上下注的人
  // 续注范围是 Kx 起，不是「前 15% 里的前 65%」。这道题让模型直接判他续注的牌强不强，
  // 代码拿它在「按范围算的胜率」和「对最强一档的胜率」之间做混合。
  if (opts.strength && candidates.length) {
    const preflop = state.table?.phase === 'preflop';
    questions.continue_strength = {
      type: 'noul',
      instructions: preflop
        ? 'Suppose the hero raises now and an opponent calls or re-raises. Will that opponent be holding ' +
          'a premium hand: a pair of tens or better, or ace-king? Judge from `action_this_hand` and `opponent_profiles`.'
        : 'Suppose the hero bets or raises now and an opponent calls or re-raises. On the current `board`, will that ' +
          'opponent be holding a hand stronger than one pair, such as two pair, trips, a straight or a flush? ' +
          'Judge from `action_this_hand`, the board texture, and `opponent_profiles`.',
      criteria: {
        true: preflop
          ? 'The opponent who continues holds TT+ or AK.'
          : 'The opponent who continues holds two pair or better.',
        false: preflop
          ? 'The opponent who continues holds a weaker hand: a small pair, a suited connector, a broadway hand without an ace-king.'
          : 'The opponent who continues holds one pair, a draw, or nothing.',
      },
    };
  }

  return questions;
}

// ---------------------------------------------------------------- 驱动

export class JevDriver {
  /**
   * @param {object} [opts]
   * @param {JevClient} [opts.client]     不传则从环境变量装配；没 key 就全走兜底
   * @param {object} [opts.fallback]      兜底驱动（BotDriver 或 PokerAgent），不传就造一个 BotDriver
   * @param {OpponentMemory} [opts.memory]
   * @param {boolean} [opts.obvious]      明显局面不问模型（默认跟 fallback 一致）
   * @param {number} [opts.minConfidence] opponent_range 的 confidence 低于它就交给兜底。默认 0 = 不分流
   * @param {number} [opts.minThinkMs]    默认 900
   * @param {number} [opts.maxThinkMs]    整次决策的墙钟，默认 10000（Jev 本身几百毫秒）
   * @param {object} [opts.logger]
   */
  constructor(opts = {}) {
    const env = opts.env || process.env;
    this.client = opts.client === undefined ? jevFromEnv(env) : opts.client;
    this.fallback = opts.fallback || new BotDriver(opts);
    this.memory = opts.memory || new OpponentMemory();
    this.logger = opts.logger || console;

    this.obvious = opts.obvious !== undefined ? !!opts.obvious : this.fallback.obvious !== false;
    this.minConfidence = Math.max(0, Math.min(1,
      Number(opts.minConfidence ?? env.POKER_JEV_MIN_CONFIDENCE) || 0));

    // 开火算术的两个候选修正（题库消融用，见 #resolve）：
    //   raiseTighter  面对下注加注时，续注范围按比读数更紧一档算
    //   strength      多问一道「他续注的牌强不强」，用来压被跟时的胜率
    this.raiseTighter = onOff(opts.raiseTighter, env.POKER_JEV_RAISE_TIGHTER, true);
    this.strength = onOff(opts.strength, env.POKER_JEV_STRENGTH, true);

    // 回传条件：范围读数的最高概率低于 minTopProb，而且按第二可能的那一档算出来的
    // 动作**不一样** —— 也就是「读数拿不准，而且读错了结论会变」。两条都满足才算脆弱。
    // 只拿不准但两档结论一样的，Jev 的答案不依赖那次读数，没必要花 DeepSeek 的钱。
    // escalate 关着时只标记不回传（题库拿它算「该回传的那部分错得多不多」）。
    this.minTopProb = Math.max(0, Math.min(1, Number(opts.minTopProb ?? env.POKER_JEV_MIN_TOP_PROB) || 0.5));
    this.escalate = onOff(opts.escalate, env.POKER_JEV_ESCALATE, false);

    // 交给语言模型的两件事（都不在决策路径上，都要有 LLM 才生效）
    this.talkOn = onOff(opts.talk, env.POKER_JEV_TALK, true);
    this.talkTimeoutMs = Math.max(1000, Number(opts.talkTimeoutMs ?? env.POKER_JEV_TALK_MS) || 8000);
    this.talkRand = typeof opts.talkRand === 'function' ? opts.talkRand : Math.random;
    this.notesOn = onOff(opts.notes, env.POKER_JEV_NOTES, true);
    this.notes = new OpponentNotes({
      clients: () => this.#llmClients(),
      memory: this.memory,
      everyHands: opts.notesEveryHands ?? env.POKER_JEV_NOTES_EVERY,
      timeoutMs: opts.notesTimeoutMs,
      logger: this.logger,
    });
    this.minThinkMs = Math.max(0, Number(opts.minThinkMs ?? 900));
    this.maxThinkMs = Math.max(1000, Number(opts.maxThinkMs ?? env.POKER_JEV_MAX_MS ?? 10_000));

    this.equitySims = Math.max(0, Number(opts.equitySims ?? env.POKER_BOT_EQUITY_SIMS ?? 20000));
    this.equityMs = Math.max(1, Number(opts.equityMs ?? env.POKER_AGENT_EQUITY_MS ?? 1200));
    this.equityChunkMs = Math.max(1, Number(opts.equityChunkMs ?? env.POKER_BOT_EQUITY_CHUNK_MS ?? 8));

    this.health = { fails: 0, until: 0 };
    this.stats = {
      jev: 0,          // Jev 答了、动作由代码算出来的次数
      obvious: 0,      // 明显局面，没问模型
      fallback: 0,     // 退回兜底的次数（含 escalated）
      escalated: 0,    // 其中因为 confidence 不够 / 读数脆弱而交给兜底的
      fragile: 0,      // 读数脆弱的次数（不管有没有回传）
      errors: 0,
      canceled: 0,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,         // 美元。只有 OpenRouter 的响应带这个数；TypeSafe 直连时一直是 0
      latencyMs: 0,    // Jev 往返的累计毫秒，除以 calls 就是均值
      talked: 0,       // 异步闲聊真的说出口的次数
    };
  }

  /** 兜底链上第一份 LLM 客户端列表（BotDriver.clients）。闲聊和笔记用它 */
  #llmClients() {
    let d = this.fallback;
    for (let i = 0; d && i < 4; i++) {
      if (Array.isArray(d.clients) && d.clients.length) return d.clients;
      d = d.fallback;
    }
    return [];
  }

  get hasLLM() {
    return !!this.client || this.fallback.hasLLM;
  }

  describe() {
    if (!this.client) return `${this.fallback.describe()}（Jev 未配置）`;
    const llm = this.#llmClients().length > 0;
    const jobs = [this.talkOn && llm ? '闲聊' : '', this.notesOn && llm ? '读人笔记' : ''].filter(Boolean);
    return `Jev × ${this.client.label}(${this.client.model})` +
      `${this.raiseTighter ? '' : '，加注不收紧'}${this.strength ? '' : '，不问续注强度'}` +
      `${this.escalate ? `，读数脆弱（最高概率 < ${this.minTopProb}）交给兜底` : ''}` +
      `${this.minConfidence > 0 ? `，confidence < ${this.minConfidence} 交给兜底` : ''}` +
      `${this.obvious ? '，明显局面不问模型' : ''}` +
      `${jobs.length ? `，${jobs.join('和')}交给大模型` : '，没配大模型所以不说话'}` +
      `；兜底：${this.fallback.describe()}`;
  }

  /**
   * 运行时配置。patch.jev 为真时配的是 Jev 自己（供应商 / key / 模型，remove 停用），
   * 否则原样转给兜底链（房主在面板上配的大模型）。
   *
   * **安全**：apiKey 只存在进程内存里，绝不进任何下发给客户端的快照。
   *
   * @returns {{ok:true}|{ok:false,msg:string}}
   */
  configure(patch) {
    if (patch && patch.jev) return this.#configureJev(patch);
    if (typeof this.fallback.configure !== 'function') return { ok: false, msg: '兜底驱动不支持配置' };
    return this.fallback.configure(patch);
  }

  #configureJev(patch) {
    if (patch.remove) {
      this.client = null;
      this.health = { fails: 0, until: 0 };
      return { ok: true };
    }
    const provider = String(patch.provider || this.client?.provider || 'openrouter').toLowerCase();
    const preset = JEV_PROVIDERS[provider];
    if (!preset) return { ok: false, msg: '不支持的 Jev 供应商' };

    let apiKey = typeof patch.apiKey === 'string' ? patch.apiKey.trim() : '';
    // 没给新 key：沿用这一家已有的；再没有就借同一家大模型的（OpenRouter 一把 key 两用）
    if (!apiKey && this.client?.provider === provider) apiKey = this.client.apiKey;
    if (!apiKey) apiKey = this.#llmClients().find((c) => c.provider === provider)?.apiKey || '';
    if (!apiKey) return { ok: false, msg: `缺少 ${preset.label} 的 API key` };

    try {
      this.client = new JevClient({
        provider,
        apiKey,
        model: patch.model ? String(patch.model).trim() : undefined,
        url: patch.url ? String(patch.url).trim() : undefined,
        timeoutMs: this.client?.timeoutMs,
      });
    } catch (e) {
      return { ok: false, msg: e.message || '配置无效' };
    }
    this.health = { fails: 0, until: 0 };
    return { ok: true };
  }

  removeProvider(provider) {
    if (typeof this.fallback.removeProvider === 'function') return this.fallback.removeProvider(provider);
    return { ok: false };
  }

  /**
   * 动作落地之后的闲聊。**异步、可有可无**：房间拿到动作先出手，这句话晚几秒进聊天区。
   * 只在 Jev（或明显局面）答的那些决策上问 —— 兜底链答的自带 say，不重复问。
   * 不说话的情况一律返回 null，绝不抛。
   *
   * @param {object} state   决策时那份脱敏快照
   * @param {object} persona
   * @param {object} out     decide() 的返回值
   * @returns {Promise<string|null>}
   */
  async talk(state, persona, out) {
    if (!this.talkOn || !state || !out || out.say) return null;
    if (out.source !== 'jev' && out.source !== 'obvious') return null;
    const client = this.#llmClients()[0];
    if (!client) return null;
    if (!shouldTalk(persona, out.action, this.talkRand)) return null;
    const text = await askForSay({
      client, state, persona, action: out.action,
      signal: AbortSignal.timeout(this.talkTimeoutMs), logger: this.logger,
    });
    if (text) this.stats.talked++;
    return text;
  }

  /** 可以安全下发给客户端的状态。**不含 apiKey**，key 只给打码后的头 3 位尾 4 位。 */
  status() {
    const base = typeof this.fallback.status === 'function'
      ? this.fallback.status()
      : { hasLLM: false, providers: [] };
    const llm = this.#llmClients().length > 0;
    return {
      ...base,
      hasLLM: !!base.hasLLM || !!this.client,
      jev: {
        enabled: !!this.client,
        provider: this.client?.provider || null,
        label: this.client?.label || null,
        model: this.client?.model || null,
        maskedKey: this.client ? maskKey(this.client.apiKey) : null,
        cooling: this.health.until > Date.now(),
        minConfidence: this.minConfidence,
        raiseTighter: this.raiseTighter,
        strength: this.strength,
        escalate: this.escalate,
        minTopProb: this.minTopProb,
        talk: this.talkOn && llm,
        notes: this.notesOn && llm,
        obvious: this.obvious,
        memory: this.memory.size,
        stats: { ...this.stats, notes: { ...this.notes.stats, kept: this.notes.notes.size } },
      },
    };
  }

  observe(state) {
    try {
      this.memory.observe(state);
    } catch (e) {
      this.logger.error(`[jev] 记忆吸收失败：${e.message}`);
    }
    if (typeof this.fallback.observe === 'function' && this.fallback.memory !== this.memory) {
      this.fallback.observe(state);
    }
    // 读人笔记只在**手牌结束**那次 observe 上写（房间用旁观者视角调，快照里没有 you.legal）；
    // decide() 开头那次 observe 是正在决策，不写。后台跑，不等。
    if (this.notesOn && !state?.you?.legal) {
      try {
        this.notes.onHandEnd(state);
      } catch (e) {
        this.logger.error(`[jev] 读人笔记调度失败：${e.message}`);
      }
    }
  }

  forget(name) {
    try {
      this.memory.forget(name);
      this.notes.forget(name);
    } catch (e) {
      this.logger.error(`[jev] 清理画像失败：${e.message}`);
    }
    if (typeof this.fallback.forget === 'function') this.fallback.forget(name);
  }

  #usable() {
    if (!this.client) return false;
    return this.health.until <= Date.now();
  }

  #onSuccess() {
    this.health.fails = 0;
    this.health.until = 0;
  }

  #onFailure(err) {
    // 不可重试的错误（401 / 422 这类）直接进冷却，别硬撞
    this.health.fails = isRetryable(err) ? this.health.fails + 1 : FAIL_THRESHOLD;
    if (this.health.fails >= FAIL_THRESHOLD) {
      this.health.until = Date.now() + COOLDOWN_MS;
      this.health.fails = 0;
      this.logger.error(`[jev] 连续失败，这路冷却 ${COOLDOWN_MS / 1000}s：${err.message}`);
    }
  }

  /**
   * 做一次决策。**不会抛异常。**
   *
   * @param {object} state    Room#buildStateFor(botPlayerId)，必须是脱敏快照
   * @param {object} persona
   * @param {AbortSignal} [signal]
   * @returns {Promise<{action:object, say:null, source:string, note:string|null,
   *           trace:object[], confidence?:number, why?:string}>}
   */
  async decide(state, persona, signal) {
    const started = Date.now();
    this.observe(state);

    if (!this.#usable() || !state?.you?.legal) {
      return this.#viaFallback(state, persona, signal, started);
    }

    const timeout = AbortSignal.timeout(this.maxThinkMs);
    const composed = signal ? AbortSignal.any([timeout, signal]) : timeout;

    // 五档表先算：明显局面靠它判，Jev 选完档也从它读数
    let rows = null;
    if (this.equitySims > 0) {
      try {
        rows = await equityTable({
          state, sims: this.equitySims, budgetMs: this.equityMs, chunkMs: this.equityChunkMs, signal: composed,
        });
      } catch (e) {
        this.logger.error(`[jev] 胜率表算失败：${e.message}`);
        rows = null;
      }
    }
    if (!rows || !rows.length) {
      // 没底牌 / 没对手 / 被取消：这条路没法算，交给兜底
      return this.#viaFallback(state, persona, signal, started);
    }

    if (this.obvious && !signal?.aborted) {
      const ob = classifyObvious({ state, rows, traits: persona?.traits });
      if (ob) {
        this.stats.obvious++;
        await this.#pace(started, signal);
        return { action: ob.action, say: null, source: 'obvious', note: null, why: ob.why, trace: [] };
      }
    }

    const trace = [];
    const candidates = planCandidates(state, persona?.traits);
    const jevState = buildJevState(state, {
      profiles: collectProfiles(state, this.memory),
      notes: (name) => this.notes.get(name),
    });
    const questions = buildJevQuestions(state, candidates, { strength: this.strength });

    let res;
    const t0 = Date.now();
    try {
      res = await this.client.systemOne({ state: jevState, questions, signal: composed });
      this.#onSuccess();
    } catch (err) {
      if (signal?.aborted) {
        this.stats.canceled++;
        return { action: fallbackAction(state, persona?.traits, null), say: null, source: 'canceled', note: null, trace };
      }
      this.stats.errors++;
      this.#onFailure(err);
      this.logger.error(`[jev] ${persona?.name || '人机'} 调用失败，退回兜底：${err.message}`);
      return this.#viaFallback(state, persona, signal, started);
    }
    const ms = Date.now() - t0;
    this.stats.calls++;
    this.stats.latencyMs += ms;
    this.stats.inputTokens += Number(res.usage?.input_tokens) || 0;
    this.stats.outputTokens += Number(res.usage?.output_tokens) || 0;
    this.stats.cost += Number(res.usage?.cost) || 0;
    trace.push({
      tool: 'jev', ms, model: res.model, provider: this.client.provider,
      inputTokens: Number(res.usage?.input_tokens) || 0,
      outputTokens: Number(res.usage?.output_tokens) || 0,
      cost: Number(res.usage?.cost) || 0,
    });

    const read = res.answers.opponent_range;
    const bucket = BUCKETS.find((b) => b.key === read.choice) || BUCKETS[BUCKETS.length - 1];
    const confidence = Number.isFinite(Number(read.confidence)) ? Number(read.confidence) : null;
    // 题库的成对题靠这一条判「范围方向对不对」
    trace.push({ tool: 'read_range', range: bucket.range, confidence, probabilities: read.probabilities || null });

    if (this.minConfidence > 0 && (confidence === null || confidence < this.minConfidence)) {
      this.stats.escalated++;
      this.logger.error(`[jev] ${persona?.name || '人机'} 范围判断 confidence ${confidence} 低于 ${this.minConfidence}，交给兜底`);
      const out = await this.#viaFallback(state, persona, signal, started);
      return { ...out, trace: [...trace, ...(out.trace || [])], confidence, escalated: true };
    }

    const folds = candidates.map((_, i) => Number(res.answers[`fold_to_bet_${i}`]?.noul));
    const strongRaw = Number(res.answers.continue_strength?.noul);
    const pStrong = this.strength && Number.isFinite(strongRaw) ? Math.max(0, Math.min(1, strongRaw)) : null;
    const args = { state, persona, rows, candidates, folds, pStrong, signal: composed };

    let decision;
    try {
      decision = await this.#resolve({ ...args, bucket, trace });
    } catch (e) {
      this.logger.error(`[jev] ${persona?.name || '人机'} 算动作失败，退回兜底：${e.message}`);
      return this.#viaFallback(state, persona, signal, started);
    }

    // 脆弱度：读数拿不准（最高概率低于门槛）且按第二可能的那档算出的动作不同。
    // 这是「Jev 不行、该回传 DeepSeek」的判据 —— 不是 confidence：题库实测 confidence
    // 在答对答错之间分不开，因为错的那些是读数下游的算术，读数本身没错。
    let fragile = false;
    const probs = read.probabilities && typeof read.probabilities === 'object' ? read.probabilities : null;
    let topProb = null;
    if (probs) {
      const ranked = BUCKETS
        .map((b) => ({ b, p: Number(probs[b.key]) || 0 }))
        .sort((x, y) => y.p - x.p);
      topProb = ranked[0].p;
      const runnerUp = ranked[1];
      if (topProb < this.minTopProb && runnerUp && runnerUp.p > 0 && runnerUp.b.key !== bucket.key) {
        let alt = null;
        try {
          alt = await this.#resolve({ ...args, bucket: runnerUp.b, trace: [] });
        } catch {
          alt = null;
        }
        fragile = !!alt && alt.action.type !== decision.action.type;
        trace.push({
          tool: 'fragility', topProb, runnerUp: runnerUp.b.range, runnerUpProb: runnerUp.p,
          action: decision.action.type, altAction: alt?.action?.type || null, fragile,
        });
      }
    }
    if (fragile) {
      this.stats.fragile++;
      if (this.escalate) {
        this.stats.escalated++;
        this.logger.error(`[jev] ${persona?.name || '人机'} 读数脆弱（最高概率 ${topProb}，换一档结论会变），交给兜底`);
        const out = await this.#viaFallback(state, persona, signal, started);
        // 把 Jev 本来会打的动作一起带回去：题库靠它比「回传之后是谁对」，
        // 线上只进日志。**不影响动作**。
        return {
          ...out, trace: [...trace, ...(out.trace || [])], confidence, topProb, fragile: true, escalated: true,
          jevWould: decision.action, jevWhy: decision.why,
        };
      }
    }

    this.stats.jev++;
    await this.#pace(started, signal);
    return {
      action: decision.action, say: null, source: 'jev', note: null, why: decision.why,
      trace, confidence, topProb, fragile,
    };
  }

  /**
   * 用 Jev 的两个判断把动作算出来。全是算术，没有模型。
   *
   * 跟注：胜率（按选中那档读表）对底池赔率，人格偏移 callThreshold。
   * 开火：每个候选尺度算「比不开火多赚多少」，取最大的那个；超过人格给的余量才开。
   *   EV(bet) = P(弃) × 底池 + (1 − P(弃)) × (被跟时的胜率 × 被跟后的底池 − 本注真正多掏的钱)
   *   被跟时的胜率按「他续注的范围」算：当前范围 × (1 − P(弃))。
   *   基线：能过牌就是 过牌 EV = 胜率 × 底池；面对下注就是 跟注 EV（划算才跟，否则 0）。
   *
   * 两个可开关的修正（默认都开，题库上量过，见 CHANGELOG）：
   *   raiseTighter  面对下注加注时，续注范围的基数取比读数更紧一档。下过注的人的范围
   *                 本来就比他翻牌前的档位强，再被加注还留下的更是；起手牌序看不见牌面，
   *                 这一档就是替它看的。
   *   strength      Jev 多答一道「他续注的牌是否强于一对」，概率 p。被跟时的胜率取
   *                 (1 − p) × 按范围算的 + p × 对最强一档的胜率。牌够大（顺子、暗三）
   *                 对最强一档也高，不受影响；中对、二对面对强续注就被压下去了。
   *
   * 两处和 plan_bet 不同，都是往保守的方向：
   *   - 被跟时的胜率按**所有还在牌里的对手**算，不是 1 个。noul 问的是「会不会全弃」，
   *     没全弃就可能不止一个人跟；多人底池按 1 个人算，拿着中对也会算出该加注
   *     （假服务器跑题库时 trap-multiway-fold 就是这么错的）。单挑时两者一样。
   *   - 续注范围比当前范围紧，胜率只会更低不会更高：eqCalled 封在 eqNow 以下。
   *     两次蒙特卡洛各有 ±0.7 的噪声，加上起手牌序在具体牌面上的怪癖，
   *     偶尔会算出「他范围收紧了我反而胜率更高」，那是噪声不是信号。
   * 开火的余量基线是底池的 5%：弃牌率和被跟胜率都是估的，薄边不值得开。
   */
  async #resolve({ state, persona, rows, bucket, candidates, folds, pStrong, trace, signal }) {
    const traits = persona?.traits;
    const bias = traitBias(traits);
    const legal = state.you.legal;
    const seats = state.seats;
    const mySeat = state.you.seat;
    const me = seats[mySeat];
    const myCommitted = Number(me?.committedRound) || 0;
    const pot = Number(state.table?.totalPot) || 0;

    const row = rows.find((r) => r.range === bucket.range) || rows[rows.length - 1];
    const eqNow = row.pct / 100;
    const opponents = Math.max(1, Number(row.opponents) || 1);
    // 对最强一档的胜率：strength 混合用。表是从紧到松排的，保险起见还是按 range 找最小
    const strongRow = rows.reduce((a, b) => (b.range < a.range ? b : a), rows[0]);
    const eqStrong = strongRow.pct / 100;
    // 面对下注加注：续注范围的基数收紧一档（见上）
    const idx = BUCKETS.findIndex((b) => b.key === bucket.key);
    const raiseBase = this.raiseTighter && legal.canRaise && idx > 0 ? BUCKETS[idx - 1].range : bucket.range;

    // ---- 不开火时的最好动作，以及它的 EV（相对弃牌 = 0）
    let baseline = 0;
    let passive;
    let why;
    if (legal.canCheck) {
      baseline = eqNow * pot;
      passive = { type: 'check' };
      why = `读成${label(bucket)}，胜率 ${row.pct}%`;
    } else if (legal.canCall) {
      const call = Number(legal.callAmount) || 0;
      const potOdds = call > 0 ? call / (pot + call) : 0;
      const need = potOdds + (legal.isAllInCall ? 0.15 : 0) + bias.callThreshold;
      if (eqNow >= need) {
        baseline = eqNow * (pot + call) - call;
        passive = { type: 'call' };
        why = `读成${label(bucket)}，胜率 ${row.pct}% ≥ 需要的 ${Math.round(need * 100)}%，跟`;
      } else {
        passive = legal.canFold ? { type: 'fold' } : { type: 'check' };
        why = `读成${label(bucket)}，胜率 ${row.pct}% < 需要的 ${Math.round(need * 100)}%，弃`;
      }
    } else {
      passive = legal.canFold ? { type: 'fold' } : { type: 'check' };
      why = `读成${label(bucket)}，胜率 ${row.pct}%`;
    }

    // ---- 开火：只有还有人能弃牌时才有意义
    let caller = null;
    for (const s of Array.isArray(seats) ? seats : []) {
      if (!s || s.seat === mySeat || s.state !== 'in') continue;
      if (!caller || (Number(s.committedRound) || 0) > (Number(caller.committedRound) || 0)) caller = s;
    }
    if (!caller || !candidates.length) return { action: passive, why };

    const callerCommitted = Number(caller.committedRound) || 0;
    const callerMax = callerCommitted + (Number(caller.chips) || 0);
    const hole = state.you.cards;
    const board = state.table?.board || [];
    const perBudget = Math.max(this.equityChunkMs, Math.floor(this.equityMs / Math.max(1, candidates.length)));

    let best = null;
    let pfFloor = 0;
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      // 官方提醒：不同题之间没有结构不变量可指望。这里自己保证「注越大弃得越多」，
      // 小尺度的弃牌率是大尺度的下界。
      let pf = Number.isFinite(folds[i]) ? Math.max(0, Math.min(1, folds[i])) : 0;
      pf = Math.max(pf, pfFloor);
      pfFloor = pf;

      // 他跟不满的那部分会退给我们，所以真正有风险的只到他能跟到的额度
      const toEff = Math.min(c.to, callerMax);
      const risk = Math.max(0, toEff - myCommitted);
      const callerAdds = Math.max(0, toEff - callerCommitted);
      const potWhenCalled = pot + risk + callerAdds;

      const cont = Math.max(0.02, Math.min(1, raiseBase * (1 - pf)));
      let eqCalled;
      try {
        const eq = await estimateEquityAsync({
          hole, board, opponents,
          opponentRange: cont >= 1 ? null : cont,
          sims: this.equitySims, budgetMs: perBudget, chunkMs: this.equityChunkMs, signal,
        });
        if (!eq) continue;
        eqCalled = Math.min(eq.pct / 100, eqNow);
      } catch {
        continue;
      }
      if (pStrong !== null && pStrong !== undefined) {
        // 强牌续注不可能让我们的胜率变高，所以那一项也封在 eqCalled 以下
        eqCalled = (1 - pStrong) * eqCalled + pStrong * Math.min(eqStrong, eqCalled);
      }

      const tooBig = pot > 0 && c.to > pot * EV_MAX_POT_RATIO;
      const evBet = pf * pot + (1 - pf) * (eqCalled * potWhenCalled - risk);
      const gain = evBet - baseline;
      trace.push({
        tool: 'plan_bet', amount: c.to, risk, foldProb: Math.round(pf * 100) / 100,
        continueRange: Math.round(cont * 100) / 100,
        raiseBase, pStrong: pStrong === null || pStrong === undefined ? null : Math.round(pStrong * 100) / 100,
        equityWhenCalled: Math.round(eqCalled * 100),
        ev: Math.round(evBet), evBaseline: Math.round(baseline), gain: Math.round(gain),
        priced: !tooBig,
      });
      // 超池的注不定价：弃牌率在那个尺度上系统性高估（同 plan_bet），只有最小的候选才保底
      if (tooBig && best) continue;
      if (!best || gain > best.gain) best = { to: c.to, gain, pf, eqCalled };
    }
    if (!best) return { action: passive, why };

    // 开火的余量：激进 / 爱诈唬的人格余量小甚至为负，被动 / 不诈唬的要多赚不少才开
    const margin = pot * Math.max(-0.05, Math.min(0.25, 0.05 + 0.5 * bias.raiseThreshold));
    if (best.gain > margin) {
      const allin = best.to >= legal.maxRaiseTo;
      const type = allin ? 'allin' : (legal.canRaise ? 'raise' : 'bet');
      const fire = `${type === 'allin' ? '全下' : type === 'raise' ? '加注到' : '下注'} ${best.to}：` +
        `估他弃 ${Math.round(best.pf * 100)}%` +
        `${pStrong !== null && pStrong !== undefined ? `、续注强牌 ${Math.round(pStrong * 100)}%` : ''}` +
        `，被跟时胜率 ${Math.round(best.eqCalled * 100)}%，` +
        `比${passive.type === 'check' ? '过牌' : passive.type === 'call' ? '跟注' : '弃牌'}多赚约 ${Math.round(best.gain)}`;
      return { action: allin ? { type } : { type, amount: best.to }, why: `${why}；${fire}` };
    }
    return { action: passive, why };
  }

  /** 退回兜底（BotDriver 或 PokerAgent），它自己保证一定返回合法动作 */
  async #viaFallback(state, persona, signal, started) {
    this.stats.fallback++;
    try {
      const out = await this.fallback.decide(state, persona, signal);
      return { ...out, source: `fallback:${out.source}` };
    } catch (e) {
      this.logger.error(`[jev] 兜底也失败了，用纯规则：${e.message}`);
      await this.#pace(started, signal);
      return { action: fallbackAction(state, persona?.traits, null), say: null, source: 'rule', note: null, trace: [] };
    }
  }

  async #pace(started, signal) {
    const elapsed = Date.now() - started;
    if (elapsed >= this.minThinkMs) return;
    await sleep(this.minThinkMs - elapsed, signal);
  }
}

function label(bucket) {
  return bucket.range >= 1 ? '任意两张' : `前 ${Math.round(bucket.range * 100)}%`;
}

/** 打码：头 3 位 + … + 尾 4 位，够房主确认粘对了，拼不回原文 */
function maskKey(key) {
  const k = String(key || '');
  if (k.length <= 8) return '****';
  return `${k.slice(0, 3)}…${k.slice(-4)}`;
}

/** 开关：opts 里给了就听 opts（布尔或 'on'/'off'），否则看环境变量，都没有用默认 */
function onOff(v, envV, dflt) {
  if (v !== undefined && v !== null) {
    if (typeof v === 'string') return v.toLowerCase() !== 'off' && v !== '0' && v !== 'false';
    return !!v;
  }
  if (envV !== undefined && envV !== null && String(envV) !== '') return String(envV).toLowerCase() !== 'off';
  return dflt;
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(t);
      signal?.removeEventListener?.('abort', done);
      resolve();
    }
  });
}

export default JevDriver;
