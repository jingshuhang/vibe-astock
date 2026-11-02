import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { formatLine, installRunLog, logFileName, localDay, pruneLogs, readHeartbeat, writeHeartbeat } from "../src/runlog.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "vra-runlog-"));

test("日志行带本地时间、级别和正文;Error 带栈(不然只看到一个 message,查不出炸在哪)", () => {
  const line = formatLine("error", ["取数失败"], new Date(2026, 10, 2, 14, 1, 4));
  assert.match(line, /^14:01:04 \[error\] 取数失败\n$/);

  const withErr = formatLine("fatal", ["未捕获异常:", new Error("boom")], new Date(2026, 10, 2, 14, 1, 4));
  assert.match(withErr, /未捕获异常:/);
  assert.match(withErr, /boom/);
  assert.match(withErr, /at /, "要带栈,只有 message 定位不了");
});

test("文件按本地日期切,不按 UTC —— 否则北京时间 08:00 前的日志会落到前一天", () => {
  assert.equal(logFileName("2026-11-02"), "api-2026-11-02.log");
  // 2026-11-02 00:30 本地时间 = UTC 还是 11-01;这里必须说 11-02
  assert.equal(localDay(new Date(2026, 10, 2, 0, 30)), "2026-11-02");
  assert.equal(localDay(new Date(2026, 10, 2, 23, 30)), "2026-11-02");
});

test("清理只删过期的 api-YYYY-MM-DD.log,别人放进去的文件一个不碰", () => {
  const dir = tmp();
  const write = (name: string) => fs.writeFileSync(path.join(dir, name), "x");
  write("api-2026-10-01.log"); // 过期
  write("api-2026-10-30.log"); // 保留窗口内
  write("api-2026-11-02.log"); // 今天
  write("notes.txt"); // 不是我们的
  write("api-old.log"); // 名字不合规
  write("ui.log");

  const r = pruneLogs(dir, 14, new Date(2026, 10, 2, 18, 0));
  assert.deepEqual(r.removed, ["api-2026-10-01.log"]);
  assert.equal(r.kept, 2);
  assert.ok(fs.existsSync(path.join(dir, "notes.txt")), "别人的文件不能删");
  assert.ok(fs.existsSync(path.join(dir, "api-old.log")), "名字不合规的不动");
  assert.ok(fs.existsSync(path.join(dir, "ui.log")));
});

test("目录不存在时清理不抛错(首次运行、数据目录刚建)", () => {
  assert.deepEqual(pruneLogs(path.join(tmp(), "nope"), 14, new Date()), { removed: [], kept: 0 });
});

test("装上之后 console.error 照旧上屏,同时多一份写在盘上;restore 之后彻底摘干净", () => {
  const dataRoot = tmp();
  const before = { log: process.listenerCount("uncaughtException"), exit: process.listenerCount("exit") };
  const h = installRunLog(dataRoot, { now: () => new Date(2026, 10, 2, 14, 1, 4) });
  try {
    const seen: unknown[][] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    // 控制台输出要原样保留 —— 只多一份,不是重定向。console.error 走的是 stderr
    (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => { seen.push([s]); return origWrite(s); };
    try { console.error("调度出错:boom"); } finally {
      (process.stderr as unknown as { write: (s: string) => boolean }).write = origWrite;
    }
    const text = fs.readFileSync(path.join(dataRoot, "logs", "api-2026-11-02.log"), "utf8");
    assert.match(text, /14:01:04 \[error\] 调度出错:boom/);
    assert.ok(seen.length > 0, "控制台那一路不能被吞掉");
  } finally {
    h.restore();
  }
  // 摘干净:否则这个进程里每个未捕获异常都会被人抢着 exit(1)
  assert.equal(process.listenerCount("uncaughtException"), before.log);
  assert.equal(process.listenerCount("exit"), before.exit);
  const size = fs.statSync(path.join(dataRoot, "logs", "api-2026-11-02.log")).size;
  console.error("restore 之后的这条不该进文件");
  assert.equal(fs.statSync(path.join(dataRoot, "logs", "api-2026-11-02.log")).size, size);
});

test("心跳写得进去也读得出来;文件坏了当没有,不抛错", () => {
  const dataRoot = tmp();
  assert.equal(readHeartbeat(dataRoot), null);
  writeHeartbeat(dataRoot, { at: "2026-11-02T14:01:04.000Z", pid: 123, day: "2026-11-02", hm: "14:01" });
  assert.deepEqual(readHeartbeat(dataRoot), { at: "2026-11-02T14:01:04.000Z", pid: 123, day: "2026-11-02", hm: "14:01" });
  fs.writeFileSync(path.join(dataRoot, "logs", "heartbeat.json"), "{ 坏掉的 json");
  assert.equal(readHeartbeat(dataRoot), null);
});
