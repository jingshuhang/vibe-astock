import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  DEFAULT_RAW_RETENTION_DAYS, pruneRawResponses, rawRetentionDays, resetRawPruneThrottle,
} from "../src/raw_retention.ts";

const DAY = 24 * 3600 * 1000;

function tmpRaw(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vra-raw-"));
  return path.join(dir, "raw");
}

/** 造一个「N 天前」的文件;mtime 是唯一判据(文件名里的时间戳各来源格式不统一) */
function file(dir: string, name: string, ageDays: number, size = 10): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, "x".repeat(size));
  const when = new Date(Date.now() - ageDays * DAY);
  fs.utimesSync(p, when, when);
  return p;
}

test("保留期默认 30 天,环境变量可改,非法值按默认(绝不静默变成全删)", () => {
  assert.equal(DEFAULT_RAW_RETENTION_DAYS, 30);
  assert.equal(rawRetentionDays({}), 30);
  assert.equal(rawRetentionDays({ VRA_RAW_RETENTION_DAYS: "7" }), 7);
  assert.equal(rawRetentionDays({ VRA_RAW_RETENTION_DAYS: "0" }), 0, "0 = 关闭清理");
  for (const bad of ["-1", "abc", "1.5.2", " "]) {
    assert.equal(rawRetentionDays({ VRA_RAW_RETENTION_DAYS: bad }), 30, bad);
  }
});

test("按 mtime 清理:超过保留期的删、期限内的一律不动", () => {
  const raw = tmpRaw();
  const old1 = file(raw, "extracted_tencent_quote_1_1_aaaa.json", 31);
  const old2 = file(raw, "500farm+kalshi_x_20261026T2106_21540_d70c.json", 40, 20);
  const fresh = file(raw, "extracted_tencent_quote_2_2_bbbb.json", 1);
  const edge = file(raw, "extracted_tencent_quote_3_3_cccc.json", 29);
  const out = pruneRawResponses(raw, { force: true, retentionDays: 30 });
  assert.ok(out);
  assert.equal(out.scanned, 4);
  assert.equal(out.removed, 2);
  assert.equal(out.bytes, 30, "字节数按真实大小累计");
  assert.equal(out.failed, 0);
  assert.deepEqual([old1, old2].map((p) => fs.existsSync(p)), [false, false]);
  assert.deepEqual([fresh, edge].map((p) => fs.existsSync(p)), [true, true], "29 天还没到期");
});

test("保留期为 0 = 不清理;目录不存在 = 跳过且不报错", () => {
  const raw = tmpRaw();
  const old = file(raw, "a.json", 400);
  assert.equal(pruneRawResponses(raw, { force: true, retentionDays: 0 }), null);
  assert.equal(fs.existsSync(old), true);
  assert.equal(pruneRawResponses(path.join(raw, "nope"), { force: true, retentionDays: 30 }), null);
});

test("同一目录两轮之间节流:高频轮询不会每 3 秒扫一遍目录", () => {
  resetRawPruneThrottle();
  const raw = tmpRaw();
  file(raw, "a.json", 40);
  assert.ok(pruneRawResponses(raw, { retentionDays: 30 }), "第一轮真跑");
  file(raw, "b.json", 40);
  assert.equal(pruneRawResponses(raw, { retentionDays: 30 }), null, "一小时内跳过");
  assert.ok(pruneRawResponses(raw, { retentionDays: 30, now: Date.now() + 2 * 3600_000 }), "过了间隔再来一轮");
});

test("子目录与符号链接都不碰:跟随链接会删到目录之外", { skip: process.platform === "win32" ? "沙箱禁符号链接" : false }, () => {
  const raw = tmpRaw();
  const outside = tmpRaw();
  const victim = file(outside, "keep.json", 400);
  file(raw, "old.json", 400);
  fs.mkdirSync(path.join(raw, "sub"), { recursive: true });
  fs.writeFileSync(path.join(raw, "sub", "inner.json"), "x");
  fs.utimesSync(path.join(raw, "sub", "inner.json"), new Date(Date.now() - 400 * DAY), new Date(Date.now() - 400 * DAY));
  fs.symlinkSync(victim, path.join(raw, "link.json"));
  const out = pruneRawResponses(raw, { force: true, retentionDays: 30 });
  assert.ok(out);
  assert.equal(out.removed, 1, "只删那个真的普通文件");
  assert.equal(fs.existsSync(victim), true, "链接指向的文件不能被删");
  assert.equal(fs.existsSync(path.join(raw, "sub", "inner.json")), true, "子目录不递归");
});

test("研究运行的证据目录不受影响:清理只认传进来的那一个目录", () => {
  // 这不是"顺手再测一遍路径",而是把「缓存 vs 证据」这条边界钉死:
  // `.local/runs/<run>/raw/` 里的文件被报告的 raw_ref 指着、复算要用,
  // 它们同样"很旧",但**绝不能被保留期规则碰到**。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vra-evidence-"));
  const cacheRaw = path.join(root, "mcp", "default", "raw");
  const runRaw = path.join(root, "runs", "20260101-000000-600519", "raw");
  const staleCache = file(cacheRaw, "cache.json", 400);
  const evidence = file(runRaw, "extracted_kline.json", 400);
  pruneRawResponses(cacheRaw, { force: true, retentionDays: 30 });
  assert.equal(fs.existsSync(staleCache), false);
  assert.equal(fs.existsSync(evidence), true, "研究运行的原始证据一律保留");
});
