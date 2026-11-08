/**
 * 失败归类器的护栏 —— 它决定门禁把一条失败算成「环境性」还是「真实代码问题」。
 *
 * 🔴 归类错了**不会让任何测试变红**：门禁只认 file+name，cause 只给人看。
 *    所以「把真回归标成 env 蒙混过去」（等于关掉警报）此前完全无人守护，
 *    scripts/ 也不在任何 npm test 的扫描范围内。这里真跑纯函数钉住方向纪律。
 */
import assert from "node:assert/strict";
import test from "node:test";

// @ts-ignore -- test-causes.mjs 是运行时脚本,没有 .d.ts;在此给一个本地契约
const mod = await import("../scripts/test-causes.mjs");
const classify = mod.classify as (file: string, name: string, err: string, code: string) => string;
const isEnv = mod.isEnv as (cause: string) => boolean;
const CAUSE_NOTES = mod.CAUSE_NOTES as Record<string, string>;

test("[行为] 环境性失败按报错文本归类，不看用例名", () => {
  assert.equal(classify("a.test.ts", "某用例", "EPERM: operation not permitted, symlink 'x'", "EPERM"), "env-symlink");
  assert.equal(classify("a.test.ts", "某用例", "EPERM: operation not permitted", "EPERM"), "env-perm");
  assert.equal(classify("a.test.ts", "某用例", "connect ECONNREFUSED 127.0.0.1:8770", ""), "env-network");
  assert.equal(classify("a.test.ts", "某用例", "PROGRAM BLOCKED BY SECURITY POLICY: reg.exe", ""), "env-sandbox");
  assert.equal(classify("a.test.ts", "某用例", "cp936 mojibake 锟斤拷", ""), "env-encoding");
  assert.equal(classify("a.test.ts", "某用例", "d:\\program files\\wb\\workbuddy" , ""), "env-platform");
  assert.equal(classify("a.test.ts", "某用例", "Traceback (most recent call last)", ""), "env-spawn");
});

test("[行为] 守卫棘轮与两份实现不一致要归 code，不许被静音", () => {
  assert.equal(classify("anything.test.ts", "某用例", "行业词总数 1 超过上限 0", ""), "code-guardrail");
  assert.equal(classify("core_purity.test.ts", "某用例", "assert failed", ""), "code-guardrail");
  assert.equal(classify("readme_numbers.test.ts", "某用例", "assert failed", ""), "code-guardrail");
  assert.equal(classify("a.test.ts", "GATE_WORDS 逐字一致", "assert failed", ""), "code-inconsistent");
});

test("[行为] 方向纪律：认不出来一律 code-or-unclear，绝不猜成 env", () => {
  for (const [file, name, err] of [
    ["new_feature.test.ts", "刚写的用例", "Expected values to be strictly equal"],
    ["a.test.ts", "某用例", "some unexpected failure"],
    ["a.test.ts", "某用例", ""],
  ] as const) {
    const c = classify(file, name, err, "");
    assert.equal(isEnv(c), false, `${file} :: ${name} 的报错认不出来时,不许归环境性把警报关掉`);
    assert.equal(c, "code-or-unclear");
  }
});

test("[行为] isEnv 只认 env- 前缀；flaky-load / code-* 都不算", () => {
  assert.equal(isEnv("env-perm"), true);
  assert.equal(isEnv("flaky-load"), false);
  assert.equal(isEnv("code-guardrail"), false);
  assert.equal(isEnv("code-or-unclear"), false);
});

test("[行为] 每种 cause 都要有给人看的说明，新增归类别忘补 CAUSE_NOTES", () => {
  const probes: [string, string, string][] = [
    ["a", "x", "symlink EPERM"], ["a", "x", "ECONNREFUSED"], ["a", "x", "reg.exe"],
    ["a", "x", "cp936 锟斤拷"], ["a", "x", "Traceback (most recent call last)"],
    ["a", "x", "d:\\program files\\wb\\workbuddy"], ["a", "x", "agent_windows_wrapper_unsupported"],
    ["core_purity.test.ts", "x", "x"], ["a", "GATE_WORDS 逐字一致", "x"],
    ["a", "x", "完全没见过"],
  ];
  const seen = new Set(probes.map(([f, n, e]) => classify(f, n, e, "")));
  seen.add("flaky-load"); // 由 test-delta.mjs 手写，不在 classify 的返回值里
  for (const c of seen) assert.ok(CAUSE_NOTES[c], `归类 ${c} 少了可读说明`);
  assert.ok(seen.size >= 8, `探针要覆盖足够多的分支,实得 ${seen.size}`);
});
