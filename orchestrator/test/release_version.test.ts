import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const VERSION = '2.1.4';

test('v2.1.4 source version is consistent across packages, locks, README badges and CHANGELOG', () => {
  for (const dir of ['desktop', 'orchestrator']) {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, dir, 'package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(root, dir, 'package-lock.json'), 'utf8'));
    assert.equal(pkg.version, VERSION);
    assert.equal(lock.version, pkg.version);
    assert.equal(lock.packages[''].version, pkg.version);
  }
  for (const file of ['README.md', 'README_en.md']) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    const badges = [...text.matchAll(/badge\/source-v(\d+\.\d+\.\d+)-/g)].map((m) => m[1]);
    assert.deepEqual(badges, [VERSION], `${file} 首屏源码版本徽标必须恰好一个且等于 ${VERSION}`);
  }
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  // 最上面的**版本条目**必须是当前版本。允许它前面有 `[未发布]` 这类小节(Keep a Changelog 的标准写法):
  // 那一条不主张任何版本号,拿它当"版本不一致"会把「改完了但还没发版」判成错误。
  const versions = [...changelog.matchAll(/^## \[([^\]]+)\]/gm)].map((m) => m[1]!).filter((v) => /^\d+\.\d+\.\d+$/.test(v));
  assert.equal(versions[0], VERSION, 'CHANGELOG 最上面的版本条目必须是当前版本');
});
