// SPDX-License-Identifier: GPL-3.0-or-later
//
// 「热词」一局的状态机：两个人猜同一个词，谁先猜中谁赢。
//
// 这个文件不认识 WebSocket 也不认识计时器，只认识"第几号位在什么时刻猜了什么"，
// 所有时间都从参数传进来（now），所以测试里不用 sleep 也能把冷却、偷看、
// 提示解锁全部跑一遍。计时器和广播在 room.js。
//
// 设计上的两个关键取舍，改之前先读一遍：
//
// 1. 【给排名，不给相似度百分比】
//    不同目标词的相似度尺度差很多：「咖啡」最近的邻居是 0.80，「台风」最近的
//    只有 0.63。给玩家看 0.63 他会以为自己很差，其实那已经是最接近的词了。
//    排名是尺度无关的——第 7 名就是第 7 名。温度只是排名的对数映射，用来画条。
//
// 2. 【自己看得见排名，对手只看得见温度】
//    全公开的话后手纯搭便车，全隐藏的话就是两个人各玩各的单机。
//    折中：对手那侧只有"猜了几次 + 当前最好温度"，词看不见；
//    想看具体的词就得用「偷看」，代价是自己 15 秒不能猜。

/** 一局的阶段 */
export const HW_PHASE = Object.freeze({
  WAITING: 'waiting',
  PLAYING: 'playing',
  OVER: 'over',
});

/** 擂台位只有两个：这是 1v1，其余人都是观众 */
export const HW_SEATS = 2;

/** 每次猜词之间的冷却。没有它，赢家是打字快的人而不是想得对的人 */
export const GUESS_COOLDOWN_MS = 3000;

/** 偷看一次，自己多少毫秒不能猜 */
export const PEEK_FREEZE_MS = 15000;

/** 一个词最多几个字。词表里最长就是 4 个字 */
export const MAX_WORD_LEN = 8;

/**
 * 提示按【自己】猜的次数解锁，不看对手。
 * 按对手的进度解锁会出现"我想要提示但队友不动"的憋屈；按自己的次数解锁是
 * 对称规则，而且有 3 秒冷却顶着，多猜就是花时间，本身就是代价。
 */
export const HINT_TIERS = Object.freeze([
  { at: 10, key: 'len', label: '字数' },
  { at: 20, key: 'category', label: '类别' },
  { at: 30, key: 'first', label: '首字' },
]);

/**
 * 排名 -> 温度（0-100）。对数映射：越靠前每一名越值钱。
 * 第 1 名 100 度，第 10 名 79 度，第 100 名 58 度，第 1000 名 36 度，一万名开外 15 度。
 */
export function tempOf(rank, vocabSize) {
  if (rank <= 1) return 100;
  if (rank >= vocabSize) return 0;
  const t = 100 * (1 - Math.log(rank) / Math.log(vocabSize));
  return Math.max(0, Math.min(100, Math.round(t * 10) / 10));
}

/** 排名 -> 一个字的档位，画温度条的颜色和文案都用它 */
export function heatOf(rank) {
  if (rank <= 1) return 'hit';
  if (rank <= 10) return 'burning';
  if (rank <= 50) return 'hot';
  if (rank <= 200) return 'warm';
  if (rank <= 1000) return 'mild';
  if (rank <= 5000) return 'cool';
  return 'cold';
}

/** 把玩家输进来的东西收拾干净：去空白、去标点式的空格 */
export function normalizeWord(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\s　]+/g, '').trim();
}

export class HotwordRound {
  /**
   * @param {object} opts
   * @param {import('./vectors.js').WordVectors} opts.vectors
   * @param {{word:string, category:string}} opts.answer
   * @param {number} opts.no      第几局
   * @param {number} opts.now
   * @param {number} [opts.cooldownMs]    猜词冷却，房主可改
   * @param {number} [opts.peekFreezeMs]  偷看一次冻自己多久
   */
  constructor({ vectors, answer, no = 1, now = Date.now(), cooldownMs, peekFreezeMs }) {
    this.vectors = vectors;
    this.cooldownMs = Number.isFinite(cooldownMs) ? cooldownMs : GUESS_COOLDOWN_MS;
    this.peekFreezeMs = Number.isFinite(peekFreezeMs) ? peekFreezeMs : PEEK_FREEZE_MS;
    this.answer = answer.word;
    this.category = answer.category || '其他';
    this.no = no;
    this.startedAt = now;
    this.phase = HW_PHASE.PLAYING;

    this.rank = vectors.rankTable(this.answer);
    /** 与答案互为子串的词，本局当作生僻词处理（见 vectors.relatedForms 的注释） */
    this.hidden = vectors.relatedForms(this.answer);

    /** @type {{word:string, rank:number, temp:number, heat:string, at:number}[][]} */
    this.guesses = [[], []];
    /** 每个位子的最好排名（1 最好），没猜过是 null */
    this.best = [null, null];
    /** 冷却到什么时候 */
    this.nextGuessAt = [0, 0];
    /** 偷到的对手最近一次猜测（只存最后一次，页面上显示到本局结束） */
    this.peeked = [null, null];
    this.peekCount = [0, 0];

    /** @type {null|{winner:number|null, reason:string, at:number}} */
    this.result = null;
  }

  get isOver() {
    return this.phase === HW_PHASE.OVER;
  }

  /** 这个词在本局可不可以拿来算排名 */
  #known(word) {
    const i = this.vectors.index.get(word);
    if (i === undefined) return -1;
    if (this.hidden.has(i)) return -1;
    return i;
  }

  /**
   * 猜一次。
   * @returns {{ok:true, entry:object, win:boolean}|{ok:false, code:string, msg:string, waitMs?:number, entry?:object}}
   */
  guess(seat, raw, now = Date.now()) {
    if (this.isOver) return { ok: false, code: 'ROUND_OVER', msg: '这一局已经结束了' };
    if (seat !== 0 && seat !== 1) return { ok: false, code: 'ILLEGAL_ACTION', msg: '只有擂台上的两位能猜' };

    const word = normalizeWord(raw);
    if (!word) return { ok: false, code: 'WORD_EMPTY', msg: '先打个词' };
    if ([...word].length > MAX_WORD_LEN) {
      return { ok: false, code: 'WORD_TOO_LONG', msg: '词太长了，猜的是词不是句子' };
    }

    // 重复猜不罚冷却，但也不白给一次机会——把上次的结果再返回一遍
    const already = this.guesses[seat].find((g) => g.word === word);
    if (already) return { ok: false, code: 'ALREADY_GUESSED', msg: '这个词你已经猜过了', entry: already };

    const idx = this.#known(word);
    // 生僻词不计次数、不进冷却：词表覆盖不到的词罚玩家是没道理的
    if (idx < 0) return { ok: false, code: 'NOT_IN_VOCAB', msg: '不认识这个词，换一个' };

    if (now < this.nextGuessAt[seat]) {
      return { ok: false, code: 'COOLING', msg: '手慢点', waitMs: this.nextGuessAt[seat] - now };
    }

    const r = this.rank[idx] + 1; // 存的是 0 起，对外一律 1 起
    const entry = { word, rank: r, temp: tempOf(r, this.vectors.size), heat: heatOf(r), at: now };
    this.guesses[seat].push(entry);
    if (this.best[seat] === null || r < this.best[seat]) this.best[seat] = r;
    this.nextGuessAt[seat] = now + this.cooldownMs;

    if (word === this.answer) {
      this.finish(seat, 'guessed', now);
      return { ok: true, entry, win: true };
    }
    return { ok: true, entry, win: false };
  }

  /**
   * 偷看对手最近一次猜的词。代价是自己 15 秒不能猜。
   * 对手还没出手的时候不收费——没东西可看。
   */
  peek(seat, now = Date.now()) {
    if (this.isOver) return { ok: false, code: 'ROUND_OVER', msg: '这一局已经结束了' };
    if (seat !== 0 && seat !== 1) return { ok: false, code: 'ILLEGAL_ACTION', msg: '只有擂台上的两位能偷看' };
    const foe = seat === 0 ? 1 : 0;
    const list = this.guesses[foe];
    if (!list.length) return { ok: false, code: 'NOTHING_TO_PEEK', msg: '对手还没猜过，没什么可看的' };

    const last = list[list.length - 1];
    this.peeked[seat] = { word: last.word, rank: last.rank, temp: last.temp, heat: last.heat, at: now };
    this.peekCount[seat] += 1;
    // 取 max 而不是累加：已经在冷却里再偷看，重新计 15 秒，连着偷看就是一直冻着
    this.nextGuessAt[seat] = Math.max(this.nextGuessAt[seat], now + this.peekFreezeMs);
    return { ok: true, peeked: this.peeked[seat], freezeMs: this.nextGuessAt[seat] - now };
  }

  /** 这个位子解锁了哪些提示 */
  hints(seat) {
    if (seat !== 0 && seat !== 1) return [];
    const n = this.guesses[seat].length;
    const out = [];
    for (const tier of HINT_TIERS) {
      if (n < tier.at) {
        out.push({ key: tier.key, label: tier.label, at: tier.at, locked: true, value: null });
        continue;
      }
      let value = null;
      if (tier.key === 'len') value = `${[...this.answer].length} 个字`;
      else if (tier.key === 'category') value = this.category;
      else if (tier.key === 'first') value = [...this.answer][0];
      out.push({ key: tier.key, label: tier.label, at: tier.at, locked: false, value });
    }
    return out;
  }

  resign(seat, now = Date.now()) {
    if (this.isOver) return { ok: false, code: 'ROUND_OVER', msg: '这一局已经结束了' };
    if (seat !== 0 && seat !== 1) return { ok: false, code: 'ILLEGAL_ACTION', msg: '你不在擂台上' };
    this.finish(seat === 0 ? 1 : 0, 'resign', now);
    return { ok: true };
  }

  /** winner 为 null 就是流局（比如有人中途离座） */
  finish(winner, reason, now = Date.now()) {
    if (this.isOver) return;
    this.phase = HW_PHASE.OVER;
    this.result = { winner, reason, at: now };
  }

  /** 对手和观众看到的那一份：只有次数和温度，没有词 */
  publicSeat(seat) {
    const best = this.best[seat];
    return {
      guessCount: this.guesses[seat].length,
      bestRank: this.isOver ? best : null,
      bestTemp: best === null ? null : tempOf(best, this.vectors.size),
      bestHeat: best === null ? null : heatOf(best),
      peekCount: this.peekCount[seat],
      frozen: false, // room 按当前时间填
    };
  }
}
