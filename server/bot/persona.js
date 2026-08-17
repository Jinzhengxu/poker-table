// SPDX-License-Identifier: GPL-3.0-or-later
//
// 人机人格：随机组合生成，每个人机都不一样。
//
// 特质是**结构化的**，不只是给提示词看的一段话：
//   - style 文本进提示词，LLM 靠它演；
//   - traits 同时被 policy.js 读取，用来偏移规则兜底的阈值。
// 这样 API 挂掉退回规则时，"松凶"的人机不会突然打得像块石头。

import { randomInt } from 'node:crypto';

/** 名字池。够 8 个座位随机取而不撞名。 */
const NAMES = Object.freeze([
  '老陈', '小杨', '阿May', '老K', '静静', '大刘', '阿宽', '胖虎',
  '眼镜', '老白', '小鱼', '阿飞', '波哥', '豆豆', '老默', '闷子',
  '阿珍', '铁子', '小满', '老炮',
]);

/**
 * 各维度的取值。`w` 是权重（越大越常见），`d` 是写进提示词的描述。
 * 权重让"中间派"多一些，极端风格少一些——一桌全是疯子就不好玩了。
 */
const DIMENSIONS = Object.freeze({
  // 入池范围
  range: [
    { v: 'tight',  w: 3, d: '入池范围很紧，只玩强起手牌' },
    { v: 'medium', w: 4, d: '入池范围中等，位置好时会放宽一些' },
    { v: 'loose',  w: 3, d: '入池范围很宽，什么牌都想看一眼翻牌' },
  ],
  // 主动下注/加注的倾向
  aggression: [
    { v: 'passive', w: 3, d: '很少主动加注，更喜欢跟着看' },
    { v: 'balanced', w: 4, d: '该下注时下注，不无谓施压' },
    { v: 'aggro',   w: 3, d: '喜欢用加注施压，经常抢底池' },
  ],
  // 诈唬频率
  bluff: [
    { v: 'never',     w: 3, d: '几乎不诈唬，下重注基本代表真有牌' },
    { v: 'sometimes', w: 4, d: '偶尔诈唬，主要在牌面适合的时候' },
    { v: 'often',     w: 3, d: '经常诈唬，牌不好也敢开火' },
  ],
  // 面对大注的反应
  pressure: [
    { v: 'folds', w: 3, d: '被大幅加注时倾向弃牌，不喜欢打大池' },
    { v: 'calls', w: 4, d: '牌力够就跟到底，不轻易被赶走' },
    { v: 'fights', w: 3, d: '被施压时会反打回去，不吃诈唬' },
  ],
  // 话风（只影响 say 字段，不影响动作）
  talk: [
    { v: 'quiet',  w: 4, d: '话很少，多数时候不说话' },
    { v: 'normal', w: 3, d: '偶尔说一句，语气平和' },
    { v: 'chatty', w: 3, d: '爱聊天爱调侃，赢了会得意，输了会抱怨' },
  ],
});

/** 按权重随机取一项，用 node:crypto 的 randomInt 保证无偏 */
function weightedPick(options) {
  const total = options.reduce((s, o) => s + o.w, 0);
  let r = randomInt(total);
  for (const o of options) {
    if (r < o.w) return o;
    r -= o.w;
  }
  return options[options.length - 1];
}

/**
 * 生成一个随机人格。
 *
 * @param {Set<string>|string[]} [usedNames] 已经在桌上的名字，避免撞名
 * @returns {{name:string, traits:object, style:string}|null}
 *   名字用完了返回 null（理论上到不了，名字池比座位多得多）
 */
export function randomPersona(usedNames = []) {
  const used = usedNames instanceof Set ? usedNames : new Set(usedNames);
  const pool = NAMES.filter((n) => !used.has(n));
  if (!pool.length) return null;

  const name = pool[randomInt(pool.length)];

  const traits = {};
  const phrases = [];
  for (const [dim, options] of Object.entries(DIMENSIONS)) {
    const picked = weightedPick(options);
    traits[dim] = picked.v;
    phrases.push(picked.d);
  }

  return { name, traits, style: phrases.join('；') + '。' };
}

/**
 * 特质 -> 规则策略的阈值偏移。
 *
 * 返回的三个值都是「相对默认值的偏移」，由 policy.js 应用：
 *   raiseThreshold  加注所需强度的偏移（负 = 更爱加注）
 *   callThreshold   跟注所需胜率的偏移（负 = 更爱跟注）
 *   betSize         下注尺度的乘数（>1 = 下得更大）
 *
 * @param {object} [traits]
 */
export function traitBias(traits) {
  const t = traits || {};
  let raiseThreshold = 0;
  let callThreshold = 0;
  let betSize = 1;

  if (t.range === 'tight') { raiseThreshold += 0.05; callThreshold += 0.05; }
  if (t.range === 'loose') { raiseThreshold -= 0.05; callThreshold -= 0.05; }

  if (t.aggression === 'passive') { raiseThreshold += 0.10; betSize *= 0.85; }
  if (t.aggression === 'aggro')   { raiseThreshold -= 0.10; betSize *= 1.15; }

  if (t.bluff === 'never') raiseThreshold += 0.05;
  if (t.bluff === 'often') raiseThreshold -= 0.08;

  if (t.pressure === 'folds')  callThreshold += 0.08;
  if (t.pressure === 'fights') callThreshold -= 0.08;

  return { raiseThreshold, callThreshold, betSize };
}

/** 供测试与文档使用 */
export const PERSONA_DIMENSIONS = DIMENSIONS;
export const PERSONA_NAMES = NAMES;
