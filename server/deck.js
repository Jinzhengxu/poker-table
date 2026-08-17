// 牌堆与洗牌（SPEC §3）
//
// 一张牌是 2 字符字符串：点数 + 花色。
//   点数：2 3 4 5 6 7 8 9 T J Q K A（T = 10）
//   花色：c(♣梅花) d(♦方块) h(♥红桃) s(♠黑桃)

import { randomInt } from 'node:crypto';

/** 点数字符表（按从小到大） */
export const RANK_CHARS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];

/** 花色字符表（固定顺序，决定 freshDeck 的输出顺序） */
export const SUIT_CHARS = ['c', 'd', 'h', 's'];

/**
 * 生成一副全新的 52 张牌，顺序固定：
 * 先按花色 c d h s，每个花色内按点数 2..A 递增。
 * @returns {string[]} 52 张牌
 */
export function freshDeck() {
  const deck = [];
  for (const suit of SUIT_CHARS) {
    for (const rank of RANK_CHARS) {
      deck.push(rank + suit);
    }
  }
  return deck;
}

/**
 * 原地 Fisher-Yates 洗牌。使用 node:crypto 的 randomInt 取无偏随机数
 * （randomInt 内部做了拒绝采样，不存在 Math.random * n 的取模偏差）。
 * @param {string[]} deck 待洗的牌堆
 * @returns {string[]} 同一个数组引用（已被原地打乱）
 */
export function shuffle(deck) {
  if (!Array.isArray(deck)) throw new TypeError('shuffle 需要一个数组');
  // 从后往前，第 i 张与 [0, i] 中随机一张交换
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1); // 上界是开区间，故为 i + 1
    const tmp = deck[i];
    deck[i] = deck[j];
    deck[j] = tmp;
  }
  return deck;
}
