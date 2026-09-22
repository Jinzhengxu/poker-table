// SPDX-License-Identifier: GPL-3.0-or-later
/* =========================================================================
   德州扑克 · 中英文切换
   - 语言怎么定：localStorage 里手动选过的优先；否则看浏览器语言列表，
     列表里有任何一种中文就用中文，一种都没有才用英文。
   - 静态文案：本文件在 app.js 之前加载，页面已解析完，直接把 DOM 里
     命中词典的文本节点和 title / aria-label / placeholder / data-key 换掉。
     词典的键就是中文原文，所以 HTML 里照旧写中文，不用加标记。
   - 动态文案：app.js / voice.js 用 t('中文', 参数) 取文案，中文模式原样返回。
   - 服务端日志：条目带 {k, p}（见 SPEC §6.2），英文按键渲染，中文用 text。
   - 切换：顶栏按钮写 localStorage 后刷新页面——座位令牌在，刷新不丢座。
   本文件也能在 Node 的 vm 里加载（测试用），所以 document 相关都有守卫。
   ========================================================================= */
(function (root) {
  'use strict';

  var LS_KEY = 'poker_lang';

  /** 中文原文 → 英文。带 {x} 的是模板，中英文都用同一组占位符。 */
  var EN = {
    // ---- 顶栏 / 页面 ----
    '收件箱 (3) - 邮件': 'Inbox (3) - Mail',
    '德州扑克': "Texas Hold'em",
    '连接中…': 'Connecting…',
    '已连接': 'Connected',
    '重连中…': 'Reconnecting…',
    '盲注 —': 'Blinds —',
    '房主': 'Host',
    '人机的动作由 Jev 决策模型判断': 'Bot actions are decided by the Jev decision model',
    '去掼蛋桌': 'Guandan table',
    '掼蛋': 'Guandan',
    '去热词': 'Hotword',
    '热词': 'Hotword',
    '提示音开关': 'Toggle sound effects',
    '音效': 'Sound',
    '背景音乐开关': 'Toggle background music',
    '音乐': 'Music',
    '语音连麦': 'Voice chat',
    '连麦': 'Voice',
    '打开日志与聊天面板': 'Open the log and chat panel',
    '面板': 'Panel',
    '切换语言': 'Switch language',
    '第 {n} 手': 'Hand {n}',
    '未开局': 'Not started',
    '盲注 {sb}/{bb}': 'Blinds {sb}/{bb}',
    ' · 前注 {n}': ' · ante {n}',
    '人机的动作由 Jev 决策模型（{label} · {model}）判断': 'Bot actions are decided by the Jev decision model ({label} · {model})',
    ' · {n} 判断 · {avg}': ' · {n} decisions · {avg}',
    '；累计 {n} 次往返，平均 {avg}': '; {n} round trips so far, average {avg}',
    '，共花 ${cost}': ', ${cost} spent',
    '；另有 {n} 个明显局面由规则直接出手': '; {n} obvious spots were played by the rules',
    ' · 冷却中': ' · cooling down',
    '；Jev 连续出错，暂时由大模型或规则顶上': '; Jev kept failing, the language model or the rules are covering for now',

    // ---- 牌桌 ----
    '等待开局': 'Waiting to start',
    '翻牌前': 'Preflop',
    '翻牌': 'Flop',
    '转牌': 'Turn',
    '河牌': 'River',
    '摊牌': 'Showdown',
    '本手结束': 'Hand over',
    '牌桌': 'Table',
    '底池': 'Pot',
    '主池 ': 'Main pot ',
    '边池{i} ': 'Side pot {i} ',
    '公共牌': 'Community cards',
    '黑桃': 'Spades',
    '红桃': 'Hearts',
    '方块': 'Diamonds',
    '梅花': 'Clubs',
    '＋ 入座': '+ Sit here',
    '{n} 号空位': 'Seat {n} · empty',
    '第 {n} 号座位，空位': 'Seat {n}, empty',
    '，点击入座': ', click to sit down',
    '座位{n}': 'Seat {n}',
    '{n} 号座位': 'seat {n}',
    '{name} 已静音': '{name} is muted',
    '{name} 在语音里': '{name} is on voice',
    '{name}，筹码 {chips}': '{name}, chips {chips}',
    '，已弃牌': ', folded',
    '，已全下': ', all-in',
    '，已断线': ', disconnected',
    '弃牌': 'Fold',
    '过牌': 'Check',
    '跟注': 'Call',
    '跟注 {n}': 'Call {n}',
    '全下跟注 {n}': 'Call all-in {n}',
    '加注': 'Raise',
    '下注': 'Bet',
    '下注 {n}': 'Bet {n}',
    '加注到': 'Raise to',
    '加注到 {n}': 'Raise to {n}',
    '全下': 'All-in',
    '全下 {n}': 'All-in {n}',
    '确认{verb} {n}': '{verb} {n}',
    '确认加注到 0': 'Raise to 0',
    '要给大家看看你的牌吗？': 'Show everyone your cards?',
    '亮牌': 'Show cards',
    '½ 池': '½ pot',
    '⅔ 池': '⅔ pot',
    '最小': 'Min',
    '加注金额滑杆': 'Raise amount slider',
    '加注金额': 'Raise amount',
    '取消': 'Cancel',
    '开始这一手': 'Start the hand',
    '补充筹码': 'Add chips',
    '暂时离开': 'Sit out',
    '回到牌桌': 'Back to table',
    '退出': 'Leave',
    '选个座位坐下': 'Take a seat',
    '我的手牌与操作': 'My cards and actions',
    '正在连接服务器…': 'Connecting to the server…',
    '连接断开，正在重连…': 'Disconnected, reconnecting…',
    '观战中': 'Spectating',
    '等待发牌': 'Waiting',
    '观战中 · 点击牌桌上的空座位入座': 'Spectating · click an empty seat to sit down',
    '轮到你行动': 'Your turn',
    '轮到你行动 · {s} 秒': 'Your turn · {s}s',
    '等待 {name} 行动': 'Waiting for {name}',
    '人数够了，可以开始': 'Enough players, you can start',
    '等待房主开始': 'Waiting for the host to start',
    '等待更多玩家入座（至少 2 人）': 'Waiting for more players (at least 2)',
    '你暂时离开了，下一手不参与 · 点「回到牌桌」继续': 'You are sitting out · click "Back to table" to rejoin',
    '牌局进行中': 'Hand in progress',
    '你已弃牌，等待本手结束': 'You folded, waiting for the hand to end',
    '你的筹码用完了，点「补充筹码」接着打': 'You are out of chips · click "Add chips" to keep playing',
    '你的筹码用完了，让房主给你补充': 'You are out of chips · ask the host for more',
    '{s} 秒后开始下一手': 'Next hand in {s}s',
    '太久没人操作，牌桌先歇着 · 动一下就继续': 'Nobody has acted for a while, the table is resting · move to continue',
    '没人在看，牌桌先歇着': 'Nobody is watching, the table is resting',
    ' 和 ': ' and ',
    ' 赢了': ' won',
    '平分底池': 'Split pot',
    '你赢了': 'You won',
    '你输了': 'You lost',
    '这手没输没赢': 'No win, no loss',
    ' 平分': ' split it',
    ' 拿下': ' takes it',
    ' 收下底池': ' takes the pot',
    '没人跟到底': 'Nobody called',

    // ---- 侧栏 ----
    '牌局日志、聊天与设置': 'Hand log, chat and settings',
    '牌局': 'Log',
    '聊天': 'Chat',
    '设置': 'Settings',
    '关闭面板': 'Close panel',
    '关闭': 'Close',
    '说点什么…': 'Say something…',
    '聊天输入框': 'Chat input',
    '发送聊天': 'Send',
    '发送': 'Send',
    '匿名': 'Anonymous',
    '：': ': ',
    '只有房主可以修改牌桌设置。': 'Only the host can change the table settings.',
    '牌桌设置': 'Table settings',
    '小盲': 'Small blind',
    '大盲': 'Big blind',
    '前注': 'Ante',
    '起始筹码': 'Starting stack',
    '行动时限（秒）': 'Action clock (seconds)',
    '自动开始下一手': 'Auto-start the next hand',
    '保存设置': 'Save settings',
    '重置牌桌': 'Reset table',
    '设置只能在两手牌之间修改。': 'Settings can only be changed between hands.',
    '背景音乐': 'Background music',
    'Kevin MacLeod（incompetech.com）': 'Kevin MacLeod (incompetech.com)',
    '授权：Creative Commons By Attribution 4.0': 'License: Creative Commons By Attribution 4.0',
    '人机后端': 'Bot backend',
    '未配置，人机将按内置规则打牌。': 'Not configured. Bots play by the built-in rules.',
    '供应商': 'Provider',
    'Kimi（月之暗面）': 'Kimi (Moonshot)',
    '网关 token（uuid 形式）': 'gateway token (uuid)',
    '银联云（deepseek-v4-flash）': 'UnionPay Cloud (deepseek-v4-flash)',
    'OpenRouter（deepseek/deepseek-v4-flash）': 'OpenRouter (deepseek/deepseek-v4-flash)',
    '模型（留空用默认）': 'Model (blank = default)',
    '不思考': 'No thinking',
    '关掉思维链，出手快得多，也更省 token。': 'Turns off chain-of-thought: much faster to act and cheaper in tokens.',
    '这家的模型本来就不思考，这个开关对它没有意义。': "This provider's model does not reason to begin with; the switch does nothing here.",
    '保存后端': 'Save backend',
    '记住 key': 'Remember key',
    'Key 经加密连接送到服务端，只存在内存里，不会发给牌桌上的其他人， 也不会写进日志。服务重启后需要重新填。':
      'The key travels over the encrypted connection and lives only in server memory. It is never sent to other players or written to logs. After a server restart you will need to enter it again.',
    '已启用：': 'Enabled: ',
    '，不思考': ', no thinking',
    '，': ', ',
    '、': ', ',
    '（': ' (',
    '）': ')',
    ' ⚠ 冷却中': ' ⚠ cooling down',
    'Jev 决策模型': 'Jev decision model',
    '未配置，动作由上面的大模型决定。': 'Not configured. Actions are decided by the language model above.',
    '留空 = 沿用上面 OpenRouter 的 key': 'blank = reuse the OpenRouter key above',
    'TypeSafe 控制台签发的 key': 'key issued by the TypeSafe console',
    'TypeSafe 直连': 'TypeSafe direct',
    '保存 Jev': 'Save Jev',
    '停用': 'Disable',
    'Jev 只做一秒内的判断：对手范围、弃牌率、续注强度，动作由代码算，一次决策约一秒。 闲聊和赛后读人笔记仍由上面的大模型做；Jev 挂了也退回它。':
      'Jev only makes the one-second judgements: opponent range, fold probability, continuing strength. The code computes the action; one decision takes about a second. Table talk and post-hand notes still come from the language model above, which is also the fallback when Jev is down.',
    '闲聊': 'table talk',
    '读人笔记': 'player notes',
    '已启用：{label}（{model}，{key}）': 'Enabled: {label} ({model}, {key})',
    '；{jobs}交给上面的大模型': '; {jobs} go to the language model above',
    '；没配大模型，人机不说话': '; no language model configured, bots stay quiet',
    '座位管理': 'Seats',
    '＋ 加入人机': '+ Add a bot',
    '还没有人入座。': 'Nobody is seated yet.',
    '（人机）': ' (bot)',
    '（断线）': ' (offline)',
    '没筹码': 'no chips',
    '补充': 'Add',
    '给 {name} 补充筹码': 'Add chips for {name}',
    '踢出': 'Kick',
    '把 {name} 请出牌桌': 'Kick {name} from the table',

    // ---- 对话框 / 提示 ----
    '入座': 'Sit down',
    '坐到 1 号座位': 'Sit at seat 1',
    '坐到 {n} 号座位': 'Sit at seat {n}',
    '昵称（1–12 个字符）': 'Nickname (1–12 characters)',
    '例如：小明': 'e.g. Alex',
    '输入昵称（1-12 个字符）': 'Enter a nickname (1-12 characters)',
    '确认': 'Confirm',
    '确定': 'OK',
    '补充数量': 'Amount',
    '补充多少筹码？': 'How many chips to add?',
    '踢出玩家': 'Kick player',
    '确定把 {name} 请出牌桌吗？': 'Kick {name} from the table?',
    '退出牌桌': 'Leave the table',
    '确定退出、离开座位吗？如果牌局进行中会自动弃牌。': 'Leave your seat? If a hand is in progress you will fold automatically.',
    '所有人的筹码会回到起始值，当前牌局会被清空。确定吗？': "Everyone's chips go back to the starting stack and the current hand is wiped. Continue?",
    '连接已断开': 'Disconnected',
    '重新连接': 'Reconnect',
    '牌桌已在其他窗口打开': 'The table is open in another window',
    '你已离开牌桌': 'You have left the table',
    '连接断开，动作没有发出去': 'Disconnected, the action was not sent',
    '还没连上服务器，稍后再试': 'Not connected yet, try again shortly',
    '只有房主可以修改设置': 'Only the host can change settings',
    '设置不合法：大盲要大于小盲，时限至少 5 秒': 'Invalid settings: the big blind must exceed the small blind and the clock must be at least 5 seconds',
    '设置已提交': 'Settings submitted',
    '只有房主可以配置人机': 'Only the host can configure bots',
    '请先填 API Key': 'Enter an API key first',
    '人机后端已提交': 'Bot backend submitted',
    'Jev 已提交': 'Jev submitted',
    'Jev 已停用，动作交回大模型': 'Jev disabled, actions go back to the language model',
    '只有房主可以加人机': 'Only the host can add bots',

    // ---- 语音连麦 ----
    '浏览器不让用麦克风。请在地址栏左边的权限里允许麦克风，然后再试一次。': 'The browser blocked the microphone. Allow it in the site permissions next to the address bar and try again.',
    '没找到麦克风设备。': 'No microphone found.',
    '麦克风被别的程序占着，先关掉那个再来。': 'Another program is using the microphone. Close it and try again.',
    '打不开麦克风：{err}': 'Cannot open the microphone: {err}',
    '未知错误': 'unknown error',
    '麦克风断了，已经下麦': 'Microphone lost, you left voice',
    '这个浏览器不支持语音连麦': 'This browser does not support voice chat',
    '这台服务器没有开语音连麦': 'Voice chat is disabled on this server',
    '语音需要 HTTPS。用 https 的地址打开，或者在本机 localhost 上测试。': 'Voice needs HTTPS. Open the https address, or test on localhost.',
    '这个浏览器不支持麦克风': 'This browser does not support the microphone',
    '和{name}的语音没打通。两边网络之间需要 TURN 中转，详见 README。': 'Voice with {name} could not connect. The two networks need a TURN relay, see the README.',
    '对方': 'the other side',
    '静音': 'Mute',
    '取消静音': 'Unmute',
    '下麦': 'Leave voice',
    '上麦': 'Join voice',
    '🔈 点这里打开声音': '🔈 Click to enable sound',
    '连不通': 'failed',
    '断开中': 'disconnected',
    '已关闭': 'closed',
    '连接中': 'connecting',
    '观众': 'spectator',
    '（已静音）': ' (muted)',
    '{n} 号位': 'seat {n}',
    ' · 我': ' · me',
    '已屏蔽': 'blocked',
    '屏蔽': 'block',
    '只在你这边把这个人的声音关掉': 'Silence this person only on your side',
    '开麦中': 'Joining…',
    '已静音': 'Muted',
    '连麦中': 'On voice',
    '展开语音名单': 'Expand the voice list',
    '收起语音名单': 'Collapse the voice list',
    '正在上麦…': 'Joining voice…',
    '他们在语音里聊天，点「上麦」加进去。': 'They are talking on voice. Click "Join voice" to get in.',

    // ---- 服务端报错（原文由服务端下发，这里按原文查表）----
    '操作失败': 'Action failed',
    '你在另一个窗口打开了牌桌，这个窗口已断开': 'You opened the table in another window; this one has been disconnected',
    '还没有握手，请刷新页面': 'No handshake yet, please refresh the page',
    '座位号不合法': 'Invalid seat number',
    '昵称需要 1 到 12 个字符': 'The nickname must be 1 to 12 characters',
    '你已经在座位上了': 'You are already seated',
    '牌桌已坐满': 'The table is full',
    '该座位已被占用': 'That seat is taken',
    '你还没有入座': 'You are not seated',
    '只有房主可以这么做': 'Only the host can do that',
    '本手牌还没结束': 'The hand is not over yet',
    '牌局进行中不能改设置': 'Settings cannot be changed during a hand',
    '配置格式错误': 'Malformed settings',
    '小盲注不合法': 'Invalid small blind',
    '大盲注不合法': 'Invalid big blind',
    '前注不合法': 'Invalid ante',
    '起始筹码不合法': 'Invalid starting stack',
    '行动时限需要在 5 到 300 秒之间': 'The action clock must be between 5 and 300 seconds',
    '自动开局间隔需要在 1 到 60 秒之间': 'The auto-start delay must be between 1 and 60 seconds',
    '大盲注不能小于小盲注': 'The big blind cannot be smaller than the small blind',
    '补充数量不合法': 'Invalid chip amount',
    '该座位没有人': 'That seat is empty',
    '不能踢自己，请用离座': 'You cannot kick yourself; leave the seat instead',
    '你被房主请出了牌桌': 'The host removed you from the table',
    '现在不能亮牌': 'You cannot show cards now',
    '本服务没有启用人机': 'Bots are not enabled on this server',
    '没有可用的人机名字了': 'No bot names left',
    '不能发送空消息': 'Cannot send an empty message',
    '消息最长 200 字': 'Messages are limited to 200 characters',
    '至少需要 2 位有筹码的玩家': 'At least 2 players with chips are needed',
    '开局失败：': 'Failed to start: ',
    '现在没有进行中的牌局': 'No hand in progress',
    '还没轮到你': 'It is not your turn',
    '动作无法执行': 'That action is not possible',
    '信令的收件人不合法': 'Invalid signalling recipient',
    '不支持二进制消息': 'Binary messages are not supported',
    '操作太快了，请稍后再试': 'Too fast, try again in a moment',
    '消息太长': 'Message too long',
    '消息格式错误': 'Malformed message',
    '服务器无法处理这条消息': 'The server could not handle that message',
    '动作类型不合法': 'Invalid action type',
    '金额必须是非负整数': 'The amount must be a non-negative integer',
    '手牌编号不合法': 'Invalid hand number',
    'apiKey 必须是字符串': 'apiKey must be a string',
    'apiKey 过长': 'apiKey is too long',
    '聊天内容不合法': 'Invalid chat message',
    '未知的消息类型': 'Unknown message type',
    // 掼蛋 / 热词页面的报错也经过同一个入口；那两页本身还是中文，这里只是把表补全
    '出的牌不合法': 'Invalid play',
    '牌型声明不合法': 'Invalid combination claim',
    '局号不合法': 'Invalid deal number',
    '还贡的牌不合法': 'Invalid tribute return',
    '位子号不合法': 'Invalid seat number',
    '猜的词不合法': 'Invalid guess',
    '词太长了': 'Word too long',
    '设置格式不对': 'Malformed settings',
  };

  /** 服务端日志条目的 k → 英文模板（参数在 p 里；中文直接用 text）。 */
  var LOG_EN = {
    // 引擎事件（server/engine.js）
    ante: '{name} posts ante {amount}',
    sb: '{name} posts the small blind {amount}',
    bb: '{name} posts the big blind {amount}',
    deal: 'Hole cards dealt',
    return: '{name} takes back the uncalled {amount}',
    flop: 'Flop {cards}',
    turn: 'Turn {cards}',
    river: 'River {cards}',
    potMain: 'Main pot {amount}',
    potSide: 'Side pot {i} {amount}',
    showdown: '{name} shows {cards} ({handEn})',
    win: '{name} wins {amount}',
    winUncontested: '{name} wins {amount} (everyone else folded)',
    fold: '{name} folds',
    check: '{name} checks',
    call: '{name} calls {amount}',
    bet: '{name} bets {amount}',
    raise: '{name} raises to {amount}',
    allin: '{name} goes all-in for {amount}',
    // 房间（server/room.js）
    dropped: '{name} was away too long and left the seat',
    sit: '{name} sat down at seat {seat}',
    leave: '{name} left the table',
    host: '{name} is now the host',
    sitOut: '{name} is sitting out',
    back: '{name} is back in',
    config: 'Host updated the settings: blinds {sb}/{bb}, ante {ante}',
    topup: 'Host gave {name} {amount} chips',
    kicked: '{name} was removed by the host',
    show: '{name} shows {cards}',
    botRemoved: 'Host removed a bot backend',
    botConfigured: 'Host configured the bot backend: {desc}',
    botAdded: 'Host added bot "{name}" at seat {seat}',
    allLeft: 'All humans left; the bots were removed and the table cleared',
    reset: "Host reset the table; everyone's chips are back to the start",
    hand: '—— Hand {n} ——',
    idleOut: '{name} took no action for {n} hands and was sat out',
  };

  function readSaved() {
    try {
      var v = root.localStorage && root.localStorage.getItem(LS_KEY);
      return (v === 'zh' || v === 'en') ? v : null;
    } catch (e) { return null; }
  }

  /** 浏览器语言列表里有任何一种中文就是中文，一种都没有才是英文 */
  function detect() {
    var saved = readSaved();
    if (saved) return saved;
    var nav = root.navigator || {};
    var list = (nav.languages && nav.languages.length) ? nav.languages : [nav.language || ''];
    if (!list.length || !list[0]) return 'zh';
    for (var i = 0; i < list.length; i++) {
      if (String(list[i]).toLowerCase().indexOf('zh') === 0) return 'zh';
    }
    return 'en';
  }

  var lang = detect();

  function fill(tpl, p) {
    if (!p) return tpl;
    return String(tpl).replace(/\{(\w+)\}/g, function (m, k) {
      return (p[k] === undefined || p[k] === null) ? m : String(p[k]);
    });
  }

  /** 取文案：英文模式查词典，查不到（或中文模式）原样返回；参数两种模式都会填 */
  function t(zh, p) {
    var s = (lang === 'en' && Object.prototype.hasOwnProperty.call(EN, zh)) ? EN[zh] : zh;
    return fill(s, p);
  }

  /** 服务端日志条目 {text, k?, p?} → 显示文本 */
  function tlog(item) {
    if (!item) return '';
    if (lang === 'en' && item.k && Object.prototype.hasOwnProperty.call(LOG_EN, item.k)) {
      return fill(LOG_EN[item.k], item.p || {});
    }
    return String(item.text || '');
  }

  var ATTRS = ['title', 'aria-label', 'placeholder', 'data-key'];

  /** 把已解析的静态页面按词典换成英文。只在英文模式下做，且只做一次。 */
  function translateDom(doc) {
    if (lang !== 'en' || !doc || !doc.createTreeWalker) return;
    var walker = doc.createTreeWalker(doc.documentElement, 4 /* NodeFilter.SHOW_TEXT */);
    var nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var parent = n.parentNode;
      var tag = parent && parent.nodeName;
      if (tag === 'SCRIPT' || tag === 'STYLE') continue;
      var raw = n.nodeValue;
      var key = raw.replace(/\s+/g, ' ').trim();
      if (!key || !Object.prototype.hasOwnProperty.call(EN, key)) continue;
      // 保留原来的首尾空白，只换中间的文字
      var lead = raw.match(/^\s*/)[0];
      var tail = raw.match(/\s*$/)[0];
      n.nodeValue = lead + EN[key] + tail;
    }
    var all = doc.querySelectorAll ? doc.querySelectorAll('*') : [];
    for (var j = 0; j < all.length; j++) {
      var el = all[j];
      for (var a = 0; a < ATTRS.length; a++) {
        var v = el.getAttribute(ATTRS[a]);
        if (v && Object.prototype.hasOwnProperty.call(EN, v)) el.setAttribute(ATTRS[a], EN[v]);
      }
    }
  }

  function setLang(next) {
    if (next !== 'zh' && next !== 'en') return;
    try { root.localStorage.setItem(LS_KEY, next); } catch (e) { /* 隐私模式忽略 */ }
    if (root.location && root.location.reload) root.location.reload();
  }

  /** 顶栏的切换按钮：标签写的是「切过去会变成什么」 */
  function bindToggle(doc) {
    if (!doc || !doc.getElementById) return;
    var btn = doc.getElementById('btnLang');
    if (!btn) return;
    var lbl = btn.querySelector('.lbl');
    if (lbl) lbl.textContent = lang === 'en' ? '中文' : 'EN';
    btn.setAttribute('aria-label', lang === 'en' ? '切换到中文' : 'Switch to English');
    btn.title = btn.getAttribute('aria-label');
    btn.addEventListener('click', function () { setLang(lang === 'en' ? 'zh' : 'en'); });
  }

  if (typeof document !== 'undefined' && document) {
    if (document.documentElement) document.documentElement.setAttribute('lang', lang === 'en' ? 'en' : 'zh-CN');
    translateDom(document);
    bindToggle(document);
  }

  root.I18N = { lang: lang, t: t, tlog: tlog, setLang: setLang, EN: EN, LOG_EN: LOG_EN };
})(typeof window !== 'undefined' ? window : globalThis);
