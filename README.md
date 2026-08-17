# 德州扑克在线桌

免登录的单桌在线德州扑克，给朋友之间开局用。打开网页 → 点空座位 → 输个昵称 → 就能玩。
完整的无限注规则：盲注、按钮轮转、四条街下注、全下与边池、摊牌自动比大小、自动分配筹码。

- **免登录**：没有账号系统，昵称即身份，头像按昵称自动生成。
- **单张牌桌**：整个服务只有一桌、8 个座位，状态全在内存里。
- **断线不丢座**：座位令牌存在浏览器里，刷新或掉线重连回到原座位、原筹码。
- **手机能玩**：竖屏适配，牌桌等比缩放，按钮尺寸适合拇指。
- **零外部依赖**：前端不引用任何 CDN、字体、图片，牌面全用 CSS 画；后端只依赖 `ws`。

## 怎么玩

1. 第一个入座的人是**房主**，可以改盲注、补充筹码、踢人、重置牌桌（右侧「设置」页）。
2. 有 2 人及以上有筹码时自动开局，每手结束后默认 6 秒开下一手。
3. 轮到你时底部出现行动条：`弃牌 / 过牌 / 跟注 N / 下注·加注`，加注支持滑杆与
   `½ 池 / ⅔ 池 / 底池 / 全下` 快捷键。快捷键：`F` 弃牌、`C` 过牌或跟注、`R` 加注、`Enter` 确认。
4. 超时（默认 45 秒）自动帮你过牌，不能过牌就弃牌，不会卡住整桌人。

默认配置：盲注 5/10、前注 0、起始筹码 1000、行动时限 45 秒、自动开局开启。全部可在设置里改。

## 本地开发

```bash
npm install
npm start                      # 默认 8080 端口
# 浏览器打开 http://localhost:8080
```

想一个人试玩，开两个浏览器（或一个正常窗口 + 一个隐私窗口）分别入座即可——
同一浏览器的两个标签页会被认成同一个人，这是刻意的（防止一个人占两个座）。

跑测试：

```bash
npm test                       # 引擎 + 牌型评估器的单元测试
```

用 Docker 在本地跑：

```bash
docker build -t poker-table:local .
docker run --rm -p 8080:8080 poker-table:local
```

## 服务器部署

目标环境是一台 Debian 12 的小 VPS（1GB 内存够用），
上面已经跑着 Matrix/Element 那套（`matrix-chat-caddy-1` 占着宿主 80/443）。
本服务**不抢宿主端口**，而是接入 Caddy 所在的 docker 网络，由现有 Caddy 反代 `poker:8080`。

### 一、把代码放到服务器上

在服务器上以 root 执行：

```bash
apt-get update && apt-get install -y git
git clone https://github.com/Jinzhengxu/poker-table.git /root/poker
```

以后更新就是 `cd /root/poker && git pull && bash deploy/deploy.sh`。

### 二、跑部署脚本

```bash
cd /root/poker
bash deploy/deploy.sh
```

脚本会自动完成：探测 Caddy 容器与它所在的 docker 网络 → 构建并启动 poker 容器 →
等待容器 healthy → 备份 Caddyfile → 幂等插入站点块 → `caddy validate` + `caddy reload` → 自检。

**安全保证**：改 Caddyfile 之前一定先备份；`validate` 或 `reload` 任何一步失败都会自动恢复备份
并重新 reload，不会把已有的 Matrix 服务搞挂。脚本可以反复执行，结果一致。

### 三、配置 Cloudflare DNS（顺序很重要）

> 这一步的顺序上次部署 `chat` 子域名时踩过坑，务必按下面来。

1. Cloudflare → `ccswitch.online` → DNS → 添加记录：
   - 类型 `A`，名称 `poker`，内容填**这台服务器的公网 IP**
     （部署脚本跑完会在最后直接把它打印出来）
   - 代理状态先选 **仅 DNS（灰云）**
2. 等 1~2 分钟 DNS 生效，访问 `https://poker.ccswitch.online/`。
   Caddy 会走 Let's Encrypt 的 HTTP-01 挑战签发**正式证书**。
   看进度：`docker logs -f matrix-chat-caddy-1 | grep -i certificate`
3. 确认证书颁发者是 Let's Encrypt 之后，再把记录切回 **已代理（橙云）**，
   并把 SSL/TLS 加密模式设为 **Full**。

为什么不能一上来就开橙云：橙云会把 80 端口的 HTTP-01 挑战拦在 Cloudflare 边缘，
Caddy 拿不到正式证书就退回内部自签证书，再配上 Flexible 模式就会变成无限重定向或证书报错。

WebSocket 走 Cloudflare 橙云是原生支持的，不需要额外开关。

## 运维

```bash
docker logs -f poker                      # 看日志
docker restart poker                      # 重启（内存态会清空，等于重开一桌）
cd /root/poker && bash deploy/deploy.sh   # 改完代码重新部署
bash deploy/deploy.sh --rollback          # 下线：停容器 + 从 Caddyfile 摘掉站点块
```

- Caddyfile 备份在 `/root/matrix-chat/` 下，文件名带时间戳。
- 容器内存上限 200M，日志上限 10M × 3 份。
- `.env` 里的 `CADDY_NETWORK` 是脚本探测出来的 docker 网络名，不要手工乱改。

## 资源占用

实测容器稳定在 **约 18 MB 内存**（上限设的 200M，留了很大余量），镜像约 236 MB。
在跑着 Matrix 的 1GB 小机上再加这一个服务没有压力。

## 已知限制

- **只有一张桌子**：整个服务同时只能进行一局。想同时开两桌需要跑第二个实例 + 第二个子域名。
- **状态在内存里**：进程重启（`docker restart`、服务器重启、部署更新）会清空牌桌，
  所有人筹码回到初始值。这是刻意的取舍——朋友局不需要持久化，省掉一整个数据库。
- **没有鉴权**：知道网址的人就能入座。靠"不公开这个子域名"来控制，别发到公开场合。
- **筹码没有真实价值**：纯记分，不涉及任何真实结算。
- 断线玩家的座位保留 15 分钟，超时自动离座，避免死人占座。

## 项目结构

```
server/
  index.js      HTTP 静态服务 + WebSocket 入口、输入校验、限流、心跳
  room.js       房间：座位、令牌、断线重连、计时器、状态快照脱敏下发
  engine.js     单手牌状态机：盲注、下注轮、边池分层、摊牌分配
  evaluator.js  7 张牌取最优 5 张的牌型评估
  deck.js       牌堆与密码学安全洗牌
  protocol.js   共享常量
public/         零构建前端（HTML + CSS + 原生 JS）
test/           node:test 单元测试
deploy/         部署脚本与 Caddy 站点片段
SPEC.md         前后端接口契约（改协议先改这里）
```

前后端之间的消息格式、状态快照结构全部定义在 `SPEC.md`，改任何一边之前先看它。
