// SPDX-License-Identifier: GPL-3.0-or-later
//
// agent 版人机：多轮工具调用的决策循环。
//
// 和 server/bot/ 那版的区别只有一句话：**谁来决定胜率按什么假设算**。
//
//   旧版：我们在调模型之前，先按「对手随机两张牌」算好胜率塞进提示词。
//         模型只能读那一个数，而那个数系统性偏乐观——对手越紧越离谱。
//   这版：胜率变成一个工具。模型读完行动序列和对手画像，自己判断
//         「这人打成这样，范围大概前 10%」，再要一个那个假设下的胜率。
//         必要时用两个范围各算一次，看结论会不会反转。
//
// 结构上它是 BotDriver 的**外壳**，不是替代品：
//
//   PokerAgent.decide()
//     ├─ 走通了 → 用 agent 的动作（仍然过 coerceAction 夹一道）
//     └─ 任何失败 → BotDriver.decide()（LLM 单轮 → 规则策略 → 一定合法）
//
// 所以原来那套安全性质一条都没丢：外部服务全挂，牌桌照常进行，人机只是变笨。
// 而且 server/bot/ 保持零依赖，`ai` 这几个包只有走到这里才需要。
//
// 两条安全红线和 decide.js 完全一样，改这个文件前先读那边的注释：
//   1. 只吃 buildStateFor(botPlayerId) 的脱敏快照，别人的底牌是 "??"；
//   2. 聊天记录不进提示词（防提示注入），昵称经 sanitizeName 清洗。

import { generateText, stepCountIs, hasToolCall } from 'ai';

import { BotDriver } from '../bot/index.js';
import { buildUser, coerceAction, fallbackAction, sanitizeName } from '../bot/decide.js';
import { isContentFilterError } from '../bot/provider.js';
import { modelsFromEnv, buildModel } from './model.js';
import { OpponentMemory } from './memory.js';
import { buildTools } from './tools.js';

export { OpponentMemory } from './memory.js';
export { randomPersona, PERSONA_NAMES, PERSONA_DIMENSIONS } from '../bot/persona.js';

/** 连续失败多少次后，暂时不走 agent 这条路 */
const FAIL_THRESHOLD = 3;
/** 退避时长 */
const COOLDOWN_MS = 60_000;

/**
 * agent 的系统提示词。
 *
 * 和旧版最大的不同：不再要求输出 JSON，而是要求**调用工具**。收尾必须调 act，
 * 这是循环的唯一出口——prepareStep 在最后一步会强制它调，所以即使模型
 * 想一直想下去也停得下来。
 *
 * 步骤是按「跟注 / 开火」两条线写的：前四步管该不该跟，第五步管该不该开火。
 * 工具集补上 plan_bet 之后，这两条线才都有确定性的算术撑着（见 tools.js 顶上）。
 *
 * @param {object} persona {name, style}
 * @param {number} maxSteps
 */
export function buildAgentSystem(persona, maxSteps, toolNames = null) {
  // 有哪些工具就写哪些步骤。**提示词和工具集必须一致** —— 少了工具却还留着
  // "先调 plan_bet"，模型会去调一个不存在的东西，白烧一步；多了工具却不在
  // 提示词里提，它基本不会想起来用。做消融（摘掉某个工具看它值多少）时，
  // 这两边得一起动，所以这里按工具名生成步骤，不写死。
  const has = (n) => !toolNames || toolNames.includes(n);

  const steps = [
    `先看行动序列。有人加注、而且是在后面的街加注，说明他范围很紧；
   翻牌前就一堆人跟注，说明大家范围都很宽。`,
  ];
  if (has('read_opponents')) {
    steps.push('拿不准对手是什么人，就调 read_opponents 看画像。');
  }
  if (has('estimate_equity')) {
    steps.push(`调 estimate_equity 时，**你必须自己给出对手范围**。这是关键一步：
   同样一手 AK，对随机两张牌有 66% 胜率，对「只玩前 5%」的人只有 47%。
   范围估错，胜率就是错的，跟注就是亏的。`);
    steps.push(`结论在临界点上（胜率和底池赔率差不多）时，用一个更紧和一个更松的范围
   各算一次。如果两种假设下结论一致，就照做；如果会反转，说明这个决定
   取决于你对这个人的判断${has('read_opponents') ? '——那就按 read_opponents 的画像来定' : ''}。`);
  }
  if (has('plan_bet')) {
    steps.push(`**想下注或加注，先调 plan_bet。** 跟注和开火是两套算术：跟注比的是
   「你的胜率」和「底池赔率」，开火比的是「他会弃多少牌」和「需要他弃多少牌」。
   尺度不同、需要的弃牌率就不同，这个数不要心算。
   拿不准下多大，就换两三个 amount 各调一次，挑 ev_chips 最大的那个。
   记住尺度越大他继续得越少，所以大注要配更紧的 continue_range。`);
  }
  steps.push('想好了就调 act 提交。这是唯一的出口。');

  return `你是德州扑克牌桌上的一名玩家，昵称「${sanitizeName(persona.name)}」。
你的风格：${persona.style}

规则要点：
- 无限注德州扑克。bet / raise 的 amount 是「本轮总投入额」，不是增量。
- call 不需要 amount，系统会自动按需要的额度跟注。
- 只能从「可选动作」里选，选别的会被判为非法。

你有工具可以用。怎么用它们决定了你打得好不好：

${steps.map((t, i) => `${i + 1}. ${t}`).join('\n')}

你最多只有 ${maxSteps} 步，别把步数浪费在重复调同一个范围上。
不要输出任何解释性文字，思考通过调用工具体现，结论通过 act 提交。`;
}

export class PokerAgent {
  /**
   * @param {object} [opts]
   * @param {BotDriver} [opts.fallback]   兜底驱动，不传就自己造一个
   * @param {object[]} [opts.models]      不传则从环境变量装配
   * @param {number} [opts.maxSteps]      循环最多几步，默认 4
   * @param {number} [opts.maxThinkMs]    整次决策的墙钟上限，默认 20000
   * @param {number} [opts.minThinkMs]    最短「思考」时间，默认 900
   * @param {string[]} [opts.excludeTools] 摘掉这些工具（消融用），提示词会跟着变
   * @param {OpponentMemory} [opts.memory]
   * @param {object} [opts.logger]
   */
  constructor(opts = {}) {
    const env = opts.env || process.env;

    this.fallback = opts.fallback || new BotDriver(opts);
    this.models = opts.models || modelsFromEnv(env);
    this.memory = opts.memory || new OpponentMemory();
    this.logger = opts.logger || console;

    // 步数上限。**能用来调工具的是 maxSteps - 1 次** —— 最后一步被 prepareStep
    // 锁成 act 了。6 步给出 5 次工具调用，够走完整的一条线：
    // 读画像 → 算胜率 → 三个下注尺度各 plan_bet 一次挑最大的 EV → 出手。
    // 原来是 4（3 次工具调用），只够「画像 + 胜率 + 一个尺度」，横向比尺度就不够了。
    // 注意这是**上限不是开销**：模型一调 act 循环就停，绝大多数决策两三步就结束，
    // 涨的是最难那几个决策的天花板 —— 而那正是值得多花钱的地方。
    this.maxSteps = Math.max(2, Number(opts.maxSteps ?? env.POKER_AGENT_MAX_STEPS ?? 6));
    // 墙钟。这个数必须跟着步数一起涨，否则多给的步数用不上 —— 闸门在半路
    // 落下来，前面几步花的钱全部作废，还得再走一次兜底。
    //
    // 上限怎么定的（行动时限 45 秒，超时人机就被判过牌/弃牌，必须留够）：
    //   30s  这道闸门
    // + 1.5s 兜底那路自己要算一次胜率
    // + 8s   兜底那路的单轮调用超时
    // ≈ 40s，还剩 5 秒给网络抖动。再往上加就该先把行动时限也调大。
    this.maxThinkMs = Math.max(1000, Number(opts.maxThinkMs ?? env.POKER_AGENT_MAX_MS ?? 30_000));
    this.minThinkMs = Math.max(0, Number(opts.minThinkMs ?? 900));

    // 每次 estimate_equity 的预算。模型可能调好几次，所以单次给得比旧版小一点，
    // 精度损失可以忽略（20000 次模拟的置信半宽只有 ±0.7 个百分点）。
    this.equitySims = Math.max(0, Number(opts.equitySims ?? env.POKER_BOT_EQUITY_SIMS ?? 20000));
    this.equityMs = Math.max(1, Number(opts.equityMs ?? env.POKER_AGENT_EQUITY_MS ?? 1200));
    this.equityChunkMs = Math.max(1, Number(opts.equityChunkMs ?? env.POKER_BOT_EQUITY_CHUNK_MS ?? 8));

    // 消融用：摘掉某个工具，看它到底值多少。提示词会跟着一起变
    // （见 buildAgentSystem），所以不会出现"提示词让它调一个不存在的工具"。
    this.excludeTools = Array.isArray(opts.excludeTools) ? opts.excludeTools : [];

    /** 每个模型的健康状态 */
    this.health = new Map();
    for (const m of this.models) this.health.set(m, { fails: 0, until: 0 });

    this.stats = {
      agent: 0,        // 走通 agent 循环的次数
      fallback: 0,     // 退回 BotDriver 的次数
      steps: 0,        // 累计步数
      toolCalls: 0,    // 累计工具调用次数
      forcedAct: 0,    // 被 prepareStep 强制收尾的次数
      errors: 0,
      filtered: 0,     // 其中被内容安全审查拦下的次数（确定性故障，见下面的分支）
      canceled: 0,     // 被外部取消的次数（手牌结束等，不算故障）
      inputTokens: 0,
      outputTokens: 0,
    };
  }

  /** 有没有可用的后端（agent 或兜底任一有就算） */
  get hasLLM() {
    return this.models.length > 0 || this.fallback.hasLLM;
  }

  describe() {
    if (!this.models.length) return `${this.fallback.describe()}（agent 未配置，走单轮）`;
    const names = this.models.map((m) => `${m.label}(${m.model})`).join(' + ');
    return `agent × ${names}，最多 ${this.maxSteps} 步`;
  }

  /**
   * 运行时重新配置。先交给 BotDriver（它管 key 的存储与脱敏），
   * 成功后再用同一份配置造一个 AI SDK 的模型。
   *
   * **安全**：apiKey 只存在进程内存里，绝不进任何下发给客户端的快照。
   */
  configure(patch) {
    const res = this.fallback.configure(patch);
    if (!res.ok) return res;

    // 从 BotDriver 那边拿回它最终采用的配置（可能沿用了已有的 key）
    const provider = String(patch?.provider || '').toLowerCase();
    const client = this.fallback.clients.find((c) => c.provider === provider);
    if (!client) return res;

    try {
      const m = buildModel({
        provider,
        apiKey: client.apiKey,
        model: patch.model ? String(patch.model).trim() : client.model,
        baseUrl: client.baseUrl,
      });
      this.models = this.models.filter((x) => x.provider !== provider);
      this.models.push(m);
      this.health.set(m, { fails: 0, until: 0 });
    } catch (e) {
      this.logger.error(`[agent] 装配模型失败，这一路仍走单轮：${e.message}`);
    }
    return res;
  }

  removeProvider(provider) {
    for (const m of this.models) {
      if (m.provider === provider) this.health.delete(m);
    }
    this.models = this.models.filter((m) => m.provider !== provider);
    return this.fallback.removeProvider(provider);
  }

  /** 可以安全下发给客户端的状态。**不含 apiKey。** */
  status() {
    const base = this.fallback.status();
    return {
      ...base,
      agent: {
        enabled: this.models.length > 0,
        maxSteps: this.maxSteps,
        memory: this.memory.size,
        stats: { ...this.stats },
      },
    };
  }

  /**
   * 吸收一份快照进对手记忆。房间在**手牌结束时**调一次，
   * 这样才看得到摊牌亮出来的牌——决策时那些牌还是 "??"。
   *
   * 幂等，随便调。
   */
  observe(state) {
    try {
      this.memory.observe(state);
    } catch (e) {
      this.logger.error(`[agent] 记忆吸收失败：${e.message}`);
    }
  }

  /**
   * 忘掉一个人的画像。房间在**人机离座时**调，见 memory.js#forget 里的理由：
   * 人机的名字来自一个 20 个名字的固定池子，不清就会被下一个同名人机继承。
   *
   * @param {string} name
   */
  forget(name) {
    try {
      this.memory.forget(name);
    } catch (e) {
      this.logger.error(`[agent] 清理画像失败：${e.message}`);
    }
  }

  /** 挑一个不在冷却里的模型 */
  #pick(seed) {
    if (!this.models.length) return null;
    const now = Date.now();
    const usable = this.models.filter((m) => (this.health.get(m)?.until ?? 0) <= now);
    if (!usable.length) return null;
    return usable[Math.abs(seed) % usable.length];
  }

  #onFailure(model, err) {
    const h = this.health.get(model);
    if (!h) return;
    h.fails++;
    if (h.fails >= FAIL_THRESHOLD) {
      h.until = Date.now() + COOLDOWN_MS;
      h.fails = 0;
      this.logger.error(`[agent] ${model.label} 连续失败，agent 这路冷却 ${COOLDOWN_MS / 1000}s：${err.message}`);
    }
  }

  #onSuccess(model) {
    const h = this.health.get(model);
    if (h) { h.fails = 0; h.until = 0; }
  }

  /**
   * 做一次决策。**不会抛异常。**
   *
   * @param {object} state    Room#buildStateFor(botPlayerId)，必须是脱敏快照
   * @param {object} persona
   * @param {AbortSignal} [signal]
   * @returns {Promise<{action:object, say:string|null, source:string, note:string|null}>}
   */
  async decide(state, persona, signal) {
    const started = Date.now();

    // 先把这手牌到目前为止的动作吸收进记忆。决策时看不到摊牌，
    // 摊牌那部分由房间在手牌结束时调 observe() 补上。
    this.observe(state);

    const seat = state?.you?.seat ?? 0;
    const handNo = state?.table?.handNo ?? 0;
    const model = this.#pick(handNo * 8 + seat);

    if (!model || !state?.you?.legal) {
      return this.#viaFallback(state, persona, signal, started);
    }

    // 墙钟闸门。这是旧版缺的那一环——BotDriver 里的 maxThinkMs 从来没被用上，
    // 单轮调用还能靠 provider 自己的超时兜住，多轮循环则必须有人管总时长。
    //
    // **必须在造工具之前造好**：工具拿到的要是这个合成信号，不是外部那个。
    // 只传外部信号的话，墙钟到点时 generateText 中断了，工具里在飞的那次
    // 蒙特卡洛没人叫停，还会自顾自跑满它的预算 —— 决策早就不要了，CPU 白烧。
    const timeout = AbortSignal.timeout(this.maxThinkMs);
    const composed = signal ? AbortSignal.any([timeout, signal]) : timeout;

    const trace = { calls: [] };
    const { tools, readAct, toolNames } = buildTools({
      exclude: this.excludeTools,
      state,
      memory: this.memory,
      signal: composed,
      equitySims: this.equitySims,
      equityMs: this.equityMs,
      equityChunkMs: this.equityChunkMs,
      trace,
    });

    let result;
    try {
      result = await generateText({
        model: model.languageModel,
        system: buildAgentSystem(persona, this.maxSteps, toolNames),
        // 不再预先注入胜率——那是工具的活。forTools 换掉收尾那句话：
        // 共用的 buildUser 默认要的是一个 JSON 对象，那是单轮那路的收尾方式，
        // 和这里"只准调 act"的系统提示词直接打架。
        prompt: buildUser(state, { forTools: true }),
        tools,
        stopWhen: [hasToolCall('act'), stepCountIs(this.maxSteps)],
        abortSignal: composed,
        // 最后一步强制收尾，否则模型可能一直调工具直到步数耗尽而没有动作
        prepareStep: ({ stepNumber }) => {
          if (stepNumber >= this.maxSteps - 1) {
            this.stats.forcedAct++;
            return { toolChoice: { type: 'tool', toolName: 'act' } };
          }
          return undefined;
        },
      });
      this.#onSuccess(model);
    } catch (err) {
      // 外部取消（手牌结束、被踢、房间 reset）不是模型的错。
      //
      // 两件事都不能做：不能记进健康度 —— 否则连着取消三次就把 agent 这路
      // 冷却 60 秒，而那三次模型可能一次都没出过问题；也不该再走兜底 ——
      // 房间那边 #cancelBot 早就把 botPending 清了，这个动作生下来就没人要，
      // 再打一次 LLM 只是白花钱，还会连累 BotDriver 自己的健康度。
      if (signal?.aborted) {
        this.stats.canceled++;
        return {
          action: fallbackAction(state, persona?.traits, null),
          say: null,
          source: 'canceled',
          note: null,
        };
      }
      this.stats.errors++;
      this.#onFailure(model, err);

      // 被内容安全审查拦下来的要单独喊一嗓子。表面上它只是"人机今天有点笨"——
      // 上层老老实实退回规则策略，牌桌照常进行，没人会去看日志。
      //
      // 它有两种，得分开处理，别一看见就去删提示词：
      //   常驻  我们自己的文本里有网关不收的词。**每次必拦**，fallback 率直接 100%。
      //         位置名里的「枪口位」就是这种，见 decide.js#positionName。
      //   偶发  多轮循环里模型自己生成的思维链和工具参数会被原样发回去，
      //         那些字也要过审。实测同一道题跑 4 次、3 次通过 1 次被拦（DeepSeek 网关），
      //         我们这边一个字都没改。这种删提示词没用，只能靠退避重试。
      // 分辨方法：同一个局面连跑几次，次次都拦就是常驻，偶尔才拦就是偶发。
      if (isContentFilterError(err)) {
        this.stats.filtered++;
        this.logger.error(
          `[agent] ${persona.name} 被${model.label}的内容安全审查拦下（${err.message}）。` +
          '次次都拦 = 我们的提示词里有它不收的词；偶尔才拦 = 模型自己生成的字被拦了，删提示词没用。'
        );
      } else {
        this.logger.error(`[agent] ${persona.name} 循环失败，退回单轮：${err.message}`);
      }
      return this.#viaFallback(state, persona, signal, started);
    }

    this.stats.steps += result.steps?.length || 0;
    this.stats.toolCalls += result.toolCalls?.length || 0;
    this.stats.inputTokens += result.usage?.inputTokens || 0;
    this.stats.outputTokens += result.usage?.outputTokens || 0;

    const raw = readAct(result);
    if (!raw) {
      this.logger.error(`[agent] ${persona.name} 没有提交动作，退回单轮`);
      return this.#viaFallback(state, persona, signal, started);
    }

    // 最后一道关，和旧版是同一个函数：到这里为止都不相信模型输出。
    const coerced = coerceAction(raw, state, persona.traits, null);
    if (coerced.adjusted) {
      this.logger.error(`[agent] ${persona.name} 输出被修正：${coerced.adjusted}`);
    }

    // 模型的输出完全没法用（不是金额越界那种小毛病，而是动作本身不合法）。
    // 这里【不能】就地用 coerceAction 里那个 equity=null 的规则兜底 —— 那样
    // 规则策略是在没有胜率的情况下拍脑袋。改走 BotDriver：它会自己算一份
    // 带推断范围的胜率再交给同一套规则策略，结论好得多。
    // 代价是多花一次蒙特卡洛，但这条路很少走到。
    if (coerced.usedFallback) {
      this.logger.error(`[agent] ${persona.name} 动作不可用，改走单轮兜底以拿到带范围的胜率`);
      const out = await this.#viaFallback(state, persona, signal, started);
      // say 是闲聊，和动作合不合法无关，模型说了就留着
      return coerced.say ? { ...out, say: coerced.say } : out;
    }

    this.stats.agent++;

    await this.#pace(started, signal);
    return {
      ...coerced,
      source: 'agent',
      note: coerced.adjusted,
      // 这次决策调了哪些工具、按什么范围估的。运维时能看出 agent 到底在不在思考。
      trace: trace.calls,
    };
  }

  /** 退回原来那套（单轮 LLM → 规则策略），它自己保证一定返回合法动作 */
  async #viaFallback(state, persona, signal, started) {
    this.stats.fallback++;
    try {
      const out = await this.fallback.decide(state, persona, signal);
      return { ...out, source: `fallback:${out.source}` };
    } catch (e) {
      // BotDriver 承诺不抛，走到这里说明它自己也炸了。最后的最后：纯规则。
      this.logger.error(`[agent] 兜底也失败了，用纯规则：${e.message}`);
      await this.#pace(started, signal);
      return {
        action: fallbackAction(state, persona?.traits, null),
        say: null,
        source: 'rule',
        note: null,
      };
    }
  }

  /** 补齐到最短思考时间，秒回会很出戏 */
  async #pace(started, signal) {
    const elapsed = Date.now() - started;
    if (elapsed >= this.minThinkMs) return;
    await sleep(this.minThinkMs - elapsed, signal);
  }
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    // 不能 unref：unref 过的定时器不阻止事件循环退出，等待会被直接跳过。
    const t = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(t);
      signal?.removeEventListener?.('abort', done);
      resolve();
    }
  });
}

export default PokerAgent;
