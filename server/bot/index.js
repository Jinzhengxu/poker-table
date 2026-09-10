// SPDX-License-Identifier: GPL-3.0-or-later
//
// 人机驱动：决定一次动作，优先问 LLM，问不到就用规则策略。
//
// 对外只暴露 BotDriver#decide()，它保证：
//   - 一定在 timeoutMs 内返回（内部超时 + 外部取消信号）；
//   - 返回的动作一定是当前局面下合法的（coerceAction 兜底）；
//   - 任何异常都不会抛给调用方，最差情况退化成规则人机。
// 也就是说：外部服务挂了，牌桌照常进行，只是人机变笨。

import { clientsFromEnv, isRetryable, LLMClient, PROVIDERS } from './provider.js';
import { buildSystem, buildUser, coerceAction, fallbackAction } from './decide.js';
import { estimateEquityAsync, countLiveOpponents } from './equity.js';
import { inferOpponentRange } from './range.js';

// 人格改成随机组合生成，见 persona.js。每个人机在加入时抽一次，
// 之后整个生命周期不变（所以它的打法是一致的，不会一手紧一手松）。
export { randomPersona, PERSONA_NAMES, PERSONA_DIMENSIONS } from './persona.js';

/** 一个供应商连续失败多少次后进入退避 */
const FAIL_THRESHOLD = 3;
/** 退避时长 */
const COOLDOWN_MS = 60_000;

export class BotDriver {
  /**
   * @param {object} [opts]
   * @param {import('./provider.js').LLMClient[]} [opts.clients] 不传则从环境变量装配
   * @param {number} [opts.timeoutMs] 单次请求超时；不给就读 POKER_BOT_TIMEOUT_MS，
   *                                  再没有就用各供应商自己的预设
   * @param {'on'|'off'} [opts.thinking] 关思维链；不给就读 POKER_BOT_THINKING
   * @param {number} [opts.minThinkMs] 最短"思考"时间，让人机不至于秒回，默认 900
   * @param {number} [opts.maxThinkMs] 最长等待，超过就用兜底，默认 9000
   * @param {number} [opts.maxTokens]  单轮回答的 token 上限，默认 1024（要装得下思维链）
   * @param {object} [opts.logger]
   */
  constructor(opts = {}) {
    const env = opts.env || process.env;

    this.clients = opts.clients || clientsFromEnv(env);
    this.minThinkMs = opts.minThinkMs ?? 900;
    this.maxThinkMs = opts.maxThinkMs ?? 9000;
    // 单轮回答的 token 上限。见 decide() 里那段：这个数要装得下「思维链 + 动作 JSON」。
    // 4096 是量出来的：deepseek-v4-flash 在题库那 20 个局面上，思维链用掉
    // 572 ~ 3372 个 token，而动作 JSON 本身只有二十来个。
    //
    // 这里【不能】用 ?? 兜底：环境变量传下来的是字符串，没设过的那个是 ''，
    // 而 '' 不是 nullish，Number('') === 0，于是 4096 会被悄悄压到下限 64——
    // 答案答一半被截断、解析失败、整手退回规则策略。用 || 才能把 '' 也接住。
    this.maxTokens = Math.max(64, Number(opts.maxTokens) || Number(env.POKER_BOT_MAX_TOKENS) || 4096);
    this.logger = opts.logger || console;

    // 胜率估算。分片计算，所以这里有两个不同性质的预算：
    //   equityChunkMs 单片占用事件循环的时间 —— 这个必须小，因为这段时间里
    //                 全桌都被冻结（Node 单线程）。8ms 感知不到。
    //   equityMs      总墙钟上限 —— 这个可以大方给。行动时限 45 秒，人机本来
    //                 还要等 LLM 一两秒，几百毫秒完全不影响体验。
    // 于是精度不必和流畅度做取舍：慢机器只是算得久一点，而不是被迫降精度。

    // 单次请求超时。这里必须自己留一份：configure()（房主在前端填 key）会新建
    // LLMClient，以前那行传的是压根不存在的 this.timeoutMs，于是前端配出来的
    // 后端永远拿 8 秒，POKER_BOT_TIMEOUT_MS 对它无效。不填就传 undefined，
    // 让供应商预设生效（银联云那种带思维链的默认 30 秒）。
    this.timeoutMs = Number(opts.timeoutMs ?? env.POKER_BOT_TIMEOUT_MS) || undefined;

    // 关思维链。同样要自己留一份，否则前端配出来的后端跟环境变量对不上。
    this.thinking = String(opts.thinking ?? env.POKER_BOT_THINKING ?? 'on').toLowerCase() === 'off'
      ? 'off' : 'on';

    this.equitySims = Math.max(0, Number(opts.equitySims ?? env.POKER_BOT_EQUITY_SIMS ?? 20000));
    this.equityMs = Math.max(1, Number(opts.equityMs ?? env.POKER_BOT_EQUITY_MS ?? 1500));
    this.equityChunkMs = Math.max(1, Number(opts.equityChunkMs ?? env.POKER_BOT_EQUITY_CHUNK_MS ?? 8));

    /** 每个客户端的健康状态：连续失败次数与冷却截止时间 */
    this.health = new Map();
    for (const c of this.clients) this.health.set(c, { fails: 0, until: 0 });

    /** 简单统计，运维时能看出人机到底在走 LLM 还是兜底 */
    this.stats = { llm: 0, rule: 0, adjusted: 0, sayDropped: 0, errors: 0 };
  }

  /** 有没有可用的 LLM（没有就是纯规则人机，也能玩） */
  get hasLLM() {
    return this.clients.length > 0;
  }

  /** 供 /healthz 之类的地方展示 */
  describe() {
    if (!this.hasLLM) return '规则人机（未配置 LLM）';
    // 带上「不思考」是因为它同时影响延迟、花的钱和答得对不对，
    // 而这三样出问题的时候，第一眼要看的就是启动日志这一行。
    return this.clients
      .map((c) => `${c.label}(${c.model}${c.thinking === 'off' ? '，不思考' : ''})`)
      .join(' + ');
  }

  /**
   * 运行时重新配置（房主在前端填 key 时走这里）。
   *
   * **安全**：apiKey 只存在这个进程的内存里。它绝对不能出现在任何下发给客户端的
   * 快照里——那等于把 key 发给牌桌上所有人。对外只能用 status() 的脱敏结果。
   *
   * @param {object} patch
   * @param {string} patch.provider  kimi | deepseek | yinlianyun
   * @param {string} [patch.apiKey]  留空表示保留原有 key
   * @param {string} [patch.model]
   * @param {string} [patch.baseUrl]
   * @param {'on'|'off'} [patch.thinking] 不给表示沿用这一家原来的设置
   * @returns {{ok:true}|{ok:false,msg:string}}
   */
  configure(patch) {
    const provider = String(patch?.provider || '').toLowerCase();
    if (!PROVIDERS[provider]) return { ok: false, msg: '不支持的供应商' };

    const existing = this.clients.find((c) => c.provider === provider);

    // 没给新 key 就沿用同一供应商已有的那个，方便只改模型名
    let apiKey = typeof patch.apiKey === 'string' ? patch.apiKey.trim() : '';
    if (!apiKey) apiKey = existing?.apiKey || '';
    if (!apiKey) return { ok: false, msg: '缺少 API key' };

    // 思考开关同理：不给就沿用这一家原来的设置，再退回环境变量给的默认。
    // 【不能】直接退回默认值——那样"只改个模型名"会把关掉的思维链悄悄打开，
    // 而这件事只体现在延迟和账单上，页面上看不出来。
    let thinking = existing?.thinking ?? this.thinking;
    if (patch.thinking !== undefined && patch.thinking !== null) {
      thinking = String(patch.thinking).toLowerCase();
      if (thinking !== 'on' && thinking !== 'off') {
        return { ok: false, msg: '思考开关只能是 on 或 off' };
      }
    }

    let client;
    try {
      client = new LLMClient({
        provider,
        apiKey,
        model: patch.model ? String(patch.model).trim() : undefined,
        baseUrl: patch.baseUrl ? String(patch.baseUrl).trim() : undefined,
        timeoutMs: this.timeoutMs,
        thinking,
      });
    } catch (e) {
      return { ok: false, msg: e.message || '配置无效' };
    }

    // 同一供应商替换，不同供应商追加
    this.clients = this.clients.filter((c) => c.provider !== provider);
    this.clients.push(client);
    this.health.set(client, { fails: 0, until: 0 });
    return { ok: true };
  }

  /** 移除某个供应商 */
  removeProvider(provider) {
    const before = this.clients.length;
    for (const c of this.clients) {
      if (c.provider === provider) this.health.delete(c);
    }
    this.clients = this.clients.filter((c) => c.provider !== provider);
    return { ok: this.clients.length !== before };
  }

  /**
   * 可以安全下发给客户端的状态。**不含 apiKey。**
   * maskedKey 只保留头 3 位和尾 4 位，够房主确认自己粘对了，又拼不回原文。
   */
  status() {
    const now = Date.now();
    return {
      hasLLM: this.hasLLM,
      providers: this.clients.map((c) => ({
        provider: c.provider,
        label: c.label,
        model: c.model,
        thinking: c.thinking,
        canDisableThinking: c.canDisableThinking,
        maskedKey: maskKey(c.apiKey),
        cooling: (this.health.get(c)?.until ?? 0) > now,
      })),
      stats: { ...this.stats },
    };
  }

  /**
   * 算这次决策的胜率。任何异常都吞掉返回 null——胜率是加分项，
   * 拿不到就退回原来的行为，绝不能因为它让人机卡住。
   *
   * 对手范围从本手的行动序列推（range.js）。以前这里写死成「随机两张牌」，
   * 那个假设系统性偏乐观，于是规则策略会做一堆亏钱的跟注 —— 跟注决策就是
   * 拿胜率和底池赔率比大小，喂给它一个偏高的胜率，它就会跟一些本该弃的牌。
   *
   * 注意两处配套：
   *   - 提示词里的建模说明会跟着 equity.range 走（见 decide.js 的 buildUser），
   *     否则模型以为这个数还偏乐观，会自己再打一次折，等于修正两遍。
   *   - 翻牌前没人加注时推断结果是 1（任意两张），行为和以前完全一样。
   */
  async #equityFor(state, signal) {
    if (!this.equitySims) return null;                 // 设成 0 = 关闭
    const hole = state?.you?.cards;
    if (!Array.isArray(hole) || hole.length !== 2) return null;
    const opponents = countLiveOpponents(state);
    if (opponents < 1) return null;

    let opponentRange = null;
    try {
      opponentRange = inferOpponentRange({
        history: state.table?.history,
        mySeat: state.you?.seat,
      });
    } catch {
      opponentRange = null;                            // 推不出来就按随机两张牌
    }

    try {
      return await estimateEquityAsync({
        hole,
        board: state.table?.board || [],
        opponents,
        sims: this.equitySims,
        budgetMs: this.equityMs,
        chunkMs: this.equityChunkMs,
        opponentRange,
        signal,
      });
    } catch (e) {
      this.logger.error(`[bot] 胜率估算失败：${e.message}`);
      return null;
    }
  }

  /** 挑一个当前没在冷却里的客户端；全在冷却就返回 null */
  #pick(seed) {
    if (!this.clients.length) return null;
    const now = Date.now();
    const usable = this.clients.filter((c) => (this.health.get(c)?.until ?? 0) <= now);
    if (!usable.length) return null;
    // 按座位轮转，多个人机不会全压在同一家上
    return usable[Math.abs(seed) % usable.length];
  }

  #onSuccess(client) {
    const h = this.health.get(client);
    if (h) { h.fails = 0; h.until = 0; }
  }

  #onFailure(client, err) {
    const h = this.health.get(client);
    if (!h) return;
    // 不可重试的错误（4xx，通常是 key 或参数问题）直接进冷却，别硬撞
    h.fails = isRetryable(err) ? h.fails + 1 : FAIL_THRESHOLD;
    if (h.fails >= FAIL_THRESHOLD) {
      h.until = Date.now() + COOLDOWN_MS;
      h.fails = 0;
      this.logger.error(`[bot] ${client.label} 连续失败，冷却 ${COOLDOWN_MS / 1000}s：${err.message}`);
    }
  }

  /**
   * 做一次决策。**不会抛异常。**
   *
   * @param {object} state    Room#buildStateFor(botPlayerId)，必须是脱敏快照
   * @param {object} persona  PERSONAS 中的一项
   * @param {AbortSignal} [signal] 手牌已结束等情况下用来取消
   * @returns {Promise<{action:object, say:string|null, source:'llm'|'rule', note:string|null}>}
   */
  async decide(state, persona, signal) {
    const started = Date.now();
    const seat = state?.you?.seat ?? 0;
    const handNo = state?.table?.handNo ?? 0;
    const seed = handNo * 8 + seat;

    // 先算胜率：LLM 和规则兜底都要用，同一次决策只算一次。
    // 分片计算，中途会让出事件循环，所以别人的动作照常被处理。
    const equity = await this.#equityFor(state, signal);

    let out = null;
    const client = this.#pick(seed);

    if (client && state?.you?.legal) {
      try {
        const raw = await client.completeJSON({
          system: buildSystem(persona),
          user: buildUser(state, { equity }),
          // 动作 JSON 本身只有二十来个 token，但**带思维链的模型会先花掉一大截**，
          // 而思维链和正文共用这一个预算。原来写死 200，接上 deepseek-v4-flash
          // 这类推理模型必然翻车：token 全花在思考上，正文要么被
          // finish_reason=length 从中间截断、JSON 解析失败，要么干脆是空的。
          // 题库实测：200 的时候 20 题里 18 题这么没的，1024 还剩 12/40，
          // 而日志上只有一行"输出无法解析成 JSON"或"返回内容为空"，看着像模型笨。
          //
          // **给大了不多花钱，给小了才是纯浪费**：思维链的 token 你照付不误，
          // 上限只决定这笔钱换不换得回一个答案。不推理的模型答完就停，够不着这个数。
          maxTokens: this.maxTokens,
          signal,
        });
        this.#onSuccess(client);
        const coerced = coerceAction(raw, state, persona.traits, equity);
        if (coerced.adjusted) {
          this.stats.adjusted++;
          this.logger.error(`[bot] ${persona.name} 输出被修正：${coerced.adjusted}`);
        }
        // 话被丢掉了要看得见。**这行只进服务端日志**——它带着模型原话，
        // 而原话里就是那手牌，回到聊天区等于白拦一趟。
        if (coerced.sayNote) {
          this.stats.sayDropped++;
          this.logger.error(`[bot] ${persona.name} ${coerced.sayNote}`);
        }
        this.stats.llm++;
        out = { ...coerced, source: 'llm', note: coerced.adjusted };
      } catch (err) {
        this.stats.errors++;
        this.#onFailure(client, err);
        this.logger.error(`[bot] ${persona.name} 调用失败，改用规则：${err.message}`);
      }
    }

    if (!out) {
      this.stats.rule++;
      out = {
        action: fallbackAction(state, persona.traits, equity),
        say: null,
        source: 'rule',
        note: null,
      };
    }

    // 秒回会很出戏，也会让整桌节奏太快；补齐到最短思考时间
    const elapsed = Date.now() - started;
    if (elapsed < this.minThinkMs) {
      await sleep(this.minThinkMs - elapsed, signal);
    }
    return out;
  }
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    // 这里【不能】unref：unref 过的定时器不阻止事件循环退出，
    // 等待会被直接跳过（决策还没落地进程就走了）。时长最多几秒，
    // 让它正常持有事件循环是对的。
    const t = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(t);
      signal?.removeEventListener?.('abort', done);
      resolve();
    }
  });
}

/**
 * sk-abcdefghij1234 -> sk-…1234
 * 只够房主确认自己粘对了 key，拼不回原文。
 */
function maskKey(key) {
  const s = String(key || '');
  if (s.length <= 8) return '…';
  return `${s.slice(0, 3)}…${s.slice(-4)}`;
}

export default BotDriver;
