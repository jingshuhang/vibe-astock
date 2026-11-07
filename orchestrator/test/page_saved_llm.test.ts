import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import "../src/finance/register.ts";
import "../src/finance/register_tasks.ts";
import { clearSavedLlm, readSavedLlm, savedLlmFile, savedLlmStatus, writeSavedLlm } from "../src/page_saved_llm.ts";
import { RuntimeProviderError, defaultLlm, resolveSelectedRuntime, runtimeSourceFingerprint } from "../src/runtime_provider.ts";
import { ServiceError, agentTurnFor, clearSavedLlmRoute, productInfo, saveSavedLlm, savedLlmOverview, type ServiceContext } from "../src/service.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * 页面上保存的那份 AI 配置 → 落到数据根 → 定时任务用它。
 *
 * 🔴 这一组的来历（2026-11-05 实测）：侧栏写着「已接入AI」，18:55 日复盘 / 19:02 情绪复盘
 *    却全部 404、一篇没写出来 —— 因为页面那份只存在浏览器里，三个定时任务读的是
 *    `config.json` 里另一家。**界面上一片绿，任务全红**，没有任何一处能看出这两者是两家。
 */

/** 语义测试用自造模板（放在临时数据根里），不跟某家厂商当下的地址 / 模型名绑死 */
function dataRoot(config?: unknown): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vra-psl-"));
  fs.mkdirSync(path.join(root, "providers"));
  fs.writeFileSync(path.join(root, "providers", "fixture-api.json"), JSON.stringify({
    id: "fixture-api", name: "Fixture API", base_url: "https://api.fixture.invalid/v1",
    env_key: "FIXTURE_API_KEY", default_model: "fixture-default",
  }));
  if (config !== undefined) fs.writeFileSync(path.join(root, "config.json"), JSON.stringify(config));
  return root;
}

const ctxOf = (root: string): ServiceContext => ({ repoRoot: REPO, dataRoot: root, python: "python3", node: process.execPath }) as unknown as ServiceContext;
const CONFIG = { provider: { profile: "fixture-api" }, defaults: { model: "fixture-default" } };
const ENV: NodeJS.ProcessEnv = { PATH: "/usr/bin", FIXTURE_API_KEY: "sk-from-env" };
const code = (fn: () => unknown): string => {
  try { fn(); return "(没抛)"; } catch (e) {
    if (e instanceof RuntimeProviderError || e instanceof ServiceError) return e.code;
    return `(不是预期错误:${e})`;
  }
};

test("优先级：没存过 → config.json；存了 → 页面这份；清掉 → 回落 config.json", () => {
  const DATA = dataRoot(CONFIG);
  assert.deepEqual(defaultLlm(REPO, DATA, ENV), { provider: "fixture-api", apiKey: "sk-from-env", model: "fixture-default" });

  writeSavedLlm(DATA, { provider: "fixture-api", apiKey: "sk-from-page", model: "page-model" });
  assert.deepEqual(defaultLlm(REPO, DATA, ENV), { provider: "fixture-api", apiKey: "sk-from-page", model: "page-model" });

  // 真解析一遍：模型与 key 都取自页面那份（这才是三个定时任务实际用到的东西）
  const r = resolveSelectedRuntime(REPO, DATA, undefined, ENV);
  assert.equal(r.runtime, "api");
  if (r.runtime !== "api") assert.fail("模板来源应当解析成模型 API");
  assert.equal(r.api.model, "page-model");
  assert.equal(r.api.apiKey, "sk-from-page");
  assert.equal(r.env.FIXTURE_API_KEY, "sk-from-page", "子进程按模板声明的变量名拿到页面那份 key");

  assert.equal(clearSavedLlm(DATA), true);
  assert.equal(defaultLlm(REPO, DATA, ENV).apiKey, "sk-from-env");
  assert.equal(clearSavedLlm(DATA), false, "本来就没有 = false，不能报成「删掉了」");
});

test("命令行与 VRA_PROVIDER 是当次显式选择，压过页面保存的那份", () => {
  const DATA = dataRoot(CONFIG);
  writeSavedLlm(DATA, { provider: "fixture-api", apiKey: "sk-from-page", model: "page-model" });
  assert.equal(defaultLlm(REPO, DATA, ENV, { providerOverride: "fixture-api" }).apiKey, "sk-from-env");
  assert.equal(defaultLlm(REPO, DATA, ENV, { model: "cli-model" }).apiKey, "sk-from-env");
  assert.equal(defaultLlm(REPO, DATA, ENV, { userConfigPath: path.join(DATA, "config.json") }).apiKey, "sk-from-env");
  assert.equal(defaultLlm(REPO, DATA, { ...ENV, VRA_PROVIDER: "fixture-api" }).apiKey, "sk-from-env");
});

test("🔴 文件在但读不懂 → 报错，不偷换成 config.json 里那家去跑", () => {
  const DATA = dataRoot(CONFIG);
  fs.writeFileSync(savedLlmFile(DATA), "{ 这不是 json");
  assert.equal(code(() => defaultLlm(REPO, DATA, ENV)), "bad_llm");
  let message = "";
  try { defaultLlm(REPO, DATA, ENV); } catch (e) { message = (e as Error).message; }
  assert.match(message, /llm\.json/, "报错里要有文件名，否则用户不知道去哪修");
  assert.match(message, /接入 AI/, "要说去哪儿修");

  // 形状不对（没有 provider）同样当"坏了"，不当"没配"
  fs.writeFileSync(savedLlmFile(DATA), JSON.stringify({ schemaVersion: 2, source: {} }));
  assert.equal(code(() => defaultLlm(REPO, DATA, ENV)), "bad_llm");
  assert.equal(readSavedLlm(DATA).source, null);
  assert.match(readSavedLlm(DATA).problem ?? "", /provider/);
});

test("🔴 定时任务拿到的就是页面那份：指纹按它算，productInfo 也如实说取自 page", () => {
  const DATA = dataRoot(CONFIG);
  const ctx = ctxOf(DATA);
  writeSavedLlm(DATA, { provider: "fixture-api", apiKey: "sk-from-page", model: "page-model" });

  // 定时任务走的正是 agentTurnFor(ctx, {}) —— 不带请求级 llm，落在这里
  const agent = agentTurnFor(ctx, {});
  const pageFingerprint = runtimeSourceFingerprint(REPO, DATA, { provider: "fixture-api", apiKey: "sk-from-page", model: "page-model" }, ENV);
  const configFingerprint = runtimeSourceFingerprint(REPO, DATA, { provider: "fixture-api", apiKey: "sk-from-env", model: "fixture-default" }, ENV);
  assert.equal(agent.fingerprint, pageFingerprint, "开工记下的来源必须是页面那份");
  assert.notEqual(agent.fingerprint, configFingerprint, "不能跟 config.json 那份算成同一个来源");

  const info = productInfo(ctx);
  assert.equal(info.provider_source, "page");
  const provider = info.provider as Record<string, unknown>;
  assert.equal(provider.profile, "fixture-api");
  assert.equal(provider.model, "page-model");
  assert.equal(provider.key_present, true);
  assert.equal(provider.env_key, null, "key 不在环境变量里，报 env_key 会把人指到错的地方");
  // config.json 那份仍然能看到（诊断用），但**不许**冒充成正在生效的那份
  assert.equal((info.config_provider as Record<string, unknown>).model, "fixture-default");

  assert.equal(clearSavedLlm(DATA), true);
  assert.equal(productInfo(ctx).provider_source, "config", "清掉之后要如实回到 config.json");
});

test("自填端点（没有模板）也要能如实描述：不当成「配置坏了」", () => {
  const DATA = dataRoot(CONFIG);
  const ctx = ctxOf(DATA);
  saveSavedLlm(ctx, { source: { provider: "custom", baseURL: "https://gateway.example.com/v1", apiKey: "sk-x", model: "m" } });
  const info = productInfo(ctx);
  const provider = info.provider as Record<string, unknown>;
  assert.equal(info.provider_source, "page");
  assert.equal(provider.kind, "api");
  assert.equal(provider.label, "自定义端点", "没有模板不等于坏了");
  assert.equal(provider.key_present, true);
  assert.match(String(provider.base_url), /gateway\.example\.com/);
  assert.equal(info.config_error, null, "自填端点不产生配置错误");
});

test("回给页面的状态里没有 key；端点里的 userinfo / query 也抹掉", () => {
  const DATA = dataRoot(CONFIG);
  writeSavedLlm(DATA, {
    provider: "fixture-api", apiKey: "sk-very-secret-123",
    baseURL: "https://user:pass@api.fixture.invalid/v1?api_key=leaked", model: "m",
  });
  const st = savedLlmStatus(DATA);
  const json = JSON.stringify(st);
  assert.equal(st.saved, true);
  assert.ok(!json.includes("sk-very-secret-123"), `状态里混进了 key:${json}`);
  assert.ok(!json.includes("leaked") && !json.includes("pass"), `端点里的凭据被原样带出去了:${json}`);
  assert.match(st.base_url ?? "", /^https:\/\/api\.fixture\.invalid\/v1$/);
  // 盘上存的是原文（要用），下发出去的是打码后的（要能贴）—— 两者不能混为一谈
  assert.equal(readSavedLlm(DATA).source?.apiKey, "sk-very-secret-123");
});

test("落盘前按后台同一条解析链校验：认不出的来源 / 缺 key 当场拒，一律不落盘", () => {
  const ctx = ctxOf(dataRoot(CONFIG));
  assert.equal(code(() => saveSavedLlm(ctx, { source: { provider: "no-such-provider" } })), "unknown_provider");
  assert.equal(code(() => saveSavedLlm(ctx, { source: { provider: "fixture-api", model: "m" } })), "missing_key");
  assert.equal(code(() => saveSavedLlm(ctx, { source: { provider: "custom", baseURL: "", apiKey: "k", model: "m" } })), "missing_base_url");
  assert.equal(code(() => saveSavedLlm(ctx, {})), "bad_llm");
  assert.equal(code(() => saveSavedLlm(ctx, { source: { provider: "fixture-api", apiKey: "k", model: "m", oops: 1 } })), "bad_llm");
  assert.ok(!fs.existsSync(savedLlmFile(ctx.dataRoot)), "被拒的那几份一份都不许落盘");

  const ok = saveSavedLlm(ctx, { source: { provider: "fixture-api", apiKey: "sk-1", model: "m" } });
  assert.equal(ok.ok, true);
  assert.equal((savedLlmOverview(ctx).jobs_ai as Record<string, unknown>).layer, "page");
  assert.equal(clearSavedLlmRoute(ctx).removed, true);
  assert.equal((savedLlmOverview(ctx).jobs_ai as Record<string, unknown>).layer, "config");
});

test("🔴 远程访问模式下不把模型密钥存到这台机器", () => {
  const ctx = ctxOf(dataRoot(CONFIG));
  const saved = process.env.VRA_REMOTE;
  process.env.VRA_REMOTE = "1";
  try {
    assert.equal(code(() => saveSavedLlm(ctx, { source: { provider: "fixture-api", apiKey: "sk-1", model: "m" } })), "remote_saved_llm_forbidden");
    assert.ok(!fs.existsSync(savedLlmFile(ctx.dataRoot)), "拒了就不许留下半个文件");
    // 清除不受影响：把盘上那份删掉在任何模式下都是安全的
    assert.equal(clearSavedLlmRoute(ctx).removed, false);
  } finally {
    if (saved === undefined) delete process.env.VRA_REMOTE; else process.env.VRA_REMOTE = saved;
  }
});

test("重复保存只留一份，时间戳跟着更新", () => {
  const DATA = dataRoot(CONFIG);
  const first = writeSavedLlm(DATA, { provider: "fixture-api", apiKey: "sk-1", model: "m1" }, new Date("2026-11-05T10:00:00Z"));
  const second = writeSavedLlm(DATA, { provider: "fixture-api", apiKey: "sk-2", model: "m2" }, new Date("2026-11-05T11:00:00Z"));
  assert.equal(first.savedAt, "2026-11-05T18:00:00+08:00");
  assert.equal(second.savedAt, "2026-11-05T19:00:00+08:00");
  const files = fs.readdirSync(DATA).filter((f) => f.startsWith("llm.json"));
  assert.deepEqual(files, ["llm.json"], `不该留下临时文件或第二份：${files.join(",")}`);
  assert.equal(readSavedLlm(DATA).source?.apiKey, "sk-2", "后写的覆盖前一份，旧 key 不留在盘上");
});

test("文件权限收到只有本机当前用户", { skip: process.platform === "win32" ? "Windows 用 icacls，权限位不可比" : false }, () => {
  const DATA = dataRoot(CONFIG);
  writeSavedLlm(DATA, { provider: "fixture-api", apiKey: "sk-1", model: "m" });
  assert.equal(fs.statSync(savedLlmFile(DATA)).mode & 0o777, 0o600);
});
