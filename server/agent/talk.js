// SPDX-License-Identifier: GPL-3.0-or-later
//
// 人机的闲聊，交给语言模型，**在动作之后异步生成**。
//
// Jev 不生成文字，所以走 Jev 的人机原本不说话。这里把 say 拆出来单独问一次 LLM：
// 动作先落地，话晚两三秒到聊天区，牌桌不等它。和原来「动作和话在同一次调用里」相比，
// 唯一的损失是话来得慢一点；换来的是决策不被闲聊拖住。
//
// **这条路上没有底牌。** 原来 say 和动作出自同一次调用，模型手里有底牌，靠 cleanSay
// 在事后拦「亮牌」的句子。现在提示词里根本不给底牌 —— 它只知道公开信息和自己刚做的
// 动作，想亮也亮不出来。cleanSay 仍然过一遍，那是第二道保险。
//
// 说不说话由人格的 talk 维度定（quiet / normal / chatty），按概率抽，不是每手都问：
// 每问一次就是一次 LLM 调用，而话痨人机在真桌上也很烦。

import { buildSystem, cleanSay, sanitizeName, positionName } from '../bot/decide.js';

/** 各话风每次行动开口的概率。开火（下注 / 加注 / 全下）时翻倍，最高 0.9 */
const TALK_RATE = Object.freeze({ quiet: 0.12, normal: 0.3, chatty: 0.55 });

const PHASE_CN = { preflop: '翻牌前', flop: '翻牌', turn: '转牌', river: '河牌' };
const ACTION_CN = { fold: '弃牌', check: '过牌', call: '跟注', bet: '下注', raise: '加注', allin: '全下' };

function prettyCard(c) {
  if (typeof c !== 'string' || c.length !== 2) return '??';
  const suit = { s: '♠', h: '♥', d: '♦', c: '♣' }[c[1]] || c[1];
  return (c[0] === 'T' ? '10' : c[0]) + suit;
}

/**
 * 这一次要不要开口。
 *
 * @param {object} persona
 * @param {{type:string}} action 刚做的动作
 * @param {() => number} [rand]  测试注入
 */
export function shouldTalk(persona, action, rand = Math.random) {
  const style = persona?.traits?.talk;
  let rate = TALK_RATE[style] ?? TALK_RATE.normal;
  if (action && ['bet', 'raise', 'allin'].includes(action.type)) rate = Math.min(0.9, rate * 2);
  return rand() < rate;
}

/**
 * 给 LLM 的用户提示词：公开局面 + 自己刚做的动作。**不含底牌，不含聊天记录。**
 *
 * @param {object} state   决策时用的那份脱敏快照
 * @param {object} persona
 * @param {{type:string, amount?:number}} action
 */
export function buildTalkUser(state, persona, action) {
  const { table, seats, you, config } = state;
  const inHand = seats
    .filter((s) => s && ['in', 'folded', 'allin'].includes(s.state))
    .map((s) => s.seat);
  const me = seats[you.seat];
  const others = seats
    .filter((s) => s && s.seat !== you.seat && ['in', 'allin', 'folded'].includes(s.state))
    .map((s) => `${sanitizeName(s.name)}（${positionName(s.seat, inHand, table.buttonSeat) || '在座'}` +
      `${s.state === 'folded' ? '，已弃牌' : s.state === 'allin' ? '，全下' : ''}）`);
  const board = Array.isArray(table.board) && table.board.length ? table.board.map(prettyCard).join(' ') : '还没发';
  const act = `${ACTION_CN[action?.type] || action?.type || '行动'}${action?.amount ? ` ${action.amount}` : ''}`;
  const last = (Array.isArray(table.history) ? table.history : []).slice(-1)[0];
  const lastActs = last?.acts?.slice(-3).map((a) => {
    const s = seats[a.seat];
    const who = s ? sanitizeName(s.name) : `座位${a.seat + 1}`;
    return `${who}${ACTION_CN[a.type] || a.type}${a.amount ? a.amount : ''}`;
  }) || [];

  return [
    `你是「${sanitizeName(persona?.name || (me ? me.name : '人机'))}」，刚在牌桌上做了一个动作，现在说一句话（也可以不说）。`,
    `阶段：${PHASE_CN[table.phase] || table.phase}，公共牌：${board}，底池 ${table.totalPot}，盲注 ${config?.smallBlind}/${config?.bigBlind}。`,
    `你刚才：${act}。你的筹码 ${me ? me.chips : 0}。`,
    lastActs.length ? `这条街最近几手：${lastActs.join('，')}。` : '',
    others.length ? `桌上其他人：${others.join('，')}。` : '',
    '',
    '只输出一个 JSON 对象：{"say": "一句话"}。say 最多 20 字，可以是空字符串表示不说。',
    // 房主的界面是英文时，桌上人多半看不懂中文；话按桌子的语言说
    table?.lang === 'en' ? 'The table speaks English: write "say" in casual, natural English (at most 20 words).' : '',
    '聊气氛、调侃对手、说你要干什么都行；**一个字都不许提你自己的牌**（底牌、牌型、听牌、胜率、是不是在诈唬）。',
    '不要解释，不要加别的字段。',
  ].filter((l) => l !== '').join('\n');
}

/**
 * 问 LLM 要一句话。任何失败都返回 null，绝不抛。
 *
 * @param {object} args
 * @param {{completeJSON:Function, label?:string}} args.client  bot/provider.js 的 LLMClient
 * @param {object} args.state
 * @param {object} args.persona
 * @param {object} args.action
 * @param {AbortSignal} [args.signal]
 * @param {object} [args.logger]
 * @returns {Promise<string|null>}
 */
export async function askForSay({ client, state, persona, action, signal, logger }) {
  if (!client || typeof client.completeJSON !== 'function') return null;
  try {
    const raw = await client.completeJSON({
      system: buildSystem(persona),
      user: buildTalkUser(state, persona, action),
      maxTokens: 120,
      signal,
    });
    const { say, note } = cleanSay(raw?.say);
    if (note) logger?.error?.(`[talk] ${persona?.name || '人机'} ${note}`);
    return say || null;
  } catch (e) {
    logger?.error?.(`[talk] ${persona?.name || '人机'} 闲聊生成失败：${e.message}`);
    return null;
  }
}
