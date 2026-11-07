/**
 * 增量门禁的 fail-open 护栏。
 *
 * 2026-11-07 复核 45 条失败基线时发现：`test-delta.mjs` 对「疑似新增失败」做单独重跑，
 * 但只取 `results`（失败列表），丢掉了 `files`（这次真跑过的文件）。单跑匹配不到文件时
 * 两者都为空 → 所有候选被判成「单独通过 / 负载偶发」，真实回归被整批吞掉、退出码假 0。
 * 这里用真实子进程证明空集合确实会出现，并钉住护栏不许退回旧写法。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = (p: string) => fileURLToPath(new URL(`../scripts/${p}`, import.meta.url));
const cwd = fileURLToPath(new URL("..", import.meta.url));

test("[行为] --only 拼错时 files=[] 且 results=[] —— fail-open 的输入真实存在", () => {
  const out = execFileSync(process.execPath, [script("run-all-tests.mjs"), "--only", "zzz_no_such_file_xyz"], { encoding: "utf8", cwd });
  const r = JSON.parse(out);
  assert.deepEqual(r.files, [], "没匹配到就是没跑过任何文件");
  assert.deepEqual(r.results, [], "但失败列表同样是空的 —— 只看它分不出「全过」和「没跑」");
});

test("[行为] 门禁自己遇到 --only 拼错要报错退出，不能假绿", () => {
  let status = 0;
  let stderr = "";
  try {
    execFileSync(process.execPath, [script("test-delta.mjs"), "--only", "zzz_no_such_file_xyz"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], cwd });
  } catch (e) {
    const err = e as { status?: number; stderr?: Buffer | string };
    status = err.status ?? -1;
    stderr = String(err.stderr ?? "");
  }
  assert.equal(status, 2, "拼错必须退出码 2");
  assert.match(stderr, /没匹配到任何测试文件/);
});

test("[结构] 单独重跑要用 files 确认覆盖，没覆盖的不许判 flaky", () => {
  const src = readFileSync(script("test-delta.mjs"), "utf8");
  assert.ok(src.includes("const reranFiles = new Set("), "要收集这次真跑过的文件");
  assert.ok(src.includes("!reranFiles.has(current.get(k).file)"), "没覆盖到要拦下");
  assert.ok(src.includes("uncovered.push(k)"), "拦下的要留痕，不能静默");
  assert.doesNotMatch(src, /const rerun = suspectFiles\.flatMap\(\(f\) => runSweep\(1, f\)\.results\)/, "不许退回只取 results 的旧写法");
});
