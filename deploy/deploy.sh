#!/usr/bin/env bash
#
# 德州扑克在线桌 —— 一键部署 / 回滚脚本
#
# 在服务器（Debian 12，1GB 内存起）上以 root 执行：
#     cd /root/poker && bash deploy/deploy.sh
#
# 设计原则：
#   1. 幂等 —— 重复执行结果完全一致，Caddyfile 里的站点块按标记整块替换，不会越追加越多。
#   2. 绝不影响已有的 matrix 服务 —— 不占宿主端口，改 Caddyfile 前先备份，
#      validate / reload 任何一步失败都自动恢复备份并重新 reload。
#   3. 出错时给中文报错 + 明确的手工修复方式。
#
# 用法：
#   bash deploy/deploy.sh                部署或更新
#   bash deploy/deploy.sh --rollback     下线 poker 容器并从 Caddyfile 移除站点块
#   bash deploy/deploy.sh --help         查看帮助
#
# 可用环境变量覆盖默认值：
#   CADDY_CONTAINER   Caddy 容器名（默认 matrix-chat-caddy-1）
#   CADDY_NETWORK     Caddy 所在 docker 网络名（默认自动探测）
#   CADDYFILE_HOST    宿主上的 Caddyfile 路径（默认 /root/matrix-chat/Caddyfile）
#   POKER_DOMAIN      站点域名（必填，见下）
#   HEALTH_TIMEOUT    等待容器 healthy 的秒数（默认 60）
#
# POKER_DOMAIN 没有默认值——仓库里不写死任何人的域名。
# 一次性写进项目根目录的 .env（该文件在 .gitignore 里，不会进版本库）：
#     echo 'POKER_DOMAIN=poker.example.com' >> /root/poker/.env
# 之后直接 bash deploy/deploy.sh 即可；也可以临时 POKER_DOMAIN=... bash deploy/deploy.sh。
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$PROJECT_DIR/.env"

# .env 先于参数解析读入，好让 POKER_DOMAIN 等配置可以持久化在服务器本地。
# 真实环境变量优先级更高：set -a 之后再 source，已存在的变量不会被覆盖……
# 其实会被覆盖，所以这里先存后恢复。
if [[ -f "$ENV_FILE" ]]; then
  _env_domain_override="${POKER_DOMAIN:-}"
  set -a
  # .env 由部署时生成，静态分析期并不存在，所以告诉 shellcheck 不必追进去
  # shellcheck source=/dev/null
  . "$ENV_FILE"
  set +a
  [[ -n "$_env_domain_override" ]] && POKER_DOMAIN="$_env_domain_override"
  unset _env_domain_override
fi

# ------------------------------------------------------------------ 参数与常量
DOMAIN="${POKER_DOMAIN:-}"
CADDY_CONTAINER="${CADDY_CONTAINER:-matrix-chat-caddy-1}"
CADDYFILE_HOST="${CADDYFILE_HOST:-/root/matrix-chat/Caddyfile}"
CADDY_NETWORK="${CADDY_NETWORK:-}"      # 留空 = 自动探测
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-60}"
APP_CONTAINER="poker"

# TURN 中转（语音连麦用）。默认端口和 docker-compose.yml 里 coturn 的参数必须一致。
TURN_CONTAINER="poker-turn"
TURN_PORT="${POKER_TURN_PORT:-3478}"
TURN_RELAY_MIN=49160
TURN_RELAY_MAX=49200
TURN_ON=0                # setup_turn 里决定：1 = 这次要自建 coturn

# 服务器公网 IP —— 只用于最后打印「Cloudflare A 记录该填什么」。
# 脚本就跑在这台机器上，所以默认自动探测；探测不到就留占位符，自己照着填。
# 想手动指定：POKER_SERVER_IP=1.2.3.4 bash deploy/deploy.sh
SERVER_IP="${POKER_SERVER_IP:-$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.*src \([0-9.]*\).*/\1/p' || true)}"
SERVER_IP="${SERVER_IP:-<这台服务器的公网 IP>}"

# Caddyfile 里的幂等标记，必须与 deploy/caddy-site.txt 里的首尾两行完全一致
BEGIN_MARK='# >>> poker-table BEGIN'
END_MARK='# <<< poker-table END'

SITE_SNIPPET="$SCRIPT_DIR/caddy-site.txt"

WORK_DIR="$(mktemp -d)"
BACKUP_FILE=""          # 本次运行生成的 Caddyfile 备份路径
CADDY_MODIFIED=0        # 本次运行是否真的改写了 Caddyfile
CADDYFILE_IN_CONTAINER="/etc/caddy/Caddyfile"   # 真实值在 update_caddyfile 里探测
STEP=0

cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

# ------------------------------------------------------------------ 输出helper
if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[36m'; C_DIM=$'\033[2m'
else
  C_RESET=''; C_BOLD=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''; C_DIM=''
fi

step()  { STEP=$((STEP + 1)); printf '\n%s%s[步骤 %d] %s%s\n' "$C_BOLD" "$C_BLUE" "$STEP" "$*" "$C_RESET"; }
info()  { printf '    %s\n' "$*"; }
dim()   { printf '    %s%s%s\n' "$C_DIM" "$*" "$C_RESET"; }
ok()    { printf '    %s✔ %s%s\n' "$C_GREEN" "$*" "$C_RESET"; }
warn()  { printf '    %s⚠ %s%s\n' "$C_YELLOW" "$*" "$C_RESET"; }
die()   { printf '\n%s✘ 错误：%s%s\n' "$C_RED" "$*" "$C_RESET" >&2; exit 1; }

usage() {
  cat <<'EOF'
德州扑克在线桌 —— 部署脚本

  bash deploy/deploy.sh              部署 / 更新（幂等，可反复执行）
  bash deploy/deploy.sh --rollback   回滚：停掉 poker 容器 + 从 Caddyfile 移除站点块并 reload
  bash deploy/deploy.sh --help       显示本帮助

环境变量：CADDY_CONTAINER / CADDY_NETWORK / CADDYFILE_HOST / POKER_DOMAIN / HEALTH_TIMEOUT
          POKER_SERVER_IP（TURN 中转要用真实公网 IP，探测不到时手工指定）

语音连麦：脚本会自动生成 TURN 密钥、起一个 coturn 容器、放行端口并做连通性自检。
          不想要中转就在 .env 里写 POKER_VOICE=off（整个语音功能关掉），
          或者填上 POKER_TURN_USERNAME/POKER_TURN_CREDENTIAL 用别人家的 TURN。
          事后单独排查：docker exec poker node server/turn-check.js
EOF
}

# ------------------------------------------------------------------ 通用函数

# docker compose 包装：优先用插件版 `docker compose`。
# COMPOSE_PROFILES 由 setup_turn 决定要不要设成 turn —— coturn 服务挂在这个
# profile 下，没配 TURN 的部署就完全不会碰它。
dc() { docker compose "$@"; }

# 写入/更新 .env 里的一个键，幂等
env_set() {
  local key="$1" value="$2"
  if [[ ! -f "$ENV_FILE" ]]; then
    {
      printf '# 由 deploy/deploy.sh 自动生成，请勿手工乱改\n'
      printf '# CADDY_NETWORK 是 Caddy 容器所在的 docker 网络，docker-compose.yml 以 external 方式接入\n'
    } > "$ENV_FILE"
  fi
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    # 用 awk 重写，避免 sed 对特殊字符的转义问题
    awk -v k="$key" -v v="$value" '
      index($0, k "=") == 1 { print k "=" v; done = 1; next }
      { print }
      END { if (!done) print k "=" v }
    ' "$ENV_FILE" > "$WORK_DIR/env.new"
    cat "$WORK_DIR/env.new" > "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

# 读 .env 里某个键的值，读不到就返回空
env_get() {
  local key="$1"
  [[ -f "$ENV_FILE" ]] || return 0
  sed -n "s/^${key}=//p" "$ENV_FILE" | tail -n 1
}

# 生成一段随机十六进制。openssl 在最小化安装的 Debian 上不一定有，所以留了退路。
rand_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

# 等待容器 healthy（镜像里定义了 HEALTHCHECK）；没有 healthcheck 时退化为"进程在运行"
wait_healthy() {
  local name="$1" timeout="$2" waited=0 status running
  while [[ "$waited" -lt "$timeout" ]]; do
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}nohealth{{end}}' "$name" 2>/dev/null || echo missing)"
    case "$status" in
      healthy)
        printf '\n'; return 0 ;;
      unhealthy)
        printf '\n'; return 1 ;;
      nohealth)
        running="$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null || echo false)"
        if [[ "$running" == "true" ]]; then printf '\n'; return 0; fi ;;
      missing)
        printf '\n'; return 1 ;;
    esac
    sleep 2
    waited=$((waited + 2))
    printf '.'
  done
  printf '\n'
  return 1
}

# 探测 Caddyfile 在 caddy 容器内部的路径（读它的挂载表），取不到就回退 /etc/caddy/Caddyfile
detect_caddyfile_in_container() {
  local host_path="$1" src dst rel
  while IFS='|' read -r src dst; do
    if [[ -z "$src" ]]; then continue; fi
    if [[ "$src" == "$host_path" ]]; then
      printf '%s\n' "$dst"; return 0
    fi
    if [[ "$host_path" == "$src"/* ]]; then
      rel="${host_path#"$src"/}"
      printf '%s\n' "${dst%/}/$rel"; return 0
    fi
  done < <(docker inspect -f '{{range .Mounts}}{{.Source}}|{{.Destination}}{{"\n"}}{{end}}' "$CADDY_CONTAINER" 2>/dev/null || true)
  return 1
}

# 生成"去掉 poker 站点块"之后的 Caddyfile 内容到 $1
strip_block_to() {
  local out="$1"
  awk -v b="$BEGIN_MARK" -v e="$END_MARK" '
    index($0, b) { skip = 1; next }
    skip && index($0, e) { skip = 0; next }
    !skip { print }
  ' "$CADDYFILE_HOST" > "$out.raw"
  # 去掉文件尾部多余的空行（命令替换会吃掉末尾换行，printf 再补一个）
  printf '%s\n' "$(cat "$out.raw")" > "$out"
  rm -f "$out.raw"
}

# 备份 Caddyfile（带时间戳）
backup_caddyfile() {
  BACKUP_FILE="${CADDYFILE_HOST}.bak.$(date +%Y%m%d-%H%M%S)"
  cp -a "$CADDYFILE_HOST" "$BACKUP_FILE"
  ok "已备份原 Caddyfile → $BACKUP_FILE"
}

# 把内容写回 Caddyfile。
# 注意：必须用 `cat > 文件` 原地截断写入，绝不能用 mv！
# Caddyfile 多半是以【单文件 bind mount】挂进容器的，mv 会换掉 inode，
# 容器里看到的仍然是旧文件，reload 出来的效果会莫名其妙。
write_caddyfile() {
  local src="$1"
  cat "$src" > "$CADDYFILE_HOST"
}

# 从备份恢复并重新 reload（任何一步失败时的兜底）
restore_caddyfile() {
  if [[ -z "$BACKUP_FILE" || ! -f "$BACKUP_FILE" ]]; then
    warn "没有可用备份，Caddyfile 未被恢复（本次可能压根没改过它）"
    return 0
  fi
  warn "正在回滚 Caddyfile：$BACKUP_FILE → $CADDYFILE_HOST"
  write_caddyfile "$BACKUP_FILE"
  if docker exec "$CADDY_CONTAINER" caddy reload --config "$CADDYFILE_IN_CONTAINER" --adapter caddyfile >/dev/null 2>&1; then
    ok "已恢复到修改前的配置，matrix 服务不受影响"
  else
    warn "恢复后的 reload 也失败了！请手工检查："
    warn "  docker logs --tail 50 $CADDY_CONTAINER"
    warn "  docker exec $CADDY_CONTAINER caddy validate --config $CADDYFILE_IN_CONTAINER"
  fi
}

# ------------------------------------------------------------------ 各个步骤

check_prereq() {
  step "前置检查（root / docker / compose / 项目文件）"

  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    die "请以 root 执行本脚本（服务器上直接 root 登录，或 sudo bash deploy/deploy.sh）"
  fi
  ok "当前是 root"

  command -v docker >/dev/null 2>&1 || die "找不到 docker 命令。请先安装 docker：curl -fsSL https://get.docker.com | sh"
  docker info >/dev/null 2>&1 || die "docker 守护进程没跑起来。试试：systemctl start docker && systemctl enable docker"
  ok "docker 可用（$(docker --version)）"

  dc version >/dev/null 2>&1 || die "找不到 docker compose 插件（v2）。Debian 12 上安装：apt-get install -y docker-compose-plugin"
  ok "docker compose 可用（$(dc version --short 2>/dev/null || echo v2)）"

  [[ -f "$PROJECT_DIR/Dockerfile" ]] || die "在 $PROJECT_DIR 下找不到 Dockerfile，请把整个项目目录传到服务器后再运行本脚本"
  [[ -f "$PROJECT_DIR/docker-compose.yml" ]] || die "在 $PROJECT_DIR 下找不到 docker-compose.yml"
  [[ -f "$SITE_SNIPPET" ]] || die "找不到站点片段 $SITE_SNIPPET"
  ok "项目文件齐备（$PROJECT_DIR）"

  if ! command -v curl >/dev/null 2>&1; then
    warn "宿主没装 curl，最后的 HTTP 自检会跳过（apt-get install -y curl 可装上）"
  fi

  # 1GB 小机友情提示
  local mem_free
  mem_free="$(awk '/MemAvailable/{printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)"
  if [[ "$mem_free" -gt 0 && "$mem_free" -lt 200 ]]; then
    warn "可用内存只剩 ${mem_free}MB，构建镜像可能吃紧。建议先加 swap："
    dim "fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile"
  else
    dim "可用内存约 ${mem_free}MB"
  fi
}

detect_caddy() {
  step "探测 Caddy 容器与它所在的 docker 网络"

  if ! docker inspect "$CADDY_CONTAINER" >/dev/null 2>&1; then
    warn "找不到容器 $CADDY_CONTAINER，尝试在运行中的容器里自动搜索 caddy……"
    local guess
    guess="$(docker ps --format '{{.Names}}' | grep -i caddy | head -n 1 || true)"
    if [[ -n "$guess" ]]; then
      CADDY_CONTAINER="$guess"
      warn "自动选中容器：$CADDY_CONTAINER"
    else
      die "$(cat <<EOF
找不到任何 Caddy 容器。
当前运行中的容器：
$(docker ps --format '  {{.Names}}\t{{.Image}}' || true)
请用环境变量手工指定，例如：
  CADDY_CONTAINER=matrix-chat-caddy-1 bash deploy/deploy.sh
EOF
)"
    fi
  fi

  local running
  running="$(docker inspect -f '{{.State.Running}}' "$CADDY_CONTAINER")"
  if [[ "$running" != "true" ]]; then
    die "容器 $CADDY_CONTAINER 存在但没在运行。先把它拉起来：cd /root/matrix-chat && docker compose up -d"
  fi
  ok "Caddy 容器：$CADDY_CONTAINER（运行中）"

  if [[ -z "$CADDY_NETWORK" ]]; then
    # 取 NetworkSettings.Networks 的第一个键
    CADDY_NETWORK="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$CADDY_CONTAINER" | awk '{print $1}')"
  fi

  if [[ -z "$CADDY_NETWORK" ]]; then
    die "$(cat <<EOF
无法探测出 $CADDY_CONTAINER 所在的 docker 网络。
手工查看：docker inspect -f '{{json .NetworkSettings.Networks}}' $CADDY_CONTAINER
然后手工指定：CADDY_NETWORK=你看到的网络名 bash deploy/deploy.sh
EOF
)"
  fi
  if [[ "$CADDY_NETWORK" == "host" || "$CADDY_NETWORK" == "none" ]]; then
    die "$(cat <<EOF
$CADDY_CONTAINER 使用的是 $CADDY_NETWORK 网络模式，容器之间无法用服务名互相访问。
这种情况下 Caddy 需要反代到宿主 IP + 端口，请改成：
  1) 在 docker-compose.yml 里加 ports: ["127.0.0.1:8080:8080"]
  2) 把 deploy/caddy-site.txt 里的 reverse_proxy poker:8080 改成 reverse_proxy 172.17.0.1:8080
EOF
)"
  fi
  ok "Caddy 所在网络：$CADDY_NETWORK"

  env_set CADDY_NETWORK "$CADDY_NETWORK"
  ok "已写入 $ENV_FILE（CADDY_NETWORK=$CADDY_NETWORK）"
}

# ------------------------------------------------------------------ TURN

# 放行 TURN 需要的端口。没装防火墙的机器（Debian 12 默认就是）什么都不用做。
open_turn_ports() {
  local relay="${TURN_RELAY_MIN}:${TURN_RELAY_MAX}"
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qi 'Status: active'; then
    ufw allow "${TURN_PORT}/udp"  >/dev/null 2>&1 || true
    ufw allow "${TURN_PORT}/tcp"  >/dev/null 2>&1 || true
    ufw allow "${relay}/udp"      >/dev/null 2>&1 || true
    ok "ufw 已放行 ${TURN_PORT}/udp、${TURN_PORT}/tcp、${relay}/udp"
    return 0
  fi
  if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    firewall-cmd --permanent --add-port="${TURN_PORT}/udp" >/dev/null 2>&1 || true
    firewall-cmd --permanent --add-port="${TURN_PORT}/tcp" >/dev/null 2>&1 || true
    firewall-cmd --permanent --add-port="${TURN_RELAY_MIN}-${TURN_RELAY_MAX}/udp" >/dev/null 2>&1 || true
    firewall-cmd --reload >/dev/null 2>&1 || true
    ok "firewalld 已放行 ${TURN_PORT}/udp、${TURN_PORT}/tcp、${TURN_RELAY_MIN}-${TURN_RELAY_MAX}/udp"
    return 0
  fi
  dim "宿主没有启用 ufw / firewalld，不需要额外放行"
  # 云厂商的安全组是在机器外面的，脚本看不见也改不了，只能提醒
  dim "如果服务商控制台上还有一层安全组，记得放行 ${TURN_PORT}/udp 和 ${relay}/udp"
  return 0
}

setup_turn() {
  step "配置 TURN 中转（异地之间的语音全靠它）"

  local voice_off=0
  case "$(printf '%s' "${POKER_VOICE:-on}" | tr 'A-Z' 'a-z')" in
    0|false|no|off) voice_off=1 ;;
  esac
  if [[ "$voice_off" -eq 1 ]]; then
    warn "POKER_VOICE 是关的，跳过 TURN（语音功能本身就没开）"
    return 0
  fi

  # 已经在用别人家的 TURN 服务：尊重现有配置，不自建、不覆盖
  if [[ -n "${POKER_TURN_USERNAME:-}" && -n "${POKER_TURN_CREDENTIAL:-}" && -z "${POKER_TURN_SECRET:-}" ]]; then
    ok "检测到已配置外部 TURN（固定账号密码），不自建 coturn"
    dim "地址：${POKER_TURN_URL:-<没填 POKER_TURN_URL，TURN 不会生效>}"
    return 0
  fi

  # 自建 coturn 需要一个能被外网直接打到的 IP。这里必须是【真实公网 IP】：
  # TURN 走的是 UDP，Cloudflare 的橙云只代理 HTTP，代理不了它，
  # 所以不能用域名混过去，得把 IP 明明白白告诉浏览器。
  if [[ ! "$SERVER_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    warn "没能自动探测出这台机器的公网 IP，跳过 TURN 自建。"
    warn "手工指定后重跑即可：POKER_SERVER_IP=1.2.3.4 bash deploy/deploy.sh"
    return 0
  fi

  # 密钥只生成一次并存进 .env。每次部署换一个的话，正在通话的人会被踢下来，
  # 而且 poker 和 coturn 两个容器重启有先后，中间会出现一段密钥对不上的窗口。
  local secret
  secret="$(env_get POKER_TURN_SECRET)"
  secret="${POKER_TURN_SECRET:-$secret}"
  if [[ -z "$secret" ]]; then
    secret="$(rand_hex)"
    if [[ -z "$secret" ]]; then
      warn "生成随机密钥失败（既没有 openssl 也读不到 /dev/urandom），跳过 TURN"
      return 0
    fi
    env_set POKER_TURN_SECRET "$secret"
    ok "已生成 TURN 密钥并写入 $ENV_FILE（只在这台机器上，不会进 git）"
  else
    ok "复用 $ENV_FILE 里已有的 TURN 密钥"
  fi

  # UDP 是主路；再挂一条 TCP，给那些把 UDP 全封了的网络（部分公司网、酒店网）兜底。
  env_set POKER_TURN_URL   "turn:${SERVER_IP}:${TURN_PORT},turn:${SERVER_IP}:${TURN_PORT}?transport=tcp"
  env_set POKER_TURN_IP    "$SERVER_IP"
  env_set POKER_TURN_REALM "${DOMAIN:-poker}"
  ok "TURN 地址：turn:${SERVER_IP}:${TURN_PORT}（UDP + TCP）"

  open_turn_ports

  TURN_ON=1
  export COMPOSE_PROFILES=turn
  dim "本次会一并启动 coturn 容器（$TURN_CONTAINER）"
}

# 起来之后真的开一条中转通道试试。端口开着但密钥对不上，浏览器一样连不通，
# 所以只看"容器在运行"是不够的。检查脚本在镜像里：server/turn-check.js
check_turn() {
  [[ "$TURN_ON" -eq 1 ]] || return 0
  step "TURN 连通性自检（真的去开一条中转通道）"

  if ! docker inspect "$TURN_CONTAINER" >/dev/null 2>&1; then
    warn "找不到容器 $TURN_CONTAINER，coturn 可能没起来"
    return 0
  fi
  local running
  running="$(docker inspect -f '{{.State.Running}}' "$TURN_CONTAINER" 2>/dev/null || echo false)"
  if [[ "$running" != "true" ]]; then
    warn "容器 $TURN_CONTAINER 没在运行，最近 30 行日志："
    docker logs --tail 30 "$TURN_CONTAINER" 2>&1 | sed 's/^/      /' || true
    return 0
  fi
  ok "coturn 容器运行中"

  # 在 poker 容器里跑，读到的就是它自己那份环境变量——
  # 正好把"配置有没有真的传进容器"这一环也一起验了。
  if docker exec "$APP_CONTAINER" node server/turn-check.js 2>&1 | sed 's/^/      /'; then
    ok "TURN 自检通过：异地之间的语音有中转兜底了"
  else
    warn "TURN 自检没通过（上面有具体是哪一步断的）。"
    warn "语音在同一个局域网里仍然能用，异地之间可能还是听不见。"
    warn "常见原因：服务商控制台的安全组没放行 ${TURN_PORT}/udp 与 ${TURN_RELAY_MIN}-${TURN_RELAY_MAX}/udp"
  fi
}

build_and_start() {
  step "构建镜像并启动 poker 容器（不映射任何宿主端口）"

  cd "$PROJECT_DIR"
  dc up -d --build || die "docker compose up 失败，请看上面的构建日志"
  ok "容器已启动"

  info "等待容器变成 healthy（最多 ${HEALTH_TIMEOUT}s）"
  printf '    '
  if wait_healthy "$APP_CONTAINER" "$HEALTH_TIMEOUT"; then
    ok "容器 $APP_CONTAINER 健康"
  else
    warn "容器在 ${HEALTH_TIMEOUT}s 内没有变成 healthy，最近 40 行日志："
    docker logs --tail 40 "$APP_CONTAINER" 2>&1 | sed 's/^/      /' || true
    die "poker 容器未就绪，已中止（Caddyfile 尚未做任何修改，matrix 服务不受影响）"
  fi

  if [[ "$TURN_ON" -eq 1 ]]; then
    info "等待 coturn 就绪"
    printf '    '
    if wait_healthy "$TURN_CONTAINER" 30; then
      ok "容器 $TURN_CONTAINER 健康"
    else
      # coturn 起不来不该拖垮整个部署：牌桌照常能玩，只是异地语音没有中转兜底
      warn "coturn 没能就绪，最近 30 行日志："
      docker logs --tail 30 "$TURN_CONTAINER" 2>&1 | sed 's/^/      /' || true
      warn "牌桌本身不受影响，继续部署；语音在异地之间可能连不通"
      TURN_ON=0
    fi
  fi

  # 确认容器真的挂在 Caddy 的网络上，否则 reverse_proxy poker:8080 会 502
  if docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$APP_CONTAINER" | grep -qwF -- "$CADDY_NETWORK"; then
    ok "poker 已接入网络 $CADDY_NETWORK"
  else
    die "poker 没有接入 $CADDY_NETWORK，请检查 .env 与 docker-compose.yml 的 networks 配置"
  fi
}

self_check_container() {
  step "容器内自检与容器间连通性检查"

  if docker exec "$APP_CONTAINER" node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>r.text()).then(t=>{if(t.trim()!=='ok'){console.error('返回内容异常:',t);process.exit(1)}process.exit(0)}).catch(e=>{console.error(e.message);process.exit(1)})" >/dev/null 2>&1; then
    ok "容器内 http://127.0.0.1:8080/healthz 返回 ok"
  else
    docker logs --tail 30 "$APP_CONTAINER" 2>&1 | sed 's/^/      /' || true
    die "容器内自检失败：服务没有正常响应 /healthz"
  fi

  # 从 Caddy 容器里访问 poker:8080，验证 docker DNS + 网络互通
  if docker exec "$CADDY_CONTAINER" wget -q -T 5 -O - "http://${APP_CONTAINER}:8080/healthz" >/dev/null 2>&1; then
    ok "Caddy 容器可以访问 http://${APP_CONTAINER}:8080/healthz"
  elif docker exec "$CADDY_CONTAINER" curl -fsS --max-time 5 "http://${APP_CONTAINER}:8080/healthz" >/dev/null 2>&1; then
    ok "Caddy 容器可以访问 http://${APP_CONTAINER}:8080/healthz（用 curl 验证）"
  else
    warn "在 Caddy 容器里没能验证连通性（可能是镜像里既没有 wget 也没有 curl）。"
    warn "若稍后访问出现 502，请手工排查：docker exec $CADDY_CONTAINER wget -qO- http://${APP_CONTAINER}:8080/healthz"
  fi
}

# 修改 Caddyfile：$1 = add | remove
update_caddyfile() {
  local mode="$1"
  if [[ "$mode" == "add" ]]; then
    step "备份并幂等更新 Caddyfile（$CADDYFILE_HOST）"
  else
    step "从 Caddyfile 移除 poker 站点块"
  fi

  [[ -f "$CADDYFILE_HOST" ]] || die "找不到 $CADDYFILE_HOST。若路径不同请用 CADDYFILE_HOST=/xxx/Caddyfile 指定"

  # 站点片段的首尾标记必须和脚本一致，否则幂等替换会失效
  if [[ "$mode" == "add" ]]; then
    grep -qF -- "$BEGIN_MARK" "$SITE_SNIPPET" || die "$SITE_SNIPPET 缺少起始标记：$BEGIN_MARK"
    grep -qF -- "$END_MARK"   "$SITE_SNIPPET" || die "$SITE_SNIPPET 缺少结束标记：$END_MARK"
  fi

  local new="$WORK_DIR/Caddyfile.new"
  strip_block_to "$new"
  if [[ "$mode" == "add" ]]; then
    printf '\n' >> "$new"
    # 片段里的 __DOMAIN__ 占位符换成真实域名。域名只含字母数字点和连字符，
    # 不会撞上 sed 的分隔符，所以直接用 | 作分隔即可。
    sed "s|__DOMAIN__|${DOMAIN}|g" "$SITE_SNIPPET" >> "$new"
  fi

  # 容器内路径（validate / reload 都要用）
  CADDYFILE_IN_CONTAINER="$(detect_caddyfile_in_container "$CADDYFILE_HOST" || true)"
  if [[ -z "$CADDYFILE_IN_CONTAINER" ]]; then
    CADDYFILE_IN_CONTAINER="/etc/caddy/Caddyfile"
    warn "没能从挂载表里推断出容器内路径，回退到默认值 $CADDYFILE_IN_CONTAINER"
  else
    dim "容器内 Caddyfile 路径：$CADDYFILE_IN_CONTAINER"
  fi
  if ! docker exec "$CADDY_CONTAINER" sh -c "test -f '$CADDYFILE_IN_CONTAINER'" >/dev/null 2>&1; then
    warn "容器内 $CADDYFILE_IN_CONTAINER 不存在，改用 /etc/caddy/Caddyfile 再试"
    CADDYFILE_IN_CONTAINER="/etc/caddy/Caddyfile"
  fi

  if cmp -s "$new" "$CADDYFILE_HOST"; then
    ok "Caddyfile 已是目标状态，无需修改（幂等）"
    CADDY_MODIFIED=0
  else
    backup_caddyfile
    write_caddyfile "$new"
    CADDY_MODIFIED=1
    if [[ "$mode" == "add" ]]; then
      ok "已插入/替换 $DOMAIN 站点块"
    else
      ok "已移除 $DOMAIN 站点块"
    fi
  fi

  # ---- 校验 ----
  local out
  if out="$(docker exec "$CADDY_CONTAINER" caddy validate --config "$CADDYFILE_IN_CONTAINER" --adapter caddyfile 2>&1)"; then
    ok "caddy validate 通过"
  else
    printf '%s\n' "$out" | sed 's/^/      /'
    restore_caddyfile
    die "Caddyfile 校验失败，已回滚到备份。请检查 deploy/caddy-site.txt 的语法"
  fi

  # ---- reload ----
  if out="$(docker exec "$CADDY_CONTAINER" caddy reload --config "$CADDYFILE_IN_CONTAINER" --adapter caddyfile 2>&1)"; then
    ok "caddy reload 成功（matrix 站点在此过程中不中断）"
  else
    printf '%s\n' "$out" | sed 's/^/      /'
    restore_caddyfile
    die "caddy reload 失败，已回滚到备份并重新 reload"
  fi
}

final_check() {
  step "最终自检"

  if ! command -v curl >/dev/null 2>&1; then
    warn "宿主没有 curl，跳过 HTTP 自检。请直接用浏览器打开 https://$DOMAIN/ 验证"
    return 0
  fi

  # 1) 本机 80 端口 + Host 头：验证 Caddy 已经认得这个域名
  local code
  code="$(curl -s -o "$WORK_DIR/h1" -w '%{http_code}' --max-time 10 -H "Host: $DOMAIN" "http://127.0.0.1/healthz" || echo 000)"
  case "$code" in
    200) ok "本机 http://127.0.0.1/healthz（Host: $DOMAIN）→ 200 $(tr -d '\n' < "$WORK_DIR/h1")" ;;
    301|302|307|308) ok "本机 HTTP 返回 $code —— Caddy 正把 http 跳到 https，属正常" ;;
    000) warn "本机 80 端口没有响应，检查 $CADDY_CONTAINER 是否映射了 80/443" ;;
    *)   warn "本机 HTTP 返回 $code（502 通常意味着 Caddy 连不上 poker:8080）" ;;
  esac

  # 2) 绕过 DNS，直接对本机 443 做 TLS 自检。
  #    -k 是必须的：此刻证书可能还是 Caddy 的内部签发证书（灰云未生效前）
  local body
  if body="$(curl -sk --max-time 10 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/healthz" 2>/dev/null)"; then
    if [[ "$(printf '%s' "$body" | tr -d '[:space:]')" == "ok" ]]; then
      ok "本机 https://$DOMAIN/healthz（--resolve 直连）→ ok，反代链路通了"
    else
      warn "本机 HTTPS 返回内容不是 ok：$(printf '%s' "$body" | head -c 200)"
    fi
  else
    warn "本机 HTTPS 自检失败（证书可能还没签发好，稍等 1 分钟再试）"
  fi

  # 3) 走真实 DNS 的公网自检 —— 失败只警告，因为 DNS/灰云可能还没配好
  if curl -fsS --max-time 15 "https://$DOMAIN/healthz" >/dev/null 2>&1; then
    ok "公网 https://$DOMAIN/healthz 可访问，部署完成 🎉"
  else
    warn "公网 https://$DOMAIN/healthz 暂时访问不到 —— 如果 DNS 还没配（见下面的说明），这是正常的"
  fi
}

print_next_steps() {
  cat <<EOF

${C_BOLD}${C_GREEN}==================== 部署完成 ====================${C_RESET}

${C_BOLD}接下来的手工步骤：Cloudflare DNS（顺序很重要，别跳步）${C_RESET}

  1) 登录 Cloudflare → 域名 ${DOMAIN#*.} → DNS → 添加记录
        类型: A
        名称: ${DOMAIN%%.*}
        内容: ${SERVER_IP}
        代理状态: ${C_YELLOW}仅 DNS（灰云）${C_RESET}   ← 第一次必须是灰云！
        TTL:  自动

  2) 等 1~2 分钟 DNS 生效后，访问 https://${DOMAIN}/
     Caddy 会走 Let's Encrypt 的 HTTP-01 挑战自动签发正式证书。
     观察签发进度：docker logs -f ${CADDY_CONTAINER} | grep -i certificate

  3) ${C_BOLD}确认拿到正式证书后${C_RESET}（浏览器地址栏的证书颁发者是 Let's Encrypt），
     再把该记录切回 ${C_YELLOW}已代理（橙云）${C_RESET}，
     并在 SSL/TLS → 概述里把加密模式设为 ${C_BOLD}Full${C_RESET}（完全）。

     ${C_DIM}为什么？橙云会把 80 端口的 HTTP-01 挑战拦在 Cloudflare 边缘，
     Caddy 拿不到正式证书就会退回内部自签证书，配上 Flexible 模式就会
     变成无限重定向或证书报错 —— 上次部署 chat 子域名踩过这个坑。${C_RESET}

$( [[ "$TURN_ON" -eq 1 ]] && cat <<TURNEOF

${C_BOLD}语音连麦的 TURN 中转已就绪${C_RESET}
  地址 turn:${SERVER_IP}:${TURN_PORT}（UDP 为主，TCP 兜底），密钥存在 ${ENV_FILE}。

  ${C_BOLD}这里用的是 IP 而不是域名，是故意的：${C_RESET}TURN 走 UDP，
  Cloudflare 的橙云只代理 HTTP，代不了它。所以中转地址必须是真实公网 IP，
  这也意味着${C_YELLOW}你的服务器 IP 会出现在网页的 ICE 配置里${C_RESET}——
  能进这张牌桌的人本来就能看到，介意的话就把语音关掉（POKER_VOICE=off）。

  ${C_BOLD}还要确认的一件事：${C_RESET}如果服务商控制台上有安全组，
  放行 ${C_BOLD}${TURN_PORT}/udp${C_RESET} 和 ${C_BOLD}${TURN_RELAY_MIN}-${TURN_RELAY_MAX}/udp${C_RESET}。
  脚本改得了机器里的 ufw，改不了机器外面那层。

  ${C_DIM}带宽提示：只有打不通洞的那几对人才会走中转，能直连的仍然点对点。
  真走中转时，一路语音双向约 8KB/s 过这台机器。${C_RESET}
TURNEOF
)
${C_BOLD}常用运维命令：${C_RESET}
  查看日志      docker logs -f ${APP_CONTAINER}
  重启          docker restart ${APP_CONTAINER}
  更新代码后重部署   cd ${PROJECT_DIR} && bash deploy/deploy.sh
  下线并清理    bash deploy/deploy.sh --rollback
  资源占用      docker stats --no-stream ${APP_CONTAINER}
  ${C_BOLD}语音打不通时先跑这个${C_RESET}   docker exec ${APP_CONTAINER} node server/turn-check.js
  TURN 日志     docker logs -f ${TURN_CONTAINER}

${C_BOLD}Caddyfile 备份：${C_RESET}${CADDYFILE_HOST}.bak.*  （本次$( [[ "$CADDY_MODIFIED" -eq 1 ]] && printf '已生成 %s' "$BACKUP_FILE" || printf '未修改，无新备份' )）

EOF
}

require_domain() {
  [[ -n "$DOMAIN" ]] && return 0
  die "没有设置站点域名。写进 .env 一次即可，之后不用再管：

    echo 'POKER_DOMAIN=poker.example.com' >> ${ENV_FILE}

  或者本次临时指定：POKER_DOMAIN=poker.example.com bash deploy/deploy.sh"
}

do_deploy() {
  require_domain
  printf '%s%s德州扑克在线桌 —— 开始部署（域名 %s）%s\n' "$C_BOLD" "$C_BLUE" "$DOMAIN" "$C_RESET"
  check_prereq
  detect_caddy
  setup_turn
  build_and_start
  self_check_container
  check_turn
  update_caddyfile add
  final_check
  print_next_steps
}

do_rollback() {
  printf '%s%s德州扑克在线桌 —— 回滚（下线 poker 并清理 Caddyfile）%s\n' "$C_BOLD" "$C_YELLOW" "$C_RESET"
  check_prereq
  detect_caddy

  step "停止并移除 poker 容器"
  cd "$PROJECT_DIR"
  # down 不会启动任何东西，但要带上 profile 才认得 coturn 这个服务，否则它会被留下
  export COMPOSE_PROFILES=turn
  if dc down --remove-orphans >/dev/null 2>&1; then
    ok "docker compose down 完成"
  else
    warn "docker compose down 失败（可能 .env 缺失），改用 docker rm -f"
    docker rm -f "$APP_CONTAINER" "$TURN_CONTAINER" >/dev/null 2>&1 || true
    ok "容器 $APP_CONTAINER / $TURN_CONTAINER 已移除（若本来就不存在则忽略）"
  fi

  update_caddyfile remove

  cat <<EOF

${C_BOLD}${C_GREEN}回滚完成。${C_RESET}
  · poker 容器已停止，Caddyfile 里的站点块已移除并 reload。
  · matrix 相关服务未受影响。
  · 镜像仍保留（docker rmi poker-table:latest 可删除）。
  · Cloudflare 上的 A 记录需要你手工删除（如果不再需要）。

EOF
}

# ------------------------------------------------------------------ 入口
case "${1:-}" in
  --rollback|-r) do_rollback ;;
  --help|-h)     usage ;;
  "")            do_deploy ;;
  *)             usage; die "未知参数：$1" ;;
esac
