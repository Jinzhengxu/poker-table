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

import { DEFAULT_CONFIG } from './protocol.js';
import { DEFAULT_GD_CONFIG } from './guandan/room.js';

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
