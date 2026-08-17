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
│   └── room.js              房间：座位、令牌、断线重连、状态快照下发
├── public/
│   ├── index.html
│   ├── style.css
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

示例：`{kind:'action', seat:3, amount:80, text:'小明 加注到 80'}`

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
{"t":"reset"}                                // 仅房主：清空牌桌，所有人筹码回到 startingStack
{"t":"chat","text":"..."}                    // 最长 200 字符
{"t":"ping"}
```

`action` 消息里的 `handNo` 用于丢弃过期点击：与当前手牌号不符时服务端静默忽略。

### 8.2 服务端 → 客户端

```jsonc
{"t":"welcome","playerId":"p_ab12","token":"<hex>","seat":3|null}
{"t":"state", ...}          // 见 §8.3，任何状态变化后全量下发（状态很小，不做增量）
{"t":"error","code":"SEAT_TAKEN","msg":"该座位已被占用"}
{"t":"event","kind":"...","seat":3,"amount":80,"text":"小明 加注到 80"}  // 建议性，用于音效/动画
{"t":"pong"}
```

错误码：`SEAT_TAKEN` `NAME_INVALID` `NOT_HOST` `NOT_YOUR_TURN` `ILLEGAL_ACTION`
`TABLE_FULL` `NOT_SEATED` `HAND_IN_PROGRESS` `NOT_ENOUGH_PLAYERS` `RATE_LIMIT`。

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
    "seatedCount": 4
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
  "you": {
    "playerId":"p_ab12", "seat":1, "isHost":true, "sittingOut":false,
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

## 8.4 人机（`server/bot/`）

人机是**没有 WebSocket 连接的普通玩家**：在 `room.players` 里有记录、占座位、有筹码，
`connected` 恒为 `true`，`token` 为 `null`（没人需要用它重连）。

模块划分：

| 文件 | 职责 |
|---|---|
| `bot/provider.js` | Kimi / DeepSeek 的 HTTP 客户端。两家都是 OpenAI 兼容的 `/chat/completions`，只有一个实现 |
| `bot/policy.js` | 规则策略。不联网，Chen formula + 牌型类别 + 底池赔率 |
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

### 8.4.2 失败行为

`BotDriver#decide()` **不抛异常**，且保证在超时时间内返回。任何失败（超时、限流、
5xx、输出无法解析）都退回 `policy.js` 的规则策略，牌桌照常进行，只是人机变笨。
同一供应商连续失败 3 次进入 60 秒冷却。一个 key 都没配时人机全程走规则策略。

行动超时计时器对人机照常生效：人机卡住时会和真人一样被超时逻辑接管
（能过牌就过牌，否则弃牌），不需要额外的保险机制。

### 8.4.3 幂等触发

`#maybeTriggerBot()` 在每次 `#resetActionTimer()` 时调用。用
`${handNo}:${seat}:${events.length}` 作为决策键——同一座位在同一手牌里多次行动会得到
不同的键，而重复的 `#pump()` 不会重复触发。决策落地前要重新校验局面
（手牌还在、还轮到它、座位没换人）。

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
2. **牌桌**：椭圆牌桌，8 个座位环绕分布；每个座位显示头像、昵称、筹码、当前下注筹码、
   最近动作气泡、按钮/SB/BB 标记、行动倒计时环。
3. **中央**：公共牌（发牌有翻牌动画）、底池金额（含边池分列）。
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
