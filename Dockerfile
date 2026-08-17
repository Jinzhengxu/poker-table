# 德州扑克在线桌 —— 生产镜像
#
# 设计取舍：整个服务只有一个运行时依赖（ws），没有任何构建步骤，
# 所以不需要多阶段构建 —— 单阶段 + 精确的 COPY 白名单已经足够小
# （最终镜像 ≈ node:22-alpine 基础层 + 几十 KB 源码 + ws）。
FROM node:22-alpine

# NODE_ENV=production 会让 npm / Express 之类的库走生产分支；
# PORT / TZ 也给上默认值，compose 里可以覆盖。
ENV NODE_ENV=production \
    PORT=8080 \
    TZ=Asia/Shanghai

WORKDIR /app

# ---- 依赖层（改动最少，放最前面以命中层缓存）----
# 只拷贝依赖清单：源码变化时这一层仍然复用，重建镜像不必重新 npm ci。
# package-lock.json 后面的 * 是为了在极端情况下（没有 lock 文件）也不至于 COPY 直接失败，
# 真正没有 lock 时 npm ci 会给出清晰报错。
COPY package.json package-lock.json* ./

# --omit=dev      只装生产依赖（本项目测试用 node:test，零测试依赖）
# --ignore-scripts 禁止第三方包在安装期执行脚本，供应链更安全
# 最后把 /app 交给 node 用户，容器以非 root 身份运行
RUN npm ci --omit=dev --ignore-scripts \
 && npm cache clean --force \
 && chown -R node:node /app

# ---- 源码层（改动最频繁，放最后）----
# 只拷贝真正需要的两个目录，测试、部署脚本、文档都不进镜像。
COPY --chown=node:node server/ ./server/
COPY --chown=node:node public/ ./public/

# 非 root 运行：node:22-alpine 自带 uid/gid 1000 的 node 用户
USER node

EXPOSE 8080

# 镜像里没有 curl，用 node 自带的 fetch 做单行探活脚本。
# start-period 给 10s 冷启动缓冲；连续 3 次失败才判定 unhealthy。
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 宿主只有 1GB 内存（还跑着 matrix 的两个容器），把 V8 老生代压到 128MB，
# 让 GC 更早介入，避免堆无节制增长把整机拖进 OOM。
CMD ["node", "--max-old-space-size=128", "server/index.js"]
