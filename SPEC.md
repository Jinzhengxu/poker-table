# 德州扑克在线桌 — 实现契约 (SPEC)

> 这份文件是**所有模块的唯一真相来源**。任何实现都必须严格遵守此处定义的函数签名、
> 消息格式与状态结构。不要"改进"或重命名字段——前后端是分开实现的，字段名不一致会直接坏掉。

## 0. 产品定义

- 免登录。整个服务**只有一张桌子**（单房间，进程内内存状态，无数据库）。
- 8 个座位。玩家输入昵称即可入座，系统按昵称哈希分配默认头像。
- 页面是一张德州扑克桌：显示每个座位的筹码/头像/下注、桌面公共牌、底池、自己的两张手牌。
- 支持完整无限注德州扑克规则：盲注、按钮轮转、四条街下注、全下与边池、摊牌自动比大小、自动分配筹码。
- 界面语言：**简体中文**。必须在手机竖屏可用（朋友多半用手机打）。

## 1. 技术栈与项目结构

- 运行时：Node.js 22，**ESM**（`package.json` 里 `"type": "module"`）。
- 牌桌本身唯一运行时依赖：`ws`。前端**零构建**（纯 HTML/CSS/JS，无打包器、无 CDN 外链）。
- agent 版人机（`POKER_AGENT=on`，见 §8.5）另需 `ai` / `@ai-sdk/openai-compatible` / `zod`。
  这三个包是**可选的**：`server/index.js` 用动态 `import()` 引它们，装不上就自动退回
  单轮人机，牌桌照常跑。所以 `server/` 下除 `server/agent/` 外的任何文件都**不许**
  引入这三个包。
- 测试：Node 内置 `node --test`（`node:test` + `node:assert/strict`），零测试依赖。

```
poker/
├── package.json
├── SPEC.md                  <- 本文件
├── server/
│   ├── index.js             HTTP 静态服务 + WebSocket 入口
│   ├── protocol.js          常量（消息类型、阶段、座位状态、默认配置）
│   ├── deck.js              牌堆与洗牌
│   ├── evaluator.js         7 张牌取最优 5 张的牌力评估
│   ├── engine.js            单手牌状态机（下注轮、底池、摊牌）
│   ├── voice.js             语音连麦：频道成员表与信令中转（两张桌子各一个频道）
│   ├── room.js              房间：座位、令牌、断线重连、状态快照下发
│   └── agent/               agent 版人机（可选，见 §8.5）
│       ├── index.js         多轮工具调用的决策循环，外层包着 bot/ 那版当兜底
│       ├── tools.js         模型能调的四个工具
│       ├── memory.js        跨手牌的对手画像
│       └── model.js         把 bot/provider.js 的预设接到 AI SDK 上
├── public/
│   ├── index.html
│   ├── style.css
│   ├── voice.js             语音连麦前端（两个页面共用）
│   └── app.js
├── test/
│   ├── evaluator.test.js
│   ├── engine.test.js
│   └── agent.test.js
├── Dockerfile
├── docker-compose.yml
├── deploy/
│   ├── deploy.sh
│   └── caddy-site.txt
└── README.md
```

## 2. 牌的表示

一张牌是 2 字符字符串：`点数 + 花色`。

- 点数字符：`2 3 4 5 6 7 8 9 T J Q K A`（`T` = 10）
- 花色字符：`c`(♣梅花) `d`(♦方块) `h`(♥红桃) `s`(♠黑桃)
- 例：`"As"` = 黑桃 A，`"Th"` = 红桃 10。

隐藏的牌（别人的底牌）在下发给客户端时表示为字符串 `"??"`。

## 3. `server/deck.js`

```js
export function freshDeck(): string[]          // 52 张，顺序固定
export function shuffle(deck: string[]): string[]  // 原地 Fisher-Yates，使用 node:crypto 的
                                                   // randomInt 保证无偏；返回同一数组
```

## 4. `server/evaluator.js`

牌型类别常量（数字越大越强）：

| cat | 英文 | 中文名（`name` 字段用中文） |
|-----|------|------|
| 8 | straight flush | 同花顺（A 高时名为 `皇家同花顺`） |
| 7 | four of a kind | 四条 |
| 6 | full house | 葫芦 |
| 5 | flush | 同花 |
| 4 | straight | 顺子 |
| 3 | three of a kind | 三条 |
| 2 | two pair | 两对 |
| 1 | one pair | 一对 |
| 0 | high card | 高牌 |

```js
/**
 * @param cards 5..7 张牌
 * @returns {{cat:number, ranks:number[], best:string[], name:string, score:number}}
 *   ranks: 用于同类别内比大小的点数数组，按比较优先级从高到低排列，元素取值 2..14。
 *          长度固定为 5，不足处补 0。约定：
 *            高牌/同花 -> 5 张牌点数降序
 *            一对      -> [对子点, 踢脚1, 踢脚2, 踢脚3, 0]
 *            两对      -> [大对点, 小对点, 踢脚, 0, 0]
 *            三条      -> [三条点, 踢脚1, 踢脚2, 0, 0]
 *            顺子/同花顺-> [最大点, 0,0,0,0]；A-2-3-4-5 的最大点算作 5
 *            葫芦      -> [三条点, 对子点, 0,0,0]
 *            四条      -> [四条点, 踢脚, 0,0,0]
 *   best: 组成该牌型的 5 张牌（原始字符串），顺序不影响相等性判断
 *   score: cat * 15^5 + ranks[0]*15^4 + ranks[1]*15^3 + ... 的整数，越大越强，
 *          两手牌 score 相等 <=> 牌力完全相同（可平分底池）
 */
export function evaluate(cards)

export function compareHands(a, b): number   // a,b 是 evaluate 的返回值；a>b 返回 1，相等 0，a<b 返回 -1
export function rankValue(ch: string): number // '2'->2 ... 'T'->10 'J'->11 'Q'->12 'K'->13 'A'->14
```

实现方式：7 张时枚举 C(7,5)=21 种组合，逐个按 5 张牌评估取最大。**正确性优先于性能**。

## 5. `server/protocol.js`

导出常量（供服务端各模块与测试使用）：

```js
export const PHASES = { WAITING:'waiting', PREFLOP:'preflop', FLOP:'flop', TURN:'turn',
                        RIVER:'river', SHOWDOWN:'showdown', HAND_OVER:'handOver' }
export const SEAT_STATE = { EMPTY:'empty', SITTING:'sitting', IN:'in', FOLDED:'folded',
                            ALLIN:'allin', SITTING_OUT:'sittingOut' }
export const DEFAULT_CONFIG = {
  smallBlind: 5, bigBlind: 10, ante: 0, startingStack: 1000,
  actionTimeoutMs: 45000, autoNextHand: true, autoNextHandMs: 6000
}
export const MAX_SEATS = 8
```

### 5.1 `server/config.js` — 环境变量覆盖初始配置

`DEFAULT_CONFIG` 是**代码默认值**，不随环境变化。运行时的初始配置由
`configFromEnv(env)` 算出，层次是：

```
DEFAULT_CONFIG  ->  环境变量  ->  房主在设置页改（内存态，重启后丢）
```

| 环境变量 | 对应字段 | 单位 |
|---|---|---|
| `POKER_BLINDS`（简写，如 `100/200`） | `smallBlind` + `bigBlind` | — |
| `POKER_SMALL_BLIND` / `POKER_BIG_BLIND` | 同上，**优先级高于简写** | — |
| `POKER_ANTE` | `ante` | — |
| `POKER_STARTING_STACK` | `startingStack` | — |
| `POKER_ACTION_TIMEOUT` | `actionTimeoutMs` | **秒** |
| `POKER_NEXT_HAND_DELAY` | `autoNextHandMs` | **秒** |
| `POKER_AUTO_NEXT_HAND` | `autoNextHand` | `true/false/1/0/yes/no/on/off` |

两条硬要求：

1. **校验范围必须与 `room.js` 的 `setConfig` 完全一致。** 否则环境变量能设出一个
   UI 会拒绝的值，房主一打开设置页保存就被打回。测试里有一条专门验这个：
   把环境变量算出的配置原样提交给 `setConfig`，必须被接受。
2. **非法值报错并回退，不静默接受。** 小数不取整、越界不夹取、布尔值写错就报错，
   并在日志里写出合法范围。启动时还会打印一行实际生效的配置。
   大盲小于小盲时**整体回退盲注**（只报错留着的话，设置页一保存就会被拒）。

空串视为没设置——`docker-compose.yml` 里未填的变量会透传成空串。

## 6. `server/engine.js` — 单手牌状态机

引擎只负责**一手牌**，不关心 WebSocket、不关心计时器、不关心持久玩家。

```js
export class Hand {
  /**
   * @param opts.players  数组，元素为参与本手牌的玩家：
   *        { seat:number, name:string, chips:number }
   *        （筹码为 0 的玩家不应传进来；调用方负责过滤）
   * @param opts.config   { smallBlind, bigBlind, ante }
   * @param opts.buttonSeat number  按钮所在座位号（必须是 players 中某个 seat）
   * @param opts.deck     可选，注入的已洗好牌堆（测试用）。不传则内部 freshDeck+shuffle
   * @param opts.handNo   可选，手牌编号
   */
  constructor(opts)

  get phase()        // PHASES 之一
  get isComplete()   // 本手牌是否已结束
  get actingSeat()   // number | null，当前该谁行动
  get board()        // string[]  0/3/4/5 张
  get handNo()

  /** 本手牌内每个座位的运行时数据（只读用途）
   *  Map<seat, {seat, name, chips, holeCards:string[2], folded:boolean, allIn:boolean,
   *             committedRound:number, committedTotal:number, hasActed:boolean,
   *             lastAction:{type,amount}|null }>  */
  get players()

  /** 当前底池结构：[{amount:number, eligibleSeats:number[]}]，主池在前 */
  get pots()
  get totalPot()      // 所有 pots 之和 + 本轮已投入但尚未归池的筹码
  get currentBet()    // 本轮最高的 committedRound
  get minRaiseTo()    // 合法的最小"加注到"金额

  /**
   * @returns null（该座位现在不能行动）或
   *  { canFold:boolean, canCheck:boolean, canCall:boolean, callAmount:number,
   *    canBet:boolean, minBet:number,
   *    canRaise:boolean, minRaiseTo:number, maxRaiseTo:number,
   *    isAllInCall:boolean }
   *  说明：
   *   - callAmount 是"还需再投入"的增量（不是总额），若筹码不足则等于剩余筹码（isAllInCall=true）
   *   - minRaiseTo / maxRaiseTo / minBet 都是**本轮总投入额**（raise TO 语义），不是增量
   *   - 若剩余筹码不足以完成最小加注，canRaise 为 false，玩家只能 call 或 allin
   */
  legalActions(seat)

  /**
   * 执行一个动作。
   * @param seat number
   * @param action { type:'fold'|'check'|'call'|'bet'|'raise'|'allin', amount?:number }
   *        amount 对 bet/raise 是"本轮总投入额"(TO 语义)；fold/check/call/allin 忽略 amount
   * @returns { ok:true, events:Event[] } | { ok:false, error:string }
   *          非法动作**不改变任何状态**，返回 ok:false 与中文错误信息
   */
  act(seat, action)

  /** 超时自动动作：能过牌就过牌，否则弃牌。返回同 act */
  timeoutAction(seat)

  /** 座位在牌局中途断线/离桌时调用，等价于自动弃牌（若还在牌里） */
  forceFold(seat)

  /** 本手牌结束后的结算结果，未结束时为 null
   * {
   *   payouts: { [seat:number]: number },       // 每个座位从底池赢回的总额（含退还的未被跟注部分）
   *   chipsAfter: { [seat:number]: number },    // 本手牌结束后该座位的筹码
   *   winners: [{ seat, amount, potIndex, handName:string|null, best:string[]|null }],
   *   showdown: [{ seat, cards:string[2], handName:string, best:string[], score:number }],
   *                // 仅在真正摊牌时非空；所有人弃牌只剩一人时为空数组
   *   uncalledReturned: { seat:number, amount:number } | null,
   *   wentToShowdown: boolean
   * }
   */
  get result()

  /** 追加式事件日志（见 §6.2） */
  get events()
}
```

### 6.1 必须实现的规则细节

1. **盲注与位置**
   - 3 人及以上：按钮左手第一个玩家下小盲，第二个下大盲；翻牌前从大盲左手第一个开始行动；
     翻牌后从按钮左手第一个还在牌里的玩家开始行动。
   - **单挑（2 人）**：按钮**即是小盲**；翻牌前**按钮先行动**，翻牌后**大盲先行动**。
   - 盲注不足以支付时全下（`allIn = true`），不视为加注。
   - `ante` 为 0 时不收前注；非 0 时每人先收 ante（不足则全下），ante 直接入池。
2. **下注轮结束条件**：所有未弃牌且未全下的玩家都已行动过（`hasActed`）且
   `committedRound` 都等于 `currentBet`。翻牌前大盲有**选择权**（option）：若无人加注，
   轮到大盲时他仍可 check 或 raise，不能因为"已投入等于 currentBet"就直接结束。
3. **最小加注 / 重开下注权**：
   - 初始 `minRaiseTo = bigBlind * 2`（翻牌前），翻牌后首次下注 `minBet = bigBlind`，
     下注后 `minRaiseTo = currentBet + lastRaiseSize`。
   - 全下金额**不足一次完整加注**时，**不重开**已行动玩家的加注权：这些玩家再次轮到时
     只能 fold / call / (若之前未被加注则 check)，`canRaise` 必须为 false。
     尚未行动过的玩家不受影响。
4. **边池**：按每个玩家本手牌的 `committedTotal` 分层生成。每一层的 `eligibleSeats`
   是"投入达到该层且未弃牌"的座位。弃牌玩家的筹码仍留在池里但不参与分配。
   只有一个 eligibleSeat 的顶层视为**未被跟注的下注**，原样退还给该玩家并记入
   `uncalledReturned`（不计入 `payouts` 的赢取部分统计，但要计入 `chipsAfter`）。
5. **摊牌**：只剩一人时不摊牌、不揭示底牌，直接收池。多人时对每个 pot 用 `evaluate`
   在 `eligibleSeats` 中取最强；平分时**筹码零头从按钮左手第一位开始依次多分 1 枚**。
6. **筹码守恒**：任何一手牌结束后，
   `sum(chipsAfter) === sum(入局前 chips)`。这是硬性不变量，测试必须覆盖。

### 6.2 事件（`events`）

事件用于前端日志与动画，结构：`{ kind, seat?, amount?, text }`，`text` 是可直接展示的中文。
必须产生的 kind：`blind` `ante` `deal` `action` `flop` `turn` `river` `showdown` `pot` `win` `return`。

示例：`{kind:'action', seat:3, amount:80, type:'raise', text:'小明 加注到 80'}`

`action` 事件额外带 `type` 字段（`fold`/`check`/`call`/`bet`/`raise`/`allin`）。
前端只用 `text`；人机需要结构化的行动历史，从中文 `text` 反解太脆。

中文动作用词：弃牌 / 过牌 / 跟注 {n} / 下注 {n} / 加注到 {n} / 全下 {n}。

## 7. `server/room.js` — 房间

持久玩家记录（跨手牌存在）：

```js
{ id:'p_xxxx', token:'32位hex', seat:number, name:string, avatar:Avatar,
  chips:number, connected:boolean, sittingOut:boolean, isHost:boolean }
```

- `token` 由 `crypto.randomBytes(16).toString('hex')` 生成，客户端存在 `localStorage`，
  用于**断线重连回到原座位**。服务端维护 `token -> player` 映射。
- 第一个入座的玩家是 **房主 (host)**；房主离开时自动转给座位号最小的在座玩家。
- 断线的玩家保留座位与筹码；若在牌局中，行动超时按自动动作处理（能过牌就过牌，否则弃牌）。
- 手牌结束后若 `autoNextHand` 为真且**有筹码的在座玩家 ≥ 2**，`autoNextHandMs` 后自动开下一手。
- 按钮每手牌向左移动到下一个"有筹码且未坐出"的座位。
- 手牌进行中入座的玩家状态为 `sitting`，下一手才参与。
- **座位上一个真人都不剩时，桌上的人机全部自动离座，牌桌（牌局 / 日志 / 聊天）清空。**
  判据是座位，不是连接：掉线的人在保护期内还占着座位，人机会等他；保护期到点后
  自动离座会再次触发清场。见 §8.4.5。

头像 `Avatar`（由昵称确定性生成，前端据此渲染，无需图片文件）：

```js
{ bg:'#hex', fg:'#hex', glyph:'单个字符（昵称首个字符）', shape:0|1|2|3 }
```

## 8. WebSocket 协议

单一端点：`GET /ws`（同端口）。所有消息是 JSON 文本，均带 `t` 字段。

### 8.1 客户端 → 服务端

```jsonc
{"t":"hello","token":"<之前的token或null>"}
{"t":"sit","seat":3,"name":"小明"}          // seat 为 0..7；name 1..12 字符
{"t":"stand"}                                // 站起离座（牌局中则先自动弃牌）
{"t":"start"}                                // 房主手动开始下一手
{"t":"action","handNo":12,"type":"fold"|"check"|"call"|"bet"|"raise"|"allin","amount":80}
{"t":"sitOut","value":true}                  // 坐出/回座
{"t":"config","patch":{"smallBlind":10,"bigBlind":20,"startingStack":2000,
                       "actionTimeoutMs":45000,"autoNextHand":true,"ante":0}}  // 仅房主，仅两手牌之间
{"t":"addChips","seat":3,"amount":1000}      // 仅房主：给某座位补充筹码
{"t":"kick","seat":3}                        // 仅房主，人机也用它移除
{"t":"addBot","seat":3}                      // 仅房主：加一个人机。seat 可省略 = 挑第一个空位
{"t":"botConfig","patch":{"provider":"deepseek","apiKey":"sk-...","model":"..."}}
                                             // 仅房主：配置人机的 LLM 后端。
                                             // apiKey 留空 = 沿用已有 key（只改模型）。
                                             // patch.remove=true 表示移除该供应商。
{"t":"showCards"}                            // 不摊牌获胜时，主动把底牌亮给全桌
{"t":"reset"}                                // 仅房主：清空牌桌，所有人筹码回到 startingStack
{"t":"chat","text":"..."}                    // 最长 200 字符
{"t":"ping"}
{"t":"voiceJoin"} / {"t":"voiceLeave"} / {"t":"voiceMute"} / {"t":"voiceSignal"}  // 语音连麦，见 §13
```

`action` 消息里的 `handNo` 用于丢弃过期点击：与当前手牌号不符时服务端静默忽略。

### 8.2 服务端 → 客户端

```jsonc
{"t":"welcome","playerId":"p_ab12","token":"<hex>","seat":3|null}
{"t":"state", ...}          // 见 §8.3，任何状态变化后全量下发（状态很小，不做增量）
{"t":"error","code":"SEAT_TAKEN","msg":"该座位已被占用"}
{"t":"event","kind":"...","seat":3,"amount":80,"text":"小明 加注到 80"}  // 建议性，用于音效/动画
{"t":"pong"}
{"t":"voiceReady", ...} / {"t":"voiceSignal", ...}   // 语音连麦，见 §13
```

错误码：`SEAT_TAKEN` `NAME_INVALID` `NOT_HOST` `NOT_YOUR_TURN` `ILLEGAL_ACTION`
`TABLE_FULL` `NOT_SEATED` `HAND_IN_PROGRESS` `NOT_ENOUGH_PLAYERS` `RATE_LIMIT`
`VOICE_OFF` `VOICE_FULL`。

### 8.3 状态快照（**前后端共同契约，字段名不得更改**）

每个客户端收到的快照都经过**脱敏**：除自己以外的底牌一律是 `["??","??"]`，
只有摊牌被揭示的牌才是真实值。

```jsonc
{
  "t": "state",
  "serverNow": 1734000000000,
  "config": { "smallBlind":5, "bigBlind":10, "ante":0, "startingStack":1000,
              "actionTimeoutMs":45000, "autoNextHand":true, "autoNextHandMs":6000 },
  "table": {
    "phase": "waiting",
    "handNo": 12,
    "buttonSeat": 0,
    "board": ["Ah","Kd","7c"],
    "pots": [{"amount":300,"eligibleSeats":[0,2,5]}],
    "totalPot": 300,
    "currentBet": 40,
    "minRaiseTo": 80,
    "actingSeat": 2,
    "actionDeadline": 1734000045000,
    "nextHandAt": null,
    "canStart": false,
    "seatedCount": 4,
    "history": [
      {"street":"preflop","acts":[{"seat":5,"type":"raise","amount":40},
                                  {"seat":0,"type":"call","amount":30}]},
      {"street":"flop","acts":[{"seat":0,"type":"check","amount":0}]}
    ]
  },
  "seats": [
    null,
    { "seat":1, "name":"小明",
      "avatar":{"bg":"#c2410c","fg":"#ffffff","glyph":"小","shape":2},
      "chips":960, "committedRound":40, "committedTotal":60,
      "state":"in", "connected":true, "isHost":true, "bot":false, "sittingOut":false,
      "isButton":false, "isSB":true, "isBB":false,
      "cards":["??","??"],
      "lastAction":{"type":"raise","amount":80,"label":"加注到 80"},
      "wonThisHand":0, "isWinner":false, "handName":null }
  ],
  "bot": { "hasLLM":true,
           "providers":[{"provider":"deepseek","label":"DeepSeek","model":"deepseek-chat",
                         "maskedKey":"sk-…9876","cooling":false}] },
  "you": {
    "playerId":"p_ab12", "seat":1, "isHost":true, "sittingOut":false,
    "canShowCards":false,
    "cards":["Ah","Kd"],
    "legal": { "canFold":true,"canCheck":false,"canCall":true,"callAmount":30,
               "canBet":false,"minBet":10,
               "canRaise":true,"minRaiseTo":80,"maxRaiseTo":960,"isAllInCall":false }
  },
  "result": null,
  "log": [{"ts":1734000000000,"text":"小明 加注到 80"}],
  "chat": [{"ts":1734000000000,"seat":1,"name":"小明","text":"gg"}]
}
```

- `seats` 数组**长度恒为 8**，空位为 `null`。
- `you.seat` 为 `null` 表示观战中（未入座）。
- `you.legal` 仅在轮到自己时非 `null`。
- `result` 在 `phase === 'handOver'` 时非 `null`，结构见 §6 的 `Hand.result`，
  外加每个 winner 的 `name` 字段方便前端直接展示。
- `log` 保留最近 40 条，`chat` 保留最近 50 条。
- `table.history` 是本手牌的行动序列，按街道分段，每条只有 `seat`/`type`/`amount`。
  **不含任何牌面**，所以给谁看都安全。金额语义沿用引擎约定：
  `bet`/`raise`/`allin` 是本轮总投入额，`call` 是增量——渲染给人看之前要换算，
  否则"小盲跟注 500、大盲跟注 400"会被误读成后者投得更少（两人其实都跟到了 600）。
- `bot` 是人机后端状态，**永远不含真实 apiKey**；打码后的 `maskedKey` 只发给房主，
  其他人只有 `hasLLM` 与供应商/模型名。见 §8.4.3。
- `voice` 是语音连麦的麦上名单，见 §13.2。两张桌子的名单各存各的。

## 8.4 人机（`server/bot/`）

人机是**没有 WebSocket 连接的普通玩家**：在 `room.players` 里有记录、占座位、有筹码，
`connected` 恒为 `true`，`token` 为 `null`（没人需要用它重连）。

模块划分：

| 文件 | 职责 |
|---|---|
| `bot/provider.js` | Kimi / DeepSeek 的 HTTP 客户端。两家都是 OpenAI 兼容的 `/chat/completions`，只有一个实现 |
| `bot/persona.js` | 人格：从 5 个正交维度随机组合生成（范围/攻击性/诈唬/抗压/话风）|
| `bot/equity.js` | 蒙特卡洛胜率估算，带墙钟预算 |
| `bot/fastscore.js` | 只给胜率用的快速 7 张牌打分。**打分公式与 `evaluator.js` 完全一致** |
| `bot/policy.js` | 规则策略。不联网，Chen formula + 牌型类别 + 底池赔率，阈值按人格特质偏移 |
| `bot/decide.js` | 快照 → 提示词，模型输出 → 合法动作 |
| `bot/index.js` | `BotDriver`：调用、失败退避、兜底、统计 |

### 8.4.1 三条不可协商的约束

1. **只能读 `buildStateFor(botPlayerId)` 的输出。**
   绝对不能直接读 `room.hand` 或别人的 `holeCards`。那份快照里别人的底牌已经是 `"??"`，
   这一条同时保证了人机不作弊、以及别人的底牌不会被发到外部 API。

2. **聊天记录不进提示词。**
   玩家能往聊天框打任意文本，进了提示词就是提示注入。昵称会进提示词，
   但必须先过 `sanitizeName()`（去掉换行与花括号，截到 12 字）。

3. **模型输出一律不可信。**
   `coerceAction()` 是最后一道关：动作必须在 `legalActions()` 允许的集合里，
   `bet`/`raise` 的金额必须夹进 `[minBet|minRaiseTo, maxRaiseTo]`。
   任何无法修正的输出都退回规则策略。

以上三条各有对应的测试（`test/bot.test.js` 的「安全」小节），改动时不要绕过。

### 8.4.1a 人格

每个人机在 `addBot` 时抽一次人格，之后整个生命周期不变（打法保持一致）。
人格来自 5 个正交维度的加权随机组合（`persona.js`），共 3^5 = 243 种：

| 维度 | 取值 | 权重 |
|---|---|---|
| `range` 入池范围 | tight / medium / loose | 3 / 4 / 3 |
| `aggression` 攻击性 | passive / balanced / aggro | 3 / 4 / 3 |
| `bluff` 诈唬频率 | never / sometimes / often | 3 / 4 / 3 |
| `pressure` 抗压 | folds / calls / fights | 3 / 4 / 3 |
| `talk` 话风 | quiet / normal / chatty | 4 / 3 / 3 |

中间派权重更高，免得一桌全是极端风格。随机源是 `node:crypto` 的 `randomInt`（无偏）。

**特质是结构化的，不只是提示词文本**：`style` 字符串进提示词给 LLM 演，
`traits` 同时被 `policy.js` 的 `traitBias()` 读取，用来偏移规则兜底的
加注门槛 / 跟注门槛 / 下注尺度。这样 API 挂掉退回规则时，"松凶"的人机
不会突然打得像块石头。

名字从 20 个的池子里随机取，避开桌上已有的名字（真人的也算）。

### 8.4.1b 提示词包含什么

`buildSystem(persona)` 是稳定的（同一人机每次相同，便于命中前缀缓存），
`buildUser(state)` 每次决策重新生成，内容全部来自脱敏快照：

| 段落 | 来源 | 说明 |
|---|---|---|
| 阶段 / 盲注 / 人数 | `table`、`config` | 房主改了盲注会立刻反映 |
| 你的位置 | `positionName()` 从 `buttonSeat` 推导 | 枪口位/劫位/关煞位/按钮/小盲/大盲；单挑时按钮即小盲 |
| 公共牌 / 自己底牌 | `table.board`、`you.cards` | 别人的底牌是 `??`，不会出现 |
| 其他人 | `seats` | 位置、筹码、本轮投入、是否弃牌/全下 |
| 本手行动序列 | `table.history` | 按街道分段，`call` 已换算成"跟注到 N" |
| 可选动作 | `you.legal` | **只列当前合法的**，并写明金额区间 |
| 底池赔率 | 代码算 | `callAmount / (totalPot + callAmount)`，模型算数不可靠 |
| 真实胜率 | `equity.js` 蒙特卡洛 | 含误差、对手数、模拟次数，**以及建模假设的免责说明** |

不包含：别人的底牌、聊天记录、其他手牌的历史、任何 API key。

### 8.4.1c 胜率估算（`bot/equity.js`）

蒙特卡洛：按剩余牌堆随机发对手底牌和缺失的公共牌，比大小统计。

- **对手数按当前还在牌里的人算**（`in` + `allin`，不含弃牌的）。对 1 个人和对 4 个人
  的胜率差很多，这个不能省。
- **平分底池按份数折算**：和 M 家打平就算 `1/(M+1)` 份胜率。底牌毫无贡献时
  （最好五张就是公共牌）胜率来自打平而不是 0，测试有覆盖。
- **计算是分片的**（`estimateEquityAsync`）。Node 单线程，一次跑完意味着
  **全桌冻结**那么久。所以跑一小片就 `setImmediate` 让出事件循环。
  于是有两个性质不同的预算：

  | 参数 | 默认 | 性质 |
  |---|---|---|
  | `POKER_BOT_EQUITY_CHUNK_MS` | 8 | 单片占用事件循环的时间。**必须小**——这段时间全桌被冻结 |
  | `POKER_BOT_EQUITY_MS` | 1500 | 总墙钟上限。**可以大方给**——行动时限 45 秒，人机本来还要等 LLM |
  | `POKER_BOT_EQUITY_SIMS` | 20000 | 模拟次数，约 ±0.5% 误差。设 0 关闭 |

  实测 20000 次：同步版事件循环卡顿 91ms，分片版 15ms，墙钟时间反而略短。
  精度因此不必和流畅度取舍，慢机器只是算得久一点而不是被迫降精度。
  仍会在总预算到点或收到 `AbortSignal`（手牌提前结束）时截断，并置
  `truncated`、放大 `margin`。
- **建模假设必须写进提示词**：对手按随机两张牌估算，所以这个数**系统性偏乐观**
  （真实对手有范围，跟到后面街的人不拿垃圾牌）。不写出来模型会过度信任它。

`fastscore.js` 是为这里存在的：`evaluator.js` 枚举 C(7,5)=21 种组合、每次构造
三个对象，蒙特卡洛一次决策要调几千次，那些分配全是浪费。快速版直接从牌型结构
算，实测快 11~40 倍。

**正确性归 `evaluator.js`**（SPEC §4 的真相来源）。`fastscore.js` 用**相同的打分
公式**，所以两者 score 可以逐位比较，测试里有 6 万手随机牌（5/6/7 张）的
交叉验证断言完全相等。任何分歧都算 `fastscore.js` 的 bug。

**这不是 solver。** GTO 要对整棵牌树求近似纳什均衡，翻牌后的解是 TB 级数据、
且以「走到该节点的双方范围」为条件——200MB 容器里放不下也算不了。
翻牌前的范围表确实可以表格化，但那是另一件事，本项目没做。

### 8.4.2 失败行为

`BotDriver#decide()` **不抛异常**，且保证在超时时间内返回。任何失败（超时、限流、
5xx、输出无法解析）都退回 `policy.js` 的规则策略，牌桌照常进行，只是人机变笨。
同一供应商连续失败 3 次进入 60 秒冷却。一个 key 都没配时人机全程走规则策略。

行动超时计时器对人机照常生效：人机卡住时会和真人一样被超时逻辑接管
（能过牌就过牌，否则弃牌），不需要额外的保险机制。

### 8.4.3 运行时配置 API key

房主可以在前端直接填 key（`{"t":"botConfig"}`），服务端交给
`BotDriver#configure()` 存在**进程内存**里。**必须遵守**：

- `apiKey` 只存在内存，不写 `room.config`、不写日志、不落盘；重启即失效。
- 快照里只有 `botDriver.status()` 的脱敏结果。打码后的 `maskedKey`（头 3 尾 4）
  **只发给房主**，其他人只能看到 `hasLLM` 与供应商/模型名。
  快照是广播给全桌的，key 漏进去等于发给所有人。
- 前端不能自己调 LLM：人机要拿自己的底牌才能决策，浏览器驱动人机就等于
  把人机底牌交给某个玩家。决策必须留在服务端。

对应测试见 `test/bot.test.js` 的「前端配置 LLM 后端」小节。

### 8.4.4 幂等触发

`#maybeTriggerBot()` 在每次 `#resetActionTimer()` 时调用。用
`${handNo}:${seat}:${events.length}` 作为决策键——同一座位在同一手牌里多次行动会得到
不同的键，而重复的 `#pump()` 不会重复触发。决策落地前要重新校验局面
（手牌还在、还轮到它、座位没换人）。

### 8.4.5 只剩人机时自动清场

`#sweepBotsIfEmpty()` 在**每次有人离座之后**（`#vacate()` 的末尾）跑一次：如果座位上
一个真人都不剩，就把所有人机请下桌（连 `room.players` 里的记录一起删掉——人机没有
token，离座后没有任何东西再引用它），然后清空牌局状态、日志与聊天。

不这么做的话，最后一个真人一走，剩下的人机会永远占着座位：人机不会自己站起来，
也当不了房主（§7），于是没有任何人有权限踢它们，下一个打开网页的人看到的是一桌
不认识的机器人和别人的日志。

- 判据是**座位上有没有真人**，与连接无关。掉线的真人在 `DISCONNECT_GRACE_MS`
  内还占着座位，不清场；到点后 `#dropDisconnected()` → `#vacate()` 会再触发一次。
- 纯观战（连着但没入座）不算人在桌上。
- 牌局进行中触发也安全：每个人机离座时照常自动弃牌，本手牌先收掉，再清状态。
- 清场自身会调 `#vacate()`，靠 `#sweepingBots` 标志防止递归。

这条与 `#hasAudience()`（一个连接都没有时不自动开新手牌，等有人 `hello` 再恢复）
是两件事：那个管**暂停**——真人掉线期间人机不会自己接着打、白烧 API；
这个管**回收**——真人不打算回来了，桌子还给下一个人。

## 8.5 agent 版人机（`server/agent/`）

**默认关闭**，`POKER_AGENT=on` 才启用。它不是 §8.4 的替代品，而是**套在外面的一层**：

```
PokerAgent.decide()
  ├─ 走通了 → agent 的动作（仍然过 coerceAction 夹一道）
  └─ 任何失败 → BotDriver.decide()（单轮 LLM → 规则策略 → 一定合法）
```

所以 §8.4.1 那三条约束在这里**一条不减**，而且外部服务全挂时的行为和以前完全一样。

### 8.5.1 它解决的是哪个问题

单轮版里，胜率是我们在调模型之前算好塞进提示词的，假设固定为「对手拿随机两张牌」。
这个假设系统性偏乐观——真实对手是有范围的，跟到后面街的人通常不拿垃圾牌。
模型读到的是一个偏高的数，而且没有任何办法质疑它。

agent 版把胜率变成一个**工具**，范围由模型自己给：

| | AKo 翻牌前对 1 个对手 |
|---|---|
| 对手随机两张牌 | 约 66% |
| 对手只玩前 15% | 约 59% |
| 对手只玩前 5% | 约 47% |

同一手牌，同一个底池赔率，结论可以从「该跟」翻成「该弃」。这个差额就是这一层的全部价值。
（AA 是反例：三种假设下都是 83% 上下，因为它本来就领先一切——这也正确。）

### 8.5.2 四个工具

| 工具 | 有 execute | 作用 |
|---|---|---|
| `estimate_equity` | 是 | 按模型给的 `opponent_range`（0~1）算蒙特卡洛胜率，顺带回一个「跟注需要多少胜率才划算」|
| `read_opponents` | 是 | 还在牌里的对手的跨手牌画像：VPIP / PFR / 激进度 / 面对下注的弃牌率 / 最近摊牌，**外加按位置拆开的翻牌前统计和他这手牌所在的位置档** |
| `plan_bet` | 是 | 一个下注/加注尺度划不划算：需要他弃多少牌、他实际会弃多少、这个尺度值多少筹码 |
| `act` | **否** | 循环的唯一出口。它不执行任何东西，模型一调它 `stopWhen` 就停 |

底池赔率、位置、行动序列仍然直接写在提示词里——那是纯算术和纯事实，让模型花一轮
工具调用去取它只会增加延迟和出错面。

**`plan_bet` 补的是哪一课。** 前三个工具里只有 `estimate_equity` 出数，而它出的
全是**跟注**的数（胜率、跟注需要多少胜率）。扑克有一半的钱来自开火，那一边原来
一个数都没有，下注尺度只能靠模型的感觉。公式是底池赔率的镜像：

    需要的弃牌率 = 亏损 / (底池 + 亏损)     亏损 = 被跟时投入 − 胜率 × 被跟后的底池

「亏损」里扣掉的那部分就是「半诈唬」这个词的全部内容：100 的池下 100，纯诈唬要
50% 的弃牌率，手里多一个值 30% 胜率的听牌就只要 9%。

两条建模假设，写在工具描述里让模型知道：

1. **基线是「不下注就拿 0」。** 于是牌很强时 `needs_fold_pct` 恒为 0（被跟也不亏），
   那句话对，但答不了「该下多大」。所以还回一个 `ev_chips` 用来横向比尺度——
   同样只能比尺度，不能和过牌比，因为过牌也能赢钱，那部分不在这个模型里。
2. **底池按「只有一个人跟」推，胜率也就按 1 个对手算。** 两边必须同一个假设，
   否则数字自己打自己。多人底池里这偏乐观，结果里附一句提醒。

用工具而不是 structured output 收尾，是因为 OpenAI 兼容的第三方接口对「工具 +
结构化输出并用」的支持参差不齐，而工具调用是它们都稳的那条路。

### 8.5.2b 范围是按什么排序的

排序键是两段的：**先按可玩性档位，档内再按真实胜率**。

| 数据文件 | 内容 | 生成脚本 |
| --- | --- | --- |
| `bot/data/preflop.js` | 169 个起手牌对 1 个随机对手的胜率 | `scripts/build-preflop-equity.mjs` |
| `bot/data/ranges.js` | 169 个起手牌的可玩性档位（0~11） | `scripts/build-preflop-ranges.mjs` |

**两张表都是提交进仓库的数据，改它们必须重跑对应的生成脚本。** 两个脚本都自带
自检，不过关就拒绝写文件：胜率表和公开标准值偏差超过 1 个百分点即失败；
档位表要求 169 项齐全、档位边界单调、且常识锚点成立（76s 必须排在 K9o 前面）。

#### 为什么不能只按胜率排

胜率答的是「这手牌有多强」，`opponentRange` 问的是「对手会玩哪些牌」。
这是两个维度。拿真实开池范围和「按胜率取前 X%」对齐组合数后比较：

| 位置 | 范围宽度 | 与胜率排序的重合度 |
| --- | ---: | ---: |
| UTG | 14.2% | 80.9% |
| CO | 26.7% | **75.1%** |
| BTN | 43.6% | 83.7% |

而且错得很整齐：胜率排序多收的全是 offsuit 高牌（A9o A8o A7o K9o A5o），
漏掉的全是同花连张和小对子（76s 65s 54s 98s T9s 22 33）。76s 的胜率排第
116/169，可每一张 CO 开池表里都有它；K9o 排第 40，没人拿它在 CO 开池。
同花连张能做成顺子同花、翻后好打，这部分价值胜率完全没测。

#### 档位怎么来的

真实范围表是**集合**不是序。把集合变成序靠嵌套：一手牌能在多紧的局面里出现，
就说明它有多「能玩」。从最紧到最松排成一条梯子，每档取到该档为止的并集，
一手牌归到它第一次出现的那档。

| 档 | 累计 | 来源 |
| ---: | ---: | --- |
| 0 | 1.2% | 面对 UTG 的 4bet 还全下（只有 AA / AKs / KK） |
| 1 | 2.6% | UTG 面对 3bet 的 5bet 价值范围 |
| 3 | 7.1% | UTG 面对 3bet 的全部继续范围 |
| 5 | 14.5% | UTG 开池 |
| 7 | 26.7% | CO 开池 |
| 8 | 44.2% | BTN / SB 开池 |
| 10 | 65.0% | BB 防守 SB 开池 |
| 11 | 100% | 没人玩的那 35%，按胜率排 |

这条梯子几乎完美嵌套：169 个手型里只有 2 个越档（87s、J2s），被并集构造吸收。
档内为什么还要按胜率——档位只有 12 级，粒度不够；档内没有更多范围信息，
而胜率和可玩性在档内高度相关，是现成的最好的次级键。

#### 效果与验证

换序后与真实范围的重合度（UTG/MP/CO/BTN 是梯子自己的输入，属于拟合不是验证）：

| | 旧（纯胜率） | 新（档位 + 胜率） |
| --- | ---: | ---: |
| CO 开池（在样本内） | 75.1% | 100% |
| **31 张没进梯子的表（留出集）** | **72.9%** | **86.9%** |

留出集是唯一有说服力的那一栏：ISO、SB/BTN 防守、各种 vs-3bet 表都没参与构造，
平均重合度从 72.9% 提到 86.9%。

**数据来源与许可**：档位来自 [AHTOOOXA/poker-charts](https://github.com/AHTOOOXA/poker-charts)（MIT）的
`src/data/ranges/greenline.ts`，pin 在 commit `85ad2041`。该文件自述提取自
GreenCharts2024_01.pdf (Greenline Poker)——也就是说底层图表是第三方作品，
上游转成 MIT 重新发布这一步未必是它有权做的。我们只取档位划分（169 个手型各归
一档），不复制原图表的呈现，也不再分发原始 PDF。这条链是否可接受请自行判断，
判断依据写在 `scripts/build-preflop-ranges.mjs` 头部。

**仍然存在的局限**：档位来自 6-max 100bb 现金局的一套图表，不区分具体位置、
不随筹码深度变化，也没有混合频率（一手牌要么在某档要么不在）。牌桌是 2~8 人、
筹码会打飞，这些都没建模。

**最紧的几档里混着同花连张。** UTG 面对 3bet 的继续范围里 87s、T9s 都是 call，
那是真的 GTO 打法，不是解析错误。后果是这个序把 87s 排在 AJo 前面——作为范围
陈述对（AJo 面对 3bet 会被弃），作为牌力陈述不对。拿「出现在多紧的局面里」当
代理变量，这是固有代价。

### 8.5.3 循环的三个闸门

一次决策可能触发好几次模型调用，所以必须有人管住它：

1. **步数**：`stopWhen: [hasToolCall('act'), stepCountIs(maxSteps)]`，默认 6 步。
   能用来调工具的是 `maxSteps - 1` 次（最后一步被下面第 2 条锁成 `act` 了），
   也就是 5 次：够走「读画像 → 算胜率 → 三个尺度各 `plan_bet` 一次」。
   这是**上限不是开销**——模型一调 `act` 就停，绝大多数决策两三步就结束。
2. **强制收尾**：`prepareStep` 在最后一步把 `toolChoice` 锁成 `act`，
   否则模型可能一路调工具直到步数耗尽却没给出动作。
3. **墙钟**：`AbortSignal.timeout(POKER_AGENT_MAX_MS)`，默认 30 秒。
   这个数跟着步数一起定：30s 闸门 + 1.5s 兜底自己算胜率 + 8s 兜底的单轮调用
   ≈ 40s，行动时限 45 秒还剩 5 秒给网络抖动。再往上加就得先调大行动时限。
   它同时传给工具（`buildTools` 收的是「墙钟 + 外部取消」的合成信号），
   所以闸门落下时在飞的蒙特卡洛也会被叫停。
   注意 `AbortSignal.timeout()` 的内部定时器是 **unref** 的——线上有 HTTP 服务
   吊着事件循环所以没问题，但写测试时得自己吊一个 ref 的定时器，否则超时不会触发。

三个闸门任何一个兜住，都退回 §8.4 那条路，牌桌不会卡住。

### 8.5.4 对手记忆（`agent/memory.js`）

跨手牌的画像，全部从**脱敏快照**里攒出来——不存在作弊通道：

- 决策时（`decide()` 里）吸收本手的行动序列，算 VPIP / PFR / 激进度 / 弃牌率。
  靠 cursor 做幂等：同一手牌里人机要决策好几次，重复吸收不会把数字翻倍。
- 摊牌时（`Room#finishHand()` 调 `botDriver.observe(buildStateFor(null))`）记谁亮了什么牌。
  **只有这一刻**才看得到对手的底牌——轮到人机决策时那些牌还是 `"??"`。
  传 `null` 是旁观者视角：公开揭示的牌可见，没揭示的一张也不会多给。

两道必须有的护栏：

- 只在 `showdown` / `handOver` 阶段记摊牌。别的阶段就算快照里有明文的牌，
  那也只可能是「看快照的人自己的牌」。
- 跳过 `you.seat`。人机决策时拿到的快照里它自己的底牌是明文的，
  不排掉的话它每次决策都会把自己记成一次摊牌。

样本不足（默认 6 手）时 `profile()` 返回 `null` —— 报一个 2 手牌算出来的
「VPIP 100%」比不报更糟，模型会当真。

#### 按位置拆开

翻牌前范围最强的单一解释变量是位置：同一个人在枪口位和按钮位的入池率能差一倍
还多。不拆的话这两者会被平均成一个谁也不像的 VPIP。

`positionOf(state, seat)` 把座位归到四档之一。人数不定（2~8），所以按**离庄位
多远**分，而不是套 6-max 的位置名：

| 档 | 判据 |
| --- | --- |
| `blinds` | 小盲 / 大盲（已经投了钱，范围和别人不是一回事） |
| `late` | 庄位、庄位前一个 |
| `middle` / `early` | 其余的对半分，靠前的算 `early` |

只有四档不是六个具体位置，是为了样本量：一桌 6 人打 30 手，每个人在每个具体
位置只有 5 手，那种 VPIP 是噪声不是画像。

**只拆翻牌前**（`hands` / `vpip` / `pfr`）。翻牌后的激进度和弃牌率更像性格，
位置解释力小得多，全都拆四份只会把每个数的样本砍到四分之一换一堆噪声。

推导只用公开字段。优先读快照里的 `isSB` / `isBB`，读不到就从 `isButton` 推——
`isSB` / `isBB` 依赖 `this.hand`，手牌结束后会变 `false`，而 `#finishHand()`
那次 `observe` 正好在那之后；`isButton` 不依赖 `hand`，一直可读。
推不出来时返回 `null`，那一手只进总账不进分档——宁可少一条也不要脏数据。

分档的样本门槛（4 手）比总账的 6 手低：分档天然样本少，全按 6 手卡就永远出不来。
作为交换，每档都带自己的 `hands`，让模型按样本量自己打折。`read_opponents`
额外给一个 `here` 字段：这个对手**这手牌**坐在哪一档，以及他在这一档的历史数据。

#### 索引与回收

按**昵称**索引（快照里本来就没有玩家 id）。这其实是对的：人机建模的是
「那个叫老陈的人」，换个座位还是他，和真人玩家的做法一致。

**人机离座时必须调 `forget(name)`。** 人机的名字来自 `persona.js` 里一个只有
20 个名字的固定池子，而画像按昵称索引且从不整体清空。老陈（很紧那个）走了以后，
下一个人机迟早重新抽到「老陈」——那时它是另一套随机特质，却会继承前一个老陈的
VPIP、弃牌率和摊牌记录。名字池比座位多不了多少，长跑的服务器上这是必然不是巧合。

真人不走这条路：他们自己挑名字、会重连、也希望画像跨手牌活着，同名撞车是
既定取舍。

### 8.5.5 `Room` 侧的改动

`Room` 只多认两个**可选**方法，有就调、没有就是空操作：

```js
botDriver.observe?.(state)     // #finishHand() 里调一次，收摊牌
botDriver.forget?.(name)       // #vacate() 里对人机调，防名字回收
```

单轮版的 `BotDriver` 两个都没有，所以那条路一行都没变。除此之外 `PokerAgent`
与 `BotDriver` 的接口完全一致（`decide` / `describe` / `status` / `configure` /
`removeProvider` / `hasLLM`），可以直接顶替。

## 8.6 评测台（`server/eval/`）

`npm run eval`。**不是运行时的一部分**，服务端不引用它，Docker 镜像里也没有它。

### 8.6.1 它测的是什么

只做一件事的消融：同一套 `decideByRule`、同一批牌、同一个随机源，唯一变量是
胜率按「随机两张牌」还是按「从行动序列推断的范围」算（`bot/range.js`）。

不测 agent 本身：那样测出来的是「模型判断力 × 范围建模价值」的乘积，而且每跑一次
都要烧 API。先把「这个方向本身有没有价值」问清楚。

### 8.6.2 压方差的两件事

德扑评测最大的敌人是方差。一手牌的结果主要由发到什么牌决定。

1. **对偶发牌**：同一副牌打 `rotations` 遍，每遍策略在座位间轮转一格。于是每一手
   底牌两个策略都会拿到，牌运在它们之间抵消。
2. **统计的独立单位是「副」，不是「手」**。同一副牌的几遍之间是强相关的（就是故意
   制造这种相关性），按手算会把样本量虚报 `rotations` 倍，置信区间跟着缩水成假的。

### 8.6.2b 校准检查（`--calibrate`）

评测里我们拿着引擎的**全信息**，于是可以直接问：启发式说「对手范围是前 X%」时，
那些人手里的牌实际排第几百分位。每个决策点、每个还在牌里的对手都是一个观测值，
方差比 bb/100 小两个数量级。

**这是唯一能直接证伪范围推断的办法**，而且它抓到过一个真错误：第一版启发式在
「前 5%」那一桶上紧了 4 倍，直接导致 bb/100 净亏损。重新标定后最差 2 倍。

**换排序也必须重标。** 「前 X%」指的是哪些牌由 §8.5.2b 的排序决定，排序一动，
`bot/range.js` 的常数就全部作废。换成可玩性档位之后重标发现：换序本身修好了紧的
那一端（原来紧 4 倍的桶变成 1 倍），只剩「单次加注推得过松」一个系统误差，
于是 `FIRST_SHRINK` 0.35 → 0.22。

**故意没有追平。** 标定群体是规则人机自己：固定的 handStrength 门槛，翻牌前从不
诈唬，所以「有人加注」在它身上等价于「他真有牌」。照着实测的 0.10 去拟合，等于
把一个不会诈唬的对手的性质焊死进代码。下限也试过 0.12 → 0.06，实测退回来了：
前 5% 那桶立刻变回紧 2~4 倍。

`bot/range.js` 里那几个收缩常数是**用这条检查标定出来的**，改它们（或改排序）
之前必须重跑。两条回归测试钉着：`test/eval.test.js` 的「没有任何桶紧过头 3 倍以上」，
`test/agent.test.js` 的「单次加注推出的范围落在标定带 [0.15, 0.30] 内」。

**这个函数永远不能被运行时代码引用** —— 它要读对手底牌，那是牌桌上人机
绝对不该有的信息。它只存在于 `server/eval/`，而 `server/eval/` 不进镜像。

### 8.6.3 报告的硬性要求

- 每个结果都带 95% 置信区间。
- 区间跨 0 时必须写「**没测出差别**」，**不许**写成「打平」或「差距很小」。
- `--shadow` 必须同时报**测量噪声底**：范围 = 1 的那一桶走的是同一条代码路径，
  两次估算本该完全一样，它们的分歧率就是这次测量的假阳性率。信号要拿它当基准读。
- 不显著时打印「还需要多少副牌」，并附带警告：点估计在样本不足时连符号都会变。

最后一条是有实据的，而且已经应验过三次：

- 同一个 `seed=1`（当时的配置），2000 副 +11.51 ± 21.31，9000 副 −5.81 ± 11.35，符号翻了。
- 换排序之后又翻过一次。
- 最后一次代价最大：为了拆分「换排序」和「改常数」各自的功劳跑消融，
  seed 1 给出 +1.49 ± 9.99（p=0.77），seed 2 给出 +14.28 ± 8.98（p=0.0018）。
  **同一份代码，两个种子差 12.8 bb/100，比要归因的效应还大。**
  单个种子足以得出一个自信的错误归因。

**所以任何归因结论都必须至少两个种子。** 报告里的每一行都是这么来的。

## 9. HTTP

- `GET /` → `public/index.html`
- `GET /style.css`, `GET /app.js` → 对应静态文件（正确的 Content-Type，无缓存或短缓存）
- `GET /healthz` → `200 "ok"`
- 其他 → 404
- 静态文件服务必须防目录穿越（`..`）。
- 监听 `process.env.PORT || 8080`，`0.0.0.0`。

## 10. 前端要求（`public/`）

1. **入座**：未入座时点任意空座位 → 弹出输入昵称的对话框 → 发送 `sit`。
   页面加载时若 `localStorage` 有 token，先 `hello` 尝试恢复座位。
2. **牌桌**：跑道形（racetrack）牌桌 —— 两条长边是直线、两端收成半圆，跟真桌一样；
   8 个座位贴着轮廓分布（长边各 3 人、两端各 1 人），坐标按当前桌形实时算，
   手机竖屏跑道立起来时座位照样贴边。每个座位显示头像、昵称、筹码、当前下注筹码、
   最近动作气泡、按钮/SB/BB 标记、行动倒计时环。
3. **中央**：公共牌（发牌有翻牌动画）、底池金额（含边池分列）与底池筹码堆。
   筹码按面额配色（白 1 / 红 5 / 绿 25 / 蓝 100 / 黑 500 / 金 1000）叠成筹码摞；
   每条街结束时台面筹码飞进底池，一手结束时底池推给赢家。
4. **自己**：底部大号显示自己的两张底牌；行动条包含 `弃牌 / 过牌 / 跟注 N / 下注·加注`，
   加注用滑杆 + 快捷按钮（`1/2 池` `2/3 池` `底池` `全下`）；显示行动倒计时。
5. **摊牌**：揭示所有摊牌玩家的底牌，高亮组成牌型的 5 张牌，显示中文牌型名与赢取金额。
6. **手机竖屏可用**（≥360px 宽），牌桌等比缩放，不出现横向滚动条。
7. 轮到自己时用 WebAudio 生成一声提示音（不引入音频文件）。
8. 断线自动重连（指数退避，最长 5s 间隔），重连时用保存的 token 恢复。
9. 侧栏：牌局日志 + 聊天输入；房主可见设置面板（盲注、起始筹码、超时、自动开局、补充筹码、踢人、重置）。
10. **不得引用任何外部 CDN / 字体 / 图片**（服务器在境外且前端需离线自洽）。牌面用 CSS 绘制。

## 11. 部署

目标：一台 1GB 内存的 Debian 12 VPS，域名 `poker.example.com`。
机器上已经跑着 `matrix-chat-caddy-1`（占用 80/443）与 `matrix-chat-continuwuity-1`，
文件在 `/root/matrix-chat/`。**新服务必须复用现有 Caddy**，不能抢占 80/443。

- `Dockerfile`：`node:22-alpine`，非 root 用户运行，`npm ci --omit=dev`，
  `HEALTHCHECK` 打 `/healthz`，暴露 8080。
- `docker-compose.yml`：服务名 `poker`，容器名 `poker`，`restart: unless-stopped`，
  内存上限 200M，接入**已存在的**外部网络（Caddy 所在网络，名字由部署脚本探测后写入 `.env`）。
- `deploy/caddy-site.txt`：追加到 `/root/matrix-chat/Caddyfile` 的站点块，
  反代到 `poker:8080`，需正确透传 WebSocket。
- `deploy/deploy.sh`：幂等的一键部署脚本，在服务器上以 root 执行：
  探测 Caddy 容器与其网络 → 构建并启动 poker 容器 → 备份 Caddyfile → 幂等追加站点块 →
  `caddy reload` → 自检 `curl -fsS localhost` 与 `https://poker.example.com/healthz`。
  失败要有清晰的中文报错，且不能把已有的 matrix 服务搞挂（改 Caddyfile 前先 `cp` 备份，
  reload 失败自动回滚）。

---

## 12. 掼蛋桌（`server/guandan/` + `public/gd*`）

同一个进程上的第二张桌子，和德州桌**完全独立**：另一个 WebSocket 路径、另一份内存
状态、另一套座位与令牌。页面在 `/guandan`（`/gd` 是同一个页面的短地址）。

### 12.1 牌的表示

一张牌仍是 2 字符字符串，点数与花色沿用 §2；两张王是 `"jb"`（小王）与 `"jr"`（大王）。
一副掼蛋牌是**两副扑克 = 108 张**，所以同一个字符串会出现两次——
**牌面字符串不是唯一 id**，客户端选牌一律按手牌数组下标，发给服务端的是牌面字符串，
服务端按「多重集包含」校验。

### 12.2 共享牌型库（前后端唯一真相来源）

`public/gd-combos.js` 与 `public/gd-hints.js` 是**纯函数、零依赖**模块，
浏览器与服务端同时 `import`。不允许出现第二份牌型实现。

```js
// gd-combos.js
export function freshDeck(): string[]                        // 108 张
export function wildCard(level: number): string              // 逢人配 = 红桃级牌
export function powerValue(card: string, level: number): number   // 级牌 15，小王 16，大王 17
export function naturalValue(card: string): number                // 顺子/连对/钢板 用，级牌不升位
export function classify(cards: string[], level: number): Combo|null   // 具体牌 -> 牌型
export function interpret(cards: string[], level: number): Combo[]     // 含逢人配的所有解释
export function beats(a: Combo, b: Combo|null): boolean
export function comboName(c: Combo, level: number): string
export function sortHand(cards: string[], level: number): string[]

// Combo = { type: string, rank: number, size: number }
// type ∈ single | pair | triple | full | straight | tube | plate | bomb | sflush | jokers

// gd-hints.js
export function findPlays(hand, level, req): {cards: string[], combo: Combo}[]   // 从弱到强
export function choosePlay(hand, level, req, ctx): {cards, combo}|null           // 人机/托管
```

**不变量**：`findPlays` 声明的每个 `combo`，必须能被 `interpret(cards, level)` 复现，
否则服务端会以「牌型对不上」拒绝前端算出来的合法出牌。测试里有模糊用例守着这一条。

炸弹战力档位（`bombPower`）：4 张 20、5 张 25、同花顺 30、6 张 40、7 张 50、8 张 60、
天王炸 1000。同档位再比 `rank`。

### 12.3 `server/guandan/engine.js` — 一局的状态机

```js
export const GD_SEATS = 4, HAND_SIZE = 27
export const GD_PHASE = { TRIBUTE: 'tribute', PLAYING: 'playing', OVER: 'over' }
export function teamOf(seat): 0|1        // seat % 2
export function partnerOf(seat): number  // (seat + 2) % 4

new GuandanDeal({ level, firstSeat?, deck?, tributePlan? })
  .play(seat, cards, declared?) -> { ok, msg? }
  .pass(seat)                   -> { ok, msg? }
  .returnTribute(seat, card)    -> { ok, msg? }
  .returnCandidates(seat)       -> string[]      // 自然点数 ≤ 10
  .pendingReturns()             -> number[]      // 还欠着还贡的座位
```

`tributePlan = { double, payers: number[], receivers: number[], headSeat }` 由 room 依据
上一局名次算出：双下（头游二游同队）时 `payers = [三游, 末游]`、`receivers = [头游, 二游]`；
其余情况 `payers = [末游]`、`receivers = [头游]`。**进贡按名次算，不按队伍**——
头游与末游正好是队友时这一贡发生在队内，是规则的正常结果，不是 bug。

engine 负责：抗贡判定（进贡方合计两张 `jr`）、强制交出最大非逢人配牌、
双下时贡牌大的给头游、还贡校验、以及**首出座位**（有进贡时是贡牌最大的进贡者，
抗贡时是 `headSeat`）。

一轮结束的判定是「除 `req.seat` 外所有还有牌的座位都已 pass」。
牌权归属：`req.seat` 还有牌就他领出；他已出完则交给**对家（接风）**；对家也出完才顺延。
一方两人都出完时本局**立即结束**，剩下两人按手上牌少者为三游。

### 12.4 `server/guandan/room.js` — 房间与升级

内存状态：`levels[2]`（各队打到几，2..14）、`dealingTeam`（本局打谁的级）、
`aFail[2]`（打 A 失败次数）。

- 升级：头游与二游同队 +3，头游三游同队 +2，头游末游同队 +1；升级封顶在 14（A）。
- 打 A：坐庄方级数为 14 时，本方拿头游即 `matchOver`；对方拿头游则 `aFail[dealingTeam] += 1`，
  攒够 3 次该队退回打 2 且计数清零。
- 4 人坐满自动开局；牌局中不允许入座；中途有人离座则本局作废；真人全部离座后人机一并清场。

### 12.5 WebSocket 协议（路径 `/gd`）

客户端 → 服务端：

| `t` | 字段 | 说明 |
|-----|------|------|
| `hello` | `token?` | 同 §8，令牌是 32 位 hex |
| `ping` | — | 回 `pong` |
| `sit` | `seat` 0..3, `name` | 昵称 1..12 字符 |
| `stand` / `start` / `reset` | — | `start`/`reset` 仅房主 |
| `play` | `cards: string[]`, `as?: Combo`, `dealNo?` | `as` 是前端声明的牌型，可省略 |
| `pass` | `dealNo?` | 本轮第一个出牌的人不能 pass |
| `returnTribute` | `card` | 必须是 `returnCandidates` 里的 |
| `addBot` | `seat?` | 仅房主 |
| `kick` | `seat` | 仅房主 |
| `config` | `patch` | 仅房主：`actionTimeoutMs` 10~300s、`autoNextDealMs` 2~60s、`autoNextDeal` |
| `chat` | `text` | ≤ 200 字 |

`voiceJoin` / `voiceLeave` / `voiceMute` / `voiceSignal` 同 §13，
走的是掼蛋桌自己那个频道——和德州桌的语音完全隔离。

服务端 → 客户端：`welcome` / `state` / `error` / `pong` / `voiceReady` / `voiceSignal`，语义同 §8 与 §13。

`state` 快照的**安全红线**：`you.hand` 只含 viewer 本人的手牌，别人一律只给
`seats[].count` 张数；各家剩牌只在本局结束后随 `result.places[].rest` 下发。
`req` 与 `table` 会带上 `combo`，供前端本地预判出牌合法性——但服务端每次都会重新校验，
前端算的只是体验，不是权限。

### 12.6 前端（`public/guandan.html` / `guandan.css` / `gd.js`）

- `gd.js` 是原生 ES module（`<script type="module">`），仍然零构建、零外链。
- 复用 `style.css` 的色板、卡牌、按钮、对话框与侧栏抽屉；`guandan.css` 只写掼蛋特有布局。
- 座位按 viewer 旋转：自己在下方、下家在右、对家（队友）在上、上家在左。
- 侧栏必须有「规则」标签，把本桌实际采用的打法逐条写清楚（掼蛋各地规矩不一）。

---

## 13. 语音连麦（`server/voice.js` + `public/voice.js`）

**两张桌子的语音是分开的**：德州桌上说的话，掼蛋桌那边听不到，反之亦然。
这不是靠某个 `if` 守着，而是结构上的——每个 Room 各持有一个 `VoiceChannel`
实例，成员表各存一份，转发信令时只在自己房间的 `clients` 集合里找收件人，
而两张桌子的 `clients` 本来就不相交（WebSocket 路径就不同：`/ws` 与 `/gd`）。

### 13.1 拓扑

- **音频不经过服务器。** 浏览器之间直接建 WebRTC 连接（mesh，人人互连），
  服务端只转发 SDP / ICE 这些几 KB 的小纸条。带宽成本恒定为零，延迟是端到端最短的那条。
- 代价是连接数按 n² 涨：`MAX_VOICE_MEMBERS = 8`（8 人 = 28 条连接，
  单人上行约 7 × 24kbps）。可用 `POKER_VOICE_MAX` 调小。
- 服务端**不解析 SDP**。`voice.js` 的 `validSignal()` 只管形状与大小
  （kind 白名单、SDP ≤ 12000 字符、candidate ≤ 1200 字符），转发前还会按白名单
  重建对象，塞在信令里的多余字段不会被转出去。

### 13.2 消息（两张桌子完全一样，各走各的路径）

客户端 → 服务端：

```jsonc
{"t":"voiceJoin"}                       // 上麦。幂等：已在麦上只会重发一次 voiceReady
{"t":"voiceLeave"}                      // 下麦
{"t":"voiceMute","value":true}          // 自己静音（麦是在浏览器本地关的，这里只同步图标）
{"t":"voiceSignal","to":"p_ab12","data":{"kind":"offer"|"answer","sdp":"..."}}
{"t":"voiceSignal","to":"p_ab12","data":{"kind":"candidate","candidate":{...}|null}}
{"t":"voiceSignal","to":"p_ab12","data":{"kind":"bye"}}
```

服务端 → 客户端：

```jsonc
{"t":"voiceReady","self":"p_ab12","max":8,"iceServers":[{"urls":["stun:..."]}]}
{"t":"voiceSignal","from":"p_cd34","data":{...}}   // 只发给 to 指定的那一个人
```

快照里多一个 `voice` 字段（见 §8.3 / §12.5）：

```jsonc
"voice": {
  "enabled": true,
  "max": 8,
  "members": [{"playerId":"p_ab12","seat":3,"name":"小明","avatar":{...},"muted":false}]
}
```

`members` 按上麦先后排序；观众也能上麦，`seat` 为 `null`、`name` 为 `"观众"`。
新增错误码：`VOICE_OFF`（没开语音 / 自己还没上麦）、`VOICE_FULL`。

### 13.3 生命周期

下面这几件事都会把人从麦上摘掉，然后广播新名单，让其他人立刻拆掉 P2P 连接
（而不是干等 ICE 超时）：**断线**、**被房主请出牌桌**、**重新 `hello`**。
最后一条是关键：一次新的握手意味着页面刷新过或断线重连过，
旧的 RTCPeerConnection 已经作废；前端如果本来在麦上，会在收到 `welcome` 后自己再上一次麦。

### 13.4 限流

信令在建连的那两秒是成串涌出来的（7 个对端一起打洞），牌桌那 20 条/秒根本不够。
所以 `index.js` 的限流分两个桶：**总量** 160 条/秒（在 `JSON.parse` 之前拦，最便宜），
**牌桌动作**仍然是 20 条/秒。语音消息只吃总量那个桶。

### 13.5 打洞与 HTTPS

- `getUserMedia` 只在**安全上下文**里可用：必须是 HTTPS（或本机 `localhost`）。
  不满足时前端会明确提示，而不是静默失败。
- STUN 默认用国内能连上的几家（`stun.qq.com` / `stun.miwifi.com` / `stun.cloudflare.com`），
  可用 `POKER_STUN_URLS` 覆盖，填 `none` 表示只走局域网直连。
- 对称型 NAT / 部分蜂窝网络之间打不通，只能过 TURN 中转：
  自己搭一个 coturn，填 `POKER_TURN_URL` / `POKER_TURN_USERNAME` / `POKER_TURN_CREDENTIAL`。
  没配 TURN 时，打不通的那一对会在名单里显示「连不通」，并弹一次提示——**不能静默失败**。
- `POKER_VOICE=off` 整体关掉，前端连按钮都不显示。

### 13.6 前端（`public/voice.js`）

两个页面共用同一份文件（普通 `<script>`，挂 `window.TableVoice`），因为德州那边的
`app.js` 不是 module。宿主页面只需要给它四样东西：`send` / `toast` / 挂载点 / 顶栏按钮，
然后把每条服务端消息喂给 `handle()`、每个快照喂给 `applyState()`。

- 谁在说话是**本地算的**：对本地流和每条远端流各挂一个 `AnalyserNode`，
  按 RMS 判定，开口/闭嘴两条阈值加 350ms 保持时间，避免指示灯频闪。
  这条信息一个字节都不走服务器。
- 名单面板宽屏停在侧栏顶部（跟着排版走，不挡日志），窄屏浮在顶栏底下并默认收起成一排头像。
- 座位上必须能一眼看出谁在开口：头像绿圈 + 麦克风小灯（静音时变灰）。

## 14. 热词（`server/hotword/` + `public/hotword.*` + `public/hw.js`）

同一个进程上的第三张桌子，和前两张**完全独立**：另一个 WebSocket 路径（`/hw`）、
另一份内存状态、另一套座位与令牌。页面在 `/hotword`。

玩法：两个人猜**同一个**隐藏词，服务端按语义相似度给出「在全词表里排第几」，
谁先猜中谁赢。其余人是观众。

### 14.1 两条设计红线

这两条决定了整个游戏成不成立，改任何一处之前先读懂为什么：

1. **对外只给排名，不给相似度百分比。** 不同目标词的余弦相似度尺度差很多
   （「咖啡」最近的邻居 0.80，「台风」最近的只有 0.63），把 0.63 摆给玩家看
   他会以为自己差得远。排名是尺度无关的。温度（0-100）只是排名的对数映射，
   给温度条用。

2. **进行中的快照里不能出现答案、对手猜过的词、对手的精确排名。**
   观众拿到的那一份和对手完全一样——八个人开着语音，观众要是看得见答案，
   一句话就能把整局毁掉。只有本局结束后 `result` 里才带完整记录。
   `test/hotword.test.js` 里有一条把快照 `JSON.stringify` 之后搜答案字符串的测试守着。

还有一条中文特有的坑：**与答案互为子串的词必须整个从本局词表里摘掉**。
目标词「咖啡」时，前 50 名邻居里有 8 个是 咖啡厅/咖啡豆/咖啡馆/…，
随手一猜就漏底。摘掉之后它们的表现必须和生僻词**完全一致**（「不认识这个词」）——
不能提示「太接近了」，那句话本身就在说答案里有这两个字。

### 14.2 数据（`server/hotword/data/`）

| 文件 | 内容 | 谁生成 |
|---|---|---|
| `vocab.bin` | 头部 8 字节（词数 uint32、维数 uint32）＋ 每词 float32 缩放系数 ＋ int8 向量 | `scripts/build-hotword-data.mjs` |
| `vocab.txt` | 词表，一行一个，顺序＝词频从高到低 | 同上 |
| `answers.txt` | 答案池，`<词>\t<类别>`，`#` 是注释 | 手写 |

来源是腾讯 AI Lab 中文词向量的精简版（Apache-2.0，143,613 词 / 200 维），
取词频前 6 万里纯汉字 2-4 字的词，L2 归一化后按每向量的最大绝对值量化到 int8。
产物 52,728 词 / 10.8MB，常驻内存约 11MB。

int8 够用是实测过的：跟 float32 比，前 1000 名的重合度 99.6%、前 2000 名的
平均排名偏移 7 位。float32 要 42MB，省下的四分之三比那 7 位值钱。

`HOTWORD_DATA_DIR` 可以指到另一份词库（换词表、换答案池、测试用小词包）。
数据文件缺失时 `WordVectors.load()` 返回 `null`，房间照样能连、页面照样能开，
只是 `start` 返回 `NOT_READY`——**不能让一个数据文件缺失把德州和掼蛋一起拖下水**。

### 14.3 `server/hotword/vectors.js`

```js
WordVectors.load(dir?) -> WordVectors|null
  .size, .dim, .words: string[], .index: Map<string,number>
  .answers: {word, category}[]
  .has(word) -> boolean
  .rankTable(target) -> Uint16Array   // rank[i] 是词表第 i 个词的排名，0 是目标词自己
  .relatedForms(target) -> Set<number> // 与目标互为子串的词表下标
```

**性能约定**：`rankTable` 是 52728 × 200 次乘加再排序，约 60-70ms。
必须**每局开一次**、把结果存在 round 上，之后每次猜词都是 O(1) 查表。
绝不能每次猜词现算——那样几个人一起猜就能把事件循环压死。

词表上限 65536：排名存在 `Uint16Array` 里。要扩词表得先改成 `Uint32Array`，
`vectors.js` 里有一道断言挡着，不会静默截断。

### 14.4 `server/hotword/engine.js` — 一局的状态机

```js
export const HW_SEATS = 2
export const HW_PHASE = { WAITING, PLAYING, OVER }
export function tempOf(rank, vocabSize): number   // 0-100，对数映射
export function heatOf(rank): 'hit'|'burning'|'hot'|'warm'|'mild'|'cool'|'cold'

new HotwordRound({ vectors, answer, no?, now?, cooldownMs?, peekFreezeMs?,
                   peekLimit?, roundLimitMs?, hintsEnabled? })
  .guess(seat, raw, now?) -> { ok:true, entry, win } | { ok:false, code, msg, waitMs?, entry? }
  .peek(seat, now?)       -> { ok:true, peeked, freezeMs, left } | { ok:false, code, msg }
  .hints(now?)            -> { key, label, atMs, inMs, locked, value }[]   // 不分位子
  .hintAtMs(tier)         -> 某一档在本局第几毫秒开，对齐到整秒
  .msLeft(now?)           -> 本局还剩多少毫秒
  .timeUp(now?)           -> 到点就判平局，返回"这一次是不是刚判死"
  .resign(seat, now?)     -> { ok }
  .publicSeat(seat)       -> 对手与观众看到的那一份
```

所有时间都从参数传进来，engine 不认识 `Date.now()` 之外的任何计时器——
所以测试里不用 sleep 就能把冷却、偷看冻结、提示解锁全部跑一遍。

错误码：`COOLING`（冷却中，带 `waitMs`）、`NOT_IN_VOCAB`（生僻词**或**子串词）、
`ALREADY_GUESSED`（带上次的 `entry`）、`WORD_EMPTY`、`WORD_TOO_LONG`、`ROUND_OVER`、
`NOTHING_TO_PEEK`、`PEEK_USED_UP`。

三条计费规则，别改错方向：
- **生僻词不计次数、不进冷却**——词表覆盖不到就罚玩家，是拿自己的数据缺陷罚人。
- **重复猜不计次数、不进冷却**，把上次的 `entry` 再返回一次让页面闪一下。
- **偷看是取 `max` 不是累加**：连着偷看＝一直冻着，不会攒出一个几分钟的惩罚。
- **偷看给的是对手【目前最好的】那一手，不是最近的**，而且一局限 `peekLimit` 次
  （默认 2）。最近一次多半只是往新方向探的一枪，最好的一次才是他真正的位置；
  冻结从 15 秒降到 8 秒是因为提示共享之后终局是"提示一落地就抢答"，
  15 秒＝5 次猜测，在那个节奏里花得起的人不存在。次数封顶防止降价之后被当饭吃。

一局有**硬时限** `roundLimitMs`（默认 90 秒，可调 30-600 秒）。到点没人猜中就
`finish(null, 'timeout')` —— 这是**平局**，两边都不加分，跟 `'abandoned'`（作废）
是两回事，页面上的文案也不一样。`timeUp()` 由 room 的 `#tick` 每秒调一次，
**每个动作之前也要调一次**：定时器慢半拍的那零点几秒里不能还让人落一手。

提示按**时间**解锁，跟谁猜了多少次无关，`hints(now)` 不收座位参数——
"两边拿到的是同一份"是签名层面保证的，不是靠调用方自觉。
`HINT_TIERS` 里的 `at` 是**占本局时长的比例**（0 / 0.25 / 0.6），不是绝对秒数：
房主把一局拉到 5 分钟时三档得跟着拉开，否则按 90 秒定的档位配 5 分钟的局
等于开局全给。`hintAtMs()` 会把结果对齐到整秒，免得倒计时卡在半秒上。

这里改过两次，想动之前把两次都读完：

1. **第一版按自己的猜测次数解锁**（10/20/30），有必胜解：一次猜测的唯一成本是
   冷却，猜什么词都算数，29×3＝87 秒就能无脑刷满三档；而三档几乎就是答案——
   答案池里 **92%** 的词能被 (类别 + 字数 + 首字) 唯一确定。
2. **第二版改成"按双方取 max 解锁 + 共享 + 推开的人多冻 8 秒"**。刷次数确实不赚了，
   代价却是**认真打也挨罚**：拿到类别之后顺着候选往下试的人，试到第 11 个就撞开
   首字白送对手。引擎数的是次数，分不清刷和想。均衡于是变成两边贴着阈值停手——
   都停在 19 次，第三档（防僵局的阀门）永远没人愿意推开，僵局反而锁死了。
3. **现在按时间**：谁也拦不住、谁也加速不了。刷不出提示也拖不掉提示，阀门到点自己开。
   猜词回到纯赚（只给自己涨信息，不泄露给对手），那套额外冻结机械随之删除。

三档的顺序是按含金量排的，在 403 个答案上实测：

| 档 | 时点（90 秒局） | 候选数 | 唯一确定 | 作用 |
|---|---|---|---|---|
| 字数 | 开局 | 403 → 311 | 0.2% | 350/403 是 2 字词，几乎白给，所以不藏 |
| 类别 | 23 秒 | 403 → 25 | 0.0% | 节奏的油门：知道类别后同类别最佳词中位数排第 5、100% 进前 100 |
| 首字 | 54 秒 | 403 → 1.6 | 65.5% | 收尾的阀门，它自己就几乎是答案 |

公共日志里**不能**出现任何一档提示的**值**。提示到点自动开，战况里只写档位的
名字（「类别」），绝不写它的值（"食物"）；也不写是谁推开的——没有"谁推开"这回事了。

### 14.5 `server/hotword/room.js` — 房间

两个擂台位 + 不限人数的观众席。接口与掼蛋房间同构：
`attach / detach / hello / sit / stand / start / guess / peek / resign / reset / setConfig / sendChat / broadcast / buildStateFor / shutdown`。

- 局中途有人 `stand`，本局作废（`result.winner = null`，`reason = 'abandoned'`），
  **不计分**，但答案要公布。
- 断线保留擂台位 15 分钟，跟另外两张桌子一致。
- 到点没人猜中 → `reason = 'timeout'`，**平局不计分**，答案公布。
- `#tick()` 每秒一次，局中**每秒都广播**。原来只在有人被冷却冻着时才推，现在
  倒计时和提示解锁都是时间驱动的，不推页面就停在上一秒。一局才 90 秒，量无所谓。
- `#sweepTime()` 负责判时间到 + 把新开的档写进战况（只写档名），
  `#tick` 和每个动作（guess/peek/resign）之前都要调。

配置（房主可改，只能在两局之间）：`roundLimitMs`（30-600s，默认 90）、
`guessCooldownMs`（0-30s，默认 1.5）、`peekFreezeMs`（0-120s，默认 8）、
`peekLimit`（0-9，默认 2，填 0 等于关掉偷看）、`peekEnabled`、`hintsEnabled`。
环境变量对应 `HOTWORD_ROUND_LIMIT` / `HOTWORD_GUESS_COOLDOWN` / `HOTWORD_PEEK_FREEZE` /
`HOTWORD_PEEK_LIMIT` / `HOTWORD_PEEK` / `HOTWORD_HINTS`。

### 14.6 WebSocket 协议（`/hw`）

客户端 -> 服务端：
`hello{token}` `ping` `sit{seat,name}` `stand` `start` `guess{word}` `peek` `resign`
`reset` `config{patch}` `chat{text}`，外加 §13 的语音信令。

服务端 -> 客户端：`welcome` `state` `error` `pong` `guessed{repeat,entry}`。
`guessed` 只用在「这个词你已经猜过了」这一种情况上——它不进快照，
因为重复猜不改变任何状态。

`state` 快照：

```js
{
  t: 'state', ready, phase,
  round: { no, startedAt, vocabSize } | null,
  seats: [{ seat, name, avatar, connected, isHost,
            guessCount, bestTemp, bestHeat, peekCount, frozenMs,
            bestRank }],          // bestRank 只在本局结束后才有值
  score: [number, number],
  spectators: number,
  you: { playerId, seat, isHost, name },
  my: { guesses, cooldownMs, hints, peeked } | null,   // 只有自己这一份带词和精确排名
  result: { winner, reason, answer, category, guesses:{0:[],1:[]}, no } | null,
  config, log, chat, voice
}
```

`cooldownMs` / `frozenMs` 是**相对毫秒**不是绝对时间戳——客户端时钟和服务端差几秒
是常态，发绝对时间会让倒计时看起来乱跳。前端拿到之后本地倒着数。

### 14.7 前端（`public/hotword.html` / `hotword.css` / `hw.js`）

零构建、无外链，样式继承 `style.css`。页面本身**没有任何游戏逻辑**：
排名、冷却、提示解锁、能不能偷看全部由服务端在快照里算好，前端只画。
唯一的本地计算是冷却秒数的插值（服务端一秒推一次，光靠推按钮上的数字会一跳一跳）。
