// SPDX-License-Identifier: GPL-3.0-or-later
// 语音连麦（前端）。德州和掼蛋共用这一份，零依赖、零构建。
//
// 拓扑是 mesh：每个人和其他每个人各建一条 WebRTC 连接，音频点对点直传，
// 服务器只转发几 KB 的 SDP/ICE。所以谁也听不到别桌的声音——信令根本不过去。
//
// 用法（两个页面都是这三步）：
//   const voice = window.TableVoice.create({ send, toast, mount, button });
//   voice.handle(m)        // 每条服务端消息都丢进来（voiceReady / voiceSignal 会被吃掉）
//   voice.applyState(m)    // 每个 state 快照都丢进来
//   voice.onWelcome()      // 收到 welcome 之后调一次（断线重连会自动重新上麦）
//   voice.speakingSeat(n)  // 渲染座位时问一句：这个座位正在说话吗
(function () {
  'use strict';

  var HAS_RTC = typeof window.RTCPeerConnection === 'function';

  function elt(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }

  /** 说话判定：能量超过 ON 才算开口，掉到 OFF 以下并保持 HOLD 毫秒才算闭嘴。
   *  两条线分开是为了不让说话时的自然停顿把指示灯打成频闪。 */
  var LEVEL_ON = 0.045;
  var LEVEL_OFF = 0.022;
  var SPEAK_HOLD_MS = 350;
  var METER_MS = 100;

  function create(opts) {
    opts = opts || {};
    var send = opts.send || function () { return false; };
    var toast = opts.toast || function () {};
    // 名单面板有两个家：宽屏挂在侧栏顶部（跟着排版走，不挡日志），
    // 窄屏侧栏是抽屉、平时收着，就浮在顶栏底下。
    var mount = opts.mount || null;      // 窄屏：浮层
    var dock = opts.dock || null;        // 宽屏：侧栏里的固定位置
    var button = opts.button || null;    // 顶栏那个「连麦」按钮
    var wide = window.matchMedia ? window.matchMedia('(min-width: 901px)') : null;

    var S = {
      supported: HAS_RTC,
      enabled: false,        // 服务端有没有开语音
      max: 8,
      self: null,            // 我的 playerId
      want: false,           // 用户是不是想在麦上（断线重连后照着它自动回去）
      joined: false,         // 服务端名单里有没有我
      micMuted: false,
      stream: null,          // 本地麦克风
      busy: false,           // 正在申请麦克风
      roster: [],            // 服务端下发的麦上名单
      peers: new Map(),      // playerId -> peer
      speaking: new Set(),   // 正在说话的 playerId
      needGesture: false,    // 浏览器拦了自动播放，要用户点一下
      // 窄屏默认收起来（只留一排头像），免得整块面板压住牌桌顶上的座位。
      // 用户手动展开过就记住他的选择，不再跟着屏幕宽度变。
      compact: !(window.matchMedia && window.matchMedia('(min-width: 901px)').matches),
      compactTouched: false,
      iceServers: [],
      audioCtx: null,
      meterTimer: null,
      selfMeter: null,
      warnedFail: false,
      ui: null,
    };

    // ==================== 麦克风 ====================

    function micError(err) {
      var name = err && err.name ? err.name : '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        return '浏览器不让用麦克风。请在地址栏左边的权限里允许麦克风，然后再试一次。';
      }
      if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        return '没找到麦克风设备。';
      }
      if (name === 'NotReadableError') {
        return '麦克风被别的程序占着，先关掉那个再来。';
      }
      return '打不开麦克风：' + (name || (err && err.message) || '未知错误');
    }

    function getMic() {
      if (S.stream) return Promise.resolve(S.stream);
      if (!window.isSecureContext) {
        return Promise.reject(new Error('insecure'));
      }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        return Promise.reject(new Error('unsupported'));
      }
      return navigator.mediaDevices.getUserMedia({
        audio: {
          // 一桌人多半开着外放，这三个必须留着，否则回声能把牌局吵散
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      }).then(function (stream) {
        S.stream = stream;
        applyMicMute();
        // 系统层面把麦拔了 / 权限被撤销
        stream.getAudioTracks().forEach(function (t) {
          t.addEventListener('ended', function () {
            if (S.want) {
              toast('麦克风断了，已经下麦');
              leave();
            }
          });
        });
        startMeter();
        return stream;
      });
    }

    function dropMic() {
      if (!S.stream) return;
      try {
        S.stream.getTracks().forEach(function (t) { t.stop(); });
      } catch (e) { /* 忽略 */ }
      S.stream = null;
      if (S.selfMeter) {
        try { S.selfMeter.src.disconnect(); } catch (e) { /* 忽略 */ }
        S.selfMeter = null;
      }
    }

    function applyMicMute() {
      if (!S.stream) return;
      S.stream.getAudioTracks().forEach(function (t) { t.enabled = !S.micMuted; });
    }

    // ==================== 上麦 / 下麦 ====================

    function join() {
      if (!S.supported) { toast('这个浏览器不支持语音连麦'); return; }
      if (!S.enabled) { toast('这台服务器没有开语音连麦'); return; }
      if (S.busy) return;
      S.busy = true;
      render();
      getMic().then(function () {
        S.busy = false;
        S.want = true;
        if (!send({ t: 'voiceJoin' })) {
          toast('还没连上服务器，稍后再试');
        }
        render();
      }).catch(function (err) {
        S.busy = false;
        S.want = false;
        dropMic();
        if (err && err.message === 'insecure') {
          toast('语音需要 HTTPS。用 https 的地址打开，或者在本机 localhost 上测试。');
        } else if (err && err.message === 'unsupported') {
          toast('这个浏览器不支持麦克风');
        } else {
          toast(micError(err));
        }
        render();
      });
    }

    function leave() {
      S.want = false;
      S.joined = false;
      S.micMuted = false;
      send({ t: 'voiceLeave' });
      closeAllPeers();
      dropMic();
      stopMeter();
      S.speaking.clear();
      render();
    }

    function toggle() {
      if (S.want) leave();
      else join();
    }

    function toggleMic() {
      if (!S.want) return;
      S.micMuted = !S.micMuted;
      applyMicMute();
      send({ t: 'voiceMute', value: S.micMuted });
      if (S.micMuted && S.self) S.speaking.delete(S.self);
      render();
      if (opts.onSpeakingChange) opts.onSpeakingChange();
    }

    // ==================== 对端连接 ====================

    function sendSignal(to, data) {
      send({ t: 'voiceSignal', to: to, data: data });
    }

    function ensurePeer(id) {
      var p = S.peers.get(id);
      if (p) return p;

      var pc = new RTCPeerConnection({
        iceServers: S.iceServers,
        // mesh 下每条连接都独立打洞，池子留一个就够了
        iceCandidatePoolSize: 0,
      });
      p = {
        id: id,
        pc: pc,
        // "礼貌"的一方在信令撞车时让步。用 playerId 比大小定，双方算出来必然相反。
        polite: !!(S.self && S.self < id),
        makingOffer: false,
        ignoreOffer: false,
        queue: Promise.resolve(),
        audio: null,
        meter: null,
        state: 'connecting',
        restarted: false,
        failures: 0,
        volume: 1,
        localMuted: false,
      };
      S.peers.set(id, p);

      if (S.stream) {
        S.stream.getTracks().forEach(function (t) { pc.addTrack(t, S.stream); });
      }

      pc.onicecandidate = function (ev) {
        if (!ev.candidate) return;
        sendSignal(id, {
          kind: 'candidate',
          candidate: {
            candidate: ev.candidate.candidate,
            sdpMid: ev.candidate.sdpMid,
            sdpMLineIndex: ev.candidate.sdpMLineIndex,
            usernameFragment: ev.candidate.usernameFragment,
          },
        });
      };

      pc.ontrack = function (ev) {
        var stream = ev.streams && ev.streams[0] ? ev.streams[0] : new MediaStream([ev.track]);
        attachAudio(p, stream);
      };

      // 只让"不礼貌"的一方发 offer。两边同时发才会撞车，从源头掐掉。
      pc.onnegotiationneeded = function () {
        if (p.polite) return;
        p.queue = p.queue.then(function () {
          p.makingOffer = true;
          return pc.setLocalDescription().then(function () {
            sendSignal(id, { kind: 'offer', sdp: pc.localDescription.sdp });
          });
        }).catch(function (e) {
          console.warn('[voice] 发 offer 失败', e);
        }).then(function () {
          p.makingOffer = false;
        });
      };

      pc.onconnectionstatechange = function () {
        var st = pc.connectionState;
        p.state = st;
        if (st === 'failed') {
          p.failures += 1;
          // 先试一次 ICE 重启：换个网（比如从 Wi-Fi 切到蜂窝）多半能救回来。
          // 重启由"不礼貌"的一方发起，和 offer 一样，避免两边同时来。
          if (!p.restarted && !p.polite) {
            p.restarted = true;
            try { pc.restartIce(); } catch (e) { /* 老浏览器没有 */ }
          } else if (p.failures >= 2 && !S.warnedFail) {
            // 礼貌的一方不主动重启，所以要等第二次失败再喊——
            // 否则对面重启成功了，这边已经先弹过一次假警报
            S.warnedFail = true;
            toast('和' + nameOf(id) + '的语音没打通。两边网络之间需要 TURN 中转，详见 README。');
          }
        }
        render();
      };

      return p;
    }

    function attachAudio(p, stream) {
      if (!p.audio) {
        var el = document.createElement('audio');
        el.autoplay = true;
        el.playsInline = true;
        // 自己的声音不该从自己音箱里再出来一遍，所以只播远端
        el.volume = p.volume;
        el.muted = p.localMuted;
        el.setAttribute('data-peer', p.id);
        ((S.ui && S.ui.sinks) || document.body).appendChild(el);
        p.audio = el;
      }
      p.audio.srcObject = stream;
      var pr = p.audio.play();
      if (pr && pr.catch) {
        pr.catch(function () {
          // 浏览器的自动播放策略：需要用户先点一下页面
          S.needGesture = true;
          render();
        });
      }
      startPeerMeter(p, stream);
    }

    function closePeer(id) {
      var p = S.peers.get(id);
      if (!p) return;
      S.peers.delete(id);
      S.speaking.delete(id);
      if (p.meter) {
        try { p.meter.src.disconnect(); } catch (e) { /* 忽略 */ }
        p.meter = null;
      }
      if (p.audio) {
        try { p.audio.pause(); p.audio.srcObject = null; p.audio.remove(); } catch (e) { /* 忽略 */ }
        p.audio = null;
      }
      try { p.pc.close(); } catch (e) { /* 忽略 */ }
    }

    function closeAllPeers() {
      Array.from(S.peers.keys()).forEach(closePeer);
    }

    /** 按服务端名单把连接补齐 / 拆掉 */
    function syncPeers() {
      var want = new Set();
      if (S.joined && S.self) {
        for (var i = 0; i < S.roster.length; i++) {
          var id = S.roster[i].playerId;
          if (id && id !== S.self) want.add(id);
        }
      }
      S.peers.forEach(function (p, id) {
        if (!want.has(id)) closePeer(id);
      });
      want.forEach(function (id) { ensurePeer(id); });
    }

    // ==================== 信令 ====================

    function onSignal(from, data) {
      if (!S.joined || !data) return;
      var p = ensurePeer(from);
      p.queue = p.queue.then(function () {
        if (data.kind === 'bye') {
          closePeer(from);
          return null;
        }
        if (data.kind === 'offer' || data.kind === 'answer') {
          var collision = data.kind === 'offer' &&
            (p.makingOffer || p.pc.signalingState !== 'stable');
          p.ignoreOffer = !p.polite && collision;
          if (p.ignoreOffer) return null;
          return p.pc.setRemoteDescription({ type: data.kind, sdp: data.sdp })
            .then(function () {
              if (data.kind !== 'offer') return null;
              return p.pc.setLocalDescription().then(function () {
                sendSignal(from, { kind: 'answer', sdp: p.pc.localDescription.sdp });
              });
            });
        }
        if (data.kind === 'candidate' && data.candidate) {
          return p.pc.addIceCandidate(data.candidate).catch(function (e) {
            if (!p.ignoreOffer) console.warn('[voice] candidate 加不进去', e);
          });
        }
        return null;
      }).catch(function (e) {
        console.warn('[voice] 处理信令出错', e);
      });
    }

    // ==================== 音量检测 ====================

    function audioCtx() {
      if (S.audioCtx) return S.audioCtx;
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      try {
        S.audioCtx = new Ctx();
      } catch (e) {
        return null;
      }
      return S.audioCtx;
    }

    function makeMeter(stream) {
      var ctx = audioCtx();
      if (!ctx || !stream || !stream.getAudioTracks().length) return null;
      try {
        if (ctx.state === 'suspended') ctx.resume();
        var src = ctx.createMediaStreamSource(stream);
        var an = ctx.createAnalyser();
        an.fftSize = 512;
        an.smoothingTimeConstant = 0.6;
        src.connect(an);
        return { src: src, an: an, buf: new Uint8Array(an.fftSize), since: 0 };
      } catch (e) {
        return null;
      }
    }

    function startPeerMeter(p, stream) {
      if (p.meter) {
        try { p.meter.src.disconnect(); } catch (e) { /* 忽略 */ }
      }
      p.meter = makeMeter(stream);
      startMeter();
    }

    function startMeter() {
      if (S.meterTimer) return;
      S.meterTimer = setInterval(tickMeter, METER_MS);
    }

    function stopMeter() {
      if (!S.meterTimer) return;
      clearInterval(S.meterTimer);
      S.meterTimer = null;
    }

    /** 有效值（RMS），0~1 */
    function levelOf(meter) {
      if (!meter) return 0;
      meter.an.getByteTimeDomainData(meter.buf);
      var sum = 0;
      for (var i = 0; i < meter.buf.length; i++) {
        var v = (meter.buf[i] - 128) / 128;
        sum += v * v;
      }
      return Math.sqrt(sum / meter.buf.length);
    }

    function judge(meter, id, now) {
      var lv = levelOf(meter);
      var on = S.speaking.has(id);
      if (lv >= LEVEL_ON) {
        meter.since = now;
        if (!on) { S.speaking.add(id); return true; }
        return false;
      }
      if (on && lv < LEVEL_OFF && now - meter.since > SPEAK_HOLD_MS) {
        S.speaking.delete(id);
        return true;
      }
      return false;
    }

    function tickMeter() {
      var now = Date.now();
      var changed = false;

      if (S.stream && S.self && S.joined) {
        if (!S.selfMeter) S.selfMeter = makeMeter(S.stream);
        if (S.selfMeter) {
          if (S.micMuted) {
            if (S.speaking.delete(S.self)) changed = true;
          } else if (judge(S.selfMeter, S.self, now)) {
            changed = true;
          }
        }
      }
      S.peers.forEach(function (p, id) {
        if (!p.meter) return;
        if (p.localMuted) {
          if (S.speaking.delete(id)) changed = true;
          return;
        }
        if (judge(p.meter, id, now)) changed = true;
      });

      if (changed) {
        renderList();
        if (opts.onSpeakingChange) opts.onSpeakingChange();
      }
    }

    // ==================== 对外接口 ====================

    function nameOf(id) {
      for (var i = 0; i < S.roster.length; i++) {
        if (S.roster[i].playerId === id) return S.roster[i].name || '对方';
      }
      return '对方';
    }

    /** 吃掉语音相关的服务端消息，返回是否已处理 */
    function handle(m) {
      if (!m || typeof m.t !== 'string') return false;
      if (m.t === 'voiceReady') {
        S.self = m.self || S.self;
        S.max = m.max || S.max;
        S.iceServers = Array.isArray(m.iceServers) ? m.iceServers : [];
        return true;
      }
      if (m.t === 'voiceSignal') {
        onSignal(m.from, m.data);
        return true;
      }
      return false;
    }

    /** 每个 state 快照都喂进来 */
    function applyState(st) {
      var v = st && st.voice ? st.voice : null;
      S.enabled = !!(v && v.enabled);
      S.max = v && v.max ? v.max : S.max;
      S.roster = v && Array.isArray(v.members) ? v.members : [];
      if (st && st.you && st.you.playerId) S.self = st.you.playerId;

      var joined = false;
      for (var i = 0; i < S.roster.length; i++) {
        if (S.roster[i].playerId === S.self) { joined = true; break; }
      }
      S.joined = joined;

      // 自己的静音状态以服务端为准（多标签页、重连之后不会对不上）
      if (joined) {
        for (var j = 0; j < S.roster.length; j++) {
          if (S.roster[j].playerId === S.self) {
            if (S.roster[j].muted !== S.micMuted) {
              S.micMuted = !!S.roster[j].muted;
              applyMicMute();
            }
            break;
          }
        }
      }

      syncPeers();
      render();
    }

    /** 收到 welcome 之后调：断线重连回来，如果本来在麦上就自动再上去 */
    function onWelcome() {
      if (S.want && S.stream) send({ t: 'voiceJoin' });
    }

    /** WebSocket 断了：先把连接拆掉，等重连后重建 */
    function onDisconnect() {
      S.joined = false;
      closeAllPeers();
      render();
    }

    /** 这个座位正在说话吗（渲染座位时用） */
    function speakingSeat(seat) {
      if (seat === null || seat === undefined) return false;
      for (var i = 0; i < S.roster.length; i++) {
        var m = S.roster[i];
        if (m.seat === seat && S.speaking.has(m.playerId)) return true;
      }
      return false;
    }

    /** 这个座位在麦上吗 */
    function onMic(seat) {
      if (seat === null || seat === undefined) return null;
      for (var i = 0; i < S.roster.length; i++) {
        if (S.roster[i].seat === seat) return S.roster[i];
      }
      return null;
    }

    // ==================== 界面 ====================

    function buildUI() {
      if (!mount || S.ui) return;
      var box = elt('div', 'voice-box');
      box.hidden = true;

      var head = elt('div', 'vb-head');
      var title = elt('span', 'vb-title', '语音连麦');
      var count = elt('span', 'vb-count', '');
      head.appendChild(title);
      head.appendChild(count);

      var btnFold = elt('button', 'vb-fold', '');
      btnFold.type = 'button';
      btnFold.addEventListener('click', function () {
        S.compact = !S.compact;
        S.compactTouched = true;
        render();
      });
      head.appendChild(btnFold);

      var btnMic = elt('button', 'vb-btn vb-mic', '静音');
      btnMic.type = 'button';
      btnMic.addEventListener('click', toggleMic);
      var btnQuit = elt('button', 'vb-btn vb-quit', '下麦');
      btnQuit.type = 'button';
      btnQuit.addEventListener('click', leave);
      var btnJoin = elt('button', 'vb-btn vb-join', '上麦');
      btnJoin.type = 'button';
      btnJoin.addEventListener('click', join);
      head.appendChild(btnMic);
      head.appendChild(btnQuit);
      head.appendChild(btnJoin);

      var list = elt('ul', 'vb-list');
      var tip = elt('div', 'vb-tip');
      tip.hidden = true;

      var gesture = elt('button', 'vb-gesture', '🔈 点这里打开声音');
      gesture.type = 'button';
      gesture.hidden = true;
      gesture.addEventListener('click', function () {
        S.needGesture = false;
        if (S.audioCtx && S.audioCtx.state === 'suspended') S.audioCtx.resume();
        S.peers.forEach(function (p) {
          if (p.audio) { var r = p.audio.play(); if (r && r.catch) r.catch(function () {}); }
        });
        render();
      });

      // 音频元素常驻 body：面板会在侧栏和浮层之间搬家，
      // 正在播的 <audio> 跟着换父节点有被浏览器暂停的风险，不如让它别动。
      var sinks = elt('div', 'vb-sinks');
      sinks.setAttribute('aria-hidden', 'true');
      document.body.appendChild(sinks);

      box.appendChild(head);
      box.appendChild(list);
      box.appendChild(tip);
      box.appendChild(gesture);

      S.ui = { box: box, count: count, list: list, tip: tip, gesture: gesture,
        sinks: sinks, btnMic: btnMic, btnQuit: btnQuit, btnJoin: btnJoin,
        btnFold: btnFold, sig: '' };
      placeBox();
    }

    /** 按屏幕宽度决定面板挂在哪儿 */
    function placeBox() {
      if (!S.ui) return;
      var target = (dock && wide && wide.matches) ? dock : mount;
      if (!target) return;
      if (S.ui.box.parentNode !== target) target.appendChild(S.ui.box);
      S.ui.box.classList.toggle('is-docked', target === dock);
      if (!S.compactTouched) S.compact = !(wide && wide.matches);
    }

    function stateText(p) {
      switch (p.state) {
        case 'connected': return '';
        case 'failed': return '连不通';
        case 'disconnected': return '断开中';
        case 'closed': return '已关闭';
        default: return '连接中';
      }
    }

    function renderList() {
      if (!S.ui) return;
      var ui = S.ui;
      // 签名比对：名单没变就不重建 DOM，只更新"正在说话"的 class
      var sig = S.roster.map(function (m) {
        var p = S.peers.get(m.playerId);
        return [m.playerId, m.name, m.seat, m.muted ? 1 : 0,
          p ? p.state : '', p && p.localMuted ? 1 : 0].join('|');
      }).join(';');

      if (sig !== ui.sig) {
        ui.sig = sig;
        ui.list.textContent = '';
        S.roster.forEach(function (m) {
          var li = elt('li', 'vb-mem' + (m.muted ? ' is-muted' : ''));
          li.setAttribute('data-pid', m.playerId);
          li.title = (m.name || '观众') + (m.muted ? '（已静音）' : '');

          var av = elt('i', 'vb-av', (m.avatar && m.avatar.glyph) || (m.name || '?').charAt(0));
          if (m.avatar && m.avatar.bg) av.style.background = m.avatar.bg;
          li.appendChild(av);

          var main = elt('span', 'vb-main');
          main.appendChild(elt('span', 'vb-name', m.name || '观众'));
          var sub = elt('span', 'vb-sub');
          sub.textContent = m.seat === null || m.seat === undefined
            ? '观众' : (m.seat + 1) + ' 号位';
          if (m.playerId === S.self) sub.textContent += ' · 我';
          var p = S.peers.get(m.playerId);
          var stx = p ? stateText(p) : '';
          if (stx) sub.textContent += ' · ' + stx;
          main.appendChild(sub);
          li.appendChild(main);

          if (m.muted) li.appendChild(elt('i', 'vb-flag muted', '静音'));

          // 别人：可以单独把他关掉（比如那位在敲键盘）
          if (m.playerId !== S.self) {
            var b = elt('button', 'vb-off' + (p && p.localMuted ? ' is-on' : ''),
              p && p.localMuted ? '已屏蔽' : '屏蔽');
            b.type = 'button';
            b.title = '只在你这边把这个人的声音关掉';
            b.addEventListener('click', function () {
              var pp = S.peers.get(m.playerId);
              if (!pp) return;
              pp.localMuted = !pp.localMuted;
              if (pp.audio) pp.audio.muted = pp.localMuted;
              renderList();
            });
            li.appendChild(b);
          }
          ui.list.appendChild(li);
        });
      }

      // 说话高亮每帧都可能变，单独刷
      var items = ui.list.children;
      for (var i = 0; i < items.length; i++) {
        var pid = items[i].getAttribute('data-pid');
        items[i].classList.toggle('speaking', S.speaking.has(pid));
      }
    }

    function render() {
      buildUI();
      if (button) {
        var off = !S.supported || !S.enabled;
        button.hidden = off;
        button.disabled = S.busy;
        button.setAttribute('aria-pressed', S.want ? 'true' : 'false');
        button.classList.toggle('is-on', S.want && S.joined);
        button.classList.toggle('is-busy', S.busy);
        var lbl = button.querySelector('.lbl');
        var txt = S.busy ? '开麦中' : (S.want ? (S.micMuted ? '已静音' : '连麦中') : '连麦');
        if (lbl) lbl.textContent = txt;
        // 手机上标签会被 CSS 藏起来，人数就靠角标传达
        var badge = button.querySelector('.voice-badge');
        if (badge) {
          badge.hidden = S.roster.length === 0;
          badge.textContent = String(S.roster.length);
        }
      }
      if (!S.ui) return;
      var ui = S.ui;
      ui.box.hidden = !S.enabled || !S.supported || (!S.want && S.roster.length === 0);
      ui.count.textContent = S.roster.length + ' / ' + S.max;
      ui.btnMic.hidden = !S.want;
      ui.btnMic.textContent = S.micMuted ? '取消静音' : '静音';
      ui.btnMic.classList.toggle('is-on', S.micMuted);
      ui.btnQuit.hidden = !S.want;
      ui.btnJoin.hidden = S.want;
      ui.btnJoin.disabled = S.busy;
      ui.gesture.hidden = !S.needGesture;
      ui.box.classList.toggle('is-compact', S.compact);
      ui.btnFold.textContent = S.compact ? '▸' : '▾';
      ui.btnFold.setAttribute('aria-label', S.compact ? '展开语音名单' : '收起语音名单');

      var tip = '';
      if (S.want && !S.joined) tip = '正在上麦…';
      else if (!S.want && S.roster.length) tip = '他们在语音里聊天，点「上麦」加进去。';
      ui.tip.textContent = tip;
      ui.tip.hidden = !tip;

      renderList();
    }

    if (button) {
      button.hidden = true;
      button.addEventListener('click', toggle);
    }
    buildUI();
    if (wide && wide.addEventListener) wide.addEventListener('change', placeBox);

    // 页面关掉之前礼貌地下麦，别让别人对着一个空位等 ICE 超时
    window.addEventListener('pagehide', function () {
      if (S.want) send({ t: 'voiceLeave' });
    });

    return {
      handle: handle,
      applyState: applyState,
      onWelcome: onWelcome,
      onDisconnect: onDisconnect,
      speakingSeat: speakingSeat,
      onMic: onMic,
      join: join,
      leave: leave,
      toggle: toggle,
      get active() { return S.want; },
      _state: S,
    };
  }

  window.TableVoice = { create: create, supported: HAS_RTC };
}());
