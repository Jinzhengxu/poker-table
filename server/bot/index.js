// SPDX-License-Identifier: GPL-3.0-or-later
//
// 人机驱动：决定一次动作，优先问 LLM，问不到就用规则策略。
//
// 对外只暴露 BotDriver#decide()，它保证：
//   - 一定在 timeoutMs 内返回（内部超时 + 外部取消信号）；
//   - 返回的动作一定是当前局面下合法的（coerceAction 兜底）；
//   - 任何异常都不会抛给调用方，最差情况退化成规则人机。
// 也就是说：外部服务挂了，牌桌照常进行，只是人机变笨。

import { clientsFromEnv, isRetryable } from './provider.js';
import { buildSystem, buildUser, coerceAction, fallbackAction } from './decide.js';

/** 人机人格：影响昵称、头像和提示词里的风格描述 */
export const PERSONAS = Object.freeze([
  { name: '老陈', style: '稳健保守。只玩强牌，很少诈唬，被大幅加注时倾向弃牌。' },
  { name: '小杨', style: '激进好斗。喜欢加注施压，位置好时经常偷底池，敢诈唬。' },
  { name: '阿May', style: '算数派。严格按底池赔率和牌力决策，不情绪化，话不多。' },
  { name: '老K', style: '松凶。入池范围很宽，喜欢用中等牌打大池，难以预测。' },
  { name: '静静', style: '紧弱。翻牌前很紧，翻牌后遇到压力容易放弃，几乎不诈唬。' },
  { name: '大刘', style: '经验老到。会根据对手最近的动作调整，善于捕捉弱点。' },
  { name: '阿宽', style: '随和跟注站。喜欢看牌，很少加注，但也很少弃牌。' },
]);

/** 一个供应商连续失败多少次后进入退避 */
const FAIL_THRESHOLD = 3;
/** 退避时长 */
const COOLDOWN_MS = 60_000;

export class BotDriver {
  /**
   * @param {object} [opts]
   * @param {import('./provider.js').LLMClient[]} [opts.clients] 不传则从环境变量装配
   * @param {number} [opts.minThinkMs] 最短"思考"时间，让人机不至于秒回，默认 900
   * @param {number} [opts.maxThinkMs] 最长等待，超过就用兜底，默认 9000
   * @param {object} [opts.logger]
   */
  constructor(opts = {}) {
    this.clients = opts.clients || clientsFromEnv();
    this.minThinkMs = opts.minThinkMs ?? 900;
    this.maxThinkMs = opts.maxThinkMs ?? 9000;
    this.logger = opts.logger || console;

    /** 每个客户端的健康状态：连续失败次数与冷却截止时间 */
    this.health = new Map();
    for (const c of this.clients) this.health.set(c, { fails: 0, until: 0 });

    /** 简单统计，运维时能看出人机到底在走 LLM 还是兜底 */
    this.stats = { llm: 0, rule: 0, adjusted: 0, errors: 0 };
  }

  /** 有没有可用的 LLM（没有就是纯规则人机，也能玩） */
  get hasLLM() {
    return this.clients.length > 0;
  }

  /** 供 /healthz 之类的地方展示 */
  describe() {
    if (!this.hasLLM) return '规则人机（未配置 LLM）';
    return this.clients.map((c) => `${c.label}(${c.model})`).join(' + ');
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

    let out = null;
    const client = this.#pick(seed);

    if (client && state?.you?.legal) {
      try {
        const raw = await client.completeJSON({
          system: buildSystem(persona),
          user: buildUser(state),
          maxTokens: 200,
          signal,
        });
        this.#onSuccess(client);
        const coerced = coerceAction(raw, state);
        if (coerced.adjusted) {
          this.stats.adjusted++;
          this.logger.error(`[bot] ${persona.name} 输出被修正：${coerced.adjusted}`);
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
        action: fallbackAction(state),
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

export default BotDriver;
