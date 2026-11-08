import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Windows 启动脚本编码回归（2026-11-08）。
 *
 * 事故：启动窗口第一行报
 *   'ゆ椂绐楀彛浼氫竴闂岃€岃繃銆佺湅涓嶅嚭鍘熷洜' 不是内部或外部命令
 * 反推是「时窗口会一闪而过、看不出原因」—— scripts/start.cmd 第 4 行 rem 注释的**后半段**
 * 被 CMD 当成命令执行了。文件是 UTF-8 无 BOM，CMD 默认按 cp936 读，中文注释整行误解码；
 * 根目录 启动VibeAStock.bat 还是 LF-only（CMD 逐行只认 CRLF）。
 *
 * 服务其实正常起来了，但每次启动刷一行假错误，容易误判成启动失败。
 * 这两个脚本因此约定：**只写 ASCII + CRLF**，中文说明放 README。
 * 这里读的是真实文件字节，不是 grep 某段源码文本 —— 换行/编码回归挡得住。
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const LAUNCHER = path.join(ROOT, "启动VibeAStock.bat");
const STARTER = path.join(ROOT, "scripts", "start.cmd");
const PS1 = path.join(ROOT, "scripts", "start.ps1");

const cmdFiles: [string, string][] = [
  [LAUNCHER, "启动VibeAStock.bat"],
  [STARTER, "scripts/start.cmd"],
];

test("两个 CMD 启动脚本只含 ASCII —— cp936 会把 UTF-8 中文注释读坏", () => {
  for (const [p, label] of cmdFiles) {
    const b = fs.readFileSync(p);
    const bad = Array.from(b).filter((x) => x > 127);
    assert.equal(bad.length, 0, `${label} 还剩 ${bad.length} 个非 ASCII 字节`);
    assert.notEqual(b.subarray(0, 3).toString("hex"), "efbbbf", `${label} 不要 UTF-8 BOM`);
  }
});

test("两个 CMD 启动脚本一律 CRLF，且没有孤立 LF", () => {
  for (const [p, label] of cmdFiles) {
    const s = fs.readFileSync(p, "latin1");
    const lf = (s.match(/\n/g) ?? []).length;
    const crlf = (s.match(/\r\n/g) ?? []).length;
    assert.ok(lf > 0, `${label} 不该是空文件`);
    assert.equal(lf, crlf, `${label} 有 ${lf - crlf} 个孤立 LF；CMD 只认 CRLF`);
  }
});

test("ASCII 化没把启动逻辑改丢", () => {
  const a = fs.readFileSync(LAUNCHER, "utf8");
  const b = fs.readFileSync(STARTER, "utf8");
  assert.match(a, /cd \/d "C:\/Users\//, "工作目录仍要显式切到项目根");
  assert.match(a, /for \/f "tokens=\*" %%i in \('powershell /, "AI 密钥读取那行不能丢");
  assert.match(a, /set AGNES_API_KEY=%%i/);
  assert.match(a, /call scripts\\start\.cmd/);
  for (const v of ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "no_proxy"]) {
    assert.match(a, new RegExp(`^set ${v}=`, "m"), `${v} 仍要清空,否则本机请求被代理拦`);
  }
  assert.match(b, /-ExecutionPolicy Bypass -File "%~dp0start\.ps1"/);
  assert.match(b, /if not "%EXITCODE%"=="0"/);
  assert.match(b, /^  pause$/m, "失败时要停住窗口,别一闪而过");
});

test("start.ps1 保留 UTF-8 BOM —— 它有中文注释,靠 BOM 让 PowerShell 5.1 按 UTF-8 读", () => {
  const b = fs.readFileSync(PS1);
  assert.equal(b.subarray(0, 3).toString("hex"), "efbbbf");
});

test(".gitattributes 必须给 .bat / .cmd 钉死 CRLF，否则下次 checkout 会把脚本洗回 LF", () => {
  // 本机把文件转成 CRLF 不够:仓库默认 `* text=auto eol=lf`,
  // 提交时会被规范化、别人 checkout 又变 LF-only —— 乱码首行会复现。
  const a = fs.readFileSync(path.join(ROOT, ".gitattributes"), "utf8");
  assert.match(a, /^\*\.cmd text eol=crlf$/m);
  assert.match(a, /^\*\.bat text eol=crlf$/m);
});
