import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { installRunLog } from "../src/runlog.ts";

/**
 * 启动日志级别读反的回归（2026-11-08）。
 *
 * 事故：runlog.ts 把 console.log → [info]、console.error → [error]，但 API 进程里
 * 「listening / 调度状态 / 采集已挂载」这些**正常信息**全都用 console.error 打，
 * 于是一份健康的启动日志三行全是 [error]。筛不出真错误，人也会被误导 ——
 * 和之前「风险 15 分被读反」是同一类毛病。
 *
 * 边界：CLI 工具（run/batch/alerts/doctor）和可能被 MCP stdio 进程调用的 service.ts
 * **必须继续往 stderr 打**：它们的 stdout 是 JSON / JSON-RPC 契约，写普通日志会毁掉通道。
 * 所以这里同时钉住「改了哪几处」和「哪些地方不许跟着一刀切」。
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "..", "src");
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), "utf8");
const watch = () => read(path.join("finance", "shortline", "watch.ts"));

/** 临时掐掉控制台输出：验证的是落盘级别，不该把测试输出刷满屏 */
function quiet(fn: () => void): void {
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = () => true;
  (process.stderr as unknown as { write: (s: string) => boolean }).write = () => true;
  try { fn(); } finally {
    (process.stdout as unknown as { write: typeof out }).write = out;
    (process.stderr as unknown as { write: typeof err }).write = err;
  }
}

test("[行为] 装上日志镜像后,正常信息落 [info]、异常落 [error]", () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vra-loglevel-"));
  const h = installRunLog(dataRoot, { now: () => new Date(2026, 10, 8, 17, 44, 33) });
  try {
    quiet(() => { console.log("[api] listening http://127.0.0.1:8770"); });
    quiet(() => { console.log("[notify] 2026-11-08 17:44 shortline_premarket=skipped"); });
    quiet(() => { console.error("[notify] 调度出错:boom"); });
    const text = fs.readFileSync(path.join(dataRoot, "logs", "api-2026-11-08.log"), "utf8");
    assert.match(text, /17:44:33 \[info\] \[api\] listening/);
    assert.match(text, /17:44:33 \[info\] \[notify\] 2026-11-08/);
    assert.match(text, /17:44:33 \[error\] \[notify\] 调度出错/);
    assert.doesNotMatch(text, /\[error\] \[api\] listening/, "启动成功不许再被标成错误");
    assert.doesNotMatch(text, /\[error\] \[notify\] 2026-11-08/, "休市日的 skipped 是正常状态,不是错误");
  } finally {
    h.restore();
  }
});

test("API 进程内的启动/状态信息走 console.log,异常分流到 logError", () => {
  const api = read("api.ts");
  const notify = read("notify.ts");
  const w = watch();

  assert.match(api, /console\.log\(`\[api\] listening http:\/\//, "listening 是启动信息");
  assert.match(api, /没有程序解析它/, "注释要写清这行只给人看,没人解析");

  assert.match(notify, /const log = opts\.log \?\? \(\(line: string\) => console\.log\(line\)\)/);
  assert.match(notify, /const logError = opts\.logError \?\? \(\(line: string\) => console\.error\(line\)\)/);
  assert.match(notify, /catch\(\(e\) => logError\(`\[notify\] 每拍钩子出错/);
  assert.match(notify, /catch\(\(e\) => logError\(`\[notify\] 调度出错/);
  // 锁删不掉是降级告警,必须继续报错,不能因为分级被洗成 info
  assert.match(notify, /console\.error\(`\[notify\] 锁文件删不掉/);

  assert.match(w, /const log = deps\.log \?\? \(\(line: string\) => console\.log\(line\)\)/);
  assert.match(w, /const logError = deps\.logError \?\? \(\(line: string\) => console\.error\(line\)\)/);
  assert.match(w, /logError\(`\[collector\] 这一拍没采到/, "取数失败归 error,不是正常状态");
  assert.match(w, /console\.error\(`\[collector\] 锁文件删不掉/);
});

test("CLI 与 MCP 共用模块的 stderr 不许被一刀切改成 stdout", () => {
  for (const p of ["run.ts", "batch.ts", "alerts.ts", "doctor.ts"]) {
    assert.match(read(p), /console\.error\(/, `${p} 的 CLI 输出必须留在 stderr`);
  }
  // service.ts 也会跑在 MCP 的 stdio 进程里:stdout 是 JSON-RPC 通道,不能写普通日志
  assert.match(read("service.ts"), /console\.error\(`\[raw\] 回收/);
});

test("[行为] 启动文案说「已挂载」并注明非交易时段不取数", () => {
  const w = watch();
  assert.match(w, /常驻采集已挂载/);
  assert.match(w, /非交易时段不取数/, "休市日照样挂定时器,别让人以为正在采");
  assert.doesNotMatch(w, /盘中常驻采集已启动\(/);
});
