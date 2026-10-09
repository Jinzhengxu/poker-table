import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { versionAssets } from '../server/assets.js';

// Cloudflare 会把 js/css 的 max-age=60 改写成 4 小时。部署后新 HTML + 旧 app.js
// 的组合，症状是新控件出现了却没人填（「加入人机」下拉框只剩「自动轮流」）。

test('versionAssets：js/css 地址带上内容哈希，内容变了哈希跟着变', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'assets-'));
  await writeFile(path.join(dir, 'app.js'), 'v1');
  await writeFile(path.join(dir, 'style.css'), 'body{}');
  const html = '<link rel="stylesheet" href="/style.css"><script src="/app.js"></script>' +
    '<script src="/missing.js"></script><a href="/guandan">x</a>';

  const a = await versionAssets(html, dir);
  assert.match(a, /src="\/app\.js\?v=[0-9a-f]{10}"/);
  assert.match(a, /href="\/style\.css\?v=[0-9a-f]{10}"/);
  assert.match(a, /src="\/missing\.js"/, '不存在的文件原样留着');
  assert.match(a, /href="\/guandan"/, '不是 js/css 的链接不动');

  // 改内容（mtime 也会变），地址必须变
  await new Promise((r) => setTimeout(r, 20));
  await writeFile(path.join(dir, 'app.js'), 'v2');
  const b = await versionAssets(html, dir);
  assert.notEqual(a.match(/app\.js\?v=(\w+)/)[1], b.match(/app\.js\?v=(\w+)/)[1]);
});

test('versionAssets：真页面里引用的每个 js/css 都带上版本号', async () => {
  const dir = new URL('../public/', import.meta.url).pathname;
  for (const page of ['index.html', 'guandan.html', 'hotword.html']) {
    const out = await versionAssets(await readFile(path.join(dir, page), 'utf8'), dir);
    const bare = [...out.matchAll(/(?:src|href)="\/[\w.-]+\.(?:js|css)"/g)].map((m) => m[0]);
    assert.deepEqual(bare, [], `${page} 里还有不带版本号的引用`);
  }
});
