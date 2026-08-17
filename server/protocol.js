// SPDX-License-Identifier: GPL-3.0-or-later
// 协议常量：消息类型、阶段、座位状态、默认配置。
// 本文件只导出常量，不含任何逻辑，供服务端各模块与测试共同引用。

/** 手牌阶段 */
export const PHASES = Object.freeze({
  WAITING: 'waiting',
  PREFLOP: 'preflop',
  FLOP: 'flop',
  TURN: 'turn',
  RIVER: 'river',
  SHOWDOWN: 'showdown',
  HAND_OVER: 'handOver'
});

/** 座位状态 */
export const SEAT_STATE = Object.freeze({
  EMPTY: 'empty',
  SITTING: 'sitting',
  IN: 'in',
  FOLDED: 'folded',
  ALLIN: 'allin',
  SITTING_OUT: 'sittingOut'
});

/** 默认房间配置 */
export const DEFAULT_CONFIG = Object.freeze({
  smallBlind: 5,
  bigBlind: 10,
  ante: 0,
  startingStack: 1000,
  actionTimeoutMs: 45000,
  autoNextHand: true,
  autoNextHandMs: 6000
});

/** 最大座位数 */
export const MAX_SEATS = 8;
