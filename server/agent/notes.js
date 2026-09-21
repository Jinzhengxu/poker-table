// SPDX-License-Identifier: GPL-3.0-or-later
//
// 读人笔记：手牌结束后让语言模型给对手写一句英文小结，下一手喂进 Jev 的 state。
//
// 这是 Jev 和 LLM 的分工里最有意思的一块。Jev 是「一秒内的直觉」，它不会从十二手牌的
// 摊牌记录里归纳出「这个人转牌爱半诈唬、河牌被加注就弃」；LLM 会，但它慢，一次十几秒，
// 放在决策路径上就是那个 35 秒的 agent。把它挪到**手牌之间**，就没有延迟压力了：
// 笔记写好了下一手用，没写好就先用统计数字。
//
// 输入只有公开信息：OpponentMemory 里的画像（入池率、加注率、激进度、弃牌率）和
// 亮过的摊牌。决策时看不见的牌这里也看不见 —— 记忆本身就是按旁观者视角喂的。
//
// 节流：一个对手至少隔 everyHands 手才重写一次，而且只在有新摊牌时才写（没有新证据
// 的话上一条笔记不会变）。同一时刻最多 inflight 个请求在飞，超时就丢，绝不阻塞任何东西。

/** 笔记的最大长度（字符）。超了截断 —— 它要进 Jev 的 state，越短越好 */
const MAX_NOTE = 240;

export class OpponentNotes {
  /**
   * @param {object} opts
   * @param {() => object[]} opts.clients   返回当前可用的 LLMClient 列表（可能为空）
   * @param {import('./memory.js').OpponentMemory} opts.memory
   * @param {number} [opts.everyHands]  同一对手两次重写之间至少隔几手，默认 4
   * @param {number} [opts.timeoutMs]   单次请求超时，默认 20000（不在决策路径上，可以慢）
   * @param {number} [opts.inflight]    同时最多几个请求，默认 2
   * @param {object} [opts.logger]
   */
  constructor(opts) {
    this.clients = opts.clients;
    this.memory = opts.memory;
    this.everyHands = Math.max(1, Number(opts.everyHands) || 4);
    this.timeoutMs = Math.max(1000, Number(opts.timeoutMs) || 20_000);
    this.maxInflight = Math.max(1, Number(opts.inflight) || 2);
    this.logger = opts.logger || console;
    /** name -> {note, hands, showdowns, at} */
    this.notes = new Map();
    /** name -> 正在写 */
    this.pending = new Set();
    this.stats = { written: 0, errors: 0, skipped: 0 };
  }

  /** 某个对手当前的笔记，没有就是 null */
  get(name) {
    return this.notes.get(name)?.note || null;
  }

  /** 人机离座 / 画像被清时一起清 */
  forget(name) {
    this.notes.delete(name);
  }

  /**
   * 手牌结束时调。挑出「有新摊牌、且隔够了手数」的对手，后台去写。
   * 同步返回，不等任何请求。
   *
   * @param {object} state  手牌结束时的旁观者快照（Room 已经喂过 memory）
   */
  onHandEnd(state) {
    const clients = typeof this.clients === 'function' ? this.clients() : [];
    if (!clients?.length) return;
    const seats = Array.isArray(state?.seats) ? state.seats : [];
    for (const s of seats) {
      if (!s || !s.name || s.bot) continue;             // 只给真人写笔记：人机的打法是固定人格，写了也没意义
      if (this.pending.size >= this.maxInflight) return;
      const p = this.memory.profile(s.name);
      if (!p) continue;
      const prev = this.notes.get(s.name);
      const newShowdowns = (p.showdowns || 0) > (prev?.showdowns || 0);
      const dueByHands = !prev || p.hands - prev.hands >= this.everyHands;
      if (!newShowdowns || !dueByHands || this.pending.has(s.name)) {
        this.stats.skipped++;
        continue;
      }
      this.#write(clients[0], s.name, p);
    }
  }

  async #write(client, name, profile) {
    this.pending.add(name);
    try {
      const raw = await client.completeJSON({
        system: buildNotesSystem(),
        user: buildNotesUser(profile),
        maxTokens: 200,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const note = typeof raw?.note === 'string' ? raw.note.replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE) : '';
      if (note) {
        this.notes.set(name, { note, hands: profile.hands, showdowns: profile.showdowns || 0, at: Date.now() });
        this.stats.written++;
      }
    } catch (e) {
      this.stats.errors++;
      this.logger.error(`[notes] 给 ${name} 写笔记失败：${e.message}`);
    } finally {
      this.pending.delete(name);
    }
  }
}

/** 系统提示词。要求 JSON，DeepSeek 的 JSON 模式需要提示词里出现 "json" 字样 */
export function buildNotesSystem() {
  return 'You are a poker coach. From an opponent\'s statistics and the hands they have shown down, ' +
    'write ONE short note (at most 40 words, English) describing how this player tends to play: ' +
    'how wide they enter pots, whether their bets are usually strong, whether they fold to pressure, ' +
    'and anything a decision model should know before facing them. Be concrete; do not repeat the raw numbers. ' +
    'Reply with a JSON object only: {"note": "..."}';
}

/**
 * 用户提示词：画像 + 摊牌。全是公开信息。
 * @param {ReturnType<import('./memory.js').OpponentMemory['profile']>} p
 */
export function buildNotesUser(p) {
  const pct = (v) => (v === null || v === undefined ? 'n/a' : `${v}%`);
  const lines = [
    `Opponent: ${p.name}. Hands observed: ${p.hands}.`,
    `VPIP ${pct(p.vpip)}, preflop raise ${pct(p.pfr)}, postflop aggression factor ${p.af ?? 'n/a'}, fold to bet ${pct(p.foldToBet)}.`,
  ];
  if (p.byPos) {
    const parts = Object.entries(p.byPos).map(([k, v]) => `${k}: ${v.hands} hands, VPIP ${pct(v.vpip)}, PFR ${pct(v.pfr)}`);
    lines.push(`By position: ${parts.join('; ')}.`);
  }
  if (Array.isArray(p.shown) && p.shown.length) {
    lines.push('Showdowns (most recent last):');
    for (const s of p.shown) {
      lines.push(`- held ${s.hand}${s.handName ? ` (${s.handName})` : ''}, ${s.won ? 'won' : 'lost'}` +
        `${s.wasAggressor ? `, was the aggressor on the ${s.wasAggressor}` : ''}`);
    }
  } else {
    lines.push('No showdowns seen yet.');
  }
  lines.push('Write the note as JSON: {"note": "..."}');
  return lines.join('\n');
}

export default OpponentNotes;
