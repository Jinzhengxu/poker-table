// SPDX-License-Identifier: GPL-3.0-or-later
//
// 给页面里引用的 js / css 加内容版本号：/app.js -> /app.js?v=<内容哈希前 10 位>。
//
// 为什么要有：源站给 js/css 的是 max-age=60，但 Cloudflare 的 Browser Cache TTL
// 会把它【改写】成 max-age=14400（4 小时）。HTML 是 no-cache，每次都拿新的，
// 于是部署之后浏览器拿到新 HTML + 4 小时内缓存的旧 app.js —— 新加的控件出现了，
// 却没有脚本去填它（「加入人机」那个下拉框只剩「自动轮流」就是这么来的）。
// 地址里带上内容哈希，文件一变地址就变，哪一层缓存都绕不过去。

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/** 只认根目录下的单个文件名，不带斜杠，所以不可能拼出 public 之外的路径 */
const REF = /(\b(?:src|href)=")\/([\w.-]+\.(?:js|css))(")/g;

/** 路径 -> { mtimeMs, v }。开发时改了文件，mtime 变了就重算 */
const cache = new Map();

async function versionOf(file) {
  let st;
  try {
    st = await stat(file);
  } catch {
    return null;
  }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.v;
  const v = createHash('sha256').update(await readFile(file)).digest('hex').slice(0, 10);
  cache.set(file, { mtimeMs: st.mtimeMs, v });
  return v;
}

/**
 * 把 HTML 里 src="/x.js" / href="/x.css" 改成带 ?v= 的地址。
 * 文件不存在的引用原样留着（404 该怎么报还怎么报）。
 *
 * @param {string} html
 * @param {string} publicDir
 * @returns {Promise<string>}
 */
export async function versionAssets(html, publicDir) {
  const names = new Set();
  for (const m of html.matchAll(REF)) names.add(m[2]);
  const versions = new Map();
  for (const name of names) versions.set(name, await versionOf(path.join(publicDir, name)));
  return html.replace(REF, (all, pre, name, post) => {
    const v = versions.get(name);
    return v ? `${pre}/${name}?v=${v}${post}` : all;
  });
}
