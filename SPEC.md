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
- 唯一运行时依赖：`ws`。前端**零构建**（纯 HTML/CSS/JS，无打包器、无 CDN 外链）。
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
│   └── room.js              房间：座位、令牌、断线重连、状态快照下发
├── public/
│   ├── index.html
│   ├── style.css
│   ├── voice.js             语音连麦前端（两个页面共用）
│   └── app.js
├── test/
│   ├── evaluator.test.js
│   └── engine.test.js
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
