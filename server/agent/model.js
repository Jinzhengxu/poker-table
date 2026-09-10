// SPDX-License-Identifier: GPL-3.0-or-later
//
// 把 server/bot/provider.js 里那套供应商预设，接到 AI SDK 的模型对象上。
//
// 为什么不直接复用 LLMClient：那个类是自己拼 fetch 的，只会 chat/completions +
// JSON 模式，没有 tool calling。agent 版需要多轮工具调用，所以走 AI SDK 的
// openai-compatible provider —— Kimi、DeepSeek、银联云都是 OpenAI 兼容接口，
// 同一个 provider 工厂改 baseURL 就够了。
//
// **供应商预设仍然只有一份**（PROVIDERS 在 bot/provider.js 里），
// 这边只是换了个调用方式，不要在这里再抄一份接入点和默认模型。
//
// 注意：agent 需要模型**支持 function calling**。预设里的默认模型不一定是
// 最合适的那个，可以用 POKER_AGENT_MODEL 覆盖。模型不支持工具时，
// 这一路会调用失败，然后由 index.js 退回原来的 BotDriver。
//
// 另外这边【没有】单次请求超时可言：AI SDK 那侧不设超时，整条决策链只被
// POKER_AGENT_MAX_MS 一个墙钟闸门管着。所以接银联云这类带思维链的模型时，
// 要调的是 POKER_AGENT_MAX_MS，不是 POKER_BOT_TIMEOUT_MS（那个只管单轮版）。

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { PROVIDERS } from '../bot/provider.js';

/**
 * 造一个 AI SDK 的语言模型对象。
 *
 * @param {object} opts
 * @param {string} opts.provider  PROVIDERS 的键（kimi / deepseek / yinlianyun）
 * @param {string} opts.apiKey
 * @param {string} [opts.model]
 * @param {string} [opts.baseUrl]
 * @param {'on'|'off'} [opts.thinking] 关思维链，默认 on
 * @returns {{provider:string, label:string, model:string, apiKey:string,
 *            thinking:'on'|'off', providerOptions:object|null,
 *            languageModel:import('ai').LanguageModel}}
 */
export function buildModel(opts) {
  const preset = PROVIDERS[opts?.provider];
  if (!preset) throw new Error(`未知的 LLM 供应商: ${opts?.provider}`);
  if (!opts.apiKey) throw new Error(`${preset.label} 缺少 API key`);

  const modelId = opts.model || preset.model;
  const baseURL = (opts.baseUrl || preset.baseUrl).replace(/\/+$/, '');

  const provider = createOpenAICompatible({
    name: opts.provider,
    baseURL,
    apiKey: opts.apiKey,
  });

  // 关思维链。AI SDK 这边没有专门的参数，但 openai-compatible 会把
  // providerOptions[供应商名] 里它不认识的键【原样摊进请求体】，
  // 所以预设里那份 noThinkBody 在两条路上是同一份，不用抄第二遍。
  // 关不掉的家就停在 on，和单轮那路的口径一致：这个字段说的是实际发生了什么。
  const noThinkBody = opts.thinking === 'off' ? (preset.noThinkBody || null) : null;

  return {
    provider: opts.provider,
    label: preset.label,
    model: modelId,
    apiKey: opts.apiKey,
    baseUrl: baseURL,
    thinking: noThinkBody ? 'off' : 'on',
    providerOptions: noThinkBody ? { [opts.provider]: { ...noThinkBody } } : null,
    languageModel: provider(modelId),
  };
}

/**
 * 从环境变量装配模型列表。键的读法和 bot/provider.js 的 clientsFromEnv 一致，
 * 这样切到 agent 不用改任何已有的部署配置。
 *
 *   POKER_BOT_PROVIDER   kimi | deepseek | yinlianyun | auto（默认 auto）
 *   KIMI_API_KEY / DEEPSEEK_API_KEY / YINLIANYUN_API_KEY
 *   POKER_AGENT_MODEL    覆盖模型名（agent 专用，要支持 function calling）
 *   POKER_BOT_MODEL      同上，POKER_AGENT_MODEL 没给时的退路
 *   POKER_BOT_BASE_URL   覆盖接入点
 *   POKER_BOT_THINKING   on（默认）| off
 *
 * @param {object} [env]
 * @returns {ReturnType<typeof buildModel>[]} 可能为空（没配 key）
 */
export function modelsFromEnv(env = process.env) {
  const want = (env.POKER_BOT_PROVIDER || 'auto').toLowerCase();
  const wanted = want === 'auto' ? Object.keys(PROVIDERS) : [want];
  const out = [];

  for (const name of wanted) {
    const preset = PROVIDERS[name];
    if (!preset) {
      console.error(`[agent] 未知的 POKER_BOT_PROVIDER: ${name}`);
      continue;
    }
    const apiKey = env[preset.keyEnv];
    if (!apiKey) {
      if (want !== 'auto') console.error(`[agent] 已指定 ${name} 但没有设置 ${preset.keyEnv}`);
      continue;
    }
    try {
      out.push(buildModel({
        provider: name,
        apiKey,
        model: env.POKER_AGENT_MODEL || env.POKER_BOT_MODEL || undefined,
        baseUrl: env.POKER_BOT_BASE_URL || undefined,
        thinking: String(env.POKER_BOT_THINKING || 'on').toLowerCase(),
      }));
    } catch (e) {
      console.error(`[agent] 装配 ${name} 失败：${e.message}`);
    }
  }
  return out;
}
