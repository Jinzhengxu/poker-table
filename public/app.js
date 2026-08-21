// SPDX-License-Identifier: GPL-3.0-or-later
/* =========================================================================
   德州扑克 · 前端逻辑
   - 只消费服务端下发的 {t:'state'} 全量快照，按快照重绘整个界面
   - {t:'event'} 只用于音效与短暂动画，不作为状态来源
   - 无框架、无构建、无外部资源
   ========================================================================= */
(function () {
  'use strict';

  // ============================ 常量 ============================

  var MAX_SEATS = 8;

  /** 座位在牌桌上的百分比坐标（x 按牌桌宽、y 按牌桌高），由 computeSeats()
   *  按当前桌形算出来；这里的初值只是 buildSeats() 先用一下。
   *  bx/by 是这个座位的下注筹码摆放点，落在下注线内侧。 */
  var POS = [
    { x: 50.0, y: 95.0, bx: 50, by: 74 },
    { x: 21.0, y: 92.0, bx: 32, by: 74 },
    { x: 5.5,  y: 50.0, bx: 24, by: 50 },
    { x: 21.0, y: 8.0,  bx: 32, by: 26 },
    { x: 50.0, y: 5.0,  bx: 50, by: 26 },
    { x: 79.0, y: 8.0,  bx: 68, by: 26 },
    { x: 94.5, y: 50.0, bx: 76, by: 50 },
    { x: 79.0, y: 92.0, bx: 68, by: 74 }
  ];

  /* 牌桌是跑道形（racetrack）：两条长边是直线，两端是半圆。座位就贴着这条
     轮廓摆，长边各 3 人、两端各 1 人。轮廓随窗口比例变（手机竖屏时跑道会
     立起来），所以坐标不能写死成百分比，得按当前尺寸现算。 */

  // 毡面相对牌桌盒子的内缩，必须和 style.css 里 .rail 的 inset 一致
  var RAIL_INSET_X = 0.055;
  var RAIL_INSET_Y = 0.05;
  // 斜角座位落在"四分之一圈"的什么位置（0 = 长边正中，1 = 端点正中）
  var SEAT_U = 0.5;
  // 下注筹码摆在座位到桌心的这个比例上
  var BET_PULL = 0.57;

  /** 每个槽位：走到四分之一圈的哪儿（u），以及往哪个象限镜像（sx/sy） */
  var SEAT_SLOTS = [
    { u: 0,      sx: 1,  sy: 1 },
    { u: SEAT_U, sx: 1,  sy: 1 },
    { u: 1,      sx: 1,  sy: 1 },
    { u: SEAT_U, sx: 1,  sy: -1 },
    { u: 0,      sx: 1,  sy: -1 },
    { u: SEAT_U, sx: -1, sy: -1 },
    { u: 1,      sx: -1, sy: 1 },
    { u: SEAT_U, sx: -1, sy: 1 }
  ];

  /** 从"正下方"沿轮廓往左走 u 个四分之一圈，返回相对桌心的像素偏移
   *  和该处的朝外法线。横向跑道：先走直边再拐弯；竖向跑道：反过来。 */
  function outlineQuarter(u, horizontal, r, s) {
    var arc = Math.PI * r / 2;
    var a = u * (s + arc);
    var t;
    if (horizontal) {
      if (a <= s) return { dx: -a, dy: r, nx: 0, ny: 1 };
      t = (a - s) / r;
      return {
        dx: -s - r * Math.sin(t), dy: r * Math.cos(t),
        nx: -Math.sin(t), ny: Math.cos(t)
      };
    }
    if (a <= arc) {
      t = a / r;
      return {
        dx: -r * Math.sin(t), dy: s + r * Math.cos(t),
        nx: -Math.sin(t), ny: Math.cos(t)
      };
    }
    return { dx: -r, dy: s - (a - arc), nx: -1, ny: 0 };
  }

  /** 按牌桌当前像素尺寸重算 POS */
  function computeSeats(w, h) {
    var rw = w * (1 - 2 * RAIL_INSET_X);
    var rh = h * (1 - 2 * RAIL_INSET_Y);
    var horizontal = rw >= rh;
    var r = Math.min(rw, rh) / 2;
    var s = (Math.max(rw, rh) - 2 * r) / 2;
    // 座位牌骑在桌沿上，但不能整块悬在桌外：按它在法线方向上的宽/高
    // 各往桌里收一点，两端的座位（横着的胶囊）自然收得多些。
    var podW = Math.min(122, Math.max(60, w * 0.158));
    var podH = podW * 0.42;
    for (var k = 0; k < SEAT_SLOTS.length; k++) {
      var m = SEAT_SLOTS[k];
      var q = outlineQuarter(m.u, horizontal, r, s);
      var pull = 0.9 * (podW / 2) * Math.abs(q.nx) + 0.35 * (podH / 2) * Math.abs(q.ny);
      var dx = (q.dx - q.nx * pull) * m.sx;
      var dy = (q.dy - q.ny * pull) * m.sy;
      POS[k].x = (0.5 + dx / w) * 100;
      POS[k].y = (0.5 + dy / h) * 100;
      POS[k].bx = (0.5 + dx * BET_PULL / w) * 100;
      POS[k].by = (0.5 + dy * BET_PULL / h) * 100;
    }
  }

  /** 把算好的坐标写回座位节点 */
  function applySeatPos() {
    for (var i = 0; i < S.seatNodes.length; i++) {
      var n = S.seatNodes[i];
      var p = POS[i];
      if (!n || !p) continue;
      n.root.style.setProperty('--x', p.x.toFixed(2) + '%');
      n.root.style.setProperty('--y', p.y.toFixed(2) + '%');
      n.bet.style.setProperty('--bx', p.bx.toFixed(2) + '%');
      n.bet.style.setProperty('--by', p.by.toFixed(2) + '%');
    }
  }

  // U+FE0E 强制文本呈现，避免部分系统把花色渲染成彩色 emoji
  var SUIT_CH = { s: '♠︎', h: '♥︎', d: '♦︎', c: '♣︎' };

  var PHASE_TXT = {
    waiting: '等待开局',
    preflop: '翻牌前',
    flop: '翻牌',
    turn: '转牌',
    river: '河牌',
    showdown: '摊牌',
    handOver: '本手结束'
  };

  var LS_TOKEN = 'poker_token';
  var LS_NAME = 'poker_name';
  // 人机后端配置存在房主自己的浏览器里，方便服务重启后一键重发。
  // 注意：这是明文存在 localStorage 的，只在你自己信任的设备上勾"记住 key"。
  var LS_BOT = 'poker_bot_cfg';
  var LS_MUTED = 'poker_muted';
  var LS_MUSIC = 'poker_music';

  // ============================ 小工具 ============================

  function $(sel, root) { return (root || document).querySelector(sel); }

  function elt(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  }

  function clamp(v, lo, hi) {
    v = Number(v);
    if (!isFinite(v)) v = lo;
    return Math.min(hi, Math.max(lo, v));
  }

  /** 千分位显示，避免大数字看不清 */
  function fmt(n) {
    n = Math.round(Number(n) || 0);
    var s = String(Math.abs(n));
    s = s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (n < 0 ? '-' : '') + s;
  }

  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* 隐私模式忽略 */ } }

  /** 筹码面额表（大到小）。tier 对应 .chip[data-tier] 的配色：
   *  白 1 / 红 5 / 绿 25 / 蓝 100 / 黑 500 / 金 1000，照赌场惯例。 */
  var DENOMS = [
    { v: 1000, tier: 5 },
    { v: 500,  tier: 4 },
    { v: 100,  tier: 3 },
    { v: 25,   tier: 2 },
    { v: 5,    tier: 1 },
    { v: 1,    tier: 0 }
  ];

  /** 把金额换成筹码：从大面额开始找零，总枚数封顶在 max（不然一万块要摆几百枚）。
   *  返回 [{tier, n}]，大面额在前。 */
  function chipSplit(amount, max) {
    amount = Math.max(0, Math.round(Number(amount) || 0));
    max = max || 6;
    var out = [];
    var used = 0;
    for (var i = 0; i < DENOMS.length && used < max; i++) {
      var n = Math.floor(amount / DENOMS[i].v);
      if (n <= 0) continue;
      n = Math.min(n, max - used);
      amount -= n * DENOMS[i].v;
      used += n;
      out.push({ tier: DENOMS[i].tier, n: n });
    }
    // 下注了却一枚都摆不出来最难看，兜一枚最小面额
    if (!out.length) out.push({ tier: 0, n: 1 });
    return out;
  }

  /** 把金额画成若干摞筹码塞进 host；签名没变就不重建 DOM。
   *  perStack 是一摞最多几枚，超了就另起一摞。 */
  function renderChipPile(host, amount, max, perStack) {
    if (!host) return;
    var parts = chipSplit(amount, max);
    var sig = String(amount) + '|' + max + '|' + perStack;
    if (host.__sig === sig) return;
    host.__sig = sig;
    host.textContent = '';
    for (var i = 0; i < parts.length; i++) {
      var left = parts[i].n;
      while (left > 0) {
        var n = Math.min(left, perStack);
        left -= n;
        var stack = elt('i', 'chip-stack');
        stack.style.setProperty('--n', String(n));
        for (var k = 0; k < n; k++) {
          var c = elt('i', 'chip');
          c.setAttribute('data-tier', String(parts[i].tier));
          c.style.setProperty('--i', String(k));
          stack.appendChild(c);
        }
        host.appendChild(stack);
      }
    }
  }

  // ============================ 客户端状态 ============================

  /** 语音连麦（public/voice.js）。掼蛋那边用的是同一份代码、另一个频道。 */
  var voice = null;

  var S = {
    ws: null,
    conn: 'connecting',       // connecting | online | offline
    backoff: 500,
    reconnectTimer: null,
    pingTimer: null,
    fatal: null,              // 非空表示不再自动重连
    state: null,              // 最近一次 {t:'state'} 快照
    playerId: null,
    mySeat: null,
    clockOffset: 0,           // serverNow - Date.now()
    muted: lsGet(LS_MUTED) === '1',
    // 背景音乐默认开着；受自动播放策略限制，实际要等第一次点击才真的响
    musicOn: lsGet(LS_MUSIC) !== '0',
    raiseOpen: false,
    raiseMin: 0,
    raiseMax: 0,
    raiseVal: 0,
    pendingAction: false,
    pendingTimer: null,
    lastActingKey: '',
    shownResultHand: -1,
    resultOverlayHand: -1,    // 结算大屏已经为哪一手弹过
    resultHideTimer: null,
    resultHideAt: 0,          // 结算大屏预计什么时候退场（推池动画等它）
    logSeen: null,
    chatSeen: null,
    chatUnread: 0,
    sitSeat: null,
    lastBets: {},
    lastPot: 0,
    seatNodes: [],
    ringNode: null            // 当前正在行动座位的倒计时环
  };

  // ============================ DOM 引用 ============================

  var D = {};

  function cacheDom() {
    D.root = document.documentElement;
    D.connBadge = $('#connBadge');
    D.connText = $('#connText');
    D.metaHand = $('#metaHand');
    D.metaBlinds = $('#metaBlinds');
    D.metaHost = $('#metaHost');
    D.btnSound = $('#btnSound');
    D.btnMusic = $('#btnMusic');
    D.btnSide = $('#btnSide');
    D.sideBadge = $('#sideBadge');
    D.btnVoice = $('#btnVoice');
    D.voiceMount = $('#voiceMount');
    D.voiceDock = $('#voiceDock');

    D.tableWrap = $('#tableWrap');
    D.table = $('#table');
    D.seatLayer = $('#seatLayer');
    D.betLayer = $('#betLayer');
    D.chipLayer = $('#chipLayer');
    D.floatLayer = $('#floatLayer');
    D.phaseTag = $('#phaseTag');
    D.potRow = $('#potRow');
    D.potMain = $('#potMain');
    D.potPile = $('#potPile');
    D.potSide = $('#potSide');
    D.board = $('#board');
    D.resultOverlay = $('#resultOverlay');
    D.roHandEn = $('#roHandEn');
    D.roHandCn = $('#roHandCn');
    D.roVerdict = $('#roVerdict');
    D.roAmount = $('#roAmount');
    D.roDetail = $('#roDetail');
    D.roCards = $('#roCards');
    D.roOthers = $('#roOthers');
    D.nextHandTip = $('#nextHandTip');

    D.heroCards = $('#heroCards');
    D.heroStatusText = $('#heroStatusText');
    D.heroTimer = $('#heroTimer');
    D.heroTimerBar = $('#heroTimerBar');
    D.actionBar = $('#actionBar');
    D.showBar = $('#showBar');
    D.btnShowCards = $('#btnShowCards');
    D.btnFold = $('#btnFold');
    D.btnCheck = $('#btnCheck');
    D.btnCall = $('#btnCall');
    D.btnRaise = $('#btnRaise');
    D.btnAllin = $('#btnAllin');
    D.raisePanel = $('#raisePanel');
    D.raiseRange = $('#raiseRange');
    D.raiseNum = $('#raiseNum');
    D.btnRaiseOk = $('#btnRaiseOk');
    D.btnRaiseCancel = $('#btnRaiseCancel');
    D.idleBar = $('#idleBar');
    D.btnStart = $('#btnStart');
    D.btnRebuy = $('#btnRebuy');
    D.btnSitOut = $('#btnSitOut');
    D.btnStand = $('#btnStand');
    D.btnJoin = $('#btnJoin');

    D.side = $('#side');
    D.drawerMask = $('#drawerMask');
    D.logList = $('#logList');
    D.chatList = $('#chatList');
    D.chatForm = $('#chatForm');
    D.chatInput = $('#chatInput');
    D.cfgForm = $('#cfgForm');
    D.cfgHostOnly = $('#cfgHostOnly');
    D.cfgSB = $('#cfgSB');
    D.cfgBB = $('#cfgBB');
    D.cfgAnte = $('#cfgAnte');
    D.cfgStack = $('#cfgStack');
    D.cfgTimeout = $('#cfgTimeout');
    D.cfgAuto = $('#cfgAuto');
    D.btnReset = $('#btnReset');
    D.btnAddBot = $('#btnAddBot');
    D.botForm = $('#botForm');
    D.botStatus = $('#botStatus');
    D.botProvider = $('#botProvider');
    D.botKey = $('#botKey');
    D.botModel = $('#botModel');
    D.botRemember = $('#botRemember');
    D.seatAdmin = $('#seatAdmin');

    D.sitDlg = $('#sitDlg');
    D.sitTitle = $('#sitTitle');
    D.sitName = $('#sitName');
    D.sitErr = $('#sitErr');
    D.confirmDlg = $('#confirmDlg');
    D.confirmTitle = $('#confirmTitle');
    D.confirmText = $('#confirmText');
    D.chipsDlg = $('#chipsDlg');
    D.chipsTitle = $('#chipsTitle');
    D.chipsAmt = $('#chipsAmt');

    D.bgm = $('#bgm');
    D.toasts = $('#toasts');
    D.fatalMask = $('#fatalMask');
    D.fatalTitle = $('#fatalTitle');
    D.fatalText = $('#fatalText');
    D.fatalRetry = $('#fatalRetry');
  }

  // ============================ 提示条 ============================

  function toast(msg, ok) {
    if (!D.toasts) return;
    var t = elt('div', 'toast' + (ok ? ' ok' : ''), String(msg || ''));
    D.toasts.appendChild(t);
    setTimeout(function () { t.classList.add('fade'); }, 2600);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 3000);
    while (D.toasts.children.length > 4) D.toasts.removeChild(D.toasts.firstChild);
  }

  // ============================ 音效（WebAudio 实时合成，不引外部音频文件） ============================

  var audioCtx = null;
  var masterGain = null;
  var limiterNode = null;
  var noiseBuf = null;

  /**
   * 总音量。下面每个音效里的 gain 只是彼此之间的**相对**配比（0.02~0.09 那种小数），
   * 真正的响度由这里统一放大。放大之后叠音会超过 1.0，所以链路末端挂了个压缩器当限幅，
   * 削掉峰值而不是硬削波（硬削波听起来就是"滋啦"一声）。
   */
  var MASTER_GAIN = 4.6;

  /**
   * 同一批事件的排队游标（ctx.currentTime 基准）。
   * 服务端一次 flush 会连着发好几条事件（前注 ×N、大小盲、发牌…），
   * 不排队的话十几声会叠在同一毫秒上，听起来只是"噗"的一记爆音。
   */
  var burstAt = 0;

  /**
   * 拿到（必要时创建并唤醒）音频上下文。
   * 跟静音无关 —— 音效静音和背景音乐是两个开关，
   * 关掉音效不该把音乐也一并掐掉，所以"建上下文"和"要不要出声"分开。
   */
  function audio() {
    try {
      if (!audioCtx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        audioCtx = new AC();
        masterGain = audioCtx.createGain();
        masterGain.gain.value = MASTER_GAIN;
        // 限幅器：发牌/全下这种一口气十几声的场面会叠出过载，交给它压住。
        // 这几个是常量设置，直接赋 .value —— 用 setValueAtTime 的话，
        // 上下文此刻还是 suspended（等用户手势），排在 currentTime=0 的自动化不会生效。
        var limiter = audioCtx.createDynamicsCompressor();
        limiter.threshold.value = -8;
        limiter.knee.value = 6;
        limiter.ratio.value = 14;
        limiter.attack.value = 0.003;
        limiter.release.value = 0.22;
        masterGain.connect(limiter);
        limiter.connect(audioCtx.destination);
        limiterNode = limiter;
      }
      if (audioCtx.state === 'suspended' && audioCtx.resume) audioCtx.resume();
      return audioCtx;
    } catch (e) { return null; }
  }

  /** 音效专用入口：静音时直接不出声 */
  function ensureAudio() {
    if (S.muted) return null;
    return audio();
  }

  /** 1 秒白噪声缓冲：发牌的"唰"、筹码的"叮"、敲桌子的"咚"都由它整形而来 */
  function ensureNoise(ctx) {
    if (noiseBuf) return noiseBuf;
    var len = Math.floor(ctx.sampleRate);
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var ch = buf.getChannelData(0);
    for (var i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
    noiseBuf = buf;
    return buf;
  }

  /**
   * 给这一声在时间轴上排个位子，返回相对"现在"的延迟（秒）。
   * 同一批事件依次调用会自动往后排；最多排到 0.8 秒之后，免得音画脱节。
   */
  function slot(gap) {
    var ctx = ensureAudio();
    if (!ctx) return 0;
    var now = ctx.currentTime;
    if (burstAt < now) burstAt = now;
    var at = Math.min(burstAt, now + 0.8);
    burstAt = at + (gap == null ? 0.09 : gap);
    return at - now;
  }

  /** 纯音；给了 to 就从 freq 滑到 to */
  function tone(freq, dur, delay, gain, type, to) {
    var ctx = ensureAudio();
    if (!ctx) return;
    try {
      var t0 = ctx.currentTime + (delay || 0);
      var osc = ctx.createOscillator();
      var g = ctx.createGain();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(freq, t0);
      if (to) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain || 0.04), t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g);
      g.connect(masterGain);
      osc.start(t0);
      osc.stop(t0 + dur + 0.03);
    } catch (e) { /* 音频失败不影响功能 */ }
  }

  /** 噪声脉冲：{delay, dur, gain, type, freq, sweepTo, q, attack} */
  function noise(o) {
    var ctx = ensureAudio();
    if (!ctx) return;
    try {
      o = o || {};
      var t0 = ctx.currentTime + (o.delay || 0);
      var dur = o.dur || 0.06;
      var src = ctx.createBufferSource();
      src.buffer = ensureNoise(ctx);
      var flt = ctx.createBiquadFilter();
      flt.type = o.type || 'bandpass';
      flt.frequency.setValueAtTime(o.freq || 2000, t0);
      if (o.sweepTo) flt.frequency.exponentialRampToValueAtTime(Math.max(60, o.sweepTo), t0 + dur);
      flt.Q.value = (o.q == null) ? 1 : o.q;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.gain || 0.05), t0 + (o.attack || 0.004));
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      src.connect(flt);
      flt.connect(g);
      g.connect(masterGain);
      // 每次从缓冲的随机位置取样，免得听出是同一段循环
      src.start(t0, Math.random() * 0.8, dur + 0.05);
      src.stop(t0 + dur + 0.05);
    } catch (e) { /* 音频失败不影响功能 */ }
  }

  // ---- 音色积木 ----

  /** 一张牌擦过桌面：高频噪声往下扫 */
  function cardFlick(delay, gain) {
    noise({ delay: delay, dur: 0.075, gain: gain || 0.055, freq: 3200, sweepTo: 900, q: 0.8, attack: 0.003 });
  }

  /** 一张牌拍在绒布上：擦声 + 一点低频"啪" */
  function cardSlap(delay) {
    cardFlick(delay, 0.06);
    noise({ delay: (delay || 0) + 0.012, dur: 0.09, gain: 0.05, type: 'lowpass', freq: 420, q: 0.7 });
  }

  /** 一枚筹码落下：塑料体的低频 + 一点高频"叮"，频率随机化避免机械感 */
  function chipHit(delay, gain) {
    var k = (gain == null) ? 1 : gain;
    noise({ delay: delay, dur: 0.045, gain: 0.05 * k, freq: 2400 + Math.random() * 1600, q: 3 });
    tone(150 + Math.random() * 60, 0.05, delay, 0.03 * k, 'triangle');
  }

  // ---- 对外的具体音效 ----

  /** 按钮按下的一记轻响 */
  function sndClick(strong) {
    noise({ dur: 0.022, gain: 0.03, freq: strong ? 1500 : 2200, q: 2.5 });
    tone(strong ? 420 : 620, 0.03, 0, 0.018, 'square');
  }

  /** 发底牌：一人一张地转两圈 */
  function sndDeal(players) {
    var d = slot(0.16);
    var n = clamp(players || 4, 2, 8) * 2;
    for (var i = 0; i < n; i++) cardFlick(d + i * 0.062, 0.045);
  }

  /** 翻牌 / 转牌 / 河牌：n 张依次拍在桌上 */
  function sndBoard(n) {
    var d = slot(0.14);
    for (var i = 0; i < n; i++) cardSlap(d + i * 0.11);
  }

  /** 推筹码 */
  function sndChips(n, gain) {
    var d = slot(0.12);
    var c = clamp(n || 3, 1, 8);
    for (var i = 0; i < c; i++) chipHit(d + i * 0.035 + Math.random() * 0.012, gain);
  }

  /** 过牌：指关节在桌上敲两下 */
  function sndCheck() {
    var d = slot(0.14);
    noise({ delay: d, dur: 0.075, gain: 0.06, type: 'lowpass', freq: 260, q: 1.2 });
    noise({ delay: d + 0.115, dur: 0.075, gain: 0.05, type: 'lowpass', freq: 240, q: 1.2 });
  }

  /** 弃牌：牌被推出去的一记闷响 */
  function sndFold() {
    var d = slot(0.12);
    noise({ delay: d, dur: 0.16, gain: 0.045, type: 'lowpass', freq: 1400, sweepTo: 300, q: 0.6 });
  }

  /** 加注 / 下注：推筹码 + 一个上扬的短音 */
  function sndRaise() {
    sndChips(5);
    tone(330, 0.14, 0.02, 0.03, 'triangle', 495);
  }

  /** 全下：一大堆筹码倒下去，底下垫一层推力 */
  function sndAllin() {
    var d = slot(0.5);
    for (var i = 0; i < 14; i++) chipHit(d + i * 0.032 + Math.random() * 0.02, 0.85);
    tone(110, 0.5, d, 0.05, 'sawtooth', 220);
    tone(220, 0.45, d + 0.05, 0.028, 'triangle', 440);
  }

  /** 轮到自己：两声清脆提示 */
  function sndTurn() {
    tone(784, 0.11, 0, 0.05, 'sine');
    tone(1046, 0.13, 0.13, 0.045, 'sine');
  }

  /**
   * 思考倒计时的"嗒"。只在轮到自己、且时间快用完时一秒一响。
   * @param {boolean} urgent 最后 3 秒，音更高更硬
   */
  function sndTick(urgent) {
    if (urgent) {
      tone(1320, 0.055, 0, 0.085, 'square');
      noise({ dur: 0.022, gain: 0.05, freq: 3400, q: 4 });
    } else {
      tone(880, 0.055, 0, 0.045, 'sine');
      noise({ dur: 0.018, gain: 0.026, freq: 2400, q: 4 });
    }
  }

  /** 超时：低沉的一声"到点了" */
  function sndTimeUp() {
    tone(196, 0.4, 0, 0.075, 'sawtooth', 110);
    tone(392, 0.3, 0, 0.035, 'triangle', 220);
  }

  /** 亮牌 */
  function sndShowdown() {
    var d = slot(0.1);
    cardSlap(d);
    tone(880, 0.09, d + 0.03, 0.022, 'sine');
  }

  /** 自己赢：大三和弦上行 + 筹码雨 */
  function sndWinMine() {
    var d = slot(0.7);
    var notes = [523.25, 659.25, 783.99, 1046.5];
    for (var i = 0; i < notes.length; i++) {
      tone(notes[i], 0.34, d + i * 0.085, 0.05, 'sine');
      tone(notes[i] * 2, 0.2, d + i * 0.085, 0.014, 'sine');
    }
    for (var j = 0; j < 12; j++) chipHit(d + 0.16 + j * 0.045 + Math.random() * 0.02, 0.7);
  }

  /** 别人赢：一句短下行，知道结果就行，别吵 */
  function sndWinOther() {
    var d = slot(0.35);
    tone(392, 0.2, d, 0.028, 'sine');
    tone(294, 0.28, d + 0.11, 0.024, 'sine');
    for (var i = 0; i < 5; i++) chipHit(d + 0.05 + i * 0.05, 0.5);
  }

  /**
   * 大牌型的号角。顺子及以上响一次，四条以上更长更亮。
   * 跟 sndWinMine/sndWinOther 是叠着放的：那个报"谁赢"，这个报"牌有多大"。
   * @param {string} hype 'big' | 'mega'
   */
  function sndFanfare(hype) {
    var d = slot(hype === 'mega' ? 0.9 : 0.6);
    var mega = hype === 'mega';
    // 大调琶音往上冲，mega 再加一层高八度
    var notes = mega
      ? [392, 523.25, 659.25, 783.99, 1046.5, 1318.5]
      : [523.25, 659.25, 783.99, 1046.5];
    for (var i = 0; i < notes.length; i++) {
      var t = d + i * (mega ? 0.075 : 0.07);
      tone(notes[i], mega ? 0.42 : 0.3, t, mega ? 0.06 : 0.045, 'triangle');
      if (mega) tone(notes[i] * 2, 0.25, t, 0.02, 'sine');
    }
    // 底下垫一记闷鼓，让它砸得实一点
    noise({ delay: d, dur: 0.28, gain: mega ? 0.08 : 0.05, type: 'lowpass', freq: 220, q: 1 });
    if (mega) {
      // 收尾一记镲
      noise({ delay: d + 0.42, dur: 0.7, gain: 0.045, type: 'highpass', freq: 5200, q: .5 });
    }
  }

  /**
   * 分池时同一手会连发好几条 win 事件，先攒 80ms 再决定放哪一版：
   * 只要其中有一条是自己的，就按"我赢了"来放。
   */
  var winPending = false;
  var winTimer = null;

  function queueWin(seat) {
    if (S.mySeat !== null && seat === S.mySeat) winPending = true;
    if (winTimer) return;
    winTimer = setTimeout(function () {
      var mine = winPending;
      winPending = false;
      winTimer = null;
      if (mine) sndWinMine(); else sndWinOther();
    }, 80);
  }

  /** 桌上还在牌局里的人数，只用来决定发牌音效响几下 */
  function livePlayerCount() {
    var seats = (S.state && Array.isArray(S.state.seats)) ? S.state.seats : [];
    var n = 0;
    for (var i = 0; i < seats.length; i++) {
      var d = seats[i];
      if (d && !d.sittingOut && d.state !== 'sittingOut') n++;
    }
    return n || 4;
  }

  // ============================ 背景音乐 ============================
  //
  // 三首慢速布鲁斯 / lounge（Kevin MacLeod，CC BY 4.0），文件在 public/music/，
  // 署名与转码参数见 music/README.md。之前是一首 8 分半的拉格泰姆钢琴单曲循环，
  // 打一晚上牌同一段要听十几遍，换成随机顺序的小歌单。
  //
  // 走 WebAudio 而不是直接用 <audio>.volume：接进跟音效同一个限幅器，
  // 音效响的时候音乐会被压一下（侧链闪避），加起来也不会削顶。

  /**
   * 播放音量。三首都归一到 -18 LUFS，所以这一个值管全部，切歌不用另调。
   * 实测这个值下音乐单独播放约 -13 dBFS 峰值 / -30 dBFS RMS ——
   * 听得见但压得住，音效盖上去时不会挤成一团。
   */
  var MUSIC_LEVEL = 0.2;

  /**
   * 歌单。title 是 CC BY 要求的署名用的曲名，设置面板里会一起显示；
   * 加曲子只要往这儿加一行，播放逻辑不用动。
   */
  var TRACKS = [
    { file: 'matts-blues.mp3',    title: "Matt's Blues" },
    { file: 'octoblues.mp3',      title: 'OctoBlues' },
    { file: 'backbay-lounge.mp3', title: 'Backbay Lounge' }
  ];

  // order 是洗过的播放顺序（存的是 TRACKS 下标），at 是当前放到第几个
  var music = { bus: null, src: null, fadeTimer: null, order: [], at: 0 };

  /**
   * 洗一遍播放顺序。avoid 是上一轮最后放的那首的下标 ——
   * 洗完第一首要是又是它，接上去就是同一首连着放两遍，挪一下。
   */
  function musicShuffle(avoid) {
    var order = TRACKS.map(function (_, i) { return i; });
    for (var i = order.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = order[i]; order[i] = order[j]; order[j] = t;
    }
    if (order.length > 1 && order[0] === avoid) {
      var k = 1 + Math.floor(Math.random() * (order.length - 1));
      order[0] = order[k]; order[k] = avoid;
    }
    return order;
  }

  /** 把第 at 首挂到 <audio> 上。preload=none，挂上不会真去下载，等 play() */
  function musicLoad() {
    var t = TRACKS[music.order[music.at]];
    if (t && D.bgm) D.bgm.src = '/music/' + t.file;
  }

  /** 一首放完接下一首；整轮放完重新洗牌 */
  function musicNext() {
    if (!D.bgm || !music.order.length) return;
    var prev = music.order[music.at];
    music.at += 1;
    if (music.at >= music.order.length) {
      music.order = musicShuffle(prev);
      music.at = 0;
    }
    musicLoad();
    // 关掉音乐时 pause 不会触发 ended，这里只可能是自然放完，直接续上
    if (!S.musicOn) return;
    var pending = D.bgm.play();
    if (pending && pending.catch) pending.catch(function () { /* 等手势 */ });
  }

  /** 把 <audio> 接进音频图。只能接一次，重复调用会抛错。 */
  function musicWire() {
    var ctx = audio();
    if (!ctx || !D.bgm) return null;
    if (music.bus) return music.bus;
    try {
      music.bus = ctx.createGain();
      music.bus.gain.value = 0.0001;
      music.bus.connect(limiterNode || ctx.destination);
      music.src = ctx.createMediaElementSource(D.bgm);
      music.src.connect(music.bus);
      return music.bus;
    } catch (e) {
      music.bus = null;
      return null;
    }
  }

  /** 淡到某个音量，秒为单位 */
  function musicFade(to, secs) {
    var ctx = audioCtx;
    if (!ctx || !music.bus) return;
    var t = ctx.currentTime;
    try {
      music.bus.gain.cancelScheduledValues(t);
      music.bus.gain.setValueAtTime(Math.max(0.0001, music.bus.gain.value), t);
      music.bus.gain.exponentialRampToValueAtTime(Math.max(0.0001, to), t + secs);
    } catch (e) { /* 音乐失败不影响牌局 */ }
  }

  function musicStart() {
    if (!D.bgm) return;
    if (!musicWire()) return;
    if (!music.order.length) { music.order = musicShuffle(-1); music.at = 0; musicLoad(); }
    if (music.fadeTimer) { clearTimeout(music.fadeTimer); music.fadeTimer = null; }
    // 淡入 4 秒：背景音乐要"慢慢有了"，不是"啪一下开了"
    musicFade(MUSIC_LEVEL, 4);
    var pending = D.bgm.play();
    // 没有用户手势时 play() 会 reject，这不是错误，等下次交互再说
    if (pending && pending.catch) pending.catch(function () { /* 等手势 */ });
  }

  function musicStop() {
    if (!D.bgm) return;
    musicFade(0.0001, 1.2);
    if (music.fadeTimer) clearTimeout(music.fadeTimer);
    // 等淡出走完再暂停，直接 pause 会"咔"一声
    music.fadeTimer = setTimeout(function () {
      music.fadeTimer = null;
      try { D.bgm.pause(); } catch (e) { /* 忽略 */ }
    }, 1400);
  }

  /** 按当前开关把音乐拉起来或停掉 */
  function syncMusic() {
    if (S.musicOn) musicStart(); else musicStop();
  }

  // ============================ 按下反馈 ============================

  /**
   * 按钮按下时亮一下。
   * 行动按钮点完立刻会被 disable（防重复提交），CSS 的 :active 当场就消失了，
   * 所以这里用 JS 加类：动画自己跑完，"我刚按了哪颗"一定看得见。
   */
  function flashPress(el) {
    if (!el || !el.classList) return;
    el.classList.remove('press-fx');
    void el.offsetWidth; // 强制重排，连点也能重新播放动画
    el.classList.add('press-fx');
  }

  var ACT_BTN_KEY = {
    fold: 'btnFold', check: 'btnCheck', call: 'btnCall',
    bet: 'btnRaise', raise: 'btnRaise', allin: 'btnAllin'
  };
  var actedTimer = null;

  /** 行动按钮按下后留一圈金色余晖，按钮被禁用期间也能看出刚才选了什么 */
  function markActed(type) {
    var keys = ['btnFold', 'btnCheck', 'btnCall', 'btnRaise', 'btnAllin'];
    for (var i = 0; i < keys.length; i++) {
      if (D[keys[i]]) D[keys[i]].classList.remove('acted');
    }
    var el = D[ACT_BTN_KEY[type]];
    if (!el) return;
    // 键盘快捷键没有 pointerdown，这里补一次闪光；鼠标点过的就别重放了
    if (!el.classList.contains('press-fx')) flashPress(el);
    void el.offsetWidth;
    el.classList.add('acted');
    if (actedTimer) clearTimeout(actedTimer);
    actedTimer = setTimeout(function () { el.classList.remove('acted'); actedTimer = null; }, 1400);
  }

  // ============================ WebSocket ============================

  function wsUrl() {
    return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
  }

  function setConn(kind, text) {
    var changed = S.conn !== kind;
    S.conn = kind;
    if (D.connBadge) D.connBadge.setAttribute('data-conn', kind);
    if (D.connText) D.connText.textContent = text;
    // 连接状态会影响「空位可点」与底部提示，需要重绘一次
    if (changed && S.state) {
      try { render(); } catch (e) { /* 重绘失败不影响重连 */ }
    }
  }

  function connect() {
    if (S.reconnectTimer) { clearTimeout(S.reconnectTimer); S.reconnectTimer = null; }
    if (S.ws) {
      try { S.ws.onclose = null; S.ws.close(); } catch (e) { /* 忽略 */ }
      S.ws = null;
    }
    setConn('connecting', '连接中…');
    var ws;
    try {
      ws = new WebSocket(wsUrl());
    } catch (e) {
      scheduleReconnect();
      return;
    }
    S.ws = ws;

    ws.onopen = function () {
      S.backoff = 500;
      setConn('online', '已连接');
      // 重连可能意味着服务端重启过（内存态全丢），允许再推一次人机配置
      S.botPushed = false;
      send({ t: 'hello', token: lsGet(LS_TOKEN) || null });
      startPing();
    };

    ws.onmessage = function (ev) {
      var m = null;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (!m || typeof m !== 'object') return;
      handleMessage(m);
    };

    ws.onerror = function () { /* onclose 会接手 */ };

    ws.onclose = function () {
      stopPing();
      if (voice) voice.onDisconnect();
      if (S.ws === ws) S.ws = null;
      if (S.fatal) {
        showFatal(S.fatal.title, S.fatal.text);
        return;
      }
      setConn('offline', '重连中…');
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    if (S.reconnectTimer || S.fatal) return;
    var wait = S.backoff;
    S.backoff = Math.min(5000, Math.round(S.backoff * 1.7));
    S.reconnectTimer = setTimeout(function () {
      S.reconnectTimer = null;
      connect();
    }, wait);
  }

  function send(obj) {
    var ws = S.ws;
    if (!ws || ws.readyState !== 1) return false;
    try { ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
  }

  function startPing() {
    stopPing();
    S.pingTimer = setInterval(function () { send({ t: 'ping' }); }, 25000);
  }
  function stopPing() {
    if (S.pingTimer) { clearInterval(S.pingTimer); S.pingTimer = null; }
  }

  function showFatal(title, text) {
    if (!D.fatalMask) return;
    D.fatalTitle.textContent = title || '连接已断开';
    D.fatalText.textContent = text || '';
    D.fatalMask.hidden = false;
  }

  function handleMessage(m) {
    // 语音的信令自己吃掉，不进下面这套牌桌逻辑
    if (voice && voice.handle(m)) return;
    switch (m.t) {
      case 'welcome':
        if (typeof m.token === 'string' && m.token) lsSet(LS_TOKEN, m.token);
        S.playerId = m.playerId || null;
        if (typeof m.seat === 'number') S.mySeat = m.seat;
        if (voice) voice.onWelcome();
        break;

      case 'state':
        S.state = m;
        if (typeof m.serverNow === 'number') S.clockOffset = m.serverNow - Date.now();
        clearPending();
        if (voice) voice.applyState(m);
        render();
        pushRememberedBotConfig(m);
        break;

      case 'error':
        clearPending();
        toast(m.msg || '操作失败');
        if (typeof m.msg === 'string' && /另一个窗口|请出了牌桌/.test(m.msg)) {
          S.fatal = {
            title: /窗口/.test(m.msg) ? '牌桌已在其他窗口打开' : '你已离开牌桌',
            text: m.msg
          };
        }
        break;

      case 'event':
        onServerEvent(m);
        break;

      default:
        break;
    }
  }

  function onServerEvent(m) {
    switch (m.kind) {
      case 'deal':
        sndDeal(livePlayerCount());
        break;
      case 'flop':
        sndBoard(3);
        break;
      case 'turn':
      case 'river':
        sndBoard(1);
        break;
      case 'blind':
      case 'ante':
        sndChips(2, 0.75);
        break;
      case 'return':
        sndChips(2, 0.6);
        break;
      case 'action':
        // 每种动作一个声音，不看屏幕也知道别人干了什么
        switch (m.type) {
          case 'fold':  sndFold(); break;
          case 'check': sndCheck(); break;
          case 'call':  sndChips(3); break;
          case 'bet':
          case 'raise': sndRaise(); break;
          case 'allin': sndAllin(); break;
          default:      sndChips(2); break;
        }
        break;
      case 'showdown':
        sndShowdown();
        break;
      case 'win':
        queueWin(m.seat);
        break;
      default:
        break;
    }
  }

  function clearPending() {
    S.pendingAction = false;
    if (S.pendingTimer) { clearTimeout(S.pendingTimer); S.pendingTimer = null; }
  }

  // ============================ 牌面渲染 ============================

  function makeCardNode(code, opt) {
    opt = opt || {};
    if (!code) {
      var slot = elt('div', 'slot empty');
      return slot;
    }
    if (code === '??') {
      var back = elt('div', 'card-back');
      return back;
    }
    var r = code.charAt(0);
    var s = code.charAt(1);
    var red = (s === 'h' || s === 'd');
    var card = elt('div', 'card' + (opt.mini ? ' mini' : '') + (red ? ' red' : ''));
    var rank = elt('span', 'c-rank', r === 'T' ? '10' : r);
    card.appendChild(rank);
    var suit = SUIT_CH[s] || '?';
    if (!opt.mini) {
      card.appendChild(elt('span', 'c-suit-sm', suit));
    }
    card.appendChild(elt('span', 'c-suit-big', suit));
    card.setAttribute('aria-label', cardLabel(code));
    return card;
  }

  function cardLabel(code) {
    var names = { s: '黑桃', h: '红桃', d: '方块', c: '梅花' };
    var r = code.charAt(0);
    return (names[code.charAt(1)] || '') + (r === 'T' ? '10' : r);
  }

  /**
   * 最小化 DOM diff 地同步一排牌。
   * @param host 容器
   * @param cards 数组，元素为 'As' / '??' / null（空位）
   * @param opt  { mini:boolean, hl:Set<string>, boardSlot:boolean, animate:boolean }
   */
  function syncCards(host, cards, opt) {
    if (!host) return;
    opt = opt || {};
    var sig = host.__sig || [];
    while (host.children.length > cards.length) host.removeChild(host.lastChild);
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i] == null ? '' : String(cards[i]);
      var node = host.children[i];
      var changed = !node || sig[i] !== c;
      if (changed) {
        var fresh = makeCardNode(c, opt);
        if (opt.boardSlot && c) fresh.classList.add('slot');
        if (node) host.replaceChild(fresh, node);
        else host.appendChild(fresh);
        node = fresh;
        if (c && opt.animate !== false) node.classList.add('dealt');
      }
      var isFace = c && c !== '??';
      var hl = !!(isFace && opt.hl && opt.hl.has(c));
      if (node.classList) {
        node.classList.toggle('hl', hl);
        node.classList.toggle('dim-card', !!(opt.dimOthers && isFace && !hl));
      }
    }
    var next = [];
    for (var j = 0; j < cards.length; j++) next.push(cards[j] == null ? '' : String(cards[j]));
    host.__sig = next;
  }

  // ============================ 座位骨架 ============================

  function buildSeats() {
    if (!D.seatLayer) return;
    D.seatLayer.textContent = '';
    D.betLayer.textContent = '';
    S.seatNodes = [];

    for (var i = 0; i < MAX_SEATS; i++) {
      var p = POS[i];
      var root = elt('div', 'seat');
      root.style.setProperty('--x', p.x + '%');
      root.style.setProperty('--y', p.y + '%');

      var pod = elt('div', 'pod');
      var avWrap = elt('div', 'av-wrap');
      var avatar = elt('div', 'avatar');
      var ring = elt('div', 'ring');
      var mic = elt('i', 'pod-mic');
      mic.hidden = true;
      avWrap.appendChild(avatar);
      avWrap.appendChild(ring);
      avWrap.appendChild(mic);
      var info = elt('div', 'pod-info');
      var name = elt('div', 'pod-name');
      var chips = elt('div', 'pod-chips');
      info.appendChild(name);
      info.appendChild(chips);
      var offDot = elt('i', 'off-dot');
      offDot.hidden = true;
      var emptyTxt = elt('div', 'empty-txt', '＋ 入座');
      emptyTxt.hidden = true;

      pod.appendChild(avWrap);
      pod.appendChild(info);
      pod.appendChild(offDot);
      pod.appendChild(emptyTxt);

      var tags = elt('div', 'tags');
      var bubble = elt('div', 'bubble');
      bubble.hidden = true;
      var mini = elt('div', 'mini-cards');

      root.appendChild(pod);
      root.appendChild(tags);
      root.appendChild(bubble);
      root.appendChild(mini);

      var bet = elt('div', 'bet');
      bet.style.setProperty('--bx', p.bx + '%');
      bet.style.setProperty('--by', p.by + '%');
      bet.hidden = true;
      var chipNode = elt('i', 'bet-chips');
      var amtNode = elt('span', 'amt');
      bet.appendChild(chipNode);
      bet.appendChild(amtNode);

      D.seatLayer.appendChild(root);
      D.betLayer.appendChild(bet);

      S.seatNodes.push({
        root: root, pod: pod, avWrap: avWrap, avatar: avatar, ring: ring, mic: mic,
        info: info, name: name, chips: chips, offDot: offDot, emptyTxt: emptyTxt,
        tags: tags, bubble: bubble, mini: mini,
        bet: bet, chip: chipNode, amt: amtNode,
        seat: -1
      });

      (function (slot) {
        pod.addEventListener('click', function () {
          var node = S.seatNodes[slot];
          if (!node || node.seat < 0) return;
          if (S.mySeat !== null) return;
          var st = S.state;
          var seatData = st && Array.isArray(st.seats) ? st.seats[node.seat] : null;
          if (seatData) return;
          openSitDialog(node.seat);
        });
      })(i);
    }
  }

  // ============================ 主渲染 ============================

  function render() {
    var st = S.state;
    if (!st) return;

    var table = st.table || {};
    var seats = Array.isArray(st.seats) ? st.seats : [];
    var you = st.you || {};
    var cfg = st.config || {};
    var result = st.result || null;

    S.mySeat = (typeof you.seat === 'number') ? you.seat : null;

    renderTopbar(st, table, cfg, you);
    renderSeats(st, table, seats, you, result);
    renderCenter(st, table, result);
    renderHero(st, table, seats, you, cfg);
    renderLog(st);
    renderChat(st);
    renderConfigPane(st, cfg, seats, you);
    maybeAnnounceTurn(table);
    maybeFloatWins(table, result);
  }

  function renderTopbar(st, table, cfg, you) {
    if (D.metaHand) {
      D.metaHand.textContent = table.handNo ? ('第 ' + table.handNo + ' 手') : '未开局';
    }
    if (D.metaBlinds) {
      var ante = Number(cfg.ante) || 0;
      D.metaBlinds.textContent = '盲注 ' + fmt(cfg.smallBlind || 0) + '/' + fmt(cfg.bigBlind || 0) +
        (ante > 0 ? ' · 前注 ' + fmt(ante) : '');
    }
    if (D.metaHost) D.metaHost.hidden = !you.isHost;
  }

  // ============================ 筹码动画 ============================

  /** 牌桌百分比坐标 -> 相对 #table 的像素坐标 */
  function tableXY(xPct, yPct) {
    if (!D.table) return { x: 0, y: 0 };
    return { x: D.table.clientWidth * xPct / 100, y: D.table.clientHeight * yPct / 100 };
  }

  /** 底池筹码堆的中心；量不到就用牌桌中偏上兜底 */
  function potXY() {
    if (D.potPile && D.table && D.potRow && !D.potRow.hidden) {
      var a = D.potPile.getBoundingClientRect();
      var b = D.table.getBoundingClientRect();
      if (a.width > 0) {
        return { x: a.left - b.left + a.width / 2, y: a.top - b.top + a.height / 2 };
      }
    }
    return tableXY(50, 44);
  }

  /** 一把筹码从 from 飞到 to（像素，相对 #table）。纯装饰，失败也不影响状态。 */
  function flyChips(from, to, amount, opt) {
    if (!D.chipLayer) return;
    opt = opt || {};
    var parts = chipSplit(amount, opt.max || 4);
    var tiers = [];
    for (var a = 0; a < parts.length; a++) {
      for (var b = 0; b < parts[a].n; b++) tiers.push(parts[a].tier);
    }
    var dur = opt.dur || 520;
    var gap = opt.gap == null ? 55 : opt.gap;
    var base = opt.delay || 0;
    for (var i = 0; i < tiers.length; i++) {
      // 出发点稍微散开，看着像抓了一把筹码推出去，而不是一根线
      var jx = (i - (tiers.length - 1) / 2) * 5;
      var jy = -i * 2;
      var node = elt('i', 'fly-chip chip');
      node.setAttribute('data-tier', String(tiers[i]));
      node.style.left = (from.x + jx) + 'px';
      node.style.top = (from.y + jy) + 'px';
      node.style.setProperty('--dx', (to.x - from.x - jx + (i % 3 - 1) * 4) + 'px');
      node.style.setProperty('--dy', (to.y - from.y - jy - i * 2) + 'px');
      node.style.setProperty('--dur', dur + 'ms');
      node.style.setProperty('--delay', (base + i * gap) + 'ms');
      D.chipLayer.appendChild(node);
      (function (n) {
        setTimeout(function () { if (n.parentNode) n.parentNode.removeChild(n); }, base + i * gap + dur + 60);
      })(node);
    }
  }

  /** 一条街打完：各家台面上的筹码收进底池 */
  function sweepChipsToPot(list) {
    var to = potXY();
    for (var i = 0; i < list.length; i++) {
      var p = POS[list[i].slot];
      if (!p) continue;
      flyChips(tableXY(p.bx, p.by), to, list[i].amount, { max: 3, dur: 460, gap: 45 });
    }
    sndChips(2, 0.45);
  }

  /** 一手结束：底池推给赢家。等结算大屏退场之后再推，
   *  不然筹码全在遮罩底下飞，等于白飞。 */
  function payChipsToWinner(slot, amount) {
    var p = POS[slot];
    if (!p) return;
    var wait = (S.resultHideAt || 0) - Date.now() + 150;
    // 落在座位牌和下注位之间——荷官把池子推到人面前，而不是盖在人脸上
    var to = tableXY((p.x + p.bx) / 2, (p.y + p.by) / 2);
    flyChips(potXY(), to, amount, {
      max: 6, dur: 620, gap: 60, delay: clamp(wait, 420, 4000)
    });
  }

  function renderSeats(st, table, seats, you, result) {
    var rot = (S.mySeat === null) ? 0 : S.mySeat;
    var actingSeat = (typeof table.actingSeat === 'number') ? table.actingSeat : null;
    S.ringNode = null;
    var swept = [];   // 本次快照里"下注被收走"的座位，用来放归池动画

    // 摊牌高亮：每位摊牌玩家高亮自己的最优五张
    var showdownBySeat = {};
    if (result && Array.isArray(result.showdown)) {
      for (var k = 0; k < result.showdown.length; k++) {
        var e = result.showdown[k];
        if (e && typeof e.seat === 'number') showdownBySeat[e.seat] = e;
      }
    }

    for (var i = 0; i < MAX_SEATS; i++) {
      var node = S.seatNodes[i];
      if (!node) continue;
      var seatNum = (rot + i) % MAX_SEATS;
      var data = seats[seatNum] || null;
      var seatChanged = node.seat !== seatNum;
      node.seat = seatNum;
      node.root.setAttribute('data-seat', String(seatNum));

      var cls = 'seat';
      if (!data) {
        cls += ' is-empty';
        if (S.mySeat === null && S.conn === 'online') cls += ' can-sit';
      } else {
        if (data.state === 'folded') cls += ' folded';
        if (data.state === 'allin') cls += ' allin';
        if (data.state === 'sittingOut' || data.sittingOut) cls += ' sitting-out';
        if (seatNum === S.mySeat) cls += ' is-me';
        if (data.isWinner) cls += ' winner';
        if (data.lastAction && data.lastAction.label) cls += ' has-bubble';
        if (voice && voice.speakingSeat(seatNum)) cls += ' speaking';
      }
      if (data && actingSeat === seatNum) cls += ' acting';
      node.root.className = cls;

      if (!data) {
        node.avWrap.hidden = true;
        node.info.hidden = true;
        node.offDot.hidden = true;
        node.mic.hidden = true;
        node.emptyTxt.hidden = false;
        node.emptyTxt.textContent = (S.mySeat === null) ? '＋ 入座' : ((seatNum + 1) + ' 号空位');
        node.pod.setAttribute('role', S.mySeat === null ? 'button' : 'presentation');
        node.pod.setAttribute('aria-label', '第 ' + (seatNum + 1) + ' 号座位，空位' +
          (S.mySeat === null ? '，点击入座' : ''));
        node.pod.tabIndex = (S.mySeat === null && S.conn === 'online') ? 0 : -1;
        node.tags.textContent = '';
        node.tags.__sig = '';
        node.bubble.hidden = true;
        syncCards(node.mini, [], { mini: true });
        node.bet.hidden = true;
        continue;
      }

      node.avWrap.hidden = false;
      node.info.hidden = false;
      node.emptyTxt.hidden = true;
      node.pod.tabIndex = -1;
      node.pod.setAttribute('role', 'group');

      var av = data.avatar || {};
      node.avatar.style.setProperty('--av-bg', av.bg || '#31514a');
      node.avatar.style.setProperty('--av-fg', av.fg || '#ffffff');
      node.avatar.setAttribute('data-shape', String(av.shape == null ? 0 : av.shape));
      node.avatar.textContent = av.glyph || (data.name ? data.name.charAt(0) : '?');

      node.name.textContent = data.name || ('座位' + (seatNum + 1));
      node.chips.textContent = fmt(data.chips);
      node.chips.className = 'pod-chips' + ((Number(data.chips) || 0) <= 0 ? ' dim' : '');
      node.offDot.hidden = !!data.connected;

      // 麦上的人在头像角上挂个小灯：绿色＝开着麦，灰色＝自己静音了
      var mem = voice ? voice.onMic(seatNum) : null;
      node.mic.hidden = !mem;
      if (mem) {
        node.mic.classList.toggle('muted', !!mem.muted);
        node.mic.title = mem.muted ? mem.name + ' 已静音' : mem.name + ' 在语音里';
      }

      node.pod.setAttribute('aria-label',
        (data.name || '') + '，筹码 ' + fmt(data.chips) +
        (data.state === 'folded' ? '，已弃牌' : '') +
        (data.state === 'allin' ? '，已全下' : '') +
        (data.connected ? '' : '，已断线'));

      // 按钮 / 盲注标记
      var tagSig = (data.isButton ? 'D' : '') + (data.isSB ? 'S' : '') + (data.isBB ? 'B' : '') +
        (data.bot ? 'R' : '');
      if (node.tags.__sig !== tagSig) {
        node.tags.textContent = '';
        if (data.isButton) node.tags.appendChild(elt('i', 'tag btn-d', 'D'));
        if (data.isSB) node.tags.appendChild(elt('i', 'tag sb', 'SB'));
        if (data.isBB) node.tags.appendChild(elt('i', 'tag bb', 'BB'));
        // 人机要一眼看得出来，不能让人以为在跟真人打
        if (data.bot) node.tags.appendChild(elt('i', 'tag bot', 'BOT'));
        node.tags.__sig = tagSig;
      }

      // 动作气泡
      var label = data.lastAction && data.lastAction.label ? data.lastAction.label : '';
      if (label) {
        if (node.bubble.textContent !== label || node.bubble.hidden) {
          node.bubble.textContent = label;
          node.bubble.className = 'bubble k-' + ((data.lastAction && data.lastAction.type) || 'x');
          node.bubble.hidden = false;
          // 重新触发进场动画
          node.bubble.style.animation = 'none';
          void node.bubble.offsetWidth;
          node.bubble.style.animation = '';
        }
      } else {
        node.bubble.hidden = true;
        node.bubble.textContent = '';
      }

      // 底牌（自己的牌在下方大显示，这里也给一份小的）
      var cards = Array.isArray(data.cards) ? data.cards.slice(0, 2) : [];
      var sd = showdownBySeat[seatNum];
      var hlSet = null;
      if (sd && Array.isArray(sd.best)) hlSet = new Set(sd.best);
      syncCards(node.mini, cards, { mini: true, hl: hlSet, animate: !seatChanged });

      // 本轮下注筹码
      var bet = Number(data.committedRound) || 0;
      var prev = S.lastBets[seatNum] || 0;
      if (bet > 0) {
        node.bet.hidden = false;
        node.amt.textContent = fmt(bet);
        renderChipPile(node.chip, bet, 4, 4);
        if (bet !== prev) {
          node.bet.classList.remove('bump');
          void node.bet.offsetWidth;
          node.bet.classList.add('bump');
        }
      } else {
        node.bet.hidden = true;
        // 这一轮打完了，桌上的筹码要收进底池——飞过去，别凭空消失
        if (prev > 0) swept.push({ slot: i, amount: prev });
      }
      S.lastBets[seatNum] = bet;

      // 倒计时环
      if (actingSeat === seatNum) S.ringNode = node.ring;
    }

    // 清掉已经不在场上的下注记录
    for (var s2 = 0; s2 < MAX_SEATS; s2++) {
      var d2 = seats[s2];
      if (!d2 || !(Number(d2.committedRound) > 0)) S.lastBets[s2] = 0;
    }

    if (swept.length) sweepChipsToPot(swept);
  }

  function renderCenter(st, table, result) {
    // 阶段
    if (D.phaseTag) {
      D.phaseTag.textContent = PHASE_TXT[table.phase] || '牌桌';
    }

    // 底池
    var total = Number(table.totalPot) || 0;
    if (D.potRow) {
      D.potRow.hidden = !(total > 0);
      if (total > 0) {
        renderChipPile(D.potPile, total, 12, 4);
        if (D.potMain.textContent !== fmt(total)) {
          D.potMain.textContent = fmt(total);
          D.potMain.classList.remove('bump');
          void D.potMain.offsetWidth;
          D.potMain.classList.add('bump');
        }
        var pots = Array.isArray(table.pots) ? table.pots : [];
        var sideSig = pots.map(function (p) { return p && p.amount; }).join(',');
        if (D.potSide.__sig !== sideSig) {
          D.potSide.textContent = '';
          if (pots.length > 1) {
            for (var i = 0; i < pots.length; i++) {
              var p = pots[i];
              if (!p) continue;
              var nm = (i === 0 ? '主池 ' : '边池' + i + ' ') + fmt(p.amount);
              D.potSide.appendChild(elt('span', null, nm));
            }
          }
          D.potSide.__sig = sideSig;
        }
      }
    }

    // 公共牌：始终 5 个位置
    var board = Array.isArray(table.board) ? table.board.slice(0, 5) : [];
    var slots = [];
    for (var b = 0; b < 5; b++) slots.push(board[b] || null);

    var hl = null;
    if (result && Array.isArray(result.winners)) {
      hl = new Set();
      for (var w = 0; w < result.winners.length; w++) {
        var win = result.winners[w];
        if (win && Array.isArray(win.best)) {
          for (var c = 0; c < win.best.length; c++) hl.add(win.best[c]);
        }
      }
      if (hl.size === 0) hl = null;
    }
    syncCards(D.board, slots, { hl: hl, boardSlot: true });

    renderResultOverlay(st, Array.isArray(st.seats) ? st.seats : [], result);
  }

  /** 把 winners 里同一座位的多个底池合并成一条 */
  function mergeWinners(winners) {
    var out = [];
    var idx = {};
    for (var i = 0; i < winners.length; i++) {
      var w = winners[i];
      if (!w || typeof w.seat !== 'number') continue;
      if (idx[w.seat] == null) {
        idx[w.seat] = out.length;
        out.push({
          seat: w.seat,
          name: w.name || ('座位' + (w.seat + 1)),
          amount: 0,
          handName: null,
          handNameEn: null,
          handRank: null,
          best: null
        });
      }
      var e = out[idx[w.seat]];
      e.amount += Number(w.amount) || 0;
      if (!e.handName && w.handName) e.handName = w.handName;
      if (!e.handNameEn && w.handNameEn) e.handNameEn = w.handNameEn;
      if (e.handRank == null && typeof w.handRank === 'number') e.handRank = w.handRank;
      if (!e.best && Array.isArray(w.best)) e.best = w.best;
    }
    out.sort(function (a, b) { return b.amount - a.amount; });
    return out;
  }

  /**
   * 把一手的结算算成"给人看的结论"。
   *
   * 输赢判定用的是**本手净收支** ＝ 从底池赢到的 − 真正投进池子的，
   * 而不是"有没有出现在 winners 里"：分池的时候你可能名列赢家却照样亏钱，
   * 那种情况写"你赢了"是骗人的。
   *
   * @returns {null|{kind:string,verdict:string,amountText:string,detail:string,
   *                 winners:object[],top:object,inHand:boolean,net:number}}
   */
  function handVerdict(st, seats, result) {
    var winners = (result && Array.isArray(result.winners)) ? mergeWinners(result.winners) : [];
    if (!winners.length) return null;

    var mine = (S.mySeat !== null) ? (seats[S.mySeat] || null) : null;
    var myCards = (st.you && Array.isArray(st.you.cards)) ? st.you.cards : [];
    var inHand = !!(mine && (
      (Number(mine.committedTotal) || 0) > 0 ||
      (Number(mine.wonThisHand) || 0) > 0 ||
      myCards.length > 0
    ));
    var net = inHand
      ? (Number(mine.wonThisHand) || 0) - (Number(mine.committedTotal) || 0)
      : 0;

    var iWon = false;
    for (var i = 0; i < winners.length; i++) {
      if (winners[i].seat === S.mySeat) { iWon = true; break; }
    }
    var top = winners[0];
    var split = winners.length > 1;

    var kind;      // win | lose | even | watch
    var verdict;
    if (!inHand) {
      kind = 'watch';
      verdict = winners.map(function (w) { return w.name; }).join(' 和 ') + ' 赢了';
    } else if (iWon && split) {
      kind = net > 0 ? 'win' : 'even';
      verdict = '平分底池';
    } else if (iWon) {
      kind = 'win';
      verdict = '你赢了';
    } else if (net < 0) {
      kind = 'lose';
      verdict = '你输了';
    } else {
      kind = 'even';
      verdict = '这手没输没赢';
    }

    // 金额：自己在牌里就报净收支，旁观就报赢家拿走多少。
    // 净收支为 0（没下过注就弃了）时不报数字——大大一个 "0" 是噪音不是信息。
    var amt = inHand ? net : top.amount;
    var sign = inHand ? (amt > 0 ? '+' : (amt < 0 ? '−' : '')) : '';
    var amountText = amt === 0 ? '' : sign + fmt(Math.abs(amt));

    // 细节只回答"谁"——"什么牌型"已经是大标题了，别重复
    var detail;
    if (split) {
      detail = winners.map(function (w) { return w.name; }).join('  ·  ') + ' 平分';
    } else if (inHand && iWon) {
      detail = '';
    } else {
      detail = top.name + (result.wentToShowdown ? ' 拿下' : ' 收下底池');
    }

    // 结算大屏的主标题：摊了牌就报英文牌型，没摊牌就是没人跟到底
    var handEn = result.wentToShowdown ? (top.handNameEn || '') : 'UNCONTESTED';
    var handCn = result.wentToShowdown ? (top.handName || '') : '没人跟到底';
    // 牌型档次决定特效强度：顺子(4)起算"大牌"，四条(7)起算"炸场"
    var rank = result.wentToShowdown && typeof top.handRank === 'number' ? top.handRank : -1;
    var hype = rank >= 7 ? 'mega' : (rank >= 4 ? 'big' : 'plain');

    return {
      kind: kind,
      verdict: verdict,
      amountText: amountText,
      detail: detail,
      handEn: handEn,
      handCn: handCn,
      hype: hype,
      winners: winners,
      top: top,
      inHand: inHand,
      net: net
    };
  }

  /**
   * 结算大屏：盖住牌桌把结论砸出来，2.4 秒后自动让开
   * （或者点一下立刻让开），好让大家还能回看各家亮的牌。
   */
  function renderResultOverlay(st, seats, result) {
    if (!D.resultOverlay) return;
    var v = handVerdict(st, seats, result);
    if (!v) {
      hideResultOverlay();
      return;
    }

    // 主标题：英文牌型。data-text 给 CSS 的描边/流光副本用（两层必须同字）
    D.roHandEn.textContent = v.handEn;
    D.roHandEn.setAttribute('data-text', v.handEn);
    // THREE OF A KIND / FOUR OF A KIND / STRAIGHT FLUSH 这些长名字要降一号
    D.roHandEn.classList.toggle('is-long', v.handEn.length > 11);
    D.roHandCn.textContent = v.handCn;
    D.roHandCn.hidden = !v.handCn;

    D.roVerdict.textContent = v.verdict;
    D.roAmount.textContent = v.amountText;
    D.roAmount.hidden = !v.amountText;
    D.roDetail.textContent = v.detail;
    D.roDetail.hidden = !v.detail;

    // 赢牌的那 5 张，逐张翻出来（没摊牌就没有 best，不显示）
    D.roCards.textContent = '';
    var best = Array.isArray(v.top.best) ? v.top.best : [];
    for (var c = 0; c < best.length; c++) {
      var cd = makeCardNode(best[c], { mini: true });
      cd.style.setProperty('--i', String(c));
      D.roCards.appendChild(cd);
    }
    D.roCards.hidden = !best.length;

    // 分池时把每个赢家各拿多少列出来
    D.roOthers.textContent = '';
    if (v.winners.length > 1) {
      for (var k = 0; k < v.winners.length; k++) {
        var row = elt('div', 'ro-other' + (v.winners[k].seat === S.mySeat ? ' is-me' : ''));
        row.appendChild(elt('span', 'ro-other-name', v.winners[k].name));
        row.appendChild(elt('span', 'ro-other-amt', '+' + fmt(v.winners[k].amount)));
        D.roOthers.appendChild(row);
      }
      D.roOthers.hidden = false;
    } else {
      D.roOthers.hidden = true;
    }

    D.resultOverlay.setAttribute('data-kind', v.kind);
    D.resultOverlay.setAttribute('data-hype', v.hype);

    // 每手只登场一次：之后的快照（亮牌、补充筹码…）不该把它重新弹出来。
    // 牌型越大留得越久——四条同花顺值得多看两眼。
    var handNo = Number(st.table && st.table.handNo) || 0;
    if (S.resultOverlayHand !== handNo) {
      S.resultOverlayHand = handNo;
      D.resultOverlay.classList.remove('is-gone');
      D.resultOverlay.hidden = false;
      // 重播入场动画：连着两手都是同一档次时，光换文字看不出"又来了一次"
      D.resultOverlay.classList.remove('is-in');
      void D.resultOverlay.offsetWidth;
      D.resultOverlay.classList.add('is-in');
      if (v.hype !== 'plain') sndFanfare(v.hype);
      if (S.resultHideTimer) clearTimeout(S.resultHideTimer);
      var hold = v.hype === 'plain' ? 2400 : 3400;
      S.resultHideAt = Date.now() + hold;
      S.resultHideTimer = setTimeout(dismissResultOverlay, hold);
    }
  }

  /** 大屏退场，但结论仍留在底部状态栏里 */
  function dismissResultOverlay() {
    if (S.resultHideTimer) { clearTimeout(S.resultHideTimer); S.resultHideTimer = null; }
    if (D.resultOverlay) D.resultOverlay.classList.add('is-gone');
  }

  function hideResultOverlay() {
    if (S.resultHideTimer) { clearTimeout(S.resultHideTimer); S.resultHideTimer = null; }
    S.resultOverlayHand = -1;
    if (!D.resultOverlay) return;
    D.resultOverlay.hidden = true;
    D.resultOverlay.classList.remove('is-gone');
  }

  function renderHero(st, table, seats, you, cfg) {
    var mySeatData = (S.mySeat !== null) ? (seats[S.mySeat] || null) : null;
    var legal = you.legal || null;
    var myTurn = !!(legal && S.mySeat !== null && table.actingSeat === S.mySeat);

    // 我的底牌
    var myCards = Array.isArray(you.cards) ? you.cards.slice(0, 2) : [];
    if (myCards.length) {
      var hl = null;
      if (st.result && Array.isArray(st.result.showdown)) {
        for (var i = 0; i < st.result.showdown.length; i++) {
          var e = st.result.showdown[i];
          if (e && e.seat === S.mySeat && Array.isArray(e.best)) hl = new Set(e.best);
        }
      }
      D.heroCards.classList.remove('is-ph');
      syncCards(D.heroCards, myCards, { hl: hl });
    } else {
      // 占位
      var phTxt = (S.mySeat === null) ? '观战中' : '等待发牌';
      if (D.heroCards.__ph !== phTxt) {
        D.heroCards.textContent = '';
        D.heroCards.__sig = [];
        for (var j = 0; j < 2; j++) D.heroCards.appendChild(elt('div', 'ph', phTxt));
        D.heroCards.__ph = phTxt;
      }
    }
    if (myCards.length) D.heroCards.__ph = null;

    // 状态文案
    var statusText = '';
    var strong = false;
    var verdictKind = '';   // handOver 时的输赢，用来给状态栏上色
    // 输光筹码：进不了下一手，得补上才能接着打。
    // canRebuy 由服务端给，别只看 chips —— 全下的时候引擎里的筹码也是 0。
    var busted = !!(mySeatData && (Number(mySeatData.chips) || 0) <= 0 && mySeatData.canRebuy);
    if (S.conn !== 'online') {
      statusText = (S.conn === 'offline') ? '连接断开，正在重连…' : '正在连接服务器…';
    } else if (S.mySeat === null) {
      statusText = '观战中 · 点击牌桌上的空座位入座';
    } else if (myTurn) {
      statusText = '轮到你行动';
      strong = true;
    } else if (typeof table.actingSeat === 'number' && seats[table.actingSeat]) {
      statusText = '等待 ' + (seats[table.actingSeat].name || ('座位' + (table.actingSeat + 1))) + ' 行动';
    } else if (table.phase === 'handOver') {
      // 大屏两秒后就让开了，结论留在这儿，整个结算窗口都看得到
      var hv = handVerdict(st, seats, st.result);
      if (hv) {
        statusText = hv.verdict + (hv.amountText ? ' ' + hv.amountText : '')
          + (hv.detail ? ' · ' + hv.detail : '');
        verdictKind = hv.kind;
      } else {
        statusText = '本手结束';
      }
    } else if (table.phase === 'waiting') {
      if (table.canStart) statusText = you.isHost ? '人数够了，可以开始' : '等待房主开始';
      else statusText = '等待更多玩家入座（至少 2 人）';
    } else if (you.sittingOut) {
      statusText = '你暂时离开了，下一手不参与';
    } else {
      statusText = '牌局进行中';
    }
    // 弃牌提示只在牌局还没打完时盖过状态文案；结算阶段要让位给输赢结论
    if (mySeatData && mySeatData.state === 'folded' && table.phase !== 'handOver') {
      statusText = '你已弃牌，等待本手结束';
    }
    // 没筹码是最要紧的事：不补上就一直坐在场外，这条盖过其他提示
    if (busted && table.phase !== 'handOver') {
      statusText = you.isHost
        ? '你的筹码用完了，点「补充筹码」接着打'
        : '你的筹码用完了，让房主给你补充';
      verdictKind = '';
      strong = true;
    }
    D.heroStatusText.textContent = statusText;
    D.heroStatusText.className = strong ? 'strong' : (verdictKind ? 'v-' + verdictKind : '');
    D.heroTimer.hidden = !myTurn;
    lastTimerSec = -1;   // 让 rAF 立刻把秒数补回状态文案
    D.heroCards.classList.toggle('folded', !!(mySeatData && mySeatData.state === 'folded'));

    // 行动条
    if (myTurn) {
      D.actionBar.hidden = false;
      D.idleBar.hidden = true;
      configureActionBar(legal, table, seats);
      if (S.raiseOpen) syncRaiseBounds(legal, table);
    } else {
      D.actionBar.hidden = true;
      D.idleBar.hidden = false;
      closeRaise();
    }

    // 亮牌条：只在服务端说可以亮的时候出现（handOver 且没被摊过牌）
    if (D.showBar) D.showBar.hidden = !you.canShowCards;

    // 空闲按钮
    var seated = S.mySeat !== null;
    // 输光了就随时能补：服务端只拦"正在这手牌里"的座位，破产的人不在其中
    D.btnRebuy.hidden = !(seated && busted && you.isHost);
    if (!D.btnRebuy.hidden) D.btnRebuy.setAttribute('data-seat', String(S.mySeat));
    D.btnStart.hidden = !(seated && you.isHost && table.canStart && !myTurn);
    D.btnSitOut.hidden = !seated;
    D.btnSitOut.textContent = you.sittingOut ? '回到牌桌' : '暂时离开';
    D.btnStand.hidden = !seated;
    D.btnJoin.hidden = seated;
  }

  function configureActionBar(legal, table, seats) {
    var disabled = S.pendingAction;

    D.btnFold.hidden = !legal.canFold;
    D.btnFold.disabled = disabled;

    D.btnCheck.hidden = !legal.canCheck;
    D.btnCheck.disabled = disabled;

    var callAmt = Number(legal.callAmount) || 0;
    D.btnCall.hidden = !legal.canCall;
    D.btnCall.disabled = disabled;
    D.btnCall.textContent = legal.isAllInCall ? ('全下跟注 ' + fmt(callAmt)) : ('跟注 ' + fmt(callAmt));
    D.btnCall.appendChild(elt('em', null, 'C'));

    var canOpen = !!(legal.canBet || legal.canRaise);
    D.btnRaise.hidden = !canOpen;
    D.btnRaise.disabled = disabled;
    D.btnRaise.textContent = legal.canBet ? '下注' : '加注';
    D.btnRaise.appendChild(elt('em', null, 'R'));

    // 只能全下（筹码不够完成最小加注）时单独给一个全下按钮
    var maxTo = Number(legal.maxRaiseTo) || 0;
    var showAllin = !canOpen && maxTo > (Number(table.currentBet) || 0);
    D.btnAllin.hidden = !showAllin;
    D.btnAllin.disabled = disabled;
    D.btnAllin.textContent = '全下 ' + fmt(maxTo);
  }

  function renderLog(st) {
    var log = Array.isArray(st.log) ? st.log : [];
    var keys = log.map(function (l) { return (l && l.ts) + '|' + (l && l.text); });
    var sig = keys.join('\n');
    if (D.logList.__sig === sig) return;
    var prev = S.logSeen || {};
    var nextSeen = {};
    var atBottom = isNearBottom(D.logList);
    D.logList.textContent = '';
    for (var i = 0; i < log.length; i++) {
      var item = log[i];
      if (!item) continue;
      var li = elt('li', null, String(item.text || ''));
      if (!prev[keys[i]]) li.classList.add('new');
      if (/赢得|摊牌|开始|重置/.test(String(item.text || ''))) li.classList.add('hi');
      nextSeen[keys[i]] = 1;
      D.logList.appendChild(li);
    }
    S.logSeen = nextSeen;
    D.logList.__sig = sig;
    if (atBottom) D.logList.scrollTop = D.logList.scrollHeight;
  }

  function renderChat(st) {
    var chat = Array.isArray(st.chat) ? st.chat : [];
    var keys = chat.map(function (c) { return (c && c.ts) + '|' + (c && c.seat) + '|' + (c && c.text); });
    var sig = keys.join('\n');
    if (D.chatList.__sig === sig) return;
    var prevCount = D.chatList.__count || 0;
    var atBottom = isNearBottom(D.chatList);
    D.chatList.textContent = '';
    for (var i = 0; i < chat.length; i++) {
      var c = chat[i];
      if (!c) continue;
      var li = elt('li');
      li.appendChild(elt('span', 'nm', (c.name || '匿名') + '：'));
      li.appendChild(document.createTextNode(String(c.text || '')));
      D.chatList.appendChild(li);
    }
    D.chatList.__sig = sig;
    D.chatList.__count = chat.length;
    if (atBottom) D.chatList.scrollTop = D.chatList.scrollHeight;

    // 抽屉关着的时候提示有新消息
    if (chat.length > prevCount && !isSideOpen() && !$('#paneChat').classList.contains('is-on')) {
      S.chatUnread += (chat.length - prevCount);
      if (D.sideBadge) D.sideBadge.hidden = false;
    }
  }

  function isNearBottom(el) {
    if (!el) return true;
    return (el.scrollHeight - el.scrollTop - el.clientHeight) < 40;
  }

  /**
   * 人机后端面板。只有房主看得到——它能改全桌的人机行为。
   * 服务端下发的 st.bot 里只有打码后的 key，真实 key 永远不回传。
   */
  function renderBotConfig(st, isHost) {
    if (!D.botForm) return;
    D.botForm.hidden = !isHost;
    if (!isHost) return;

    var info = st.bot || { hasLLM: false, providers: [] };
    var sig = JSON.stringify(info.providers) + (info.hasLLM ? '1' : '0');
    if (D.botStatus.__sig === sig) return;
    D.botStatus.__sig = sig;

    if (!info.hasLLM) {
      D.botStatus.textContent = '未配置，人机将按内置规则打牌。';
      D.botStatus.className = 'bot-status';
      return;
    }
    var parts = info.providers.map(function (p) {
      return p.label + '（' + p.model + '，' + p.maskedKey + '）' + (p.cooling ? ' ⚠ 冷却中' : '');
    });
    D.botStatus.textContent = '已启用：' + parts.join('、');
    D.botStatus.className = 'bot-status ok';
  }

  /** 服务端还没有 LLM 时，把本机记住的配置推上去（重启后自动恢复） */
  function pushRememberedBotConfig(st) {
    if (!st || !st.you || !st.you.isHost) return;
    if (st.bot && st.bot.hasLLM) return;
    if (S.botPushed) return;
    var raw = lsGet(LS_BOT);
    if (!raw) return;
    var cfg;
    try { cfg = JSON.parse(raw); } catch (e) { return; }
    if (!cfg || !cfg.apiKey || !cfg.provider) return;
    S.botPushed = true;
    send({ t: 'botConfig', patch: cfg });
  }

  function renderConfigPane(st, cfg, seats, you) {
    var isHost = !!you.isHost;
    D.cfgHostOnly.hidden = isHost;
    D.cfgForm.classList.toggle('locked', !isHost);
    if (D.btnAddBot) D.btnAddBot.hidden = !isHost;
    renderBotConfig(st, isHost);

    // 表单值：正在输入时不覆盖
    var focus = document.activeElement;
    var typing = focus && D.cfgForm.contains(focus);
    if (!typing) {
      D.cfgSB.value = String(cfg.smallBlind == null ? '' : cfg.smallBlind);
      D.cfgBB.value = String(cfg.bigBlind == null ? '' : cfg.bigBlind);
      D.cfgAnte.value = String(cfg.ante == null ? 0 : cfg.ante);
      D.cfgStack.value = String(cfg.startingStack == null ? '' : cfg.startingStack);
      D.cfgTimeout.value = String(Math.round((Number(cfg.actionTimeoutMs) || 45000) / 1000));
      D.cfgAuto.checked = !!cfg.autoNextHand;
    }

    // 座位管理
    var rows = [];
    for (var i = 0; i < MAX_SEATS; i++) {
      var d = seats[i];
      if (!d) continue;
      rows.push(i + ':' + d.name + ':' + d.chips + ':' + (d.connected ? 1 : 0) + ':' + (d.bot ? 1 : 0)
        + ':' + (d.canRebuy ? 1 : 0));
    }
    var sig = rows.join('|') + '|' + (isHost ? 'h' : '-');
    if (D.seatAdmin.__sig === sig) return;
    D.seatAdmin.__sig = sig;
    D.seatAdmin.textContent = '';
    if (!rows.length) {
      D.seatAdmin.appendChild(elt('div', 'sa-empty', '还没有人入座。'));
      return;
    }
    for (var s = 0; s < MAX_SEATS; s++) {
      var data = seats[s];
      if (!data) continue;
      // 同上：全下的人筹码也是 0，但那不是"没钱了"
      var broke = (Number(data.chips) || 0) <= 0 && data.canRebuy;
      var row = elt('div', 'sa-row' + (broke ? ' is-broke' : ''));
      row.appendChild(elt('span', 'sa-name',
        (s + 1) + '. ' + (data.name || '') +
        (data.bot ? '（人机）' : '') +
        (data.connected || data.bot ? '' : '（断线）')));
      // 没筹码的人一眼能挑出来，房主不用去数谁是 0
      row.appendChild(elt('span', 'sa-chips', broke ? '没筹码' : fmt(data.chips)));
      if (isHost) {
        var add = elt('button', null, '补充');
        add.type = 'button';
        add.setAttribute('aria-label', '给 ' + (data.name || '') + ' 补充筹码');
        add.setAttribute('data-seat', String(s));
        add.addEventListener('click', onAddChips);
        var kick = elt('button', 'danger', '踢出');
        kick.type = 'button';
        kick.setAttribute('aria-label', '把 ' + (data.name || '') + ' 请出牌桌');
        kick.setAttribute('data-seat', String(s));
        kick.addEventListener('click', onKick);
        row.appendChild(add);
        row.appendChild(kick);
      }
      D.seatAdmin.appendChild(row);
    }
  }

  /** 轮到自己时提示音（每手每个行动位置只响一次） */
  function maybeAnnounceTurn(table) {
    var key = String(table.handNo) + ':' + String(table.actingSeat) + ':' + String(table.phase) +
      ':' + String(table.currentBet);
    if (key === S.lastActingKey) return;
    S.lastActingKey = key;
    if (S.mySeat !== null && table.actingSeat === S.mySeat) sndTurn();
  }

  /**
   * 思考倒计时报时：轮到自己时一秒一声"嗒"，最后 3 秒变急。
   *
   * 起点取"剩 10 秒"和"总时长三分之一"里更小的那个 —— 房主要是把时限设成 8 秒，
   * 从头响到尾就成噪音了。
   *
   * 报时用 (deadline, 秒数) 当键去重，而不是靠 lastTimerSec：
   * renderHero 每收到一份快照都会把 lastTimerSec 重置成 -1，拿它判重会漏响。
   *
   * @param {number} sec 剩余整秒
   * @param {number} totalMs 本次行动的总时长
   * @param {number} deadline 本次行动的截止时刻，用来区分不同回合
   */
  var lastBeepKey = '';

  function countdownBeep(sec, totalMs, deadline) {
    var from = Math.max(3, Math.min(10, Math.floor((totalMs || 45000) / 3000)));
    if (sec > from) return;
    var key = deadline + ':' + sec;
    if (key === lastBeepKey) return;
    lastBeepKey = key;
    if (sec <= 0) sndTimeUp();
    else sndTick(sec <= 3);
  }

  /** 赢家 "+N" 上浮 */
  function maybeFloatWins(table, result) {
    if (!result || !Array.isArray(result.winners) || !result.winners.length) return;
    var handNo = Number(table.handNo) || 0;
    if (S.shownResultHand === handNo) return;
    S.shownResultHand = handNo;

    var rot = (S.mySeat === null) ? 0 : S.mySeat;
    var merged = {};
    for (var i = 0; i < result.winners.length; i++) {
      var w = result.winners[i];
      if (!w || typeof w.seat !== 'number') continue;
      if (!merged[w.seat]) merged[w.seat] = { amount: 0, handName: null };
      merged[w.seat].amount += Number(w.amount) || 0;
      if (!merged[w.seat].handName && w.handName) merged[w.seat].handName = w.handName;
    }
    Object.keys(merged).forEach(function (seatStr) {
      var seat = Number(seatStr);
      var slot0 = ((seat - rot) % MAX_SEATS + MAX_SEATS) % MAX_SEATS;
      // 筹码从底池推到赢家面前——自己赢了也要看到这一下
      payChipsToWinner(slot0, merged[seat].amount);
      // 自己的那份不飘：结算大屏就在正中央，两个数字叠一起反而看不清，
      // 而且飘的是毛收入、大屏报的是净收支，摆一起容易被当成矛盾。
      if (seat === S.mySeat) return;
      var slot = ((seat - rot) % MAX_SEATS + MAX_SEATS) % MAX_SEATS;
      var p = POS[slot];
      if (!p) return;
      var f = elt('div', 'float-win', '+' + fmt(merged[seat].amount));
      if (merged[seat].handName) f.appendChild(elt('small', null, merged[seat].handName));
      f.style.setProperty('--x', p.x + '%');
      f.style.setProperty('--y', (p.y - 6) + '%');
      D.floatLayer.appendChild(f);
      setTimeout(function () { if (f.parentNode) f.parentNode.removeChild(f); }, 2000);
    });
  }

  // ============================ 行动 ============================

  function currentLegal() {
    var st = S.state;
    if (!st || !st.you) return null;
    var legal = st.you.legal || null;
    if (!legal) return null;
    if (!st.table || st.table.actingSeat !== st.you.seat) return null;
    return legal;
  }

  function sendAction(type, amount) {
    var st = S.state;
    if (!st || !st.table) return;
    var msg = { t: 'action', handNo: st.table.handNo, type: type };
    if (amount != null) msg.amount = Math.round(amount);
    if (!send(msg)) { toast('连接断开，动作没有发出去'); return; }
    S.pendingAction = true;
    if (S.pendingTimer) clearTimeout(S.pendingTimer);
    S.pendingTimer = setTimeout(function () {
      S.pendingAction = false;
      S.pendingTimer = null;
      render();
    }, 3000);
    closeRaise();
    // 立即禁用按钮，避免重复点击
    [D.btnFold, D.btnCheck, D.btnCall, D.btnRaise, D.btnAllin].forEach(function (b) {
      if (b) b.disabled = true;
    });
    markActed(type);
  }

  function doFold() { if (currentLegal()) sendAction('fold'); }
  function doCheck() { var l = currentLegal(); if (l && l.canCheck) sendAction('check'); }
  function doCall() { var l = currentLegal(); if (l && l.canCall) sendAction('call'); }
  function doAllin() { if (currentLegal()) sendAction('allin'); }

  function raiseBounds(legal) {
    var min = legal.canBet ? (Number(legal.minBet) || 0) : (Number(legal.minRaiseTo) || 0);
    var max = Number(legal.maxRaiseTo) || 0;
    if (max < min) max = min;
    return { min: min, max: max };
  }

  function openRaise() {
    var legal = currentLegal();
    if (!legal || !(legal.canBet || legal.canRaise)) return;
    S.raiseOpen = true;
    D.raisePanel.hidden = false;
    syncRaiseBounds(legal, (S.state && S.state.table) || {});
    setRaiseValue(S.raiseVal || S.raiseMin, true);
    if (D.raiseNum) D.raiseNum.focus();
  }

  function closeRaise() {
    if (!S.raiseOpen && D.raisePanel.hidden) return;
    S.raiseOpen = false;
    D.raisePanel.hidden = true;
  }

  function syncRaiseBounds(legal, table) {
    var b = raiseBounds(legal);
    S.raiseMin = b.min;
    S.raiseMax = b.max;
    D.raiseRange.min = String(b.min);
    D.raiseRange.max = String(b.max);
    D.raiseNum.min = String(b.min);
    D.raiseNum.max = String(b.max);
    var step = 1;
    D.raiseRange.step = String(step);
    D.raiseNum.step = String(step);
    if (!(S.raiseVal >= b.min && S.raiseVal <= b.max)) {
      setRaiseValue(b.min, true);
    } else {
      setRaiseValue(S.raiseVal, true);
    }
    // 快捷按钮：金额超出上限的直接置灰
    var quicks = D.raisePanel.querySelectorAll('.qk');
    for (var i = 0; i < quicks.length; i++) {
      var f = quicks[i].getAttribute('data-frac');
      if (f === 'min' || f === 'max') { quicks[i].disabled = false; continue; }
      var v = potRaiseTo(parseFloat(f), legal, table);
      quicks[i].disabled = !(v > b.min && v < b.max);
    }
  }

  function potRaiseTo(frac, legal, table) {
    var pot = Number(table.totalPot) || 0;
    var call = Number(legal.callAmount) || 0;
    var cur = Number(table.currentBet) || 0;
    return Math.round(cur + frac * (pot + call));
  }

  function setRaiseValue(v, silent) {
    var val = clamp(Math.round(Number(v) || 0), S.raiseMin, S.raiseMax);
    S.raiseVal = val;
    if (D.raiseRange.value !== String(val)) D.raiseRange.value = String(val);
    if (!silent || document.activeElement !== D.raiseNum) D.raiseNum.value = String(val);
    var legal = currentLegal();
    var verb = (legal && legal.canBet) ? '下注' : '加注到';
    var allin = (val >= S.raiseMax && S.raiseMax > 0);
    D.btnRaiseOk.textContent = allin ? ('全下 ' + fmt(val)) : ('确认' + verb + ' ' + fmt(val));
  }

  function confirmRaise() {
    var legal = currentLegal();
    if (!legal) { closeRaise(); return; }
    var val = clamp(S.raiseVal, S.raiseMin, S.raiseMax);
    if (val >= S.raiseMax) { sendAction('allin'); return; }
    sendAction(legal.canBet ? 'bet' : 'raise', val);
  }

  // ============================ 入座 / 房主操作 ============================

  function openSitDialog(seat) {
    S.sitSeat = seat;
    var name = lsGet(LS_NAME) || '';
    if (!D.sitDlg || !D.sitDlg.showModal) {
      // 极老浏览器兜底
      var typed = window.prompt('输入昵称（1-12 个字符）', name);
      if (typed) doSit(seat, typed);
      return;
    }
    D.sitTitle.textContent = '坐到 ' + (seat + 1) + ' 号座位';
    D.sitName.value = name;
    D.sitErr.hidden = true;
    D.sitDlg.showModal();
    setTimeout(function () { try { D.sitName.focus(); D.sitName.select(); } catch (e) { /* 忽略 */ } }, 30);
  }

  function doSit(seat, name) {
    name = String(name == null ? '' : name).trim();
    if (!name || Array.from(name).length > 12) {
      toast('昵称需要 1 到 12 个字符');
      return;
    }
    lsSet(LS_NAME, name);
    if (!send({ t: 'sit', seat: seat, name: name })) {
      toast('还没连上服务器，稍后再试');
      return;
    }
    ensureAudio(); // 借用户手势解锁音频
  }

  function askConfirm(title, text, onOk) {
    if (!D.confirmDlg || !D.confirmDlg.showModal) {
      if (window.confirm(text)) onOk();
      return;
    }
    D.confirmTitle.textContent = title;
    D.confirmText.textContent = text;
    D.confirmDlg.__onOk = onOk;
    D.confirmDlg.showModal();
  }

  function onAddChips(ev) {
    var seat = Number(ev.currentTarget.getAttribute('data-seat'));
    if (!(seat >= 0)) return;
    var st = S.state;
    var d = st && Array.isArray(st.seats) ? st.seats[seat] : null;
    if (!D.chipsDlg || !D.chipsDlg.showModal) {
      var v = window.prompt('补充多少筹码？', '1000');
      if (v) send({ t: 'addChips', seat: seat, amount: Math.max(1, Math.round(Number(v) || 0)) });
      return;
    }
    D.chipsTitle.textContent = '给 ' + ((d && d.name) || ((seat + 1) + ' 号座位')) + ' 补充筹码';
    D.chipsDlg.__seat = seat;
    var stack = (st && st.config && st.config.startingStack) || 1000;
    D.chipsAmt.value = String(stack);
    D.chipsDlg.showModal();
  }

  function onKick(ev) {
    var seat = Number(ev.currentTarget.getAttribute('data-seat'));
    if (!(seat >= 0)) return;
    var st = S.state;
    var d = st && Array.isArray(st.seats) ? st.seats[seat] : null;
    askConfirm('踢出玩家', '确定把 ' + ((d && d.name) || ((seat + 1) + ' 号座位')) + ' 请出牌桌吗？', function () {
      send({ t: 'kick', seat: seat });
    });
  }

  // ============================ 侧栏 ============================

  function isSideOpen() {
    if (!D.side) return false;
    if (window.innerWidth > 900) return true;
    return D.side.classList.contains('open');
  }

  function openSide(open) {
    if (!D.side) return;
    D.side.classList.toggle('open', !!open);
    D.drawerMask.hidden = !open;
    if (open) {
      S.chatUnread = 0;
      if (D.sideBadge) D.sideBadge.hidden = true;
    }
  }

  function switchTab(name) {
    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      var on = tabs[i].getAttribute('data-tab') === name;
      tabs[i].classList.toggle('is-on', on);
      tabs[i].setAttribute('aria-selected', on ? 'true' : 'false');
    }
    var panes = { log: $('#paneLog'), chat: $('#paneChat'), cfg: $('#paneCfg') };
    Object.keys(panes).forEach(function (k) {
      if (panes[k]) panes[k].classList.toggle('is-on', k === name);
    });
    if (name === 'chat') {
      S.chatUnread = 0;
      if (D.sideBadge) D.sideBadge.hidden = true;
      if (D.chatList) D.chatList.scrollTop = D.chatList.scrollHeight;
    }
    if (name === 'log' && D.logList) D.logList.scrollTop = D.logList.scrollHeight;
  }

  // ============================ 布局测量 ============================

  function layout() {
    if (!D.tableWrap || !D.root) return;
    var narrow = window.innerWidth <= 620;
    var padX = narrow ? 10 : 20;
    var padY = narrow ? 24 : 36;
    var availW = Math.max(220, D.tableWrap.clientWidth - padX * 2);
    var availH = Math.max(150, D.tableWrap.clientHeight - padY * 2);
    // 桌面固定成横向跑道（真桌大约 2:1，这里留一点余量给两侧的座位牌）；
    // 手机竖屏时按可用区域的比例把牌桌拉高，否则固定宽高比会让上下留出
    // 大片空白，牌桌被挤成中间一条。
    var ar = window.innerWidth <= 760
      ? Math.min(1.6, Math.max(0.75, availW / availH))
      : 1.85;
    var w = Math.min(availW, availH * ar, 1040);
    w = Math.max(240, w);
    D.root.style.setProperty('--tw', Math.round(w) + 'px');
    D.root.style.setProperty('--ar', String(ar));
    computeSeats(Math.round(w), Math.round(w) / ar);
    applySeatPos();
  }

  // ============================ 计时（rAF） ============================

  var lastTimerSec = -1;
  var lastNextSec = -1;

  function tick() {
    var st = S.state;
    if (st && st.table) {
      var table = st.table;
      var cfg = st.config || {};
      var now = Date.now() + S.clockOffset;
      var total = Number(cfg.actionTimeoutMs) || 45000;
      var dl = Number(table.actionDeadline) || 0;

      if (dl > 0 && typeof table.actingSeat === 'number') {
        var left = Math.max(0, dl - now);
        var p = total > 0 ? clamp(left / total, 0, 1) : 0;
        var urgent = left < 8000;
        if (S.ringNode) {
          S.ringNode.style.setProperty('--p', p.toFixed(3));
          if (S.ringNode.classList.contains('urgent') !== urgent) {
            S.ringNode.classList.toggle('urgent', urgent);
          }
        }
        if (!D.heroTimer.hidden) {
          D.heroTimerBar.style.width = (p * 100).toFixed(1) + '%';
          if (D.heroTimer.classList.contains('urgent') !== urgent) {
            D.heroTimer.classList.toggle('urgent', urgent);
          }
          var sec = Math.ceil(left / 1000);
          if (sec !== lastTimerSec) {
            lastTimerSec = sec;
            D.heroStatusText.textContent = '轮到你行动 · ' + sec + ' 秒';
          }
          countdownBeep(sec, total, dl);
        }
      }

      // 下一手倒计时
      var nh = Number(table.nextHandAt) || 0;
      if (nh > 0) {
        var leftN = Math.max(0, Math.ceil((nh - now) / 1000));
        if (leftN !== lastNextSec) {
          lastNextSec = leftN;
          D.nextHandTip.hidden = false;
          D.nextHandTip.textContent = leftN + ' 秒后开始下一手';
        }
      } else if (!D.nextHandTip.hidden) {
        D.nextHandTip.hidden = true;
        lastNextSec = -1;
      }
    }
    window.requestAnimationFrame(tick);
  }

  // ============================ 事件绑定 ============================

  function bindEvents() {
    // 全局按下反馈：任何按钮按下都亮一下 + 一记轻响。
    // 用 capture 阶段的 pointerdown，比 click 早、也不怕中途被 stopPropagation。
    document.addEventListener('pointerdown', function (e) {
      var el = (e.target && e.target.closest)
        ? e.target.closest('button, .pod[role="button"]') : null;
      if (!el || el.disabled) return;
      flashPress(el);
      ensureAudio(); // 顺带借这次手势解锁音频
      sndClick(el.classList.contains('act-allin') || el.classList.contains('act-danger'));
    }, true);

    // 键盘激活按钮不会有 pointerdown，单独补一次
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var el = e.target;
      if (!el || el.tagName !== 'BUTTON' || el.disabled) return;
      flashPress(el);
      ensureAudio();
      sndClick(false);
    }, true);

    document.addEventListener('animationend', function (e) {
      if (e.animationName === 'pressFlash' || e.animationName === 'pressFlashFlat') {
        if (e.target && e.target.classList) e.target.classList.remove('press-fx');
      }
    }, true);

    // 行动按钮
    D.btnFold.addEventListener('click', doFold);
    D.btnCheck.addEventListener('click', doCheck);
    D.btnCall.addEventListener('click', doCall);
    D.btnAllin.addEventListener('click', doAllin);
    D.btnRaise.addEventListener('click', function () {
      if (S.raiseOpen) closeRaise(); else openRaise();
    });
    D.btnRaiseCancel.addEventListener('click', closeRaise);
    D.btnRaiseOk.addEventListener('click', confirmRaise);

    D.raiseRange.addEventListener('input', function () { setRaiseValue(D.raiseRange.value); });
    D.raiseNum.addEventListener('input', function () { setRaiseValue(D.raiseNum.value, true); });
    D.raiseNum.addEventListener('change', function () { setRaiseValue(D.raiseNum.value); });
    D.raiseNum.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); confirmRaise(); }
    });

    var quicks = D.raisePanel.querySelectorAll('.qk');
    for (var i = 0; i < quicks.length; i++) {
      quicks[i].addEventListener('click', function (ev) {
        var legal = currentLegal();
        if (!legal) return;
        var table = (S.state && S.state.table) || {};
        var f = ev.currentTarget.getAttribute('data-frac');
        if (f === 'min') setRaiseValue(S.raiseMin);
        else if (f === 'max') setRaiseValue(S.raiseMax);
        else setRaiseValue(potRaiseTo(parseFloat(f), legal, table));
      });
    }

    // 空闲按钮
    D.btnStart.addEventListener('click', function () { send({ t: 'start' }); ensureAudio(); });
    D.btnRebuy.addEventListener('click', onAddChips);
    D.btnSitOut.addEventListener('click', function () {
      var st = S.state;
      var cur = !!(st && st.you && st.you.sittingOut);
      send({ t: 'sitOut', value: !cur });
    });
    D.btnStand.addEventListener('click', function () {
      askConfirm('退出牌桌', '确定退出、离开座位吗？如果牌局进行中会自动弃牌。', function () {
        send({ t: 'stand' });
      });
    });
    D.btnJoin.addEventListener('click', function () {
      var st = S.state;
      var seats = st && Array.isArray(st.seats) ? st.seats : [];
      for (var s = 0; s < MAX_SEATS; s++) {
        if (!seats[s]) { openSitDialog(s); return; }
      }
      toast('牌桌已坐满');
    });

    // 座位键盘可达
    D.seatLayer.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var pod = e.target && e.target.closest ? e.target.closest('.pod') : null;
      if (!pod) return;
      var seatEl = pod.parentNode;
      if (!seatEl || !seatEl.classList.contains('can-sit')) return;
      e.preventDefault();
      var seat = Number(seatEl.getAttribute('data-seat'));
      if (seat >= 0) openSitDialog(seat);
    });

    // 顶栏
    D.btnSound.addEventListener('click', function () {
      S.muted = !S.muted;
      lsSet(LS_MUTED, S.muted ? '1' : '0');
      D.btnSound.setAttribute('aria-pressed', S.muted ? 'false' : 'true');
      // 开音效时放一段试听，让人知道现在是什么动静
      if (!S.muted) { ensureAudio(); sndBoard(1); sndChips(3); }
    });
    D.btnSound.setAttribute('aria-pressed', S.muted ? 'false' : 'true');

    D.btnMusic.addEventListener('click', function () {
      S.musicOn = !S.musicOn;
      lsSet(LS_MUSIC, S.musicOn ? '1' : '0');
      D.btnMusic.setAttribute('aria-pressed', S.musicOn ? 'true' : 'false');
      syncMusic();
    });
    D.btnMusic.setAttribute('aria-pressed', S.musicOn ? 'true' : 'false');

    // 一首放完自动接下一首。<audio> 上没有 loop 了，全靠这个把歌单串起来
    if (D.bgm) D.bgm.addEventListener('ended', musicNext);

    // 结算大屏：点一下立刻让开，不用等那 2.4 秒
    if (D.resultOverlay) {
      D.resultOverlay.addEventListener('click', dismissResultOverlay);
    }

    D.btnSide.addEventListener('click', function () { openSide(!D.side.classList.contains('open')); });
    $('#btnSideClose').addEventListener('click', function () { openSide(false); });
    D.drawerMask.addEventListener('click', function () { openSide(false); });

    // 侧栏标签
    var tabs = document.querySelectorAll('.tab');
    for (var t = 0; t < tabs.length; t++) {
      tabs[t].addEventListener('click', function (ev) {
        switchTab(ev.currentTarget.getAttribute('data-tab'));
      });
    }

    // 聊天
    D.chatForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = D.chatInput.value.trim();
      if (!text) return;
      if (Array.from(text).length > 200) text = Array.from(text).slice(0, 200).join('');
      send({ t: 'chat', text: text });
      D.chatInput.value = '';
    });

    // 设置
    D.cfgForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var st = S.state;
      if (!st || !st.you || !st.you.isHost) { toast('只有房主可以修改设置'); return; }
      var sb = Math.round(Number(D.cfgSB.value) || 0);
      var bb = Math.round(Number(D.cfgBB.value) || 0);
      var ante = Math.round(Number(D.cfgAnte.value) || 0);
      var stack = Math.round(Number(D.cfgStack.value) || 0);
      var secs = Math.round(Number(D.cfgTimeout.value) || 0);
      if (!(sb > 0) || !(bb > sb) || !(stack > 0) || !(secs >= 5)) {
        toast('设置不合法：大盲要大于小盲，时限至少 5 秒');
        return;
      }
      send({
        t: 'config',
        patch: {
          smallBlind: sb, bigBlind: bb, ante: Math.max(0, ante),
          startingStack: stack, actionTimeoutMs: secs * 1000,
          autoNextHand: !!D.cfgAuto.checked
        }
      });
      toast('设置已提交', true);
    });

    D.btnReset.addEventListener('click', function () {
      askConfirm('重置牌桌', '所有人的筹码会回到起始值，当前牌局会被清空。确定吗？', function () {
        send({ t: 'reset' });
      });
    });

    if (D.botForm) {
      D.botForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var st = S.state;
        if (!st || !st.you || !st.you.isHost) { toast('只有房主可以配置人机'); return; }

        var key = D.botKey.value.trim();
        var patch = {
          provider: D.botProvider.value,
          model: D.botModel.value.trim(),
        };
        // 留空表示"沿用已有 key，只改模型"
        if (key) patch.apiKey = key;
        else if (!(st.bot && st.bot.hasLLM)) { toast('请先填 API Key'); return; }

        send({ t: 'botConfig', patch: patch });

        if (key && D.botRemember.checked) {
          lsSet(LS_BOT, JSON.stringify(patch));
        } else if (!D.botRemember.checked) {
          lsSet(LS_BOT, '');
        }
        // 输入框里不留 key，避免肩窥
        D.botKey.value = '';
        toast('人机后端已提交', true);
      });
    }

    if (D.btnShowCards) {
      D.btnShowCards.addEventListener('click', function () {
        send({ t: 'showCards' });
        // 立刻收起来，别让人连点；服务端下一帧快照会把 canShowCards 置 false
        D.showBar.hidden = true;
      });
    }

    if (D.btnAddBot) {
      D.btnAddBot.addEventListener('click', function () {
        var st = S.state;
        if (!st || !st.you || !st.you.isHost) { toast('只有房主可以加人机'); return; }
        // 不传 seat，让服务端挑第一个空位
        send({ t: 'addBot' });
      });
    }

    // 对话框
    if (D.sitDlg) {
      D.sitDlg.addEventListener('close', function () {
        if (D.sitDlg.returnValue !== 'ok') return;
        if (S.sitSeat === null) return;
        doSit(S.sitSeat, D.sitName.value);
      });
    }
    if (D.confirmDlg) {
      D.confirmDlg.addEventListener('close', function () {
        var fn = D.confirmDlg.__onOk;
        D.confirmDlg.__onOk = null;
        if (D.confirmDlg.returnValue === 'ok' && typeof fn === 'function') fn();
      });
    }
    if (D.chipsDlg) {
      D.chipsDlg.addEventListener('close', function () {
        if (D.chipsDlg.returnValue !== 'ok') return;
        var seat = D.chipsDlg.__seat;
        var amt = Math.round(Number(D.chipsAmt.value) || 0);
        if (!(seat >= 0) || !(amt > 0)) return;
        send({ t: 'addChips', seat: seat, amount: amt });
      });
    }

    D.fatalRetry.addEventListener('click', function () {
      S.fatal = null;
      D.fatalMask.hidden = true;
      S.backoff = 500;
      connect();
    });

    // 快捷键
    document.addEventListener('keydown', function (e) {
      var tag = e.target && e.target.tagName ? e.target.tagName : '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var legal = currentLegal();
      var k = String(e.key || '').toLowerCase();
      if (k === 'escape') {
        if (S.raiseOpen) { closeRaise(); e.preventDefault(); }
        else if (isSideOpen() && window.innerWidth <= 900) openSide(false);
        return;
      }
      if (!legal) return;
      if (k === 'f') { e.preventDefault(); doFold(); }
      else if (k === 'c') { e.preventDefault(); if (legal.canCheck) doCheck(); else if (legal.canCall) doCall(); }
      else if (k === 'r') { e.preventDefault(); if (S.raiseOpen) closeRaise(); else openRaise(); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        if (S.raiseOpen) confirmRaise();
        else if (legal.canCheck) doCheck();
        else if (legal.canCall) doCall();
      }
    });

    // 尺寸变化
    window.addEventListener('resize', layout);
    window.addEventListener('orientationchange', function () { setTimeout(layout, 120); });
    if (window.ResizeObserver && D.tableWrap) {
      try { new window.ResizeObserver(layout).observe(D.tableWrap); } catch (e) { /* 忽略 */ }
    }

    // 回到前台立刻重连
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && !S.ws && !S.fatal) {
        S.backoff = 500;
        connect();
      }
    });

    // 首次交互解锁音频。浏览器的自动播放策略要求必须有用户手势，
    // 背景音乐也只能等到这一刻才真正开得起来。
    // 监听器**不摘**，每次手势都重试一遍：
    // 自动播放策略只认"用户激活"，而第一次交互不一定给得到（合成点击、
    // 某些辅助技术路径都拿不到），play() 会被拒。只试一次就把监听摘掉的话，
    // 那一拒就是永久没有背景音乐。已经在放了就直接返回，开销可以忽略。
    var unlock = function () {
      audio();
      if (S.musicOn && D.bgm && D.bgm.paused) musicStart();
    };
    ['pointerdown', 'touchend', 'keydown', 'click'].forEach(function (evt) {
      window.addEventListener(evt, unlock);
    });
  }

  // ============================ 启动 ============================

  function boot() {
    cacheDom();
    voice = window.TableVoice ? window.TableVoice.create({
      send: send,
      toast: toast,
      mount: D.voiceMount,
      dock: D.voiceDock,
      button: D.btnVoice,
      // 说话状态一变就重画座位，头像上的绿圈才跟得上
      onSpeakingChange: function () { if (S.state) render(); },
    }) : null;
    buildSeats();
    bindEvents();
    layout();
    switchTab('log');
    window.requestAnimationFrame(tick);
    connect();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
