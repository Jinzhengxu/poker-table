// SPDX-License-Identifier: GPL-3.0-or-later
//
// 从环境变量读取牌桌的【初始】配置。
//
// 为什么需要：牌桌配置存在内存里，容器一重启就回到 DEFAULT_CONFIG。
// 房主每次部署完都要重新点一遍盲注和起始筹码，很烦——尤其是只能靠
// VNC 控制台操作那台机器的时候。写进 .env 就一劳永逸。
//
// 层次关系（后者覆盖前者）：
//   protocol.js 的 DEFAULT_CONFIG  ->  环境变量  ->  房主在设置页改
// 环境变量只决定【启动时】的值，房主仍然可以随时在页面上改，
// 只是那个改动依旧是内存态，重启后回到环境变量给的值。
//
// 校验范围与 room.js 的 setConfig 完全一致——不能让环境变量设出
// 一个 UI 会拒绝的值，否则房主打开设置页保存一下就会被打回。

import { createHmac } from 'node:crypto';
import { DEFAULT_CONFIG } from './protocol.js';
import { DEFAULT_GD_CONFIG } from './guandan/room.js';
import { MAX_VOICE_MEMBERS } from './voice.js';

/** 每个字段的解析方式与取值范围。范围必须和 room.js setConfig 保持一致。 */
const FIELDS = [
  { key: 'smallBlind',      env: 'POKER_SMALL_BLIND',     kind: 'int',  min: 1,    max: 1000000 },
  { key: 'bigBlind',        env: 'POKER_BIG_BLIND',       kind: 'int',  min: 1,    max: 2000000 },
  { key: 'ante',            env: 'POKER_ANTE',            kind: 'int',  min: 0,    max: 1000000 },
  { key: 'startingStack',   env: 'POKER_STARTING_STACK',  kind: 'int',  min: 1,    max: 100000000 },
  // 时间类用【秒】填，比毫秒好写；内部仍存毫秒
  { key: 'actionTimeoutMs', env: 'POKER_ACTION_TIMEOUT',  kind: 'sec',  min: 5000, max: 300000 },
  { key: 'autoNextHandMs',  env: 'POKER_NEXT_HAND_DELAY', kind: 'sec',  min: 1000, max: 60000 },
  { key: 'autoNextHand',    env: 'POKER_AUTO_NEXT_HAND',  kind: 'bool' },
];

/**
 * @param {object} [env]     默认 process.env
 * @param {object} [logger]  出错时往哪儿喊，默认 console
 * @returns {typeof DEFAULT_CONFIG}
 */
export function configFromEnv(env = process.env, logger = console) {
  const cfg = { ...DEFAULT_CONFIG };
  const applied = [];

  // POKER_BLINDS=100/200 是简写，等价于同时设小盲和大盲。
  // 单独的 POKER_SMALL_BLIND / POKER_BIG_BLIND 优先级更高。
  const blinds = str(env.POKER_BLINDS);
  if (blinds) {
    const m = blinds.match(/^\s*(\d+)\s*\/\s*(\d+)\s*$/);
    if (!m) {
      logger.error(`[config] POKER_BLINDS="${blinds}" 格式不对，应该像 100/200，已忽略`);
    } else {
      const sb = clampInt(m[1], 1, 1000000);
      const bb = clampInt(m[2], 1, 2000000);
      if (sb === null || bb === null) {
        logger.error(`[config] POKER_BLINDS="${blinds}" 数值超出范围，已忽略`);
      } else {
        cfg.smallBlind = sb;
        cfg.bigBlind = bb;
        applied.push(`盲注 ${sb}/${bb}`);
      }
    }
  }

  for (const f of FIELDS) {
    const raw = str(env[f.env]);
    if (raw === null) continue;

    if (f.kind === 'bool') {
      const v = parseBool(raw);
      if (v === null) {
        logger.error(`[config] ${f.env}="${raw}" 不是布尔值（用 true/false 或 1/0），已忽略`);
        continue;
      }
      cfg[f.key] = v;
      applied.push(`${f.env}=${v}`);
      continue;
    }

    // sec：填的是秒，内部存毫秒
    const scaled = f.kind === 'sec' ? Number(raw) * 1000 : raw;
    const v = clampInt(scaled, f.min, f.max);
    if (v === null) {
      const lo = f.kind === 'sec' ? f.min / 1000 : f.min;
      const hi = f.kind === 'sec' ? f.max / 1000 : f.max;
      logger.error(`[config] ${f.env}="${raw}" 不合法（需要 ${lo}~${hi} 的整数），已忽略`);
      continue;
    }
    cfg[f.key] = v;
    applied.push(`${f.env}=${raw}`);
  }

  // 与 setConfig 同样的交叉校验：大盲不能小于小盲。
  // 这里不能只报错了事——留着会让房主一打开设置页保存就被拒。
  if (cfg.bigBlind < cfg.smallBlind) {
    logger.error(
      `[config] 大盲注 ${cfg.bigBlind} 小于小盲注 ${cfg.smallBlind}，` +
      `盲注设置整体回退到默认的 ${DEFAULT_CONFIG.smallBlind}/${DEFAULT_CONFIG.bigBlind}`
    );
    cfg.smallBlind = DEFAULT_CONFIG.smallBlind;
    cfg.bigBlind = DEFAULT_CONFIG.bigBlind;
  }

  if (applied.length) {
    logger.log?.(`[config] 环境变量覆盖了牌桌初始设置：${applied.join('，')}`);
  }
  return cfg;
}


/** 掼蛋桌的环境变量，规则与上面德州那套一致 */
const GD_FIELDS = [
  { key: 'actionTimeoutMs', env: 'GUANDAN_ACTION_TIMEOUT',   kind: 'sec',  min: 10000, max: 300000 },
  { key: 'autoNextDealMs',  env: 'GUANDAN_NEXT_DEAL_DELAY',  kind: 'sec',  min: 2000,  max: 60000 },
  { key: 'autoNextDeal',    env: 'GUANDAN_AUTO_NEXT_DEAL',   kind: 'bool' },
];

/**
 * 掼蛋桌的【初始】配置。和德州那张桌子一样：环境变量只决定启动时的值，
 * 房主随时能在设置页改，但改动是内存态，重启后回到这里。
 * @param {object} [env]
 * @param {object} [logger]
 * @returns {typeof DEFAULT_GD_CONFIG}
 */
export function guandanConfigFromEnv(env = process.env, logger = console) {
  const cfg = { ...DEFAULT_GD_CONFIG };
  const applied = [];

  for (const f of GD_FIELDS) {
    const raw = str(env[f.env]);
    if (raw === null) continue;

    if (f.kind === 'bool') {
      const v = parseBool(raw);
      if (v === null) {
        logger.error(`[config] ${f.env}="${raw}" 不是布尔值（用 true/false 或 1/0），已忽略`);
        continue;
      }
      cfg[f.key] = v;
      applied.push(`${f.env}=${v}`);
      continue;
    }

    const v = clampInt(Number(raw) * 1000, f.min, f.max);
    if (v === null) {
      logger.error(
        `[config] ${f.env}="${raw}" 不合法（需要 ${f.min / 1000}~${f.max / 1000} 的整数秒），已忽略`
      );
      continue;
    }
    cfg[f.key] = v;
    applied.push(`${f.env}=${raw}`);
  }

  if (applied.length) {
    logger.log?.(`[config] 环境变量覆盖了掼蛋桌初始设置：${applied.join('，')}`);
  }
  return cfg;
}

/** 默认 STUN。选在国内能连上的几家——Google 那台在墙内是打不通的，
 *  真要用它得自己在 POKER_STUN_URLS 里填。STUN 只用来问"我的公网地址是多少"，
 *  不经手任何音频，所以用谁家的都不涉及隐私。
 *
 *  这三个都是发 STUN binding 请求实测过、能拿回映射地址的。
 *  原本第一个是 stun.qq.com，实测已经不响应了（两个解析结果都超时），
 *  排在最前面等于让每次 ICE 收集都先白等一个超时，已经换掉。 */
const DEFAULT_STUN = [
  'stun:stun.miwifi.com:3478',
  'stun:stun.chat.bilibili.com:3478',
  'stun:stun.cloudflare.com:3478',
];

const ICE_SCHEME = /^(stun|stuns|turn|turns):[^\s]+$/i;

/** TURN 临时凭据的有效期。凭据只在【开中转通道那一刻】被校验，通道建起来之后
 *  就不受它影响了，所以这个值只要覆盖得住"打开页面到上麦"这段就够。
 *  给 6 小时是留足断线重连和中途加人的余量，同时万一凭据被人抄走，
 *  能白嫖的窗口也就这么长。 */
const TURN_TTL_SEC = 6 * 3600;

/**
 * 按 coturn 的 REST API 约定，现签一组临时 TURN 凭据。
 *
 * 为什么不能用固定账号密码：ICE 配置是发给【每一个打开网页的人】的，
 * 固定密码等于把中转服务器的账号公开挂在网上，谁都能抄走跑自己的流量，
 * 而流量走的是你这台机器的带宽。
 *
 * 这套方案里用户名自带过期时间戳，密码是拿服务器密钥对用户名做的 HMAC，
 * 密钥本身永远不出服务器：
 *
 *   username   = <过期时刻的 unix 秒>:<标签>
 *   credential = base64(HMAC-SHA1(secret, username))
 *
 * coturn 那边开 `--use-auth-secret --static-auth-secret=<同一个密钥>` 就认这套，
 * 不需要建任何账号，也不需要重启就能换密钥。
 *
 * @param {string} secret 与 coturn 共享的密钥
 * @param {string} [tag] 只是为了在 coturn 日志里认人，不参与鉴权
 * @param {number} [ttlSec]
 * @param {number} [now] 便于测试注入时间
 * @returns {{username:string, credential:string}}
 */
export function turnCredentials(secret, tag = 'poker', ttlSec = TURN_TTL_SEC, now = Date.now()) {
  const expiry = Math.floor(now / 1000) + ttlSec;
  // 冒号是用户名里的分隔符，标签里混进去会把过期时间切错，所以只留安全字符
  const safeTag = String(tag || '').replace(/[^A-Za-z0-9_-]/g, '') || 'poker';
  const username = `${expiry}:${safeTag}`;
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential };
}

/**
 * 解析 TURN 配置。两种模式，二选一：
 *
 *   1) POKER_TURN_SECRET —— 和自建 coturn 的 use-auth-secret 配套，
 *      服务端按人现签短期凭据。【推荐】，理由见 turnCredentials。
 *   2) POKER_TURN_USERNAME + POKER_TURN_CREDENTIAL —— 固定账号密码。
 *      用别人家的 TURN 服务（自己改不了那台的配置）时才走这条。
 *
 * @returns {{urls:string[], secret?:string, ttlSec?:number, username?:string, credential?:string}|null}
 */
function turnFromEnv(env, logger) {
  const turnUrl = str(env.POKER_TURN_URL);
  if (!turnUrl) {
    // 配了密钥却没配地址，八成是漏了一行。静默忽略的话，
    // 表现就是"语音还是打不通"，排查起来毫无线索，所以这里必须喊出来。
    if (str(env.POKER_TURN_SECRET)) {
      logger.error('[config] 配了 POKER_TURN_SECRET 却没配 POKER_TURN_URL，TURN 已忽略');
    }
    return null;
  }

  const urls = turnUrl.split(',').map((x) => x.trim()).filter(Boolean);
  const bad = urls.filter((u) => !ICE_SCHEME.test(u));
  if (bad.length) {
    logger.error(`[config] POKER_TURN_URL 里这些地址不合法，已丢弃：${bad.join('，')}`);
  }
  const good = urls.filter((u) => ICE_SCHEME.test(u));
  if (!good.length) {
    logger.error(`[config] POKER_TURN_URL="${turnUrl}" 里没有一个合法地址（要像 turn:1.2.3.4:3478），TURN 已忽略`);
    return null;
  }

  const secret = str(env.POKER_TURN_SECRET);
  if (secret) {
    let ttlSec = TURN_TTL_SEC;
    const ttlRaw = str(env.POKER_TURN_TTL);
    if (ttlRaw !== null) {
      const v = clampInt(ttlRaw, 60, 86400);
      if (v === null) {
        logger.error(`[config] POKER_TURN_TTL="${ttlRaw}" 不合法（需要 60~86400 的整数秒），已忽略`);
      } else {
        ttlSec = v;
      }
    }
    if (str(env.POKER_TURN_USERNAME) || str(env.POKER_TURN_CREDENTIAL)) {
      logger.error('[config] 同时配了 POKER_TURN_SECRET 和固定账号密码，以 SECRET 为准（临时凭据更安全）');
    }
    return { urls: good, secret, ttlSec };
  }

  const username = str(env.POKER_TURN_USERNAME);
  const credential = str(env.POKER_TURN_CREDENTIAL);
  if (!username || !credential) {
    logger.error(
      '[config] 配了 POKER_TURN_URL 却没有凭据。二选一：' +
      'POKER_TURN_SECRET（推荐，配套自建 coturn），' +
      '或者 POKER_TURN_USERNAME + POKER_TURN_CREDENTIAL。TURN 已忽略'
    );
    return null;
  }
  return { urls: good, username, credential };
}

/**
 * 语音连麦的配置。
 *
 * 音频是浏览器之间直连的，服务端只转发信令，所以这里唯一要操心的就是
 * 【打洞打不通怎么办】：
 *   - STUN 负责告诉双方各自的公网地址，能直连的话音频完全不过服务器；
 *   - 但两边都在运营商大内网（CGNAT）里的时候是打不通的——国内家宽这是常态，
 *     不是偶发。那种情况音频必须过 TURN 中转，没有 TURN 就是"上麦成功、
 *     名单里有人、但互相听不见"。
 *
 * 所以：**要给异地的朋友用，TURN 不是可选项**。自建 coturn 见
 * docker-compose.yml 里的 coturn 服务，deploy/deploy.sh 会自动配好。
 *
 * @param {object} [env]
 * @param {object} [logger]
 * @returns {{enabled:boolean, maxMembers:number, iceServers:object[],
 *            turn:object|null, iceFor:(tag?:string)=>object[]}}
 */
export function voiceConfigFromEnv(env = process.env, logger = console) {
  const enabledRaw = str(env.POKER_VOICE);
  let enabled = true;
  if (enabledRaw !== null) {
    const v = parseBool(enabledRaw);
    if (v === null) logger.error(`[config] POKER_VOICE="${enabledRaw}" 不是布尔值，按开启处理`);
    else enabled = v;
  }

  let maxMembers = MAX_VOICE_MEMBERS;
  const maxRaw = str(env.POKER_VOICE_MAX);
  if (maxRaw !== null) {
    const v = clampInt(maxRaw, 2, MAX_VOICE_MEMBERS);
    if (v === null) {
      logger.error(`[config] POKER_VOICE_MAX="${maxRaw}" 不合法（需要 2~${MAX_VOICE_MEMBERS} 的整数），已忽略`);
    } else {
      maxMembers = v;
    }
  }

  const stunRaw = str(env.POKER_STUN_URLS);
  let stun = DEFAULT_STUN;
  if (stunRaw !== null) {
    // 明确填空列表（POKER_STUN_URLS=none）表示只走局域网直连，不问任何外部服务器
    stun = /^none$/i.test(stunRaw) ? [] : stunRaw.split(',').map((x) => x.trim()).filter(Boolean);
    const bad = stun.filter((u) => !ICE_SCHEME.test(u));
    if (bad.length) {
      logger.error(`[config] POKER_STUN_URLS 里这些地址不合法，已丢弃：${bad.join('，')}`);
      stun = stun.filter((u) => ICE_SCHEME.test(u));
    }
  }

  /** 每个人都一样、可以直接缓存的那部分（STUN，以及固定凭据的 TURN） */
  const iceServers = [];
  if (stun.length) iceServers.push({ urls: stun });

  const turn = turnFromEnv(env, logger);
  if (turn && turn.credential) {
    iceServers.push({ urls: turn.urls, username: turn.username, credential: turn.credential });
  }

  /**
   * 这次上麦该下发哪些 ICE 服务器。
   * 临时凭据必须现签、不能缓存（缓存下来就等于把有效期变成了进程寿命），
   * 所以对外给的是个函数而不是一个常量数组。
   */
  const iceFor = (tag) => {
    if (!turn || !turn.secret) return iceServers;
    const cred = turnCredentials(turn.secret, tag, turn.ttlSec);
    return iceServers.concat([{
      urls: turn.urls,
      username: cred.username,
      credential: cred.credential,
    }]);
  };

  return { enabled, maxMembers, iceServers, turn, iceFor };
}

/** 空串视为没设置（compose 里未填的变量会透传成空串） */
function str(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

function parseBool(s) {
  const t = s.toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(t)) return true;
  if (['0', 'false', 'no', 'off'].includes(t)) return false;
  return null;
}

/** 与 room.js 里的同名函数行为一致：非整数或越界返回 null */
function clampInt(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  if (i !== n) return null;          // 拒绝小数，别悄悄取整
  if (i < min || i > max) return null;
  return i;
}

export default configFromEnv;
