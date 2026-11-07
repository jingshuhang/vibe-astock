/**
 * 调度锁的降级路径回归。
 *
 * 2026-11-06 实测：沙箱的 SAFE_DELETE_BULK_CONFIRM_REQUIRED 拦下 fs.rmSync 后，
 * unlock() 直接抛错、锁文件残留且 mtime 被 touch 过 → 之后约 11 分钟里所有 tick
 * 静默返回 skipped「另一个后台进程正在调度」。不报错、只是不跑任务。
 * 这里把「删不掉」真实注入一次，验证降级留痕且下一拍能恢复。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  tick, type GateResult, type JobContext, type JobResult, type ScheduleDef,
} from "../src/notify.ts";
import { type ServiceContext } from "../src/service.ts";

const sh = (s: string) => new Date(`${s}:00+08:00`);

function tmpCtx(): ServiceContext {
  return { repoRoot: process.cwd(), dataRoot: fs.mkdtempSync(path.join(os.tmpdir(), "vra-lock-")), python: "python3", node: process.execPath };
}
const clean = (ctx: ServiceContext) => fs.rmSync(ctx.dataRoot, { recursive: true, force: true });
const lockOf = (ctx: ServiceContext, name = "tick.lock") => path.join(ctx.dataRoot, "notify", name);
const writeLock = (ctx: ServiceContext, content: string) => {
  fs.mkdirSync(path.dirname(lockOf(ctx)), { recursive: true });
  fs.writeFileSync(lockOf(ctx), content);
};

function def(): ScheduleDef {
  return {
    timeZone: "Asia/Shanghai", gateNote: "测试",
    gate: async () => ({ status: "open" } as GateResult),
    jobs: [{
      id: "digest", label: "摘要", description: "测试任务", at: "15:40", defaultEnabled: true,
      run: async (j: JobContext): Promise<JobResult> => ({
        messages: [{ title: `摘要 ${j.day}`, lines: ["一行事实"], link: "/x", dedupeKey: `d:${j.day}` }],
      }),
    }],
  };
}

const blockedByLock = (r: Awaited<ReturnType<typeof tick>>) => !!r.skipped?.includes("另一个后台进程");

test("锁文件标记 released 时：不被当成有人持有，任务照常跑", async () => {
  const ctx = tmpCtx();
  try {
    writeLock(ctx, "released");
    const r = await tick(ctx, { now: sh("2026-10-08T15:40"), def: def() });
    assert.equal(blockedByLock(r), false, "释放标记不该把调度卡住");
    assert.ok(r.ran.length > 0, "任务要真的跑起来，不是只返回个空报告");
  } finally { clean(ctx); }
});

test("空锁文件也按已释放处理", async () => {
  const ctx = tmpCtx();
  try {
    writeLock(ctx, "");
    const r = await tick(ctx, { now: sh("2026-10-08T15:40"), def: def() });
    assert.equal(blockedByLock(r), false);
  } finally { clean(ctx); }
});

test("别的进程刚写的活锁仍要挡住：互斥没被降级路径破坏", async () => {
  const ctx = tmpCtx();
  try {
    writeLock(ctx, "999999:abcdef123456");
    const r = await tick(ctx, { now: sh("2026-10-08T15:40"), def: def() });
    assert.equal(blockedByLock(r), true, "pid:token 且时间很新 = 有人正在跑，必须跳过");
  } finally { clean(ctx); }
});

test("正常跑完一拍：锁被释放，不会自己把自己卡住", async () => {
  const ctx = tmpCtx();
  try {
    const r = await tick(ctx, { now: sh("2026-10-08T15:40"), def: def() });
    assert.equal(blockedByLock(r), false);
    if (fs.existsSync(lockOf(ctx))) {
      assert.equal(fs.readFileSync(lockOf(ctx), "utf8").trim(), "released", "删不掉时至少留下释放标记");
    }
  } finally { clean(ctx); }
});

test("删锁真的失败时：写释放标记 + 显式告警 + 不抛，下一拍能恢复", async () => {
  const ctx = tmpCtx();
  const origRm = fs.rmSync;
  const origErr = console.error;
  const errors: string[] = [];
  try {
    // 只让 tick.lock 的删除失败，其它 fs.rmSync 照常（模拟环境层拦截，不是 dry-run）
    (fs as unknown as { rmSync: typeof fs.rmSync }).rmSync = ((p: unknown, ...rest: unknown[]) => {
      if (typeof p === "string" && p.endsWith("tick.lock")) throw new Error("SAFE_DELETE_BULK_CONFIRM_REQUIRED");
      return (origRm as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.rmSync;
    console.error = (...a: unknown[]) => { errors.push(a.map(String).join(" ")); };

    const r1 = await tick(ctx, { now: sh("2026-10-08T15:40"), def: def() });
    assert.equal(blockedByLock(r1), false, "unlock 抛错不该让这一拍变成失败");
    assert.equal(fs.readFileSync(lockOf(ctx), "utf8").trim(), "released", "删不掉要留下释放标记");
    assert.ok(errors.some((e) => e.includes("锁文件删不掉")), "降级必须显式告警，不能静默");

    // 恢复删除能力后，下一拍要能从 released 残骸里重建锁并继续跑
    (fs as unknown as { rmSync: typeof fs.rmSync }).rmSync = origRm;
    const r2 = await tick(ctx, { now: sh("2026-10-08T15:45"), def: def() });
    assert.equal(blockedByLock(r2), false, "释放标记不能变成新的永久锁");
  } finally {
    (fs as unknown as { rmSync: typeof fs.rmSync }).rmSync = origRm;
    console.error = origErr;
    clean(ctx);
  }
});

test("源码钉住：unlock 不许再退回裸调 rmSync", () => {
  const src = fs.readFileSync(new URL("../src/notify.ts", import.meta.url), "utf8");
  assert.ok(src.includes("function releaseLock("), "释放锁要有统一的降级函数");
  assert.ok(src.includes("LOCK_RELEASED"), "要有释放标记常量");
  assert.ok(src.includes("unlock: () => { if (mine()) releaseLock(file); }"), "unlock 要走降级函数");
  assert.ok(!src.includes("unlock: () => { if (mine()) fs.rmSync"), "不许退回裸调 rmSync");
  assert.ok(src.includes("lockContentIsHeld"), "tryLock 要能识别释放标记");
});
