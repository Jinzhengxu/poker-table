// SPDX-License-Identifier: GPL-3.0-or-later
//
// LLM 供应商适配：Kimi(Moonshot) 与 DeepSeek。
//
// 两家都提供 OpenAI 兼容的 /chat/completions，请求体和响应体结构一致，
// 所以这里只有一个客户端，差异全部收敛成 baseUrl / model / apiKey 三个字段。
// 用 Node 22 自带的全局 fetch，不引入任何依赖（见 CONTRIBUTING.md 的约定）。

/** 各供应商的默认接入点与模型 */
export const PROVIDERS = Object.freeze({
  kimi: {
    label: 'Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    keyEnv: 'KIMI_API_KEY',
  },
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    keyEnv: 'DEEPSEEK_API_KEY',
  },
});

/** 调用失败时抛出的错误，带一个粗分类便于上层决定要不要退避 */
export class ProviderError extends Error {
  /**
   * @param {string} message
   * @param {'timeout'|'network'|'http'|'format'} kind
   * @param {number} [status] HTTP 状态码（kind==='http' 时有意义）
   */
  constructor(message, kind, status) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = status ?? null;
  }
}

/** 4xx 里除了 408/429 之外都是请求本身有问题，重试没有意义 */
export function isRetryable(err) {
  if (!(err instanceof ProviderError)) return false;
  if (err.kind === 'timeout' || err.kind === 'network') return true;
  if (err.kind !== 'http') return false;
  if (err.status === 408 || err.status === 429) return true;
  return err.status >= 500;
}

export class LLMClient {
  /**
   * @param {object} opts
   * @param {string} opts.provider   PROVIDERS 的键（kimi / deepseek）
   * @param {string} opts.apiKey
   * @param {string} [opts.baseUrl]  覆盖默认接入点（自建代理 / 海外站点时用）
   * @param {string} [opts.model]
   * @param {number} [opts.timeoutMs] 单次请求超时，默认 8000
   */
  constructor(opts) {
    const preset = PROVIDERS[opts.provider];
    if (!preset) throw new Error(`未知的 LLM 供应商: ${opts.provider}`);
    if (!opts.apiKey) throw new Error(`${preset.label} 缺少 API key`);

    this.provider = opts.provider;
    this.label = preset.label;
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl || preset.baseUrl).replace(/\/+$/, '');
    this.model = opts.model || preset.model;
    this.timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 8000;
  }

  /**
   * 发一次对话补全，要求返回 JSON 对象。
   *
   * @param {object} args
   * @param {string} args.system    系统提示词
   * @param {string} args.user      用户消息（本项目里就是牌局快照）
   * @param {number} [args.maxTokens]
   * @param {AbortSignal} [args.signal] 外部取消信号（例如手牌已经结束了）
   * @returns {Promise<object>} 解析后的 JSON 对象
   * @throws {ProviderError}
   */
  async completeJSON({ system, user, maxTokens = 200, signal }) {
    // 自己的超时 + 外部取消信号，任一触发都要中断请求
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const composed = signal ? AbortSignal.any([timeout, signal]) : timeout;

    let res;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          // 两家都支持 OpenAI 的 JSON 模式。注意 DeepSeek 要求提示词里
          // 出现 "json" 字样才会进入该模式，prompt.js 里已经满足。
          response_format: { type: 'json_object' },
          temperature: 0.7,
          max_tokens: maxTokens,
          stream: false,
        }),
        signal: composed,
      });
    } catch (err) {
      // AbortSignal.timeout 触发时 err.name === 'TimeoutError'
      if (err?.name === 'TimeoutError') {
        throw new ProviderError(`${this.label} 请求超时（${this.timeoutMs}ms）`, 'timeout');
      }
      if (err?.name === 'AbortError') {
        throw new ProviderError(`${this.label} 请求被取消`, 'network');
      }
      throw new ProviderError(`${this.label} 网络错误: ${err?.message || err}`, 'network');
    }

    if (!res.ok) {
      // 错误体可能很长（有些网关会回整个 HTML），截断后再进日志
      const body = await res.text().catch(() => '');
      throw new ProviderError(
        `${this.label} HTTP ${res.status}: ${body.slice(0, 200)}`,
        'http',
        res.status
      );
    }

    let payload;
    try {
      payload = await res.json();
    } catch {
      throw new ProviderError(`${this.label} 返回的不是合法 JSON`, 'format');
    }

    const text = payload?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) {
      throw new ProviderError(`${this.label} 返回内容为空`, 'format');
    }

    return parseJSONObject(text, this.label);
  }
}

/**
 * 从模型输出里抠出 JSON 对象。
 * 即便开了 JSON 模式，也有模型会裹一层 ```json 代码块或在前后加一句话，
 * 所以这里先直接解析，失败再退回到"取第一个 {...} 片段"。
 *
 * @param {string} text
 * @param {string} label 供应商名字，只用于错误信息
 */
export function parseJSONObject(text, label = 'LLM') {
  const raw = text.trim();

  const direct = tryParse(raw);
  if (direct) return direct;

  // 去掉 ```json ... ``` 包裹
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const inner = tryParse(fenced[1].trim());
    if (inner) return inner;
  }

  // 最后兜底：第一个 { 到最后一个 } 之间
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end > start) {
    const slice = tryParse(raw.slice(start, end + 1));
    if (slice) return slice;
  }

  throw new ProviderError(`${label} 输出无法解析成 JSON 对象: ${raw.slice(0, 120)}`, 'format');
}

function tryParse(s) {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * 从环境变量装配客户端列表。
 *
 *   POKER_BOT_PROVIDER   kimi | deepseek | auto（默认 auto：有哪个 key 用哪个）
 *   KIMI_API_KEY / DEEPSEEK_API_KEY
 *   POKER_BOT_MODEL      覆盖模型名
 *   POKER_BOT_BASE_URL   覆盖接入点
 *   POKER_BOT_TIMEOUT_MS 单次请求超时，默认 8000
 *
 * @param {object} [env] 默认 process.env，测试时可注入
 * @returns {LLMClient[]} 可能为空（没配 key 就没有 LLM 人机，只能用规则人机）
 */
export function clientsFromEnv(env = process.env) {
  const want = (env.POKER_BOT_PROVIDER || 'auto').toLowerCase();
  const timeoutMs = Number(env.POKER_BOT_TIMEOUT_MS) || 8000;

  const wanted = want === 'auto' ? Object.keys(PROVIDERS) : [want];
  const out = [];
  for (const name of wanted) {
    const preset = PROVIDERS[name];
    if (!preset) {
      console.error(`[bot] 未知的 POKER_BOT_PROVIDER: ${name}`);
      continue;
    }
    const apiKey = env[preset.keyEnv];
    if (!apiKey) {
      // auto 模式下没配就跳过；显式指定却没 key 才值得报警
      if (want !== 'auto') console.error(`[bot] 已指定 ${name} 但没有设置 ${preset.keyEnv}`);
      continue;
    }
    out.push(new LLMClient({
      provider: name,
      apiKey,
      model: env.POKER_BOT_MODEL || undefined,
      baseUrl: env.POKER_BOT_BASE_URL || undefined,
      timeoutMs,
    }));
  }
  return out;
}
