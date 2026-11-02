import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { collectRawRefs, pruneRawArchive, pruneRawOncePerDay, resetPruneMemo } from "../src/maintenance.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "vra-maint-"));
const day = 86_400_000;

/** 造一个 mcp/<session>/{raw,fetch} 的假数据根;ages 单位「天前」 */
function setup(files: { session?: string; name: string; ageDays: number; ref?: boolean; size?: number }[]): string {
  const dataRoot = tmp();
  for (const f of files) {
    const session = f.session ?? "default";
    const rawDir = path.join(dataRoot, "mcp", session, "raw");
    const fetchDir = path.join(dataRoot, "mcp", session, "fetch");
    fs.mkdirSync(rawDir, { recursive: true });
    fs.mkdirSync(fetchDir, { recursive: true });
    const p = path.join(rawDir, f.name);
    fs.writeFileSync(p, "x".repeat(f.size ?? 10));
    const t = new Date(Date.now() - f.ageDays * day);
    fs.utimesSync(p, t, t);
    if (f.ref) fs.writeFileSync(path.join(fetchDir, "some_endpoint.json"), JSON.stringify({ extra: { raw_files: [`raw/${f.name}`] } }));
  }
  return dataRoot;
}

test("🔴 还被 fetch 引用的 raw 一个都不能删,哪怕它早就过了保留窗口", () => {
  const dataRoot = setup([
    { name: "old_referenced.html", ageDays: 90, ref: true },
    { name: "old_orphan.html", ageDays: 90 },
  ]);
  const r = pruneRawArchive(dataRoot, { keepDays: 30, now: new Date() });
  assert.equal(r.referenced, 1);
  assert.equal(r.deleted, 1);
  assert.equal(r.keptReferenced, 1);
  assert.ok(fs.existsSync(path.join(dataRoot, "mcp", "default", "raw", "old_referenced.html")), "证据链不能断");
  assert.ok(!fs.existsSync(path.join(dataRoot, "mcp", "default", "raw", "old_orphan.html")));
});

test("保留窗口内的不删(哪怕没有引用) —— 窗口是用来兜住当天的", () => {
  const dataRoot = setup([{ name: "fresh.html", ageDays: 1 }, { name: "borderline.html", ageDays: 29 }]);
  const r = pruneRawArchive(dataRoot, { keepDays: 30, now: new Date() });
  assert.equal(r.deleted, 0);
  assert.equal(r.keptRecent, 2);
});

test("窗口按天算得住:31 天前删、29 天前留", () => {
  const dataRoot = setup([{ name: "d31.html", ageDays: 31 }, { name: "d29.html", ageDays: 29 }]);
  const r = pruneRawArchive(dataRoot, { keepDays: 30, now: new Date() });
  assert.equal(r.deleted, 1);
  assert.deepEqual(r.oldestDeleted, new Date(Date.now() - 31 * day).toISOString().slice(0, 10));
});

test("dryRun 只统计不删 —— 先看数再决定", () => {
  const dataRoot = setup([{ name: "old.html", ageDays: 90, size: 100 }]);
  const r = pruneRawArchive(dataRoot, { keepDays: 30, now: new Date(), dryRun: true });
  assert.equal(r.deleted, 1);
  assert.equal(r.freedBytes, 100);
  assert.ok(fs.existsSync(path.join(dataRoot, "mcp", "default", "raw", "old.html")), "dryRun 不许真删");
});

test("只动 mcp/<session>/raw/ 里的文件:fetch、别的目录、嵌套更深的一律不碰", () => {
  const dataRoot = setup([{ name: "target.html", ageDays: 90 }]);
  const keep = [
    path.join(dataRoot, "mcp", "default", "fetch", "keep.json"),
    path.join(dataRoot, "snapshots", "keep.json"),
    path.join(dataRoot, "mcp", "default", "raw", "nested", "deeper.html"),
  ];
  for (const p of keep) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "keep");
    const t = new Date(Date.now() - 90 * day);
    fs.utimesSync(p, t, t);
  }
  const r = pruneRawArchive(dataRoot, { keepDays: 30, now: new Date() });
  assert.equal(r.deleted, 1, "只该删 raw 下那一个");
  for (const p of keep) assert.ok(fs.existsSync(p), `不该动:${p}`);
});

test("跨 session 的引用也认(同一份报文被另一个 session 引过就留着)", () => {
  const dataRoot = setup([{ session: "market_state", name: "shared.html", ageDays: 90 }]);
  fs.mkdirSync(path.join(dataRoot, "mcp", "longterm", "fetch"), { recursive: true });
  fs.writeFileSync(
    path.join(dataRoot, "mcp", "longterm", "fetch", "x.json"),
    JSON.stringify({ evidence: [{ raw_ref: "raw/shared.html" }] }),
  );
  const r = pruneRawArchive(dataRoot, { keepDays: 30, now: new Date() });
  assert.equal(r.deleted, 0);
  assert.ok(fs.existsSync(path.join(dataRoot, "mcp", "market_state", "raw", "shared.html")));
});

test("没有 mcp 目录时如实说跳过,不抛错", () => {
  const r = pruneRawArchive(tmp(), { keepDays: 30, now: new Date() });
  assert.equal(r.skipped, "没有 mcp 目录");
  assert.equal(r.deleted, 0);
});

test("collectRawRefs 认得 evidence.raw_ref 与 extra.raw_files 两种写法", () => {
  const dataRoot = tmp();
  const fetchDir = path.join(dataRoot, "mcp", "default", "fetch");
  fs.mkdirSync(fetchDir, { recursive: true });
  fs.writeFileSync(path.join(fetchDir, "a.json"), JSON.stringify({
    evidence: [{ raw_ref: "raw/aaa.html" }],
    extra: { raw_files: ["raw/bbb.json"] },
  }));
  const refs = collectRawRefs(path.join(dataRoot, "mcp"));
  assert.deepEqual([...refs].sort(), ["aaa.html", "bbb.json"]);
});

test("每天只跑一次(进程内记账),重启后可再跑", () => {
  const dataRoot = setup([{ name: "old.html", ageDays: 90 }]);
  resetPruneMemo();
  const first = pruneRawOncePerDay(dataRoot, new Date(2026, 10, 2, 10, 0));
  assert.ok(first, "第一次该跑");
  assert.equal(pruneRawOncePerDay(dataRoot, new Date(2026, 10, 2, 18, 0)), null, "同一天第二次直接跳过");
  const next = pruneRawOncePerDay(dataRoot, new Date(2026, 10, 3, 10, 0));
  assert.ok(next, "第二天要能再跑");
  resetPruneMemo();
});
