// SPDX-License-Identifier: GPL-3.0-or-later
// 「热词」前端。零构建：浏览器原生 ES module，没有打包器也没有外链。
//
// 页面本身没有任何游戏逻辑——排名、冷却、提示解锁、能不能偷看，
// 全部由服务端在快照里算好。这边只负责画出来，以及把冷却秒数
// 本地倒着数（服务端一秒推一次，光靠推的话按钮上的数字会一跳一跳的）。

const LS_TOKEN = 'hotword.token';
const LS_NAME = 'hotword.name';
const LS_SOUND = 'hotword.sound';
const LS_SORT = 'hotword.sort';

const $ = (id) => document.getElementById(id);

function elt(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = String(text);
  return e;
}

function lsGet(k) { try { return window.localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch { /* 隐私模式忽略 */ } }

const D = {};
for (const id of [
  'connBadge', 'connText', 'metaRound', 'metaScore', 'metaHost',
  'arena', 'fighter0', 'fighter1', 'lobby', 'lobbyText', 'btnStart', 'btnStand',
  'guessForm', 'guessInput', 'btnGuess', 'lastGuess',
  'toolRow', 'hintList', 'btnPeek', 'btnResign', 'btnStandPlay', 'peekBox',
  'myGuesses', 'mgCount', 'guessList',
  'resultOverlay', 'roTitle', 'roSub', 'roAnswer', 'roCompare', 'btnAgain',
  'roClose', 'roActions', 'btnStandOver',
  'side', 'btnSide', 'btnSideClose', 'drawerMask', 'sideBadge',
  'logList', 'chatList', 'chatForm', 'chatInput', 'ruleVocab',
  'cfgForm', 'cfgCooldown', 'cfgPeekFreeze', 'cfgPeek', 'cfgHints', 'cfgHostOnly', 'btnReset',
  'sitDlg', 'sitTitle', 'sitName', 'sitErr',
  'confirmDlg', 'confirmTitle', 'confirmText',
  'fatalMask', 'fatalTitle', 'fatalText', 'fatalRetry',
  'toasts', 'btnSound', 'btnVoice', 'voiceMount', 'voiceDock',
]) D[id] = $(id);

/** 语音连麦（/voice.js）。三张桌子共用这一份代码，各连各的频道 */
const voice = window.TableVoice ? window.TableVoice.create({
  send: (obj) => send(obj),
  toast: (msg) => toast(msg),
  mount: D.voiceMount,
  dock: D.voiceDock,
  button: D.btnVoice,
}) : null;

const S = {
  ws: null,
  state: null,
  playerId: null,
  seat: null,
  backoff: 500,
  reconnectTimer: null,
  pingTimer: null,
  fatal: null,
  sound: lsGet(LS_SOUND) !== '0',
  sort: lsGet(LS_SORT) === 'time' ? 'time' : 'rank',
  cooldownEndsAt: 0,
  sitSeat: null,
  lastResultNo: null,
  closedResultNo: null,
  lastLogLen: 0,
  lastChatLen: 0,
};

// ============================ 小工具 ============================

const HEAT_TEXT = {
  hit: '就是它',
  burning: '烫',
  hot: '很热',
  warm: '热',
  mild: '温',
  cool: '凉',
  cold: '冷',
};

function heatText(heat) { return HEAT_TEXT[heat] || '—'; }

/** 排名怎么念。前面几名报名次，后面就报个大概，精确到个位没意义 */
function rankText(rank) {
  if (rank === null || rank === undefined) return '—';
  if (rank === 1) return '答案';
  if (rank <= 1000) return `第 ${rank} 名`;
  return `第 ${Math.round(rank / 100) * 100} 名开外`;
}

function toast(msg) {
  const el = elt('div', 'toast', msg);
  D.toasts.appendChild(el);
  setTimeout(() => el.classList.add('out'), 2600);
  setTimeout(() => el.remove(), 3200);
}

function setConn(kind, text) {
  D.connBadge.dataset.conn = kind;
  D.connText.textContent = text;
}

function showFatal(title, text) {
  D.fatalTitle.textContent = title;
  D.fatalText.textContent = text;
  D.fatalMask.hidden = false;
}

// ============================ 音效 ============================
//
// 跟德州那边一样实时合成，不引音频文件。这里只要三个动静：
// 猜了一个热词、猜了一个冷词、赢了。

let audioCtx = null;
function audio() {
  if (!S.sound) return null;
  try {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      audioCtx = new AC();
    }
    if (audioCtx.state === 'suspended' && audioCtx.resume) audioCtx.resume();
    return audioCtx;
  } catch { return null; }
}

function beep(freq, dur, gain = 0.06, type = 'sine') {
  const ctx = audio();
  if (!ctx) return;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g);
  g.connect(ctx.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

/** 猜完一个词的反馈音：越热越高 */
function sndGuess(heat) {
  const f = { burning: 880, hot: 740, warm: 620, mild: 520, cool: 440, cold: 350 }[heat] || 400;
  beep(f, 0.14);
}

function sndWin() {
  beep(660, 0.16);
  setTimeout(() => beep(880, 0.16), 130);
  setTimeout(() => beep(1170, 0.3), 260);
}

function sndLose() {
  beep(330, 0.22, 0.05, 'triangle');
  setTimeout(() => beep(247, 0.34, 0.05, 'triangle'), 190);
}

// ============================ 连接 ============================

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/hw`;
}

function send(obj) {
  if (S.ws && S.ws.readyState === WebSocket.OPEN) {
    S.ws.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

function scheduleReconnect() {
  if (S.reconnectTimer) return;
  const wait = S.backoff;
  S.backoff = Math.min(S.backoff * 2, 10000);
  S.reconnectTimer = setTimeout(() => {
    S.reconnectTimer = null;
    connect();
  }, wait);
}

function connect() {
  if (S.reconnectTimer) { clearTimeout(S.reconnectTimer); S.reconnectTimer = null; }
  if (S.ws) {
    try { S.ws.onclose = null; S.ws.close(); } catch { /* 忽略 */ }
    S.ws = null;
  }
  setConn('connecting', '连接中…');
  let ws;
  try {
    ws = new WebSocket(wsUrl());
  } catch {
    scheduleReconnect();
    return;
  }
  S.ws = ws;

  ws.onopen = () => {
    S.backoff = 500;
    setConn('online', '已连接');
    send({ t: 'hello', token: lsGet(LS_TOKEN) || null });
    if (S.pingTimer) clearInterval(S.pingTimer);
    S.pingTimer = setInterval(() => send({ t: 'ping' }), 25000);
  };

  ws.onmessage = (ev) => {
    let m = null;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m && typeof m === 'object') handleMessage(m);
  };

  ws.onerror = () => { /* onclose 会接手 */ };

  ws.onclose = () => {
    if (voice) voice.onDisconnect();
    if (S.pingTimer) { clearInterval(S.pingTimer); S.pingTimer = null; }
    if (S.ws === ws) S.ws = null;
    if (S.fatal) { showFatal(S.fatal.title, S.fatal.text); return; }
    setConn('offline', '重连中…');
    scheduleReconnect();
  };
}

function handleMessage(m) {
  if (voice && voice.handle(m)) return;
  switch (m.t) {
    case 'welcome':
      S.playerId = m.playerId;
      S.seat = m.seat;
      if (m.token) lsSet(LS_TOKEN, m.token);
      if (voice) voice.onWelcome();
      return;
    case 'state':
      if (voice) voice.applyState(m);
      render(m);
      return;
    case 'guessed':
      // 重复猜过的词：不进列表，就闪一下告诉他猜过了
      if (m.entry) showLastGuess(m.entry, true);
      return;
    case 'error':
      onError(m);
      return;
    case 'pong':
    default:
  }
}

function onError(m) {
  if (m.code === 'ILLEGAL_ACTION' && /另一个窗口/.test(m.msg || '')) {
    S.fatal = { title: '这个窗口已断开', text: m.msg };
    showFatal(S.fatal.title, S.fatal.text);
    return;
  }
  if (D.sitDlg.open && (m.code === 'SEAT_TAKEN' || m.code === 'NAME_INVALID')) {
    D.sitErr.textContent = m.msg || '上不去';
    D.sitErr.hidden = false;
    return;
  }
  toast(m.msg || '操作失败');
}

// ============================ 渲染 ============================

function render(st) {
  const prev = S.state;
  S.state = st;
  S.seat = st.you.seat;

  const playing = st.phase === 'playing';
  const mine = st.my;

  // ---- 顶栏 ----
  D.metaRound.textContent = st.round ? `第 ${st.round.no} 局` : '还没开局';
  D.metaScore.textContent = `${st.score[0]} : ${st.score[1]}`;
  D.metaHost.hidden = !st.you.isHost;
  if (st.round && D.ruleVocab) D.ruleVocab.textContent = st.round.vocabSize.toLocaleString('zh-CN');

  // ---- 擂台 ----
  renderFighter(D.fighter0, st, 0);
  renderFighter(D.fighter1, st, 1);

  // ---- 大厅那块空地 ----
  renderLobby(st, playing);

  // ---- 猜词区 ----
  const canGuess = playing && S.seat !== null;
  D.guessForm.hidden = !canGuess;
  D.toolRow.hidden = !canGuess;
  D.btnStandPlay.hidden = !canGuess;
  D.myGuesses.hidden = !mine || !mine.guesses.length;
  if (!canGuess) {
    D.lastGuess.hidden = true;
    D.peekBox.hidden = true;
  }

  if (mine) {
    S.cooldownEndsAt = mine.cooldownMs > 0 ? Date.now() + mine.cooldownMs : 0;
    tickCooldown();
    renderHints(mine.hints, st.config);
    renderPeek(mine.peeked);
    renderGuessList(mine.guesses);
    // 新猜出来的词：本地立刻响一声，不等下一帧
    const before = prev?.my?.guesses?.length || 0;
    if (mine.guesses.length > before && mine.guesses.length) {
      const last = mine.guesses[mine.guesses.length - 1];
      showLastGuess(last, false);
      if (last.rank !== 1) sndGuess(last.heat);
    }
  }
  D.btnPeek.hidden = !st.config.peekEnabled;

  // ---- 结算 ----
  renderResult(st);

  // ---- 侧栏 ----
  renderLog(st.log);
  renderChat(st.chat);
  renderCfg(st);

  // ---- 词库没装好 ----
  if (!st.ready) {
    D.lobbyText.textContent = '服务端没装词库，这个游戏暂时开不了局。';
    D.btnStart.hidden = true;
  }
}

function renderFighter(box, st, seat) {
  const info = st.seats[seat];
  const isMe = st.you.seat === seat;
  box.innerHTML = '';
  box.classList.toggle('is-me', isMe);
  box.classList.toggle('is-empty', !!info.empty);

  if (info.empty) {
    box.appendChild(elt('div', 'f-name', seat === 0 ? '空擂台位' : '空擂台位'));
    const btn = elt('button', 'act act-ghost f-sit', '上擂台');
    btn.type = 'button';
    btn.disabled = st.you.seat !== null || st.phase === 'playing';
    btn.addEventListener('click', () => openSit(seat));
    box.appendChild(btn);
    return;
  }

  const head = elt('div', 'f-head');
  const av = elt('div', 'f-avatar', info.avatar?.glyph || '?');
  if (info.avatar) av.style.background = info.avatar.bg;
  head.appendChild(av);
  const nameWrap = elt('div', 'f-name-wrap');
  nameWrap.appendChild(elt('div', 'f-name', info.name + (isMe ? '（你）' : '')));
  const tags = elt('div', 'f-tags');
  if (info.isHost) tags.appendChild(elt('span', 'f-tag', '房主'));
  if (!info.connected) tags.appendChild(elt('span', 'f-tag off', '掉线'));
  if (info.peekCount > 0) tags.appendChild(elt('span', 'f-tag peek', `偷看 ${info.peekCount}`));
  nameWrap.appendChild(tags);
  head.appendChild(nameWrap);
  head.appendChild(elt('div', 'f-count', `${info.guessCount} 次`));
  box.appendChild(head);

  // 温度条。对手这条是他唯一泄露给你的信息
  const bar = elt('div', 'therm');
  const fill = elt('div', `therm-fill heat-${info.bestHeat || 'none'}`);
  fill.style.width = `${info.bestTemp === null ? 0 : info.bestTemp}%`;
  bar.appendChild(fill);
  box.appendChild(bar);

  const foot = elt('div', 'f-foot');
  foot.appendChild(elt('span', 'f-heat', info.bestTemp === null ? '还没出手' : `${heatText(info.bestHeat)} · ${info.bestTemp}°`));
  if (info.bestRank !== null && info.bestRank !== undefined) {
    foot.appendChild(elt('span', 'f-rank', `最好 ${rankText(info.bestRank)}`));
  }
  if (info.frozenMs > 0) foot.appendChild(elt('span', 'f-frozen', `冻结 ${Math.ceil(info.frozenMs / 1000)}s`));
  box.appendChild(foot);
}

function renderLobby(st, playing) {
  const seated = st.seats.filter((s) => !s.empty).length;
  const iAmIn = st.you.seat !== null;

  D.btnStand.hidden = !iAmIn || playing;
  D.btnStart.hidden = !(iAmIn && !playing && seated === 2 && st.ready);

  if (playing) {
    D.lobby.hidden = iAmIn;         // 自己在打就把这块收起来，屏幕留给猜词
    D.lobbyText.textContent = `${st.seats[0].name} 对 ${st.seats[1].name} 正在打，${st.spectators} 人围观`;
    return;
  }
  D.lobby.hidden = false;
  if (!st.ready) return;
  if (seated < 2) {
    D.lobbyText.textContent = iAmIn ? '等一个人上来对你' : '两个人上擂台就能开打。';
  } else if (iAmIn) {
    D.lobbyText.textContent = '两边都到齐了，开吧。';
  } else {
    D.lobbyText.textContent = `擂台满了，你是观众（还有 ${Math.max(0, st.spectators - 1)} 人在看）`;
  }
}

function renderHints(hints, config) {
  D.hintList.innerHTML = '';
  if (!config.hintsEnabled) {
    D.hintList.appendChild(elt('span', 'hint-off', '这桌关掉了提示'));
    return;
  }
  for (const h of hints) {
    const chip = elt('span', `hint-chip${h.locked ? ' locked' : ''}`);
    chip.appendChild(elt('b', null, h.label));
    chip.appendChild(elt('span', null, h.locked ? `猜满 ${h.at} 次` : h.value));
    D.hintList.appendChild(chip);
  }
}

function renderPeek(peeked) {
  if (!peeked) { D.peekBox.hidden = true; return; }
  D.peekBox.hidden = false;
  D.peekBox.innerHTML = '';
  D.peekBox.appendChild(elt('span', 'pk-label', '偷到的'));
  D.peekBox.appendChild(elt('span', 'pk-word', peeked.word));
  D.peekBox.appendChild(elt('span', `pk-rank heat-${peeked.heat}`, rankText(peeked.rank)));
}

function showLastGuess(entry, repeat) {
  D.lastGuess.hidden = false;
  D.lastGuess.className = `last-guess heat-${entry.heat}`;
  D.lastGuess.innerHTML = '';
  D.lastGuess.appendChild(elt('span', 'lg-word', entry.word));
  D.lastGuess.appendChild(elt('span', 'lg-rank', rankText(entry.rank)));
  D.lastGuess.appendChild(elt('span', 'lg-heat', repeat ? '猜过了' : heatText(entry.heat)));
}

function renderGuessList(guesses) {
  D.mgCount.textContent = guesses.length ? `猜了 ${guesses.length} 次` : '还没猜过';
  const list = guesses.slice();
  if (S.sort === 'rank') list.sort((a, b) => a.rank - b.rank);
  else list.sort((a, b) => b.at - a.at);

  D.guessList.innerHTML = '';
  for (const g of list) {
    const li = elt('li', `g-row heat-${g.heat}`);
    li.appendChild(elt('span', 'g-word', g.word));
    const bar = elt('span', 'g-bar');
    const fill = elt('i', `g-fill heat-${g.heat}`);
    fill.style.width = `${g.temp}%`;
    bar.appendChild(fill);
    li.appendChild(bar);
    li.appendChild(elt('span', 'g-rank', g.rank === 1 ? '答案' : `#${g.rank}`));
    D.guessList.appendChild(li);
  }
}

function renderResult(st) {
  const r = st.result;
  if (!r) {
    D.resultOverlay.hidden = true;
    S.lastResultNo = null;
    S.closedResultNo = null;
    return;
  }
  const fresh = S.lastResultNo !== r.no;
  S.lastResultNo = r.no;
  // 关掉之后不再自己弹回来——底下的「下擂台」得留得住手指
  if (fresh) S.closedResultNo = null;
  D.resultOverlay.hidden = S.closedResultNo === r.no;

  const mySeat = st.you.seat;
  if (r.reason === 'abandoned') {
    D.roTitle.textContent = '这局作废';
    D.roSub.textContent = '有人中途下了擂台';
  } else if (r.winner === null) {
    D.roTitle.textContent = '这局作废';
    D.roSub.textContent = '';
  } else {
    const w = st.seats[r.winner];
    const wname = w && !w.empty ? w.name : `${r.winner + 1} 号`;
    const won = mySeat === r.winner;
    D.roTitle.textContent = mySeat === null ? `${wname} 赢了` : (won ? '你赢了' : '你输了');
    D.roSub.textContent = r.reason === 'resign'
      ? `${st.seats[r.winner === 0 ? 1 : 0]?.name || '对手'}认输`
      : `${wname} 用 ${r.guesses[r.winner].length} 次猜中`;
    if (fresh && mySeat !== null) (won ? sndWin : sndLose)();
  }

  D.roAnswer.innerHTML = '';
  D.roAnswer.appendChild(elt('span', 'ro-label', '答案'));
  D.roAnswer.appendChild(elt('span', 'ro-word', r.answer));
  D.roAnswer.appendChild(elt('span', 'ro-cat', r.category));

  // 局末才公布双方的完整记录——打的时候谁也看不到对面
  D.roCompare.innerHTML = '';
  for (let s = 0; s < 2; s++) {
    const col = elt('div', 'ro-col');
    const info = st.seats[s];
    col.appendChild(elt('div', 'ro-col-name', (info && !info.empty ? info.name : `${s + 1} 号`) + `　${r.guesses[s].length} 次`));
    const ol = elt('ol', 'ro-list');
    for (const g of r.guesses[s].slice().sort((a, b) => a.rank - b.rank).slice(0, 12)) {
      const li = elt('li', `ro-item heat-${g.heat}`);
      li.appendChild(elt('span', 'ro-item-word', g.word));
      li.appendChild(elt('span', 'ro-item-rank', g.rank === 1 ? '答案' : `#${g.rank}`));
      ol.appendChild(li);
    }
    col.appendChild(ol);
    D.roCompare.appendChild(col);
  }

  // 观众没什么可按的，那一行整条收起来，只留右上角的关闭
  D.btnAgain.hidden = st.you.seat === null;
  D.btnStandOver.hidden = st.you.seat === null;
  D.roActions.hidden = st.you.seat === null;
}

function renderLog(log) {
  if (log.length === S.lastLogLen) return;
  S.lastLogLen = log.length;
  D.logList.innerHTML = '';
  for (const l of log) {
    const li = elt('li', 'log-item');
    li.appendChild(elt('span', 'log-time', new Date(l.ts).toLocaleTimeString('zh-CN', { hour12: false })));
    li.appendChild(elt('span', 'log-text', l.text));
    D.logList.appendChild(li);
  }
  D.logList.scrollTop = D.logList.scrollHeight;
  bumpSideBadge();
}

function renderChat(chat) {
  if (chat.length === S.lastChatLen) return;
  S.lastChatLen = chat.length;
  D.chatList.innerHTML = '';
  for (const c of chat) {
    const li = elt('li', 'chat-item');
    li.appendChild(elt('span', 'chat-name', c.name));
    li.appendChild(elt('span', 'chat-text', c.text));
    D.chatList.appendChild(li);
  }
  D.chatList.scrollTop = D.chatList.scrollHeight;
  bumpSideBadge();
}

function bumpSideBadge() {
  if (!D.side.classList.contains('open') && window.matchMedia('(max-width: 900px)').matches) {
    D.sideBadge.hidden = false;
  }
}

function renderCfg(st) {
  const host = st.you.isHost;
  D.cfgHostOnly.hidden = host;
  D.cfgForm.classList.toggle('locked', !host);
  if (document.activeElement && D.cfgForm.contains(document.activeElement)) return;
  D.cfgCooldown.value = Math.round(st.config.guessCooldownMs / 1000);
  D.cfgPeekFreeze.value = Math.round(st.config.peekFreezeMs / 1000);
  D.cfgPeek.checked = !!st.config.peekEnabled;
  D.cfgHints.checked = !!st.config.hintsEnabled;
}

/** 冷却倒计时。服务端一秒推一次，本地补上中间那些帧 */
function tickCooldown() {
  const left = S.cooldownEndsAt - Date.now();
  const cooling = left > 0;
  D.btnGuess.disabled = cooling;
  D.btnGuess.textContent = cooling ? `${Math.ceil(left / 1000)}s` : '猜';
  D.guessForm.classList.toggle('cooling', cooling);
}
setInterval(tickCooldown, 120);

// ============================ 交互 ============================

function openSit(seat) {
  S.sitSeat = seat;
  D.sitTitle.textContent = `上擂台（${seat + 1} 号位）`;
  D.sitName.value = lsGet(LS_NAME) || '';
  D.sitErr.hidden = true;
  D.sitDlg.showModal();
  setTimeout(() => D.sitName.focus(), 30);
}

D.sitDlg.addEventListener('close', () => {
  if (D.sitDlg.returnValue !== 'ok') return;
  const name = D.sitName.value.trim();
  if (!name) return;
  lsSet(LS_NAME, name);
  send({ t: 'sit', seat: S.sitSeat, name });
});

D.guessForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const word = D.guessInput.value.trim();
  if (!word) return;
  if (send({ t: 'guess', word })) D.guessInput.value = '';
  D.guessInput.focus();
});

D.btnStart.addEventListener('click', () => send({ t: 'start' }));
D.btnAgain.addEventListener('click', () => {
  closeResult();
  send({ t: 'start' });
});
D.roClose.addEventListener('click', closeResult);
D.btnPeek.addEventListener('click', () => send({ t: 'peek' }));
D.btnResign.addEventListener('click', () => {
  confirmDlg('认输', '这一局算对手赢，确定？', () => send({ t: 'resign' }));
});

/** 结算大屏是浮在最上面的一层，不关掉就摸不到底下的按钮 */
function closeResult() {
  S.closedResultNo = S.state?.result?.no ?? S.lastResultNo;
  D.resultOverlay.hidden = true;
}

/** 下擂台。局中途走人算作废，局间走人就是空出位子 */
function askStand() {
  const playing = S.state?.phase === 'playing';
  confirmDlg(
    '下擂台',
    playing ? '下去之后这一局就作废了，确定？' : '把位子让出来，确定？',
    () => { closeResult(); send({ t: 'stand' }); },
  );
}
D.btnStand.addEventListener('click', askStand);
D.btnStandPlay.addEventListener('click', askStand);
D.btnStandOver.addEventListener('click', askStand);

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !D.resultOverlay.hidden) closeResult();
});

D.chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = D.chatInput.value.trim();
  if (!text) return;
  if (send({ t: 'chat', text })) D.chatInput.value = '';
});

D.cfgForm.addEventListener('submit', (e) => {
  e.preventDefault();
  send({
    t: 'config',
    patch: {
      guessCooldownMs: Number(D.cfgCooldown.value) * 1000,
      peekFreezeMs: Number(D.cfgPeekFreeze.value) * 1000,
      peekEnabled: D.cfgPeek.checked,
      hintsEnabled: D.cfgHints.checked,
    },
  });
});

D.btnReset.addEventListener('click', () => {
  confirmDlg('比分清零', '把这一场的比分清回 0:0？', () => send({ t: 'reset' }));
});

let confirmAction = null;
function confirmDlg(title, text, onOk) {
  D.confirmTitle.textContent = title;
  D.confirmText.textContent = text;
  confirmAction = onOk;
  D.confirmDlg.showModal();
}
D.confirmDlg.addEventListener('close', () => {
  const fn = confirmAction;
  confirmAction = null;
  if (D.confirmDlg.returnValue === 'ok' && fn) fn();
});

for (const btn of document.querySelectorAll('.sort-btn')) {
  btn.addEventListener('click', () => {
    S.sort = btn.dataset.sort;
    lsSet(LS_SORT, S.sort);
    for (const b of document.querySelectorAll('.sort-btn')) b.classList.toggle('is-on', b === btn);
    if (S.state?.my) renderGuessList(S.state.my.guesses);
  });
}
for (const b of document.querySelectorAll('.sort-btn')) b.classList.toggle('is-on', b.dataset.sort === S.sort);

// 侧栏标签
for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.tab')) {
      const on = t === tab;
      t.classList.toggle('is-on', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    for (const p of document.querySelectorAll('.pane')) {
      p.classList.toggle('is-on', p.id.toLowerCase() === `pane${tab.dataset.tab}`.toLowerCase());
    }
  });
}

function openSide(open) {
  D.side.classList.toggle('open', open);
  D.drawerMask.hidden = !open;
  if (open) D.sideBadge.hidden = true;
}
D.btnSide.addEventListener('click', () => openSide(!D.side.classList.contains('open')));
D.btnSideClose.addEventListener('click', () => openSide(false));
D.drawerMask.addEventListener('click', () => openSide(false));

D.btnSound.addEventListener('click', () => {
  S.sound = !S.sound;
  lsSet(LS_SOUND, S.sound ? '1' : '0');
  D.btnSound.setAttribute('aria-pressed', S.sound ? 'true' : 'false');
  if (S.sound) beep(660, 0.1);
});
D.btnSound.setAttribute('aria-pressed', S.sound ? 'true' : 'false');

D.fatalRetry.addEventListener('click', () => {
  S.fatal = null;
  D.fatalMask.hidden = true;
  connect();
});

// 首次交互解锁音频（自动播放策略）
const unlock = () => { audio(); };
['pointerdown', 'touchend', 'keydown'].forEach((evt) => window.addEventListener(evt, unlock, { once: false }));

connect();
