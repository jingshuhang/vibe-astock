#!/usr/bin/env node
// 逐文件跑 orchestrator/test/*.test.ts,输出每个文件的失败用例清单(JSON 到 stdout)。
//
// 为什么要逐文件:`node --test "test/*.test.ts"` 的 TAP 输出把 124 个文件混在一条流里,
// 没有文件名边界,失败用例定位不回文件。基线和增量比对都要「文件 → 失败用例」这个粒度。
//
// 用法:
//   node scripts/run-all-tests.mjs            # 并发 4 跑全量,stdout 出 JSON 报告
//   node scripts/run-all-tests.mjs --concurrency 1
//   node scripts/run-all-tests.mjs --only "market_call,schedule"
//
// 报告形状:
//   { totalFiles, failedFiles, totalTests, failedTests, results: [ { file, ok, code, fail: [名...], error } ] }
// 只有出现失败用例或进程异常退出的文件才会进 results(通过的文件不占体积)。
import { readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

const args = process.argv.slice(2);
const getArg = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const concurrency = Number(getArg("--concurrency", "4"));
const only = getArg("--only", "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const testDir = join(process.cwd(), "test");
const all = readdirSync(testDir)
  .filter((f) => f.endsWith(".test.ts"))
  .sort()
  .filter((f) => !only.length || only.some((k) => f.includes(k)));

/** 跑单个测试文件,解析 TAP 里的 `not ok` 行。 */
function runOne(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", `test/${file}`], {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (out += b));
    child.on("error", (e) => resolve({ file, ok: false, code: null, fail: [], error: String(e) }));
    child.on("close", (code) => {
      // TAP:`not ok 3 - 用例名`。文件级崩(如 import 失败)会没有 not ok 但退出码非 0。
      const fail = [];
      for (const line of out.split(/\r?\n/)) {
        const m = /^not ok \d+ - (.+)$/.exec(line);
        if (m) fail.push(m[1].trim());
      }
      // 兜底:退出码非 0 却一条 not ok 都没解析到(进程被杀 / 超时 / TAP 没写完),
      // 必须造一条失败,否则下游 delta 门禁会把它当成「这个文件通过了」——静默漏报。
      if (code !== 0 && fail.length === 0) fail.push(`(文件退出码 ${code} 但无 TAP 失败行:进程可能被杀或超时)`);
      resolve({ file, ok: code === 0 && fail.length === 0, code, fail });
    });
  });
}

const results = new Array(all.length);
let cursor = 0;
async function worker() {
  for (;;) {
    const i = cursor++;
    if (i >= all.length) return;
    results[i] = await runOne(all[i]);
    const r = results[i];
    process.stderr.write(`[${i + 1}/${all.length}] ${r.ok ? "ok  " : "FAIL"} ${r.file}\n`);
  }
}
await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

const failed = results.filter((r) => !r.ok);
const report = {
  totalFiles: all.length,
  failedFiles: failed.length,
  totalTests: 0, // 单文件 TAP 的汇总行在文件级解析里不取,这里只统计文件与失败用例
  failedTests: results.reduce((n, r) => n + r.fail.length, 0),
  results: failed,
};
process.stdout.write(JSON.stringify(report, null, 2));
