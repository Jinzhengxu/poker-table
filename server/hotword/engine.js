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
//    想看具体的词就得用「偷看」，代价是冻自己一段时间、而且一局只有两次。
//
// 3. 【提示是共享的，谁把它推开谁多冻一会儿】
//    见 HINT_TIERS 上面那段长注释。这是改过一次的地方，改回去之前先读完。

/** 一局的阶段 */
export const HW_PHASE = Object.freeze({
  WAITING: 'waiting',
  PLAYING: 'playing',
  OVER: 'over',
});

/** 擂台位只有两个：这是 1v1，其余人都是观众 */
export const HW_SEATS = 2;

/**
 * 每次猜词之间的冷却。没有它，赢家是打字快的人而不是想得对的人。
 * 一局只有 90 秒，3 秒冷却只够猜 30 次、太紧，所以压到 1.5 秒。
 */
export const GUESS_COOLDOWN_MS = 1500;

/** 偷看一次，自己多少毫秒不能猜 */
export const PEEK_FREEZE_MS = 8000;

/** 一局里最多偷看几次 */
export const PEEK_LIMIT = 2;

/**
 * 一局最长多久，到点没人猜中就流局、公布答案。
 *
 * 原来没有这个东西，一局能无限拖下去——两边都不动的时候，没有任何力量推动局面。
 * 90 秒是照着"能被完整看完、能录成一段短视频"选的：开局给字数，四分之一处给
 * 类别（节奏的油门），五分之三处给首字，然后收。
 */
export const ROUND_LIMIT_MS = 90_000;

/** 房主能把一局设成多长。下限防止短到没法玩，上限是"还算一局"的边界 */
export const ROUND_LIMIT_MIN_MS = 30_000;
export const ROUND_LIMIT_MAX_MS = 600_000;

/** 一个词最多几个字。词表里最长就是 4 个字 */
export const MAX_WORD_LEN = 8;

/**
 * 提示按【时间】解锁，不看谁猜了多少次。
 *
 * 这里改过两次，想改回去之前把两次都读完。
 *
 * 第一版"按自己的次数解锁"有个必胜解：一次猜测的唯一成本是冷却，猜什么词都算数，
 * 所以无脑刷满三档只要 87 秒。而三档合起来几乎就是答案——实测答案池里 92% 的词
 * 能被 (类别 + 字数 + 首字) 唯一确定。"不动脑刷 90 秒"严格优于"想"。
 *
 * 第二版改成"按双方猜得多的那一边解锁、两人共享、推开的人多冻一会儿"。刷次数
 * 确实不赚了，代价却是【认真打也挨罚】：拿到类别之后顺着候选往下试的人，试到第
 * 11 个就撞开首字、白送给对手。引擎数的是次数，它分不清刷和想。于是均衡变成两边
 * 贴着阈值停手——都停在 19 次，而第三档（防僵局的阀门）永远没人愿意推开，僵局
 * 反而锁死了。
 *
 * 现在按时间：谁也拦不住、谁也加速不了。刷不出提示，也拖不掉提示，阀门到点自己开。
 * 猜词回到纯赚——只给你自己涨信息、不泄露任何东西给对手，那套"推开的人多冻 8 秒"
 * 的惩罚机械也跟着删了，没有存在的理由了。
 *
 * 刷词会不会卷土重来？不会。刷只剩下拿排名，而随便扔的常用词基本都在一万名开外，
 * 信息量接近零；顺着梯度想一个词的收益远高于乱猜十个。它从必胜解降级成弱策略。
 *
 * 三档的顺序是按含金量排的（在 403 个答案上实测）：
 *   字数   403 → 311 候选，唯一确定  0.2%   350/403 都是 2 字词，几乎白给，所以开局就给
 *   类别   403 →  25 候选，唯一确定  0.0%   油门：知道类别之后，同类别里最好的那个词
 *                                          中位数排到第 5 名、100% 进前 100
 *   首字   403 → 1.6 候选，唯一确定 65.5%   收尾的阀门，它自己就几乎是答案
 *
 * at 是【占本局时长的比例】而不是绝对秒数：房主把一局从 90 秒改成 3 分钟的时候
 * 三档得跟着一起拉开，否则按 90 秒定的绝对档位配 3 分钟的局，等于开局全给。
 */
export const HINT_TIERS = Object.freeze([
  { at: 0,    key: 'len',      label: '字数' },
  { at: 0.25, key: 'category', label: '类别' },
  { at: 0.6,  key: 'first',    label: '首字' },
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

/** 回合时长夹到合法区间。没给或给了脏值就用默认的 90 秒 */
function clampRoundLimit(ms) {
  if (!Number.isFinite(ms)) return ROUND_LIMIT_MS;
  return Math.min(ROUND_LIMIT_MAX_MS, Math.max(ROUND_LIMIT_MIN_MS, Math.floor(ms)));
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
   * @param {number} [opts.peekLimit]     一局最多偷看几次
   * @param {number} [opts.roundLimitMs]  一局最长多久，到点流局
   * @param {boolean} [opts.hintsEnabled] 这桌开不开提示
   */
  constructor({
    vectors, answer, no = 1, now = Date.now(),
    cooldownMs, peekFreezeMs, peekLimit, roundLimitMs, hintsEnabled,
  }) {
    this.vectors = vectors;
    this.cooldownMs = Number.isFinite(cooldownMs) ? cooldownMs : GUESS_COOLDOWN_MS;
    this.peekFreezeMs = Number.isFinite(peekFreezeMs) ? peekFreezeMs : PEEK_FREEZE_MS;
    this.peekLimit = Number.isFinite(peekLimit) ? peekLimit : PEEK_LIMIT;
    this.roundLimitMs = clampRoundLimit(roundLimitMs);
    this.hintsEnabled = hintsEnabled !== false;
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

  /** 这一局什么时候到点 */
  get deadline() {
    return this.startedAt + this.roundLimitMs;
  }

  /** 还剩多少毫秒。局已结束就是 0 */
  msLeft(now = Date.now()) {
    if (this.isOver) return 0;
    return Math.max(0, this.deadline - now);
  }

  /**
   * 到点没人猜中就流局。room 每秒调一次；每个动作之前也调一次——
   * 不然定时器慢半拍的那零点几秒里还能落一手，看着像"我明明猜中了"。
   * @returns {boolean} 这一次调用是不是把局判死了
   */
  timeUp(now = Date.now()) {
    if (this.isOver || now < this.deadline) return false;
    this.finish(null, 'timeout', now);
    return true;
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
    this.timeUp(now);
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
    // 猜测不再触发任何共享后果：提示是时间给的，猜多猜少只影响你自己
    return { ok: true, entry, win: false };
  }

  /**
   * 偷看对手【目前最好的】那一次猜测。代价是自己一段时间不能猜，一局限两次。
   * 对手还没出手的时候不收费——没东西可看。
   *
   * 这里有两处改过，一起改的：
   *
   * 给"最好的"而不是"最近的"——最近一次很可能只是往新方向探的一枪，
   * 最好的一次才是对手真正站的位置。偷看要值这个冻结时间，给的就得是位置。
   *
   * 冻结从 15 秒降到 8 秒、加了次数上限——15 秒等于 5 次猜测，而提示共享之后
   * 终局是提示一落地就抢答、几秒定生死，那个节奏里花 15 秒等于自杀。
   * 降价让它从"永远不划算"变成"什么时候用"，次数封顶防止改完之后被当饭吃。
   */
  peek(seat, now = Date.now()) {
    this.timeUp(now);
    if (this.isOver) return { ok: false, code: 'ROUND_OVER', msg: '这一局已经结束了' };
    if (seat !== 0 && seat !== 1) return { ok: false, code: 'ILLEGAL_ACTION', msg: '只有擂台上的两位能偷看' };
    if (this.peekCount[seat] >= this.peekLimit) {
      return { ok: false, code: 'PEEK_USED_UP', msg: `一局只能偷看 ${this.peekLimit} 次，你用完了` };
    }
    const foe = seat === 0 ? 1 : 0;
    const list = this.guesses[foe];
    if (!list.length) return { ok: false, code: 'NOTHING_TO_PEEK', msg: '对手还没猜过，没什么可看的' };

    let best = list[0];
    for (const g of list) if (g.rank < best.rank) best = g;
    this.peeked[seat] = { word: best.word, rank: best.rank, temp: best.temp, heat: best.heat, at: now };
    this.peekCount[seat] += 1;
    // 取 max 而不是累加：已经在冷却里再偷看，重新计一次，连着偷看就是一直冻着
    this.nextGuessAt[seat] = Math.max(this.nextGuessAt[seat], now + this.peekFreezeMs);
    return {
      ok: true,
      peeked: this.peeked[seat],
      freezeMs: this.nextGuessAt[seat] - now,
      left: this.peeksLeft(seat),
    };
  }

  /** 这个位子还剩几次偷看 */
  peeksLeft(seat) {
    if (seat !== 0 && seat !== 1) return 0;
    return Math.max(0, this.peekLimit - this.peekCount[seat]);
  }

  /**
   * 某一档在本局的第几毫秒解锁（at 是比例，见 HINT_TIERS 的注释）。
   * 对齐到整秒：0.25×90 秒是 22.5 秒，战况里写"23 秒到"就差了半秒，
   * 页面上的倒计时也会卡在半秒上不去。
   */
  hintAtMs(tier) {
    return Math.round((tier.at * this.roundLimitMs) / 1000) * 1000;
  }

  /**
   * 本局解锁了哪些提示。跟座位无关也跟猜了几次无关——只看开局到现在过了多久，
   * 所以两个人任何时刻拿到的都是同一份。
   */
  hints(now = Date.now()) {
    if (!this.hintsEnabled) return [];
    const elapsed = Math.max(0, now - this.startedAt);
    const out = [];
    for (const tier of HINT_TIERS) {
      const atMs = this.hintAtMs(tier);
      if (elapsed < atMs) {
        // inMs 是相对时长，不是时间戳：客户端的钟跟服务端不一定对得上
        out.push({ key: tier.key, label: tier.label, atMs, inMs: atMs - elapsed, locked: true, value: null });
        continue;
      }
      let value = null;
      if (tier.key === 'len') value = `${[...this.answer].length} 个字`;
      else if (tier.key === 'category') value = this.category;
      else if (tier.key === 'first') value = [...this.answer][0];
      out.push({ key: tier.key, label: tier.label, atMs, inMs: 0, locked: false, value });
    }
    return out;
  }

  resign(seat, now = Date.now()) {
    this.timeUp(now);
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
