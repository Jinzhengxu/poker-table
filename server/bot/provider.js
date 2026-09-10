// SPDX-License-Identifier: GPL-3.0-or-later
//
// LLM 供应商适配：Kimi(Moonshot)、DeepSeek，以及银联云网关。
//
// 三家都提供 OpenAI 兼容的 /chat/completions，请求体和响应体结构一致，
// 所以这里只有一个客户端，差异全部收敛成 baseUrl / model / apiKey 三个字段。
// 用 Node 22 自带的全局 fetch，不引入任何依赖（见 CONTRIBUTING.md 的约定）。

/**
 * 各供应商的默认接入点与模型。
 *
 * 两个可选字段，都只跟【带思维链的模型】有关：
 *
 *   timeoutMs    单次请求超时的默认值。那种模型光想就要十几秒，用全局那个
 *                8 秒会稳定超时——而超时是【静默】的，牌桌照常进行，人机只是
 *                悄悄退回规则策略，日志外面看不出来。POKER_BOT_TIMEOUT_MS 优先。
 *   noThinkBody  「把思维链关掉」要往请求体里加的字段。各家的开关名字都不一样，
 *                所以写在预设里，代码只管加不加。没写这个字段的供应商就是没有
 *                已知开关（Kimi、DeepSeek 的默认模型本来就不带思维链），
 *                这时要 off 也只能维持 on —— 但会照实说出来：日志里一行，
 *                status() 里 thinking 字段仍然是 on。绝不发一个上游不认识的
 *                字段过去，然后装作关掉了。
 */
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
  // 银联云：走 code-tool 网关，key 是网关自己签发的 token（uuid 形式），
  // 不是上游的真 key。
  //
  // 默认模型 deepseek-v4-flash 带思维链，所以超时单独给到 30 秒：
  // 题库 obvious 那 7 题实测单轮延迟 p50 7.5s、p95 27.8s，最短的一次问答
  // （45 个输入 token）也要 5 秒。用全局那 8 秒的话 p50 就已经超了，
  // 而且是静默超——每手都退回规则策略，页面上完全看不出来。
  // 上限压在 30 秒是因为行动时限默认 45 秒，再加上算胜率的 1.5 秒还得留余量。
  //
  // 思维链可以关：这两个模型都认 thinking:{type:'disabled'}，关掉后
  // reasoning_tokens 确实是 0（实测 flash 6~8s -> 2~3s，pro 7~10s -> 4s）。
  // 同批试过的 enable_thinking:false / reasoning:{enabled:false} /
  // chat_template_kwargs 都【只是被无视】，reasoning_tokens 照样不为 0；
  // reasoning_effort 那两个直接 502。所以这里只认这一种写法。
  yinlianyun: {
    label: '银联云',
    baseUrl: 'https://llm.code-tool.com:8443/yinlianyun/v1',
    model: 'deepseek-v4-flash',
    keyEnv: 'YINLIANYUN_API_KEY',
    timeoutMs: 30_000,
    noThinkBody: { thinking: { type: 'disabled' } },
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

/**
 * 这次失败是不是被内容安全审查拦下来的。
 *
 * 值得单独认出来，因为它和别的失败**性质完全不同**，而且很隐蔽：上层老老实实
 * 退回规则策略，牌桌照常进行，只有 fallback 率悄悄往上走，没人会去看日志。
 *
 * 两种都见过，处理方式相反：
 *   常驻  我们自己的文本里有它不收的词，每次必拦。位置名里的「枪口位」就是这种
 *         （见 decide.js#positionName），改词才能恢复。
 *   偶发  多轮工具循环里，模型自己生成的思维链和工具参数会被原样发回去，
 *         那些字也要过审。实测同一道题跑 4 次、3 次通过 1 次被拦，我们一个字没改。
 *         这种只能退避重试。
 *
 * 各家网关的报法不一样：HTTP 451、或者 200 里塞一个 content_filter 的错误体。
 * 所以状态码和文本两头都认。
 *
 * @param {unknown} err  ProviderError 或 AI SDK 的 APICallError，都能认
 */
export function isContentFilterError(err) {
  if (!err || typeof err !== 'object') return false;
  const status = err.status ?? err.statusCode ?? null;
  if (status === 451) return true;
  const text = `${err.message || ''} ${err.responseBody || ''}`;
  return /content_filter|内容安全|安全审查/.test(text);
}

export class LLMClient {
  /**
   * @param {object} opts
   * @param {string} opts.provider   PROVIDERS 的键（kimi / deepseek / yinlianyun）
   * @param {string} opts.apiKey
   * @param {string} [opts.baseUrl]  覆盖默认接入点（自建代理 / 海外站点时用）
   * @param {string} [opts.model]
   * @param {number} [opts.timeoutMs] 单次请求超时，默认取供应商预设，没有则 8000
   * @param {'on'|'off'} [opts.thinking] 关思维链。默认 on（照原样带着）。
   *                                     预设里没有 noThinkBody 就关不掉，这时
   *                                     this.thinking 会照实停在 'on'
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
    this.timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : (preset.timeoutMs ?? 8000);

    // 关掉思维链要往请求体里加的字段；on 的时候是 null，请求体一个字都不变。
    // 关不掉的家就停在 'on' —— 这个字段是**实际发生了什么**，不是**要求了什么**，
    // 上层（日志、status()）照它显示才不会骗人。
    this.noThinkBody = opts.thinking === 'off' ? (preset.noThinkBody || null) : null;
    this.thinking = this.noThinkBody ? 'off' : 'on';
    this.canDisableThinking = !!preset.noThinkBody;
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
          // 三家都支持 OpenAI 的 JSON 模式。注意 DeepSeek 要求提示词里
          // 出现 "json" 字样才会进入该模式，prompt.js 里已经满足。
          response_format: { type: 'json_object' },
          temperature: 0.7,
          max_tokens: maxTokens,
          stream: false,
          ...(this.noThinkBody || {}),
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
 *   POKER_BOT_PROVIDER   kimi | deepseek | yinlianyun | auto（默认 auto：有哪个 key 用哪个）
 *   KIMI_API_KEY / DEEPSEEK_API_KEY / YINLIANYUN_API_KEY
 *   POKER_BOT_MODEL      覆盖模型名
 *   POKER_BOT_BASE_URL   覆盖接入点
 *   POKER_BOT_TIMEOUT_MS 单次请求超时，不填就按供应商预设（多数是 8000）
 *   POKER_BOT_THINKING   on（默认）| off。off = 让模型别想，直接答
 *
 * @param {object} [env] 默认 process.env，测试时可注入
 * @returns {LLMClient[]} 可能为空（没配 key 就没有 LLM 人机，只能用规则人机）
 */
export function clientsFromEnv(env = process.env) {
  const want = (env.POKER_BOT_PROVIDER || 'auto').toLowerCase();
  // 不填就传 undefined，让每家自己的预设生效（银联云那种推理模型要 30 秒）
  const timeoutMs = Number(env.POKER_BOT_TIMEOUT_MS) || undefined;
  const thinking = String(env.POKER_BOT_THINKING || 'on').toLowerCase() === 'off' ? 'off' : 'on';

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
    const client = new LLMClient({
      provider: name,
      apiKey,
      model: env.POKER_BOT_MODEL || undefined,
      baseUrl: env.POKER_BOT_BASE_URL || undefined,
      timeoutMs,
      thinking,
    });
    // 要求关却关不掉，得说一声。这两家的默认模型本来就不带思维链，
    // 所以这行多半只是提示"这个开关对它没意义"，而不是出了错。
    if (thinking === 'off' && client.thinking !== 'off') {
      console.error(`[bot] ${client.label} 没有已知的关思维链开关，仍按原样调用`);
    }
    out.push(client);
  }
  return out;
}
