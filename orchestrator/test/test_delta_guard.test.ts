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

const baseline = fileURLToPath(new URL("../test/known-failures.json", import.meta.url));

/** 跑门禁并捕获退出码 / 输出；不改 argv 之外的环境 */
function runDelta(args: string[]) {
  let status = 0, stdout = "", stderr = "";
  try {
    stdout = execFileSync(process.execPath, [script("test-delta.mjs"), ...args],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], cwd });
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    status = err.status ?? -1;
    stdout = String(err.stdout ?? "");
    stderr = String(err.stderr ?? "");
  }
  return { status, stdout, stderr };
}

test("[行为] --flaky 拼错时拒绝凭空新增，基线一个字节都不许动", () => {
  const before = readFileSync(baseline);
  const r = runDelta(["--flaky", "zzz_no_such_file_xyz.test.ts::某用例"]);
  assert.equal(r.status, 2, "没匹配到就必须拒绝");
  assert.match(r.stderr, /没有匹配/);
  assert.deepEqual(readFileSync(baseline), before, "拒绝时不能往基线里写东西");
});

test("[行为] 就算给了 --allow-new，文件不存在也拒绝登记", () => {
  const before = readFileSync(baseline);
  const r = runDelta(["--flaky", "zzz_no_such_file_xyz.test.ts::某用例", "--allow-new"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /test\/ 下得真有这个文件/);
  assert.deepEqual(readFileSync(baseline), before);
});

test("[结构] 重建基线遇新增失败要 --force；--flaky 新增要 --allow-new", () => {
  const src = readFileSync(script("test-delta.mjs"), "utf8");
  assert.ok(src.includes("const newcomers = [...current.keys()].filter((k) => !prevKeys.has(k));"),
    "重建前要算出新增失败");
  assert.ok(src.includes('newcomers.length && !has("--force")'), "有新增且没 --force 就拒绝");
  assert.ok(src.includes('!has("--allow-new")'), "flaky 新增必须显式开关");
  assert.match(src, /existsSync\(join\(HERE, "\.\.", "test", fileNorm\)\)/, "新增 flaky 要校验文件真实存在");
  // ⚠️ 诚实留白:--update-baseline 的拒绝只做了源码断言,没端到端子进程验证 ——
  //    跑一次要 3-5 分钟且会写真实基线,不适合放进单元测试。手工验收见 CHANGELOG。
});
