import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import os from "node:os";
import { fetchEnv } from "../src/config.ts";
import { localSubscriptionEnv } from "../src/local_agent_runtime.ts";
import { researchEnv, startResearch, type ServiceContext } from "../src/service.ts";
import "../src/finance/register.ts";

test("研究子进程:带空格的路径照样拉得起;v1 的 engine 字段明确拒绝,不悄悄忽略", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vra-launch-"));
  try {
    for (const name of ["Applications", "Disk Image"]) {
      const repoRoot = path.join(dir, name);
      fs.mkdirSync(path.join(repoRoot, "orchestrator/src"), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, "orchestrator/src/run.ts"), "console.log(JSON.stringify(process.argv.slice(2)))");
      const ctx: ServiceContext = { repoRoot, dataRoot: path.join(repoRoot, "data"), python: "python3", node: process.execPath };
      assert.throws(() => startResearch(ctx, { symbol: "300308", market: "SZ", engine: "codex" }), /engine 参数已在 v2\.0 移除/);
      // 干跑不调大脑,也就不要求先配好 AI 来源
      const result = startResearch(ctx, { symbol: "300308", market: "SZ", run_id: "launch-check", no_agent: true });
      const log = path.join(ctx.dataRoot, result.log);
      let output = "";
      for (let i = 0; i < 100; i++) {
        output = fs.readFileSync(log, "utf8").trim();
        if (output) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const argv: string[] = JSON.parse(output);
      assert.equal(argv[argv.indexOf("--run-id") + 1], "launch-check");
      assert.ok(argv.includes("--no-agent"));
      assert.equal(argv.includes("--execution-mode") || argv.includes("--engine"), false, "v2 不再有执行模式 / 引擎参数");
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test("no-bytecode / no-user-site policy survives fetch, research and local-agent environment isolation", () => {
  const source = { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1", UNRELATED_SECRET: "do-not-forward" };
  const envs = [fetchEnv({}, source), researchEnv(source), ...(["claude", "codex", "codebuddy"] as const).map((a) => localSubscriptionEnv(source, a))];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vra-bytecode-"));
  try {
    fs.writeFileSync(path.join(dir, "probe.py"), "value = 1\n");
    const python = process.env.VRA_PYTHON || "python3";
    for (const env of envs) {
      assert.equal(env.PYTHONDONTWRITEBYTECODE, "1");
      assert.equal(env.PYTHONNOUSERSITE, "1", "免安装包不看用户目录的 site-packages,子进程也要保持");
      assert.equal(env.UNRELATED_SECRET, undefined);
      execFileSync(python, ["-c", "import probe; assert probe.value == 1"], { cwd: dir, env });
      assert.equal(fs.existsSync(path.join(dir, "__pycache__")), false);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("取数子进程按 UTF-8 交回输出:中文标题不会变成替换符(Windows 上曾经整段乱码)", () => {
  // 真实启动环境是 `scripts/start.ps1` 起的 PowerShell,**没有** PYTHONUTF8 / PYTHONIOENCODING。
  // 取数子进程的环境是白名单挑的(FETCH_ENV_KEYS),父进程带没带都不该决定结果 —— 必须在这里写死:
  // Node 侧一律按 utf8 解 stdout(service.runFetchProcess),python 不声明就按 cp936 写,中文全成 U+FFFD 且不可逆。
  const source = { PATH: process.env.PATH, LANG: "zh_CN.GBK" };
  const env = fetchEnv({}, source);
  assert.equal(env.PYTHONUTF8, "1");
  assert.equal(env.PYTHONIOENCODING, "utf-8");
  assert.equal(env.LANG, "zh_CN.GBK", "父进程的语言变量照传,不拿它当编码开关");

  const python = process.env.VRA_PYTHON || "python3";
  const title = "股票交易异常波动公告";
  // ① 子进程真的收到了这两项(不是只在对象里躺着)
  assert.equal(execFileSync(python, ["-c", "import os;print(os.environ['PYTHONIOENCODING'])"], { env, encoding: "utf8" }).trim(), "utf-8");
  // ② 中文按 UTF-8 交回来,一个替换符都没有
  const out = execFileSync(python, ["-c", `import sys;sys.stdout.write(${JSON.stringify(title)})`], { env, encoding: "utf8" });
  assert.equal(out, title);
  assert.equal(out.includes("\ufffd"), false);
});
