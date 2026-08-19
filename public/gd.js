// SPDX-License-Identifier: GPL-3.0-or-later
// 掼蛋前端。零构建：浏览器原生 ES module，没有打包器也没有外链。
//
// 牌型判断复用服务端同一份 gd-combos.js / gd-hints.js，
// 所以"出牌"按钮亮不亮，和服务端会不会收，永远是同一个答案。
// 服务端当然还会再校验一遍——前端算的只是体验，不是权限。

import {
  TYPE, wildCard, isJoker, interpret, beats, isBomb, comboName, sortHand,
  powerValue, naturalValue, suitChar, rankName, cardName, levelName,
} from '/gd-combos.js';
import { findPlays } from '/gd-hints.js';

const LS_TOKEN = 'guandan.token';
const LS_NAME = 'guandan.name';
const LS_SOUND = 'guandan.sound';

const SUIT_CH = { s: '♠︎', h: '♥︎', d: '♦︎', c: '♣︎' };

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
  'connBadge', 'connText', 'metaDeal', 'metaLevel', 'metaHost',
  'lv0', 'lv1', 'mem0', 'mem1', 'deal0', 'deal1', 'wildTag', 'phaseTag',
  'seatTop', 'seatLeft', 'seatRight', 'seatSelf',
  'tableCombo', 'tableCards', 'tableWho', 'tributeBar',
  'resultOverlay', 'grTitle', 'grSub', 'grPlaces', 'grLevels', 'grNext',
  'matchOverlay', 'moTitle', 'moSub', 'btnAgain',
  'heroStatusText', 'heroTimer', 'heroTimerBar', 'gdHand', 'pickInfo',
  'btnPass', 'btnPlay', 'btnHint', 'btnClear', 'btnSortRank', 'btnReturn',
  'btnStart', 'btnAddBot', 'btnAddBot2', 'btnStand', 'btnJoin',
  'side', 'btnSide', 'btnSideClose', 'drawerMask', 'sideBadge',
  'logList', 'chatList', 'chatForm', 'chatInput',
  'cfgForm', 'cfgTimeout', 'cfgNext', 'cfgAuto', 'cfgHostOnly', 'btnReset',
  'seatAdmin', 'sitDlg', 'sitTitle', 'sitName', 'sitErr',
  'confirmDlg', 'confirmTitle', 'confirmText',
  'fatalMask', 'fatalTitle', 'fatalText', 'fatalRetry',
  'toasts', 'btnSound', 'btnVoice', 'voiceMount', 'voiceDock',
]) D[id] = $(id);

/** 语音连麦（/voice.js）。德州那张桌子用同一份代码、另一个频道，两边不串。 */
const voice = window.TableVoice ? window.TableVoice.create({
  send: (obj) => send(obj),
  toast: (msg) => toast(msg),
  mount: D.voiceMount,
  dock: D.voiceDock,
  button: D.btnVoice,
  onSpeakingChange: () => { if (S.state) renderSeats(S.state); },
}) : null;

const S = {
  ws: null,
  conn: 'connecting',
  backoff: 500,
  reconnectTimer: null,
  pingTimer: null,
  fatal: null,
  playerId: null,
  mySeat: null,
  state: null,
  /** 当前选中的手牌下标（对应 S.view 里的位置） */
  sel: new Set(),
  /** 排好序、真正渲染出来的那份手牌 */
  view: [],
  /** 提示循环 */
  hints: [],
  hintIdx: -1,
  hintKey: '',
  sortMode: 'rank',
  /** 设置表单被改过、还没保存 —— 这期间不让状态广播覆盖输入框 */
  cfgDirty: false,
  sound: lsGet(LS_SOUND) !== '0',
  pendingSeat: null,
  timerRaf: null,
  lastDealNo: 0,
  lastTableKey: '',
};

// ============================ 提示条 ============================

function toast(msg, ok) {
  if (!D.toasts) return;
  const t = elt('div', 'toast' + (ok ? ' ok' : ''), String(msg || ''));
  D.toasts.appendChild(t);
  setTimeout(() => t.classList.add('fade'), 2600);
  setTimeout(() => t.remove(), 3000);
  while (D.toasts.children.length > 4) D.toasts.firstChild.remove();
}

// ============================ 音效 ============================

let audioCtx = null;
// 浏览器不允许在用户交互之前起 AudioContext，硬建只会在控制台刷一片警告。
// 等第一次点击/按键之后再建，之前所有音效静默跳过。
let gestured = false;
for (const ev of ['pointerdown', 'keydown']) {
  window.addEventListener(ev, () => { gestured = true; }, { once: true, capture: true });
}

function ac() {
  if (!S.sound || !gestured) return null;
  if (!audioCtx) {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    audioCtx = new C();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}

/** 一声短音。掼蛋不需要复杂音景，出牌"啪"一下、轮到自己"叮"一下就够了。 */
function blip(freq, dur = 0.09, type = 'triangle', gain = 0.06) {
  const c = ac();
  if (!c) return;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, c.currentTime);
  g.gain.setValueAtTime(0, c.currentTime);
  g.gain.linearRampToValueAtTime(gain, c.currentTime + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
  o.connect(g).connect(c.destination);
  o.start();
  o.stop(c.currentTime + dur + 0.02);
}
const sfx = {
  play: () => blip(320, 0.07, 'square', 0.05),
  bomb: () => { blip(140, 0.22, 'sawtooth', 0.09); setTimeout(() => blip(90, 0.3, 'sawtooth', 0.07), 60); },
  turn: () => { blip(760, 0.1); setTimeout(() => blip(1010, 0.12), 90); },
  win: () => [0, 110, 220, 360].forEach((d, i) => setTimeout(() => blip([523, 659, 784, 1047][i], 0.2), d)),
};

// ============================ 卡牌 ============================

/** 造一张牌的 DOM。掼蛋只有正面，没有暗牌。 */
function cardEl(code, extraCls) {
  const e = elt('div', 'card');
  if (extraCls) e.className += ' ' + extraCls;
  if (isJoker(code)) {
    e.classList.add('joker');
    if (code === 'jr') e.classList.add('red');
    e.appendChild(elt('span', 'c-rank', code === 'jr' ? '大' : '小'));
    e.appendChild(elt('span', 'c-suit-big', '王'));
    return e;
  }
  const suit = suitChar(code);
  if (suit === 'h' || suit === 'd') e.classList.add('red');
  const ch = SUIT_CH[suit] || '?';
  e.appendChild(elt('span', 'c-rank', rankName(code[0])));
  e.appendChild(elt('span', 'c-suit-sm', ch));
  e.appendChild(elt('span', 'c-suit-big', ch));
  return e;
}

/** 一串牌渲染到容器里，带入场动画的序号 */
function renderCards(box, cards, cls) {
  box.textContent = '';
  cards.forEach((c, i) => {
    const e = cardEl(c, cls);
    e.style.setProperty('--i', String(i));
    box.appendChild(e);
  });
}

// ============================ 状态派生 ============================

const st = () => S.state;
const level = () => (st() ? st().level : 2);
const reqCombo = () => (st()?.req ? st().req.combo : null);
const isSeated = () => S.mySeat !== null && S.mySeat !== undefined;

/** 座位 -> 屏幕位置。自己永远在下方，下家在右边，对家（队友）在上方。 */
function slotOf(seat) {
  const base = isSeated() ? S.mySeat : 0;
  return ['self', 'right', 'top', 'left'][(seat - base + 4) % 4];
}

/** 当前排序方式下要渲染的手牌 */
function buildView() {
  const s = st();
  const hand = s?.you?.hand || [];
  if (S.sortMode === 'suit') {
    const w = wildCard(level());
    return [...hand].sort((a, b) => {
      const aw = a === w ? 1 : 0;
      const bw = b === w ? 1 : 0;
      if (aw !== bw) return bw - aw;
      const aj = isJoker(a) ? 1 : 0;
      const bj = isJoker(b) ? 1 : 0;
      if (aj !== bj) return bj - aj;
      const d = 'schd'.indexOf(suitChar(a)) - 'schd'.indexOf(suitChar(b));
      if (d !== 0) return d;
      return powerValue(b, level()) - powerValue(a, level());
    });
  }
  return sortHand(hand, level());
}

function selectedCards() {
  return [...S.sel].sort((a, b) => a - b).map((i) => S.view[i]).filter(Boolean);
}

/** 选中的牌能打出什么；null 表示打不出去 */
function currentPlay() {
  const cards = selectedCards();
  if (!cards.length) return null;
  const legal = interpret(cards, level()).filter((c) => beats(c, reqCombo()));
  if (!legal.length) return null;
  // 和服务端一样：跟牌取最弱的合法解释，领出取最强
  legal.sort((a, b) => {
    const d = (isBomb(a) ? 1 : 0) - (isBomb(b) ? 1 : 0);
    if (d !== 0) return reqCombo() ? d : -d;
    return reqCombo() ? a.rank - b.rank : b.rank - a.rank;
  });
  return legal[0];
}

// ============================ 渲染 ============================

function render() {
  const s = st();
  if (!s) return;

  // ---- 顶部 ----
  D.metaDeal.textContent = s.dealNo ? `第 ${s.dealNo} 局` : '未开局';
  D.metaLevel.textContent = `打 ${s.levelText}`;
  D.metaHost.hidden = !s.you.isHost;

  // ---- 比分条 ----
  for (const t of [0, 1]) {
    D['lv' + t].textContent = s.levelTexts[t];
    const names = s.seats.filter((x) => x.team === t && !x.empty).map((x) => x.name);
    D['mem' + t].textContent = names.join(' · ');
    D['deal' + t].hidden = s.dealingTeam !== t;
    const box = D['lv' + t].closest('.score-team');
    box.classList.toggle('at-a', s.levels[t] === 14);
    if (s.aFail[t] > 0) D['mem' + t].textContent += `（打A失败 ${s.aFail[t]}/3）`;
  }
  D.wildTag.textContent = s.wild ? `逢人配 ${cardName(s.wild)}` : '逢人配 —';
  D.phaseTag.textContent = phaseText(s);

  // ---- 座位 ----
  renderSeats(s);

  // ---- 中央 ----
  renderTable(s);

  // ---- 进贡横幅 ----
  renderTribute(s);

  // ---- 手牌与操作 ----
  renderHand(s);
  renderBar(s);

  // ---- 浮层 ----
  renderOverlays(s);

  // ---- 侧栏 ----
  renderLog(s);
  renderChat(s);
  renderCfg(s);
  renderSeatAdmin(s);

  tickTimer();
}

function phaseText(s) {
  if (s.matchOver) return '本场已结束';
  switch (s.phase) {
    case 'waiting': return s.seats.filter((x) => !x.empty).length + ' / 4 人';
    case 'tribute': return '进贡中';
    case 'playing': return '出牌中';
    case 'over': return '本局结束';
    default: return '';
  }
}

function renderSeats(s) {
  for (const slot of ['self', 'top', 'left', 'right']) {
    const box = D['seat' + slot[0].toUpperCase() + slot.slice(1)];
    box.textContent = '';
    const info = s.seats.find((x) => slotOf(x.seat) === slot);
    if (!info) continue;

    if (info.empty) {
      const ph = elt('div', 'pod-empty');
      ph.appendChild(elt('div', null, `${info.seat + 1} 号位 · ${s.teamNames[info.team]}`));
      if (!isSeated() && S.conn === 'online') {
        const b = elt('button', 'act act-start', '坐这里');
        b.type = 'button';
        b.addEventListener('click', () => openSit(info.seat));
        ph.appendChild(b);
      }
      box.appendChild(ph);
      continue;
    }

    const pod = elt('div', 'pod');
    pod.dataset.team = String(info.team);
    if (info.waiting) pod.classList.add('acting');
    if (info.place) pod.classList.add('gone');
    if (!info.connected) pod.classList.add('off');
    if (voice && voice.speakingSeat(info.seat)) pod.classList.add('speaking');
    if (isSeated() && info.seat === (S.mySeat + 2) % 4 && info.seat !== S.mySeat) {
      pod.classList.add('is-mate');
    }

    const av = elt('div', 'pod-av', info.avatar?.glyph || info.name[0] || '?');
    av.style.background = info.avatar?.bg || '#334';
    pod.appendChild(av);

    const main = elt('div', 'pod-main');
    main.appendChild(elt('div', 'pod-name', info.name));
    const sub = elt('div', 'pod-sub');
    const cnt = elt('span', 'pod-count', info.count);
    if (info.count > 0 && info.count <= 2) cnt.classList.add('danger');
    sub.appendChild(cnt);
    if (info.place) sub.appendChild(elt('i', 'pod-tag place', info.place));
    else if (info.passed) sub.appendChild(elt('i', 'pod-tag pass', '不要'));
    const mic = voice ? voice.onMic(info.seat) : null;
    if (mic) sub.appendChild(elt('i', 'pod-tag mic' + (mic.muted ? ' muted' : ''), mic.muted ? '静音' : '麦'));
    if (info.isBot) sub.appendChild(elt('i', 'pod-tag bot', '人机'));
    if (info.isHost) sub.appendChild(elt('i', 'pod-tag host', '房主'));
    if (!info.connected) sub.appendChild(elt('i', 'pod-tag', '掉线'));
    main.appendChild(sub);
    pod.appendChild(main);
    box.appendChild(pod);
  }
}

function renderTable(s) {
  const t = s.table;
  if (!t) {
    D.tableCombo.textContent = '';
    D.tableCards.textContent = '';
    D.tableWho.textContent = s.phase === 'playing' ? '新一轮，随便出' : '';
    return;
  }
  const key = t.seat + ':' + t.cards.join(',');
  D.tableCombo.textContent = t.name;
  if (key !== S.lastTableKey) {
    renderCards(D.tableCards, t.cards);
    S.lastTableKey = key;
    if (t.combo && isBomb(t.combo)) sfx.bomb();
    else sfx.play();
  }
  const who = s.seats.find((x) => x.seat === t.seat);
  D.tableWho.textContent = who && !who.empty ? `${who.name} 打出` : '';
}

function renderTribute(s) {
  const tb = s.tribute;
  if (!tb || (!tb.moves.length && !tb.resisted) || s.phase === 'over') {
    D.tributeBar.hidden = true;
    return;
  }
  const nm = (seat) => {
    const x = s.seats.find((y) => y.seat === seat);
    return x && !x.empty ? x.name : `${seat + 1} 号`;
  };
  // 全部走 DOM 节点，不拼 innerHTML —— 这里面有昵称，昵称是玩家自己填的
  const parts = [];
  const line = (...nodes) => {
    const frag = document.createDocumentFragment();
    for (const n of nodes) frag.appendChild(typeof n === 'string' ? document.createTextNode(n) : n);
    parts.push(frag);
  };
  if (tb.resisted) {
    line(elt('b', null, '抗贡'), '：进贡方手握两张大王，本局免贡');
  } else {
    for (const m of tb.moves) {
      line(`${nm(m.from)} → ${nm(m.to)} 进贡 `, elt('b', null, cardName(m.card)));
    }
    for (const r of tb.returns) {
      if (r.card) line(`${nm(r.from)} → ${nm(r.to)} 还贡 `, elt('b', null, cardName(r.card)));
      else line(`等 ${nm(r.from)} 还贡…`);
    }
  }
  D.tributeBar.textContent = '';
  parts.forEach((frag, i) => {
    if (i) D.tributeBar.appendChild(document.createTextNode('　|　'));
    D.tributeBar.appendChild(frag);
  });
  D.tributeBar.hidden = false;
}

function renderHand(s) {
  S.view = buildView();
  const box = D.gdHand;
  box.textContent = '';
  if (!S.view.length) {
    const msg = isSeated()
      ? (s.phase === 'waiting' ? '等人坐满就发牌' : '你已经出完啦')
      : '你还没入座，正在旁观';
    box.appendChild(elt('div', 'ph', msg));
    return;
  }

  const w = wildCard(level());
  const opts = s.you.returnOptions;
  S.view.forEach((code, i) => {
    const e = cardEl(code);
    if (code === w) e.classList.add('wild');
    if (S.sel.has(i)) e.classList.add('sel');
    // 还贡阶段：只有 10 以内的牌能点
    const locked = opts && !opts.includes(code);
    if (locked) e.style.opacity = '.35';
    else e.addEventListener('click', () => toggleCard(i));
    box.appendChild(e);
  });
}

function toggleCard(i) {
  const opts = st()?.you?.returnOptions;
  if (opts) {
    // 还贡只能选一张
    const had = S.sel.has(i);
    S.sel.clear();
    if (!had) S.sel.add(i);
  } else if (S.sel.has(i)) {
    S.sel.delete(i);
  } else {
    S.sel.add(i);
  }
  S.hintIdx = -1;
  renderHand(st());
  renderBar(st());
}

function renderBar(s) {
  const you = s.you;
  const seated = isSeated();
  const returning = !!you.returnOptions;
  const myTurn = you.myTurn;

  // ---- 状态文字 ----
  let status;
  if (S.conn !== 'online') status = S.conn === 'connecting' ? '正在连接服务器…' : '连接断开，正在重连…';
  else if (!seated) status = '选个座位坐下就能玩，不用注册。';
  else if (s.matchOver) status = `本场结束：${s.matchOver.teamName}过 A 获胜。`;
  else if (returning) status = '你收到了贡牌，请选一张 10 以内的牌还回去。';
  else if (s.phase === 'tribute') status = '等其他人还贡…';
  else if (s.phase === 'over') status = '本局结束，看看结算。';
  else if (s.phase === 'waiting') status = `还差 ${4 - s.seats.filter((x) => !x.empty).length} 个人，可以加人机凑数。`;
  else if (myTurn) status = s.req ? `轮到你了 — 要压过 ${s.req.name}` : '轮到你了 — 这一轮你先出，随便打';
  else {
    const w = s.seats.find((x) => x.seat === s.turn);
    status = w && !w.empty ? `等 ${w.name} 出牌…` : '等待中…';
  }
  D.heroStatusText.textContent = status;
  D.heroStatusText.className = myTurn || returning ? 'v-turn' : '';

  // ---- 选牌提示 ----
  const cards = selectedCards();
  const info = D.pickInfo;
  info.textContent = '';
  if (returning) {
    info.appendChild(elt('span', cards.length === 1 ? 'ok' : '', cards.length === 1
      ? `还贡 ${cardName(cards[0])}` : '点一张 10 以内的牌'));
  } else if (!cards.length) {
    info.appendChild(elt('span', '', myTurn ? '点手牌选中，再点"出牌"' : ''));
  } else {
    const play = currentPlay();
    if (play) {
      const span = elt('span', isBomb(play) ? 'bomb' : 'ok', comboName(play, level()));
      info.appendChild(span);
      info.appendChild(elt('span', '', `　${cards.length} 张`));
    } else {
      const any = interpret(cards, level());
      info.appendChild(elt('span', 'no', any.length
        ? `${comboName(any[0], level())}　压不过${s.req ? ' ' + s.req.name : ''}`
        : '这几张凑不成牌型'));
    }
  }

  // ---- 按钮 ----
  const show = (btn, on) => { if (btn) btn.hidden = !on; };
  show(D.btnJoin, !seated && s.seats.some((x) => x.empty));
  show(D.btnStand, seated);
  show(D.btnPass, seated && myTurn && you.canPass);
  show(D.btnPlay, seated && myTurn);
  show(D.btnHint, seated && myTurn);
  show(D.btnClear, seated && (myTurn || returning) && S.sel.size > 0);
  show(D.btnSortRank, seated && S.view.length > 0);
  show(D.btnReturn, returning);
  show(D.btnAddBot, you.isHost && s.phase === 'waiting' && s.seats.some((x) => x.empty));
  show(D.btnStart, you.isHost && !s.matchOver
    && (s.phase === 'waiting' || s.phase === 'over')
    && s.seats.every((x) => !x.empty));

  D.btnPlay.disabled = !currentPlay();
  D.btnReturn.disabled = cards.length !== 1;
  D.btnSortRank.textContent = S.sortMode === 'rank' ? '按花色理牌' : '按大小理牌';
}

function renderOverlays(s) {
  // 本局结算
  const r = s.result;
  const showResult = !!r && s.phase === 'over' && !s.matchOver;
  D.resultOverlay.hidden = !showResult;
  if (showResult) {
    const winName = s.teamNames[r.winTeam];
    D.grTitle.textContent = r.doubleOut ? `${winName}双下！` : `${winName}赢了这局`;
    D.grSub.textContent = `第 ${r.dealNo} 局 · 打 ${levelName(r.level)}` +
      (r.gain > 0 ? ` · 升 ${r.gain} 级` : '');
    D.grPlaces.textContent = '';
    for (const p of r.places) {
      const li = elt('li');
      li.dataset.team = String(p.seat % 2);
      li.appendChild(elt('span', 'gr-pl', p.place));
      li.appendChild(elt('span', 'gr-nm', p.name));
      li.appendChild(elt('span', 'gr-rest', p.rest.length ? `剩 ${p.rest.length} 张` : '出完'));
      D.grPlaces.appendChild(li);
    }
    D.grLevels.textContent = '';
    for (const t of [0, 1]) {
      if (t) D.grLevels.appendChild(elt('span', null, '　·　'));
      D.grLevels.appendChild(elt('span', null, s.teamNames[t] + ' '));
      D.grLevels.appendChild(elt('b', null, levelName(r.levels[t])));
    }
    D.grNext.textContent = r.demoted !== null && r.demoted !== undefined
      ? `${s.teamNames[r.demoted]}三次打 A 未过，退回打 2`
      : (s.nextDealAt ? '马上开下一局…' : '等房主开下一局');
  }

  // 整场结束
  D.matchOverlay.hidden = !s.matchOver;
  if (s.matchOver) {
    D.moTitle.textContent = `${s.matchOver.teamName}过 A！`;
    D.moSub.textContent = `${s.matchOver.seats.join(' & ')} 赢下整场比赛`;
    D.btnAgain.hidden = !s.you.isHost;
  }
}

/** 整份内容拼成签名。服务端只留最近 40 条，条数到顶后就不再变——
 *  拿长度判断"有没有新内容"，日志会从第 40 条起彻底冻住。app.js 用的也是签名。 */
function sigOf(list) {
  return list.map((x) => x.ts + '|' + x.text).join('\n');
}

function renderLog(s) {
  const sig = sigOf(s.log);
  if (D.logList.__sig === sig) return;
  D.logList.__sig = sig;
  D.logList.textContent = '';
  for (const l of s.log) D.logList.appendChild(elt('li', null, l.text));
  D.logList.scrollTop = D.logList.scrollHeight;
}

function renderChat(s) {
  const sig = sigOf(s.chat);
  if (D.chatList.__sig === sig) return;
  D.chatList.__sig = sig;
  D.chatList.textContent = '';
  for (const c of s.chat) {
    const li = elt('li');
    li.appendChild(elt('b', null, c.name + '：'));
    li.appendChild(elt('span', null, c.text));
    D.chatList.appendChild(li);
  }
  D.chatList.scrollTop = D.chatList.scrollHeight;
}

function renderCfg(s) {
  D.cfgHostOnly.hidden = !!s.you.isHost;
  const dis = !s.you.isHost;
  for (const el of [D.cfgTimeout, D.cfgNext, D.cfgAuto, D.btnReset]) el.disabled = dis;
  // 对局中每个动作都会广播一次状态。改了还没点保存就被服务端的值刷回去，
  // 会让人根本改不动设置——所以只要表单是脏的，就别覆盖用户填的东西。
  if (S.cfgDirty) return;
  D.cfgTimeout.value = Math.round(s.config.actionTimeoutMs / 1000);
  D.cfgNext.value = Math.round(s.config.autoNextDealMs / 1000);
  D.cfgAuto.checked = !!s.config.autoNextDeal;
}

function renderSeatAdmin(s) {
  D.seatAdmin.textContent = '';
  for (const info of s.seats) {
    const row = elt('div', 'sa-row');
    row.appendChild(elt('span', null, `${info.seat + 1} 号 · ${s.teamNames[info.team]}`));
    row.appendChild(elt('span', null, info.empty ? '空位' : info.name));
    if (!info.empty && s.you.isHost && info.seat !== S.mySeat) {
      const b = elt('button', 'act act-ghost', '请离座');
      b.type = 'button';
      b.addEventListener('click', () => confirmDlg('请他离座', `确定把 ${info.name} 请下牌桌吗？`,
        () => send({ t: 'kick', seat: info.seat })));
      row.appendChild(b);
    }
    D.seatAdmin.appendChild(row);
  }
}

// ---- 行动倒计时 ----

function tickTimer() {
  if (S.timerRaf) cancelAnimationFrame(S.timerRaf);
  const s = st();
  const mine = s && isSeated()
    && (s.you.myTurn || !!s.you.returnOptions);
  if (!s || !s.deadline || !mine) {
    D.heroTimer.hidden = true;
    return;
  }
  const total = s.config.actionTimeoutMs;
  const step = () => {
    const left = s.deadline - Date.now();
    if (left <= 0) { D.heroTimer.hidden = true; return; }
    D.heroTimer.hidden = false;
    const pct = Math.max(0, Math.min(1, left / total));
    D.heroTimerBar.style.width = (pct * 100).toFixed(1) + '%';
    D.heroTimer.classList.toggle('urgent', pct < 0.28);
    S.timerRaf = requestAnimationFrame(step);
  };
  step();
}

// ============================ 动作 ============================

function doPlay() {
  const combo = currentPlay();
  if (!combo) { toast('这几张牌出不出去'); return; }
  send({ t: 'play', cards: selectedCards(), as: combo, dealNo: st().dealNo });
  S.sel.clear();
  S.hintIdx = -1;
}

function doPass() {
  send({ t: 'pass', dealNo: st().dealNo });
  S.sel.clear();
  S.hintIdx = -1;
}

function doReturn() {
  const cards = selectedCards();
  if (cards.length !== 1) { toast('请选一张牌还贡'); return; }
  send({ t: 'returnTribute', card: cards[0] });
  S.sel.clear();
}

/** 提示：在所有能出的牌里循环，直接帮你选好 */
function doHint() {
  const s = st();
  const key = `${s.dealNo}:${(s.you.hand || []).length}:${s.req ? s.req.cards.join(',') : '-'}`;
  if (key !== S.hintKey) {
    S.hintKey = key;
    S.hints = findPlays(s.you.hand, level(), reqCombo());
    S.hintIdx = -1;
  }
  if (!S.hints.length) {
    toast(s.req ? '这手牌压不过，只能不要' : '没找到可出的牌型');
    return;
  }
  S.hintIdx = (S.hintIdx + 1) % S.hints.length;
  const pick = S.hints[S.hintIdx];

  // 把提示的牌面映射回手牌下标（同一张牌可能有两份，逐个占位）
  S.sel.clear();
  const used = new Set();
  for (const c of pick.cards) {
    const i = S.view.findIndex((v, idx) => v === c && !used.has(idx));
    if (i >= 0) { used.add(i); S.sel.add(i); }
  }
  renderHand(st());
  renderBar(st());
  toast(`${comboName(pick.combo, level())}（${S.hintIdx + 1}/${S.hints.length}）`, true);
}

// ============================ 对话框 ============================

function openSit(seat) {
  S.pendingSeat = seat;
  D.sitTitle.textContent = `坐到 ${seat + 1} 号位`;
  D.sitName.value = lsGet(LS_NAME) || '';
  D.sitErr.hidden = true;
  D.sitDlg.showModal();
  setTimeout(() => D.sitName.focus(), 30);
}

let confirmCb = null;
function confirmDlg(title, text, cb) {
  D.confirmTitle.textContent = title;
  D.confirmText.textContent = text;
  confirmCb = cb;
  D.confirmDlg.showModal();
}

function showFatal(title, text) {
  D.fatalTitle.textContent = title || '连接已断开';
  D.fatalText.textContent = text || '';
  D.fatalMask.hidden = false;
}

// ============================ WebSocket ============================

function wsUrl() {
  return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/gd';
}

function setConn(kind, text) {
  const changed = S.conn !== kind;
  S.conn = kind;
  D.connBadge.setAttribute('data-conn', kind);
  D.connText.textContent = text;
  if (changed && S.state) {
    try { render(); } catch { /* 重绘失败不影响重连 */ }
  }
}

function send(obj) {
  const ws = S.ws;
  if (!ws || ws.readyState !== 1) return false;
  try { ws.send(JSON.stringify(obj)); return true; } catch { return false; }
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

function scheduleReconnect() {
  if (S.reconnectTimer || S.fatal) return;
  const wait = S.backoff;
  S.backoff = Math.min(5000, Math.round(S.backoff * 1.7));
  S.reconnectTimer = setTimeout(() => { S.reconnectTimer = null; connect(); }, wait);
}

function handleMessage(m) {
  // 语音信令自己吃掉，不进牌桌逻辑
  if (voice && voice.handle(m)) return;
  switch (m.t) {
    case 'welcome':
      if (typeof m.token === 'string' && m.token) lsSet(LS_TOKEN, m.token);
      S.playerId = m.playerId || null;
      S.mySeat = typeof m.seat === 'number' ? m.seat : null;
      if (voice) voice.onWelcome();
      break;

    case 'state': {
      const prev = S.state;
      S.state = m;
      S.mySeat = m.you.seat;
      if (voice) voice.applyState(m);
      // 换局就清空选牌，别让上一局的选择残留
      if (m.dealNo !== S.lastDealNo) {
        S.lastDealNo = m.dealNo;
        S.sel.clear();
        S.hintKey = '';
        S.lastTableKey = '';
      }
      // 手牌一变就清选中。不能只比张数 —— 进贡是"给一张收一张"，
      // 张数能回到原值而内容全变，这时旧下标会指到完全不同的牌上。
      if (prev && prev.you.hand.join(',') !== m.you.hand.join(',')) {
        S.sel.clear();
        S.hintKey = '';
      }
      if (m.you.myTurn && !(prev && prev.you.myTurn)) sfx.turn();
      if (m.matchOver && !(prev && prev.matchOver)) sfx.win();
      render();
      break;
    }

    case 'error':
      if (m.code === 'KICKED') {
        S.fatal = { title: '你被请下了牌桌', text: '刷新页面可以重新入座。' };
        showFatal(S.fatal.title, S.fatal.text);
      } else {
        toast(m.msg || '操作失败');
      }
      break;

    default:
      break;
  }
}

// ============================ 事件绑定 ============================

function bind() {
  D.btnPlay.addEventListener('click', doPlay);
  D.btnPass.addEventListener('click', doPass);
  D.btnHint.addEventListener('click', doHint);
  D.btnReturn.addEventListener('click', doReturn);
  D.btnClear.addEventListener('click', () => {
    S.sel.clear(); S.hintIdx = -1; renderHand(st()); renderBar(st());
  });
  D.btnSortRank.addEventListener('click', () => {
    S.sortMode = S.sortMode === 'rank' ? 'suit' : 'rank';
    S.sel.clear();
    render();
  });
  D.btnStart.addEventListener('click', () => send({ t: 'start' }));
  D.btnAgain.addEventListener('click', () => send({ t: 'reset' }));
  for (const b of [D.btnAddBot, D.btnAddBot2]) {
    b.addEventListener('click', () => send({ t: 'addBot' }));
  }
  D.btnJoin.addEventListener('click', () => {
    const free = st()?.seats.find((x) => x.empty);
    if (free) openSit(free.seat);
  });
  D.btnStand.addEventListener('click', () => {
    confirmDlg('离座', '牌局进行中离座会让本局作废，确定吗？', () => send({ t: 'stand' }));
  });

  // 入座
  D.sitDlg.addEventListener('close', () => {
    if (D.sitDlg.returnValue !== 'ok' || S.pendingSeat === null) return;
    const name = D.sitName.value.trim();
    if (!name) { toast('昵称不能为空'); return; }
    lsSet(LS_NAME, name);
    send({ t: 'sit', seat: S.pendingSeat, name });
    S.pendingSeat = null;
  });

  D.confirmDlg.addEventListener('close', () => {
    const cb = confirmCb;
    confirmCb = null;
    if (D.confirmDlg.returnValue === 'ok' && cb) cb();
  });

  // 设置
  D.cfgForm.addEventListener('input', () => { S.cfgDirty = true; });
  D.cfgForm.addEventListener('submit', (e) => {
    e.preventDefault();
    send({
      t: 'config',
      patch: {
        actionTimeoutMs: Math.round(Number(D.cfgTimeout.value) * 1000),
        autoNextDealMs: Math.round(Number(D.cfgNext.value) * 1000),
        autoNextDeal: D.cfgAuto.checked,
      },
    });
    S.cfgDirty = false;
  });
  D.btnReset.addEventListener('click', () => {
    confirmDlg('重开一场', '双方级数都会清回打 2，确定吗？', () => send({ t: 'reset' }));
  });

  // 聊天
  D.chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = D.chatInput.value.trim();
    if (!text) return;
    send({ t: 'chat', text });
    D.chatInput.value = '';
  });

  // 侧栏抽屉
  const openSide = (on) => {
    D.side.classList.toggle('open', on);
    D.drawerMask.hidden = !on;
    if (on) D.sideBadge.hidden = true;
  };
  D.btnSide.addEventListener('click', () => openSide(!D.side.classList.contains('open')));
  D.btnSideClose.addEventListener('click', () => openSide(false));
  D.drawerMask.addEventListener('click', () => openSide(false));

  // 标签页
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      for (const t of document.querySelectorAll('.tab')) {
        const on = t === tab;
        t.classList.toggle('is-on', on);
        t.setAttribute('aria-selected', String(on));
      }
      const want = tab.dataset.tab;
      for (const p of document.querySelectorAll('.pane')) {
        p.classList.toggle('is-on', p.id === 'pane' + want[0].toUpperCase() + want.slice(1));
      }
    });
  }

  // 音效开关
  D.btnSound.addEventListener('click', () => {
    S.sound = !S.sound;
    lsSet(LS_SOUND, S.sound ? '1' : '0');
    D.btnSound.setAttribute('aria-pressed', String(S.sound));
    if (S.sound) sfx.turn();
  });
  D.btnSound.setAttribute('aria-pressed', String(S.sound));

  D.fatalRetry.addEventListener('click', () => {
    S.fatal = null;
    D.fatalMask.hidden = true;
    connect();
  });

  // 键盘快捷键：空格出牌 / P 不要 / H 提示
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea')) return;
    const s = st();
    if (!s || !s.you.myTurn) return;
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); if (currentPlay()) doPlay(); }
    else if (e.key === 'p' || e.key === 'P') { if (s.you.canPass) doPass(); }
    else if (e.key === 'h' || e.key === 'H') doHint();
  });
}

bind();
connect();
