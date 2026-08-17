export const meta = {
  name: 'poker-build',
  description: '按 SPEC.md 并行实现德州扑克桌的五个模块（评估器/引擎/服务端/前端/部署）',
  phases: [
    { title: '实现', detail: 'evaluator+deck / engine / room+server / frontend / deploy kit' },
  ],
}

const ROOT = '/home/jojo/Music/poker'
const PREAMBLE = `你在实现一个在线德州扑克网站，项目根目录是 ${ROOT}。

**第一件事：完整读取 ${ROOT}/SPEC.md。它是唯一真相来源。**
严格遵守其中定义的函数签名、字段名、消息格式。不要重命名字段、不要"改进"接口——
其他模块由别的开发者并行实现，接口不一致会直接坏掉。

通用要求：
- Node.js 22，ESM 语法（import/export），项目已有 package.json 且 "type":"module"。
- 唯一运行时依赖是 ws（已安装在 ${ROOT}/node_modules）。不要引入其他依赖。
- 代码注释用中文，面向用户的文案全部用简体中文。
- **只创建/修改分配给你的文件**，绝对不要碰其他文件（包括 package.json 和 SPEC.md）。
- 完成后必须自检：用 Bash 运行 \`node --check <你的每个 js 文件>\` 确认语法正确；
  如果你负责测试文件，运行 \`cd ${ROOT} && node --test test/<你的测试>\` 并确保全部通过。
- 返回值就是给协调者看的报告，用中文简述你写了什么、做了哪些设计取舍、有哪些已知遗留问题。
`

phase('实现')

const tasks = [
  {
    label: 'evaluator+deck',
    prompt: `${PREAMBLE}
你的任务：实现 **牌型评估器与牌堆**。

创建这些文件：
1. \`${ROOT}/server/deck.js\` — 按 SPEC §3。洗牌用 node:crypto 的 randomInt 做无偏 Fisher-Yates。
2. \`${ROOT}/server/evaluator.js\` — 按 SPEC §4。
3. \`${ROOT}/test/evaluator.test.js\` — 用 node:test + node:assert/strict。

evaluator 的实现要点：
- 7 张牌时枚举 C(7,5)=21 组合逐一评估取最优。正确性绝对优先于性能。
- ranks 数组的语义必须严格按 SPEC 表格，长度固定 5，不足补 0。
- score = cat*15^5 + ranks[0]*15^4 + ranks[1]*15^3 + ranks[2]*15^2 + ranks[3]*15 + ranks[4]。
- A-2-3-4-5 的轮子顺子最大点算 5；同花顺里 A-K-Q-J-T 的 name 是 "皇家同花顺"，
  其余同花顺 name 是 "同花顺"。
- best 必须返回真正组成牌型的 5 张原始牌字符串。
- 同花与顺子同时存在时不要误判：必须先判同花顺（在同一花色的牌里找顺子）。
- 7 张里有 3 个同点数 + 另外 2 组对子这类情况，葫芦要取最大的三条 + 最大的对子。

测试必须覆盖（每条都要有断言）：
- 九种牌型各至少一例，name 与 cat 正确。
- 皇家同花顺 vs 普通同花顺。
- 轮子顺子 A2345 判定为顺子且 ranks[0]===5；同时验证 A2345 同花 = 同花顺（轮子同花顺）。
- 同花顺不被误判成同花或顺子；7 张里同花有 6 张时取最大的 5 张。
- 踢脚比较：同对子不同踢脚、两对同大对子比小对子再比踢脚、四条比踢脚。
- 完全相同牌力（不同花色）的两手牌 score 相等，compareHands 返回 0。
- 一个随机对拍测试：随机生成 2000 手 7 张牌，验证 evaluate 返回的 best 确实是
  21 种 5 张组合里 score 最大的那个（用独立的暴力实现交叉验证），且
  evaluate(best) 的 score 等于 evaluate(7张) 的 score。
- 验证 freshDeck 是 52 张互不相同的合法牌；shuffle 后仍是同一个 52 张集合。`,
  },
  {
    label: 'engine',
    prompt: `${PREAMBLE}
你的任务：实现 **单手牌状态机**，这是整个项目最关键、最容易出错的部分。

创建这些文件：
1. \`${ROOT}/server/protocol.js\` — 按 SPEC §5，只导出常量。
2. \`${ROOT}/server/engine.js\` — 按 SPEC §6，导出 class Hand。
3. \`${ROOT}/test/engine.test.js\` — 用 node:test + node:assert/strict。

依赖：\`./evaluator.js\` 与 \`./deck.js\` 由另一位开发者并行实现，接口见 SPEC §3/§4，
按契约 import 即可（\`import { evaluate, compareHands } from './evaluator.js'\`、
\`import { freshDeck, shuffle } from './deck.js'\`）。**不要自己写这两个文件**。
如果你运行测试时它们还不存在或有 bug，在报告里说明，不要去改它们。

必须严格实现 SPEC §6.1 的全部规则，尤其注意这些高频错误点：
- 单挑时按钮=小盲、翻牌前按钮先动、翻牌后大盲先动。
- 翻牌前大盲的 option：无人加注时轮到大盲他仍可 check 或 raise。
- 全下金额不足一次完整加注时**不重开**已行动玩家的加注权（canRaise 必须为 false），
  但尚未行动过的玩家仍可加注。
- raise/bet 的 amount 是"本轮总投入额"(raise TO)，不是增量；callAmount 是增量。
- 边池分层、弃牌者筹码留池、只有一个 eligibleSeat 的顶层退还给本人并记入 uncalledReturned。
- 平分底池时零头从按钮左手第一位开始依次多分 1 枚。
- 筹码守恒是硬性不变量。
- 非法动作必须完全不改变状态并返回 {ok:false, error:'中文说明'}。
- 所有玩家都全下时不再需要行动，自动依次发完剩余公共牌直接摊牌。

测试必须用**注入的固定牌堆**（构造函数的 deck 参数）来做确定性断言，覆盖：
- 3 人局的盲注就位、行动顺序、一轮完整的 check 到河牌、摊牌分池。
- 单挑局的盲注与前后翻行动顺序。
- 大盲 option：所有人跟注后轮到大盲，legalActions 里 canCheck 与 canRaise 都为 true。
- 短码全下不足完整加注 → 之前已行动的玩家 canRaise === false，未行动的玩家 canRaise === true。
- 三人不同筹码量全下形成主池+边池，验证每个池的 amount 与 eligibleSeats，
  以及最终 payouts / chipsAfter。
- 未被跟注的下注被退还（uncalledReturned），且 chipsAfter 正确。
- 平局分池：两人同牌力平分奇数底池，验证零头给了按钮左手第一位。
- 所有人弃牌只剩一人：不摊牌（showdown 为空数组、wentToShowdown===false），赢家收池。
- 至少 200 局随机对局（随机合法动作）的模糊测试，每局断言：筹码守恒、
  没有负筹码、pots 总额与玩家投入一致、引擎最终一定能走到 isComplete。
- 非法动作（不到自己回合、加注小于 minRaiseTo、下注超过筹码）被拒绝且状态不变。`,
  },
  {
    label: 'server+room',
    prompt: `${PREAMBLE}
你的任务：实现 **房间逻辑与服务端入口**。

创建这些文件：
1. \`${ROOT}/server/room.js\` — 按 SPEC §7 与 §8.3，导出 class Room。
2. \`${ROOT}/server/index.js\` — 按 SPEC §9，HTTP 静态服务 + WebSocket 服务。

依赖（并行实现中，按契约 import，**不要自己写也不要修改**）：
- \`./engine.js\` 的 \`class Hand\`（SPEC §6）
- \`./protocol.js\` 的常量（SPEC §5）
- \`./evaluator.js\`、\`./deck.js\`（一般不需要直接用）

Room 的职责：
- 维护 8 个座位的持久玩家（跨手牌），token 重连，房主转移，坐出/坐回，补充筹码，踢人，重置。
- 开新手牌：过滤出有筹码且未坐出的在座玩家（≥2 人才能开），推进按钮到下一个符合条件的座位，
  new Hand(...)，把 result.chipsAfter 同步回持久玩家。
- 行动计时器：\`actionTimeoutMs\` 到点自动调用 \`hand.timeoutAction(seat)\`。
  每次 actingSeat 变化都要重置计时器；手牌结束要清掉计时器。
- 手牌结束后进入 handOver 阶段展示结果，\`autoNextHandMs\` 后（若 autoNextHand 且人数够）自动开下一手。
- \`buildStateFor(viewerPlayerId)\` 生成 SPEC §8.3 的脱敏快照。
  **安全red line：除自己以外的底牌必须是 ["??","??"]，只有 result.showdown 里被揭示的座位
  才下发真实底牌。任何时候都不得把未揭示的底牌发给别人。**
- 广播：任何状态变化后给每个连接单独生成快照下发（因为每人看到的底牌不同）。
- 日志 log 保留最近 40 条（来自 hand.events 的 text），chat 保留最近 50 条。

index.js 的职责：
- node:http 静态服务 public/ 目录，正确的 Content-Type，防目录穿越，\`GET /healthz\` 返回 ok。
- ws（\`import { WebSocketServer } from 'ws'\`）挂在 \`/ws\` 路径。
- 处理 SPEC §8.1 的所有客户端消息，做输入校验：
  昵称 1..12 字符去空白后非空、seat 必须是 0..7 整数、amount 必须是非负整数、
  chat 最长 200 字符。校验失败回 \`{t:'error',code,msg}\`（错误码见 SPEC §8.2）。
- 简单限流：单连接每秒最多 20 条消息，超出回 RATE_LIMIT 并忽略。
- 心跳：30s 一次 ping，60s 无响应则断开（用 ws 的 ping/pong 或协议里的 ping/pong 都行）。
- 断线：标记 player.connected=false，保留座位与筹码；牌局中的超时自动动作照常生效。
- 优雅退出：SIGTERM/SIGINT 时关闭服务器。
- 进程级 uncaughtException/unhandledRejection 要打日志但不要让服务崩掉。

写完后用 \`node --check\` 自检语法。不要试图启动服务（依赖模块可能还没写完）。`,
  },
  {
    label: 'frontend',
    prompt: `${PREAMBLE}
你的任务：实现 **完整前端**（这是用户唯一直接看到的东西，做得好看、好用、手机能玩）。

创建这些文件：
1. \`${ROOT}/public/index.html\`
2. \`${ROOT}/public/style.css\`
3. \`${ROOT}/public/app.js\`

严格按 SPEC §8（协议）与 §10（前端要求）实现。前端**只消费** \`{t:'state'}\` 全量快照，
按快照重绘；\`{t:'event'}\` 仅用于音效与短暂动画。

设计要求（认真做，不要糊）：
- 深色主题的赌场质感：深绿/墨绿毡面牌桌（径向渐变 + 细微噪点用 CSS 实现，不要图片），
  木质或暗金描边，整体克制不廉价。不要用 emoji 堆砌。
- 椭圆牌桌，8 个座位沿椭圆均匀分布（用 CSS 绝对定位 + 预先算好的百分比坐标，
  自己（如果已入座）固定显示在正下方那个位置——**把座位数组按自己的座位号旋转**，
  让本人永远在底部中央，这是德扑客户端的标准做法）。
- 每个座位卡片：头像（按 avatar 字段用 CSS 生成的圆形色块 + 首字，shape 决定形状变体）、
  昵称、筹码数、状态（弃牌变灰、全下高亮、断线显示灰点）、按钮/SB/BB 标记、
  下注筹码堆（显示在座位与牌桌中心之间）、最近动作气泡、
  轮到该座位时用 SVG/conic-gradient 画倒计时环。
- 公共牌区域：5 个卡位，发牌时逐张翻牌动画（CSS transform 3D 翻转，200ms 左右，不要太慢）。
- 牌面用纯 CSS 绘制：白底圆角、左上角点数+花色、中间大花色符号，红桃方块红色、黑桃梅花黑色。
  背面用斜纹图案。牌要清晰，手机上也要看得清点数。
- 底部自己的区域：两张大底牌 + 行动条。行动条按钮：弃牌（红）/ 过牌 / 跟注 N / 加注（金）。
  加注面板：滑杆 + 数字输入 + 快捷按钮（1/2 池、2/3 池、底池、全下）。
  只显示 legal 里允许的动作；不到自己回合时行动条整体禁用/隐藏，改显示"等待 XXX 行动"。
- 摊牌：揭示底牌，组成牌型的 5 张牌加金色高亮外发光，赢家座位显示 "+N" 上浮动画与中文牌型名。
- 侧栏（桌面）/ 抽屉（手机）：牌局日志 + 聊天。房主额外有设置面板。
- 未入座时：空座位显示"＋ 入座"，点击弹出昵称输入对话框（原生 dialog 元素即可，别用 alert）。
- 顶部状态条：连接状态、手牌号、盲注水平、房主标识。

技术细节：
- 纯原生 JS，无框架无构建。用一个 render(state) 函数做全量重绘，
  但对牌与筹码这类需要动画的元素做最小化 DOM diff（按 key 复用节点），避免动画被打断。
- WebSocket 地址：\`(location.protocol==='https:'?'wss://':'ws://') + location.host + '/ws'\`。
- token 存 localStorage 键名 \`poker_token\`，昵称存 \`poker_name\`（下次自动填）。
- 断线自动重连：指数退避 500ms→5s 封顶，重连成功后用 token 发 hello。顶部显示"重连中…"。
- 轮到自己时用 WebAudio 生成一声柔和提示音（OscillatorNode，短促两声，音量要小）；
  提供静音开关存 localStorage。
- 行动倒计时用 \`table.actionDeadline\` 与 \`serverNow\` 的差值算本地偏移，
  用 requestAnimationFrame 平滑推进（不要每帧重绘整个页面）。
- 快捷键：F 弃牌、C 过牌/跟注、R 打开加注面板、Enter 确认。
- 手机竖屏 360px 宽必须可用：牌桌用 CSS transform scale 或 clamp() 等比缩放，
  不出现横向滚动条，行动按钮足够大（最小 44px 高）。
- **绝对不引用任何外部 CDN、字体、图片**。font-family 用系统字体栈。
- 无障碍基本项：按钮有 aria-label，对话框可键盘操作。

写完用 \`node --check ${ROOT}/public/app.js\` 确认语法（它是浏览器脚本但语法能过 node 检查；
如果用了 ESM 顶层 await 之类，改成 IIFE 或普通脚本即可）。
你无法在浏览器里实测，所以要格外小心 JS 运行时错误：所有 state 字段访问都要做空值保护
（例如 seats 元素可能是 null、you.legal 可能是 null、result 可能是 null）。`,
  },
  {
    label: 'deploy-kit',
    prompt: `${PREAMBLE}
你的任务：实现 **部署套件与项目说明**。

创建这些文件：
1. \`${ROOT}/Dockerfile\`
2. \`${ROOT}/docker-compose.yml\`
3. \`${ROOT}/.dockerignore\`
4. \`${ROOT}/deploy/caddy-site.txt\`
5. \`${ROOT}/deploy/deploy.sh\`
6. \`${ROOT}/README.md\`

目标环境（重要，全部按这个来）：
- 一台 VPS，Debian 12，**只有 1GB 内存**，以 root 操作。
- 机器上已经在跑：容器 \`matrix-chat-caddy-1\`（占用宿主 80/443）与
  \`matrix-chat-continuwuity-1\`，compose 文件在 \`/root/matrix-chat/\`，
  Caddyfile 在 \`/root/matrix-chat/Caddyfile\`。
- 新站点域名 \`poker.ccswitch.online\`，DNS 在 Cloudflare（域名 ccswitch.online 已托管）。
- **绝对不能影响已有的 matrix 服务**：不抢 80/443，改 Caddyfile 前必须备份，
  reload 失败必须自动回滚到备份并重新 reload。

Dockerfile 要求：
- 基于 \`node:22-alpine\`，多阶段或单阶段都行但镜像要小。
- 先 COPY package*.json 再 \`npm ci --omit=dev\`（利用层缓存），然后 COPY 源码。
- 以非 root 用户（alpine 自带的 node 用户）运行。
- \`ENV NODE_ENV=production\`，\`EXPOSE 8080\`，
  \`HEALTHCHECK\` 用 node 单行脚本请求 \`http://127.0.0.1:8080/healthz\`（镜像里没有 curl）。
- 加 \`--max-old-space-size=128\` 之类的内存约束，因为宿主只有 1GB。

docker-compose.yml 要求：
- 服务名与容器名都是 \`poker\`，\`restart: unless-stopped\`。
- **不映射宿主端口**（由 Caddy 在同一 docker 网络内直连 \`poker:8080\`）。
- 接入外部网络：网络名从 \`.env\` 的 \`CADDY_NETWORK\` 变量读取，声明为 \`external: true\`。
- \`mem_limit: 200m\`，日志用 json-file 且 max-size 10m / max-file 3（防止 1GB 小机被日志撑爆）。
- 环境变量 \`PORT=8080\`、\`TZ=Asia/Shanghai\`。

deploy/caddy-site.txt：追加到现有 Caddyfile 的站点块，内容大致是
\`poker.ccswitch.online { encode zstd gzip; reverse_proxy poker:8080 }\`，
注意 Caddy v2 的 reverse_proxy 默认已正确透传 WebSocket 升级，不需要额外 matcher，
但要显式设置合理的 header（X-Real-IP 之类）并加注释说明。
块的首尾要加固定标记注释（例如 \`# >>> poker-table BEGIN\` / \`# <<< poker-table END\`）
以便脚本幂等替换。

deploy/deploy.sh 要求（这是重点，用户会在服务器上直接执行）：
- \`#!/usr/bin/env bash\` + \`set -euo pipefail\`，全部输出用中文，有清晰的步骤编号与彩色提示。
- 幂等：重复执行结果一致，不会重复追加 Caddyfile 块。
- 步骤：
  1. 前置检查：是否 root、docker 与 compose 插件是否可用、当前目录是否有 Dockerfile。
  2. 探测 Caddy 容器名（默认 \`matrix-chat-caddy-1\`，允许用环境变量 \`CADDY_CONTAINER\` 覆盖）
     与它所在的 docker 网络（\`docker inspect\` 取 NetworkSettings.Networks 的第一个键），
     写入 \`.env\` 的 \`CADDY_NETWORK\`。探测失败给出明确的中文报错和手工指定方式。
  3. 构建并启动：\`docker compose up -d --build\`；等待容器 healthy（轮询最多 60s）。
  4. 容器内自检：\`docker exec poker node -e ...\` 或从 caddy 容器里
     \`docker exec <caddy> wget -qO- http://poker:8080/healthz\` 验证网络互通。
  5. 备份 \`/root/matrix-chat/Caddyfile\` 到带时间戳的备份文件；用标记注释幂等地
     插入/替换 poker 站点块；\`docker exec <caddy> caddy validate --config /etc/caddy/Caddyfile\`
     校验（注意 Caddyfile 在容器内的路径可能不同，先用 docker inspect 读挂载点，
     取不到就退回 /etc/caddy/Caddyfile）；然后 \`caddy reload\`。
     校验或 reload 失败 → 恢复备份 + 重新 reload + 报错退出。
  6. 最终自检：\`curl -fsS -H 'Host: poker.ccswitch.online' http://127.0.0.1/healthz\` 与
     \`curl -fsS https://poker.ccswitch.online/healthz\`（后者失败只警告不失败，
     因为可能 DNS 还没配好/还在 Cloudflare 灰云状态）。
  7. 打印后续手工步骤（Cloudflare DNS 配置说明）。
- 提供 \`--rollback\` 参数：停掉 poker 容器并从 Caddyfile 移除站点块后 reload。

README.md 要求（中文）：
- 项目是什么、怎么玩（一句话）。
- 本地开发：\`npm install && npm start\`，浏览器开 http://localhost:8080 。
- 本地用 Docker 跑：命令示例。
- 服务器部署完整流程，**必须写清楚 Cloudflare DNS 的正确顺序**：
  先加 A 记录 \`poker\` → 服务器公网 IP 且**先设为"仅 DNS"(灰云)**，
  等 Caddy 签发到 Let's Encrypt 正式证书后，再切回"代理"(橙云) 并把 SSL/TLS 模式设为 Full，
  否则 Caddy 的 HTTP-01 挑战可能拿不到正式证书（上次部署 chat 子域名就踩过这个坑）。
- 运维：查看日志、重启、更新、回滚、备份位置。
- 已知限制：单房间、内存态、重启即清空、无鉴权（靠域名不公开）。
- 资源占用说明（1GB 小机上的预期内存占用）。

注意：\`deploy.sh\` 写完后用 \`bash -n\` 做语法检查。不要在本机真的执行它。`,
  },
]

const reports = await parallel(tasks.map(t => () =>
  agent(t.prompt, { label: t.label, phase: '实现' })
))

return tasks.map((t, i) => ({ module: t.label, report: reports[i] }))
