// SPDX-License-Identifier: GPL-3.0-or-later
//
// 跨手牌的对手画像。
//
// 这是 agent 版人机相对原来那版最实质的增量。原来每次决策只看得见**本手**的
// 行动序列（快照里的 table.history），手牌一结束就全忘了。可德扑里「这个人是谁」
// 比「我这手牌多大」更值钱——同样一手中对，对着一个 VPIP 70% 的疯子该跟，
// 对着一个只玩前 10% 起手牌的石头该弃。
//
// 三条硬约束：
//
//   1. **只吃 buildStateFor 的输出**，和 decide.js 是同一条红线。别人的底牌在
//      快照里是 "??"，只有摊牌被公开揭示后才是真牌。所以这里记下来的东西，
//      全都是牌桌上任何一个人用眼睛也能看到的信息——不存在作弊。
//
//   2. **幂等**。同一手牌里人机要决策好几次，每次都会看到同一份（越来越长的）
//      history。靠 cursor 只吸收没见过的那几个动作，重复调用不会把数字翻倍。
//
//   3. **按昵称索引**，不是按座位也不是按玩家 id（快照里本来就没有 id）。
//      这其实是对的：人机建模的是「那个叫老陈的人」，换个座位还是他，
//      这和真人玩家的做法一致。代价是同名玩家会被并成一个——朋友局里可以接受。
//
// 内存是有界的：只留最近 MAX_PLAYERS 个玩家，每人只留最近 MAX_SHOWDOWNS 次摊牌。

/** 最多记住多少个玩家（超了淘汰最久没出现的） */
const MAX_PLAYERS = 32;
/** 每人最多留多少条摊牌记录 */
const MAX_SHOWDOWNS = 6;

const STREETS = ['preflop', 'flop', 'turn', 'river'];

/**
 * 位置档。翻牌前范围最强的单一解释变量就是位置——同一个人在前位和按钮位的
 * 入池率能差一倍还多。不拆位置的话，这两者会被平均成一个谁也不像的 VPIP。
 *
 * 只有四档，不是六个具体位置：样本要够用。一桌 6 人打 30 手，每个人在每个具体
 * 位置只有 5 手，那种 VPIP 是噪声不是画像。四档下每档能攒到两三倍的样本。
 */
const POSITIONS = Object.freeze(['early', 'middle', 'late', 'blinds']);

/** 参与了本手牌的座位状态（弃了牌也算——位置是发牌那一刻定的） */
const IN_HAND = new Set(['in', 'allin', 'folded']);

/**
 * 这个座位这手牌坐在哪一档位置。
 *
 * 只用公开字段：座位状态 + isBB / isSB / isButton。人数不定（2~8），所以按
 * **离庄位多远**分档，而不是套 6-max 的位置名：
 *
 *   庄位、庄位前一个   -> late     （有绝对位置，范围最宽）
 *   两个盲位           -> blinds   （已经投了钱，范围和别人不是一回事）
 *   其余对半分         -> middle / early
 *
 * 单挑时两个人都是盲位，这时位置由庄位决定而不由这一档，返回 blinds 即可。
 *
 * @returns {string|null} null = 这手牌信息不全，推不出来（就不进分档统计）
 */
export function positionOf(state, seat) {
  const seats = Array.isArray(state?.seats) ? state.seats : [];
  const live = seats.filter((x) => x && IN_HAND.has(x.state)).map((x) => x.seat);
  live.sort((a, b) => a - b);
  const n = live.length;
  if (n < 2) return null;
  const si = live.indexOf(seat);
  if (si < 0) return null;

  // 盲位：快照里有标记就直接用
  const marked = seats.find((x) => x && x.seat === seat);
  if (marked && (marked.isSB || marked.isBB)) return 'blinds';

  // 庄位：手牌结束后 isSB / isBB 会失效，但 isButton 不依赖 hand，一直可读
  const btn = seats.find((x) => x && x.isButton && live.includes(x.seat));
  if (!btn) return null;
  const bi = live.indexOf(btn.seat);

  // 走到这里说明快照没把这个座位标成盲位 —— 可能它真不是，也可能是手牌已经
  // 结束、isSB/isBB 失效了。自己按庄位推一遍：庄位后面两个是小盲、大盲，
  // 单挑时庄位本身就是小盲。
  const blinds = n === 2
    ? [live[bi], live[(bi + 1) % n]]
    : [live[(bi + 1) % n], live[(bi + 2) % n]];
  if (blinds.includes(seat)) return 'blinds';

  const nonBlind = n - 2;
  if (nonBlind <= 0) return 'blinds';
  const dist = (bi - si + n) % n;        // 0 = 自己就是庄位
  if (dist <= 1) return 'late';
  // 剩下的人对半分，靠前的算 early
  return (dist - 2) < (nonBlind - 2) / 2 ? 'middle' : 'early';
}

/** 一个位置档的空白计数 */
function blankPos() {
  const out = {};
  for (const k of POSITIONS) out[k] = { hands: 0, vpip: 0, pfr: 0 };
  return out;
}

/** 一个新玩家的空白档案 */
function blankProfile(name) {
  return {
    name,
    lastSeen: 0,
    /** 见过他参与的手牌数（本手有任何动作就算） */
    hands: 0,
    /** 翻牌前主动投钱的手数（跟注/加注/全下，盲注不算） */
    vpip: 0,
    /** 翻牌前加注的手数 */
    pfr: 0,
    /** 翻牌后主动下注或加注的次数 */
    aggro: 0,
    /** 翻牌后跟注的次数 */
    passive: 0,
    /** 面对下注的次数（可以弃牌的局面） */
    faced: 0,
    /** 面对下注选择弃牌的次数 */
    folded: 0,
    /** 走到摊牌的次数 */
    showdowns: 0,
    /** 最近几次摊牌亮出来的牌 {cards, handName, won, wasAggressor} */
    shown: [],
    /**
     * 按位置档拆开的翻牌前统计。**只拆翻牌前**（hands/vpip/pfr）：
     * 位置对开池范围的影响是压倒性的，而翻牌后的激进度、弃牌率更像是性格，
     * 位置解释力小得多。全都拆四份只会把每个数的样本砍到四分之一，
     * 换来一堆噪声。
     */
    pos: blankPos(),
  };
}

export class OpponentMemory {
  constructor(opts = {}) {
    this.maxPlayers = opts.maxPlayers ?? MAX_PLAYERS;
    /** @type {Map<string, ReturnType<typeof blankProfile>>} */
    this.players = new Map();

    /** 当前正在吸收的手牌号；换手时结算上一手的 per-hand 标记 */
    this.handNo = null;
    /** 每条街已经吸收到第几个动作，用来做幂等 */
    this.cursor = Object.create(null);
    /** 本手牌的临时标记：谁 vpip 了、谁 pfr 了、谁弃牌了 */
    this.pending = new Map();
    /** 本手牌的摊牌是不是已经记过了 */
    this.showdownDone = false;
    /** 单调递增的时钟，用来做 LRU 淘汰 */
    this.tick = 0;
  }

  /** 拿（或新建）一个人的档案 */
  #get(name) {
    let p = this.players.get(name);
    if (!p) {
      p = blankProfile(name);
      this.players.set(name, p);
      this.#evict();
    }
    p.lastSeen = ++this.tick;
    return p;
  }

  /** 超出上限时淘汰最久没出现的那个 */
  #evict() {
    if (this.players.size <= this.maxPlayers) return;
    let oldestKey = null;
    let oldest = Infinity;
    for (const [k, v] of this.players) {
      if (v.lastSeen < oldest) { oldest = v.lastSeen; oldestKey = k; }
    }
    if (oldestKey !== null) this.players.delete(oldestKey);
  }

  /** 本手牌的临时标记 */
  #pending(name) {
    let f = this.pending.get(name);
    if (!f) {
      f = { acted: false, vpip: false, pfr: false, folded: false, lastAggroStreet: null, pos: null };
      this.pending.set(name, f);
    }
    return f;
  }

  /**
   * 把上一手牌的 per-hand 标记结算进长期档案。
   * 换手牌时调用一次，之后清空。
   */
  #commitHand() {
    for (const [name, f] of this.pending) {
      if (!f.acted) continue;              // 这手他压根没轮到过，不计入分母
      const p = this.#get(name);
      p.hands++;
      if (f.vpip) p.vpip++;
      if (f.pfr) p.pfr++;
      // 位置推不出来（信息不全）就只进总账，不进分档——宁可少一条也不要脏数据
      const bucket = f.pos && p.pos[f.pos];
      if (bucket) {
        bucket.hands++;
        if (f.vpip) bucket.vpip++;
        if (f.pfr) bucket.pfr++;
      }
    }
    this.pending.clear();
    this.cursor = Object.create(null);
    this.showdownDone = false;
  }

  /**
   * 从一份快照里吸收新信息。**可以随便重复调用。**
   *
   * @param {object} state Room#buildStateFor(...) 的输出。viewer 传谁都行，
   *                       这里只读公开字段（history / seats 的公开部分）。
   */
  observe(state) {
    const table = state?.table;
    if (!table) return;

    const handNo = Number(table.handNo) || 0;
    if (this.handNo !== null && handNo !== this.handNo) {
      this.#commitHand();               // 换手了，先把上一手结算掉
    }
    this.handNo = handNo;

    const nameOf = (seat) => {
      const s = state.seats?.[seat];
      return s && typeof s.name === 'string' ? s.name : null;
    };

    // ---- 补位置 ----
    // 下面的行动扫描靠 cursor 只看新动作，所以一个人的位置只有在他**第一次**
    // 被扫到的那一刻有机会填。那一刻要是快照缺庄位标记（推不出来），之后就再也
    // 补不上了 —— 除非他又行动一次。这里先无条件补一遍：便宜（最多 8 个座位），
    // 而且把「第一次没推出来」和「永远没有位置」这两件事分开。
    for (const s of Array.isArray(state.seats) ? state.seats : []) {
      if (!s || typeof s.name !== 'string') continue;
      const f = this.pending.get(s.name);
      if (!f || f.pos) continue;
      f.pos = positionOf(state, s.seat);
    }

    // ---- 行动序列：只处理还没吸收过的部分 ----
    const history = Array.isArray(table.history) ? table.history : [];
    for (const st of history) {
      const street = st?.street;
      if (!STREETS.includes(street)) continue;
      const acts = Array.isArray(st.acts) ? st.acts : [];
      const from = this.cursor[street] || 0;

      // 「面对下注」的判定：本条街在我之前有人 bet/raise/allin。
      // 从头扫是因为要知道第 i 个动作发生时有没有人已经开火了。
      let aggressive = street === 'preflop';   // 翻牌前大盲本身就是一注
      for (let i = 0; i < acts.length; i++) {
        const a = acts[i];
        const name = nameOf(a?.seat);
        const isRaise = a?.type === 'bet' || a?.type === 'raise' || a?.type === 'allin';

        if (i >= from && name) {
          const f = this.#pending(name);
          f.acted = true;
          // 位置一手牌只推一次；推不出来（比如快照缺庄位标记）下次再试
          if (!f.pos) f.pos = positionOf(state, a.seat);
          const p = this.#get(name);

          if (street === 'preflop') {
            if (a.type === 'call' || isRaise) f.vpip = true;
            if (a.type === 'raise' || a.type === 'allin') f.pfr = true;
          } else {
            if (isRaise) { p.aggro++; f.lastAggroStreet = street; }
            else if (a.type === 'call') p.passive++;
          }

          // 面对下注时的弃牌率。check 不算「面对下注」，所以只在
          // 前面已经有人开火的情况下统计。
          if (aggressive) {
            p.faced++;
            if (a.type === 'fold') { p.folded++; f.folded = true; }
          }
        }

        if (isRaise) aggressive = true;
      }
      this.cursor[street] = acts.length;
    }

    // ---- 摊牌：谁亮了什么牌 ----
    // 快照里没被揭示的底牌是 "??"，所以这里天然只看得到公开信息。
    //
    // 两道护栏，缺一不可：
    //   - 只在 showdown / handOver 阶段记。别的阶段就算看得见牌，那也只可能是
    //     「看快照的人自己的牌」，不是摊牌。
    //   - 跳过 you.seat。人机决策时拿到的快照里，它自己的底牌是明文的——
    //     不排掉的话它每次决策都会把自己记成一次摊牌，画像全是自己的牌。
    const phase = table.phase;
    const canShowdown = phase === 'showdown' || phase === 'handOver';
    if (canShowdown && !this.showdownDone && Array.isArray(state.seats)) {
      const mySeat = state.you?.seat;
      let any = false;
      for (const s of state.seats) {
        if (!s || !Array.isArray(s.cards)) continue;
        if (s.seat === mySeat) continue;
        if (s.cards.length !== 2) continue;
        if (s.cards.some((c) => typeof c !== 'string' || c === '??')) continue;
        any = true;
        const p = this.#get(s.name);
        p.showdowns++;
        p.shown.push({
          hand: s.cards.join(' '),
          handName: s.handName || null,
          won: !!s.isWinner,
          // 他是最后一条街主动开火的人吗——用来分辨「价值下注」和「诈唬」
          wasAggressor: this.pending.get(s.name)?.lastAggroStreet || null,
        });
        if (p.shown.length > MAX_SHOWDOWNS) p.shown.shift();
      }
      if (any) this.showdownDone = true;
    }
  }

  /**
   * 取一个人的画像。样本太少时返回 null——报一个 2 手牌算出来的
   * 「VPIP 100%」比不报更糟，模型会当真。
   *
   * @param {string} name
   * @param {number} [minHands] 少于这么多手就不给结论，默认 6
   * @param {number} [minPosHands] 某个位置档少于这么多手就不单独报，默认 4
   */
  profile(name, minHands = 6, minPosHands = 4) {
    const p = this.players.get(name);
    if (!p) return null;
    if (p.hands < minHands && p.showdowns === 0) return null;

    const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : null);

    // 分档统计：样本太少的档直接不给。这里的门槛（4 手）比总账的 6 手低——
    // 分档天然样本少，全按 6 手卡就永远出不来；作为交换，每档都带上自己的
    // hands，让读的人（模型）自己按样本量打折。
    const byPos = {};
    for (const [k, v] of Object.entries(p.pos)) {
      if (v.hands < minPosHands) continue;
      byPos[k] = { hands: v.hands, vpip: pct(v.vpip, v.hands), pfr: pct(v.pfr, v.hands) };
    }

    return {
      name: p.name,
      hands: p.hands,
      vpip: pct(p.vpip, p.hands),
      pfr: pct(p.pfr, p.hands),
      // 激进度：翻牌后（下注+加注）/ 跟注。>2 算凶，<1 算被动。
      af: p.passive > 0 ? Math.round((p.aggro / p.passive) * 10) / 10
        : (p.aggro > 0 ? null : 0),
      foldToBet: pct(p.folded, p.faced),
      showdowns: p.showdowns,
      shown: p.shown.slice(-3),
      // 按位置拆开的翻牌前入池 / 加注率。只有攒够样本的档才在这里。
      byPos: Object.keys(byPos).length ? byPos : null,
    };
  }

  /**
   * 忘掉一个人。
   *
   * 人机离座时**必须**调这个：档案按昵称索引，而人机的名字来自 persona.js 里
   * 一个只有 20 个名字的固定池子。老陈（很紧那个）走了以后，下一个人机迟早会
   * 重新抽到「老陈」——那时候它是另一套随机特质，却会继承前一个老陈的 VPIP、
   * 弃牌率和摊牌记录。名字池比座位多不了多少，长跑的服务器上这是必然，不是巧合。
   *
   * 真人不走这条路：他们自己挑名字、会重连、也希望画像跨手牌活着，
   * 同名撞车是 memory.js 顶上写明的既定取舍。
   *
   * @param {string} name
   * @returns {boolean} 之前有没有这个人的档案
   */
  forget(name) {
    if (typeof name !== 'string') return false;
    this.pending.delete(name);
    return this.players.delete(name);
  }

  /** 有档案的人数 */
  get size() {
    return this.players.size;
  }

  /** 清空（换桌 / 测试用） */
  reset() {
    this.players.clear();
    this.pending.clear();
    this.cursor = Object.create(null);
    this.handNo = null;
    this.showdownDone = false;
  }
}

export default OpponentMemory;
