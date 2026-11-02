import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import test from "node:test";
import { entryModuleOf, productUiReady } from "../src/startup_health.ts";

test("启动就绪必须同时收到真实界面与代理后端健康状态", async (t) => {
  let phase = "cold";
  const server = http.createServer((req, res) => {
    if (req.url === "/") { res.setHeader("Content-Type", "text/html"); res.end(phase === "wrong-ui" ? "other service" : '<div id="root"></div>'); return; }
    if (phase === "hung") return;
    if (phase === "cold") { res.writeHead(502); res.end(); return; }
    if (phase === "unauthorized") { res.writeHead(401); res.end(); return; }
    res.setHeader("Content-Type", "application/json");
    res.end(phase === "malformed" ? '<div id="root"></div>' : JSON.stringify({ ok: true, version: "test" }));
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  for (phase of ["cold", "unauthorized", "malformed", "wrong-ui", "hung"]) {
    assert.equal(await productUiReady(url, 80), false, phase);
  }
  phase = "ready";
  assert.equal(await productUiReady(url), true);
});

test("Windows 启动器在打开浏览器前轮询就绪，并持续检查两棵进程", () => {
  const script = fs.readFileSync(new URL("../../scripts/start.ps1", import.meta.url), "utf8");
  assert.doesNotMatch(script, /Start-Sleep -Seconds 2/);
  assert.match(script, /startup_health\.ts/);
  assert.match(script, /while \(\[DateTime\]::UtcNow -lt \$readyDeadline\)/);
  assert.ok(script.indexOf("Start-Process $uiUrl") > script.indexOf('if (-not $ready)'));
  assert.ok(script.indexOf('if (-not $ready)') > 0);
  assert.match(script, /\$api\.Refresh\(\)[\s\S]*\$ui\.Refresh\(\)/);
});

test("就绪检查命令行:按 VRA_UI_PORT 查实际端口;经符号链接 / 目录联接运行也真的去查(否则什么都不做、退出码 0 被当成已就绪)", async (t) => {
  const { spawn } = await import("node:child_process");
  const os = await import("node:os");
  const path = await import("node:path");
  const server = http.createServer((req, res) => {
    if (req.url === "/") { res.setHeader("Content-Type", "text/html"); res.end('<div id="root"></div>'); return; }
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ ok: true, version: "test" }));
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vr-health-link-"));
  t.after(() => { server.closeAllConnections(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const closed = await new Promise<number>((resolve) => { const s = http.createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); }); });
  const { fileURLToPath } = await import("node:url");
  const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
  const link = path.join(dir, "src");
  fs.symlinkSync(src, link, process.platform === "win32" ? "junction" : "dir");
  const run = (script: string, uiPort: number) => new Promise<number | null>((resolve) => {
    const child = spawn(process.execPath, [script], { env: { ...process.env, VRA_UI_PORT: String(uiPort) }, stdio: "ignore" });
    child.on("exit", (code) => resolve(code));
  });
  for (const script of [path.join(src, "startup_health.ts"), path.join(link, "startup_health.ts")]) {
    assert.equal(await run(script, port), 0, `${script} 就绪`);
    assert.equal(await run(script, closed), 2, `${script} 端口没开着必须报没就绪`);
  }
});

test("🔴 首页 200 但入口模块还没编译出来 → 不算就绪(否则启动器打开的是白屏)", async (t) => {
  let entry: "none" | "js" | "html-error" | "404" = "none";
  const server = http.createServer((req, res) => {
    if (req.url === "/") {
      res.setHeader("Content-Type", "text/html");
      res.end('<!doctype html><div id="root"></div><script type="module" src="/src/main.tsx"></script>');
      return;
    }
    if (req.url === "/src/main.tsx") {
      if (entry === "404") { res.writeHead(404); res.end(); return; }
      if (entry === "html-error") { res.setHeader("Content-Type", "text/html"); res.end("<h1>Transform failed</h1>"); return; }
      if (entry === "js") { res.setHeader("Content-Type", "text/javascript"); res.end("export {}"); return; }
      return; // none:一直不返回 —— 模拟正在编译
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, version: "test" }));
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  assert.equal(await productUiReady(url, 200), false, "入口还在编译就不能放行");
  entry = "html-error";
  assert.equal(await productUiReady(url, 200), false, "入口返回的是错误页,不是 JS");
  entry = "404";
  assert.equal(await productUiReady(url, 200), false, "入口 404 说明前端根本没起来");
  entry = "js";
  assert.equal(await productUiReady(url), true, "入口真能编译出来才算就绪");
});

test("打包页没有 /src 入口,不该去探它(否则 -Prebuilt 永远等不到就绪)", async (t) => {
  const asked: string[] = [];
  const server = http.createServer((req, res) => {
    asked.push(req.url ?? "");
    if (req.url === "/") {
      res.setHeader("Content-Type", "text/html");
      res.end('<!doctype html><div id="root"></div><script type="module" crossorigin src="/assets/index-a1b2c3.js"></script>');
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, version: "test" }));
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  assert.equal(await productUiReady(url), true);
  assert.ok(!asked.includes("/src/main.tsx"), "打包页不该被问 /src/main.tsx");
});

test("entryModuleOf 只认开发服务器入口,别的 script 不误认", () => {
  assert.equal(entryModuleOf('<script type="module" src="/src/main.tsx"></script>'), "/src/main.tsx");
  assert.equal(entryModuleOf('<script type="module" src="/@vite/client"></script>'), null);
  assert.equal(entryModuleOf('<script src="/assets/x.js"></script>'), null);
  assert.equal(entryModuleOf("<div id=root></div>"), null);
});
