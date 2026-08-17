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

  /** 座位在牌桌上的百分比坐标（预先按椭圆算好）：
   *  显示槽位 0 永远在正下方（自己的位置），槽位号沿顺时针递增。 */
  var POS = [
    { x: 50.0, y: 92.5, bx: 50, by: 74 },
    { x: 21.4, y: 80.0, bx: 28, by: 66 },
    { x: 9.5,  y: 50.0, bx: 21, by: 50 },
    { x: 21.4, y: 19.9, bx: 28, by: 34 },
    { x: 50.0, y: 7.5,  bx: 50, by: 26 },
    { x: 78.6, y: 19.9, bx: 72, by: 34 },
    { x: 90.5, y: 50.0, bx: 79, by: 50 },
    { x: 78.6, y: 80.0, bx: 72, by: 66 }
  ];

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
  var LS_MUTED = 'poker_muted';

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

  function chipTier(n) {
    if (n < 25) return 0;
    if (n < 100) return 1;
    if (n < 500) return 2;
    if (n < 2000) return 3;
    if (n < 10000) return 4;
    return 5;
  }

  // ============================ 客户端状态 ============================

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
    raiseOpen: false,
    raiseMin: 0,
    raiseMax: 0,
    raiseVal: 0,
    pendingAction: false,
    pendingTimer: null,
    lastActingKey: '',
    shownResultHand: -1,
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
    D.btnSide = $('#btnSide');
    D.sideBadge = $('#sideBadge');

    D.tableWrap = $('#tableWrap');
    D.table = $('#table');
    D.seatLayer = $('#seatLayer');
    D.betLayer = $('#betLayer');
    D.floatLayer = $('#floatLayer');
    D.phaseTag = $('#phaseTag');
    D.potRow = $('#potRow');
    D.potMain = $('#potMain');
    D.potSide = $('#potSide');
    D.board = $('#board');
    D.resultBanner = $('#resultBanner');
    D.nextHandTip = $('#nextHandTip');

    D.heroCards = $('#heroCards');
    D.heroStatusText = $('#heroStatusText');
    D.heroTimer = $('#heroTimer');
    D.heroTimerBar = $('#heroTimerBar');
    D.actionBar = $('#actionBar');
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

  // ============================ 音效（WebAudio 合成） ============================

  var audioCtx = null;

  function ensureAudio() {
    if (S.muted) return null;
    try {
      if (!audioCtx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        audioCtx = new AC();
      }
      if (audioCtx.state === 'suspended' && audioCtx.resume) audioCtx.resume();
      return audioCtx;
    } catch (e) { return null; }
  }

  function tone(freq, dur, delay, gain, type) {
    var ctx = ensureAudio();
    if (!ctx) return;
    try {
      var t0 = ctx.currentTime + (delay || 0);
      var osc = ctx.createOscillator();
      var g = ctx.createGain();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(freq, t0);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain || 0.04), t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g);
      g.connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.03);
    } catch (e) { /* 音频失败不影响功能 */ }
  }

  function sndTurn() { tone(784, 0.10, 0, 0.05, 'sine'); tone(1046, 0.10, 0.13, 0.042, 'sine'); }
  function sndChip() { tone(230, 0.05, 0, 0.028, 'triangle'); }
  function sndCard() { tone(480, 0.045, 0, 0.02, 'sine'); }
  function sndWin() { tone(523, 0.16, 0, 0.045); tone(659, 0.16, 0.09, 0.045); tone(784, 0.24, 0.18, 0.045); }

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
    switch (m.t) {
      case 'welcome':
        if (typeof m.token === 'string' && m.token) lsSet(LS_TOKEN, m.token);
        S.playerId = m.playerId || null;
        if (typeof m.seat === 'number') S.mySeat = m.seat;
        break;

      case 'state':
        S.state = m;
        if (typeof m.serverNow === 'number') S.clockOffset = m.serverNow - Date.now();
        clearPending();
        render();
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
      case 'flop':
      case 'turn':
      case 'river':
        sndCard();
        break;
      case 'action':
      case 'blind':
      case 'ante':
        sndChip();
        break;
      case 'win':
        sndWin();
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
      avWrap.appendChild(avatar);
      avWrap.appendChild(ring);
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
      var chipNode = elt('i', 'chip');
      var amtNode = elt('span', 'amt');
      bet.appendChild(chipNode);
      bet.appendChild(amtNode);

      D.seatLayer.appendChild(root);
      D.betLayer.appendChild(bet);

      S.seatNodes.push({
        root: root, pod: pod, avWrap: avWrap, avatar: avatar, ring: ring,
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

  function renderSeats(st, table, seats, you, result) {
    var rot = (S.mySeat === null) ? 0 : S.mySeat;
    var actingSeat = (typeof table.actingSeat === 'number') ? table.actingSeat : null;
    S.ringNode = null;

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
      }
      if (data && actingSeat === seatNum) cls += ' acting';
      node.root.className = cls;

      if (!data) {
        node.avWrap.hidden = true;
        node.info.hidden = true;
        node.offDot.hidden = true;
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
      if (bet > 0) {
        var prev = S.lastBets[seatNum] || 0;
        node.bet.hidden = false;
        node.amt.textContent = fmt(bet);
        node.chip.setAttribute('data-tier', String(chipTier(bet)));
        if (bet !== prev) {
          node.bet.classList.remove('bump');
          void node.bet.offsetWidth;
          node.bet.classList.add('bump');
        }
      } else {
        node.bet.hidden = true;
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

    // 结算横幅
    if (D.resultBanner) {
      if (result && Array.isArray(result.winners) && result.winners.length) {
        var parts = [];
        var seen = {};
        for (var i2 = 0; i2 < result.winners.length; i2++) {
          var ww = result.winners[i2];
          if (!ww) continue;
          var key = ww.seat;
          if (seen[key] != null) {
            parts[seen[key]].amount += Number(ww.amount) || 0;
            if (!parts[seen[key]].handName && ww.handName) parts[seen[key]].handName = ww.handName;
            continue;
          }
          seen[key] = parts.length;
          parts.push({
            name: ww.name || ('座位' + ((ww.seat | 0) + 1)),
            amount: Number(ww.amount) || 0,
            handName: ww.handName || null
          });
        }
        var txt = parts.map(function (p) {
          return p.name + ' 赢得 ' + fmt(p.amount) + (p.handName ? '（' + p.handName + '）' : '');
        }).join('    ');
        D.resultBanner.textContent = txt;
        D.resultBanner.hidden = false;
      } else {
        D.resultBanner.hidden = true;
        D.resultBanner.textContent = '';
      }
    }
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
      statusText = '本手结束';
    } else if (table.phase === 'waiting') {
      if (table.canStart) statusText = you.isHost ? '人数够了，可以开始' : '等待房主开始';
      else statusText = '等待更多玩家入座（至少 2 人）';
    } else if (you.sittingOut) {
      statusText = '你已坐出，下一手不参与';
    } else {
      statusText = '牌局进行中';
    }
    if (mySeatData && mySeatData.state === 'folded') statusText = '你已弃牌，等待本手结束';
    D.heroStatusText.textContent = statusText;
    D.heroStatusText.className = strong ? 'strong' : '';
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

    // 空闲按钮
    var seated = S.mySeat !== null;
    D.btnStart.hidden = !(seated && you.isHost && table.canStart && !myTurn);
    D.btnSitOut.hidden = !seated;
    D.btnSitOut.textContent = you.sittingOut ? '回到牌桌' : '坐出一手';
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

  function renderConfigPane(st, cfg, seats, you) {
    var isHost = !!you.isHost;
    D.cfgHostOnly.hidden = isHost;
    D.cfgForm.classList.toggle('locked', !isHost);
    if (D.btnAddBot) D.btnAddBot.hidden = !isHost;

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
      rows.push(i + ':' + d.name + ':' + d.chips + ':' + (d.connected ? 1 : 0) + ':' + (d.bot ? 1 : 0));
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
      var row = elt('div', 'sa-row');
      row.appendChild(elt('span', 'sa-name',
        (s + 1) + '. ' + (data.name || '') +
        (data.bot ? '（人机）' : '') +
        (data.connected || data.bot ? '' : '（断线）')));
      row.appendChild(elt('span', 'sa-chips', fmt(data.chips)));
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
      var slot = ((seat - rot) % MAX_SEATS + MAX_SEATS) % MAX_SEATS;
      var p = POS[slot];
      if (!p) return;
      var f = elt('div', 'float-win', '+' + fmt(merged[seat].amount));
      if (merged[seat].handName) f.appendChild(elt('small', null, merged[seat].handName));
      f.style.setProperty('--x', p.x + '%');
      f.style.setProperty('--y', (p.y - 6) + '%');
      D.floatLayer.appendChild(f);
      setTimeout(function () { if (f.parentNode) f.parentNode.removeChild(f); }, 1800);
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
    // 桌面固定成横向椭圆；手机竖屏时按可用区域的比例把牌桌拉高，
    // 否则固定宽高比会让上下留出大片空白，牌桌被挤成中间一条。
    var ar = window.innerWidth <= 760
      ? Math.min(1.35, Math.max(0.75, availW / availH))
      : 1.55;
    var w = Math.min(availW, availH * ar, 920);
    w = Math.max(240, w);
    D.root.style.setProperty('--tw', Math.round(w) + 'px');
    D.root.style.setProperty('--ar', String(ar));
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
    D.btnSitOut.addEventListener('click', function () {
      var st = S.state;
      var cur = !!(st && st.you && st.you.sittingOut);
      send({ t: 'sitOut', value: !cur });
    });
    D.btnStand.addEventListener('click', function () {
      askConfirm('离座', '确定离开座位吗？如果牌局进行中会自动弃牌。', function () {
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
      if (!S.muted) { ensureAudio(); sndCard(); }
    });
    D.btnSound.setAttribute('aria-pressed', S.muted ? 'false' : 'true');

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

    // 首次交互解锁音频
    var unlock = function () {
      ensureAudio();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  }

  // ============================ 启动 ============================

  function boot() {
    cacheDom();
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
