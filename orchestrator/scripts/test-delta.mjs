#!/usr/bin/env node
// 增量测试门禁:把「本机既有的失败」固化成基线,只报「本次改动新引入的失败」。
//
// 背景:本机(Windows 沙箱)有近百个既有失败 —— 一部分是环境性的(沙箱禁符号链接、
// Python 子进程用 cp936 读 UTF-8、reg.exe 被黑名单、无外网、Windows ESM c: 协议),
// 一部分是工作区累积改动触发的守卫测试(Core 纯净度棘轮、README 栏目数、路由/导航
// 双向一致、Python/TS 两份 gate 词表),一直没人裁决。每次改完都人工核对
// 「这 90 多个是不是我搞的」不可持续,所以把它们记成基线,之后只看增量。
//
// ⚠️ 基线不是「把失败藏起来」:env-* 是本机跑不了、换机器就绿;code-* 是真实代码问题,
//    报告里单独一节列出提醒你去修。门禁只认「文件名 + 用例名」,cause 只是给人看的归类。
//
// 用法:
//   node scripts/test-delta.mjs                    # 跑全量,只报新增失败(回归),退出码 0/1
//   node scripts/test-delta.mjs --update-baseline  # 用当前失败覆盖基线(确认后主动收编)
//   node scripts/test-delta.mjs --only "market_call,schedule"  # 只跑部分文件(快验,不与基线比对)
//   node scripts/test-delta.mjs --concurrency 8
//
// 判定:
//   🔴 新增失败(不在基线) → 退出码 1。这就是「本次操作造成的」,必须处理。
//   ✅ 已修复(在基线但现在通过) → 提示从基线移除,退出码 0。
//   ⚪ 基线内失败(仍在失败) → 只计数,不打扰;其中 code-* 会单独提醒。
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { classify, CAUSE_NOTES, isEnv } from "./test-causes.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE = join(HERE, "..", "test", "known-failures.json");

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const getArg = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

/** 用例名里若嵌了动态 JSON/数组,比对会不稳 —— 从第一个带 { 或 [ 的括号处截断。 */
function normName(name) {
  const m = /\s[(（][{[]/.exec(name);
  return (m ? name.slice(0, m.index) : name).trim();
}

/** 逐文件跑全量,复用 run-all-tests.mjs 的输出。返回只含失败文件的数组。 */
function runSweep(concurrency, only) {
  const argv = [join(HERE, "run-all-tests.mjs"), "--concurrency", String(concurrency)];
  if (only) argv.push("--only", only);   // 透传:不传的话 --only 会跑完整全量却谎称只跑部分
  const out = execFileSync(process.execPath, argv, {
    encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], windowsHide: true,
    cwd: join(HERE, ".."),
  });
  return JSON.parse(out).results;
}

/** 对一批失败文件抓 error/code,用于 --update-baseline 打标签。 */
function harvestErrors(failedFiles) {
  const map = {};
  for (const f of failedFiles) {
    let tap = "";
    try {
      tap = execFileSync(process.execPath, ["--test", `test/${f}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, cwd: join(HERE, "..") });
    } catch (e) { tap = (e.stdout || "") + (e.stderr || ""); }
    const lines = tap.split(/\r?\n/);
    const errs = [];
    for (let i = 0; i < lines.length; i++) {
      const m = /^not ok \d+ - (.+)$/.exec(lines[i]);
      if (!m) continue;
      let err = "", code = "";
      for (let j = i + 1; j < Math.min(i + 30, lines.length); j++) {
        const L = lines[j];
        if (/^  \.\.\./.test(L)) break;
        let mm = /^  code: (.+)$/.exec(L); if (mm) code = mm[1].replace(/["']/g, "");
        mm = /^  error: (.+)$/.exec(L);
        if (mm) {
          if (mm[1] === "|-" || mm[1] === "|") {
            const buf = [];
            for (let k = j + 1; k < lines.length; k++) {
              if (/^    \S/.test(lines[k]) || /^      /.test(lines[k])) buf.push(lines[k].trim());
              else if (/^  [a-z_]+:/.test(lines[k]) || /^  \.\.\./.test(lines[k])) break;
            }
            err = buf.join(" ").slice(0, 240);
          } else err = mm[1];
        }
      }
      errs.push({ name: normName(m[1]), err, code });
    }
    map[f] = errs;
  }
  return map;
}

const only = getArg("--only", "");
const concurrency = Number(getArg("--concurrency", "4"));
process.stderr.write(`[test-delta] 逐文件跑${only ? `(--only ${only})` : "全量"}(concurrency=${concurrency}${only ? "" : ",约 3-5 分钟"})...\n`);
const sweep = runSweep(concurrency, only);

// --only 拼错匹配到 0 个文件时必须报错退出,不能输出「无变化 + 退出码 0」——
// 那是假绿:一个测试都没跑却看起来全过(fail-open)。
if (only && sweep.length === 0) {
  process.stderr.write(`[test-delta] --only "${only}" 没匹配到任何测试文件。检查拼写(test/ 下 *.test.ts)。\n`);
  process.exit(2);
}

// 展平成 当前失败集合:key = "file::normName"
const current = new Map();
for (const r of sweep) for (const n of r.fail) current.set(`${r.file}::${normName(n)}`, { file: r.file, name: normName(n) });

if (has("--update-baseline")) {
  process.stderr.write(`[test-delta] 抓取报错用于打标签...\n`);
  const errMap = harvestErrors([...new Set([...current.values()].map((v) => v.file))]);
  const entries = [...current.values()]
    .map((v) => {
      const hit = (errMap[v.file] || []).find((e) => e.name === v.name) || {};
      const err = (hit.err || "").replace(/\s+/g, " ");
      return { file: v.file, name: v.name, cause: classify(v.file, v.name, err, hit.code), err: err.slice(0, 140) };
    })
    .sort((a, b) => (a.file + a.name).localeCompare(b.file + b.name));
  const byCause = {};
  for (const e of entries) byCause[e.cause] = (byCause[e.cause] || 0) + 1;
  writeFileSync(BASELINE, JSON.stringify({
    _comment: "本机既有失败基线。由 scripts/test-delta.mjs --update-baseline 生成。门禁只认 file+name;cause 是给人看的归类(env-*=环境性换机即绿,code-*=真实代码问题待修)。",
    generatedAt: new Date().toISOString(),
    count: entries.length,
    byCause,
    entries,
  }, null, 2));
  process.stdout.write(`[test-delta] 基线已写入 ${BASELINE}\n  共 ${entries.length} 条\n`);
  const envN = entries.filter((e) => isEnv(e.cause)).length;
  process.stdout.write(`    其中 环境性(env-*) ${envN} 条 / 代码问题(code-*) ${entries.length - envN} 条\n`);
  for (const [c, n] of Object.entries(byCause).sort((a, b) => b[1] - a[1])) process.stdout.write(`    ${String(n).padStart(3)}  ${c.padEnd(18)} ${CAUSE_NOTES[c] || ""}\n`);
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  process.stderr.write(`[test-delta] 没有基线文件 ${BASELINE}\n  先跑: node scripts/test-delta.mjs --update-baseline\n`);
  process.exit(2);
}
const base = JSON.parse(readFileSync(BASELINE, "utf8"));
// --only 时只在「实际跑过的文件」范围内比对:否则基线里其他文件的失败会全被误报成「已修复」。
const sweptFiles = new Set(sweep.map((r) => r.file));
const scope = only ? (e) => sweptFiles.has(e.file) : () => true;
const baseMap = new Map((base.entries || []).filter(scope).map((e) => [`${e.file}::${e.name}`, e]));
const baseKeys = new Set(baseMap.keys());

const fixed = [...baseKeys].filter((k) => !current.has(k));
const added = [...current.keys()].filter((k) => !baseKeys.has(k));

process.stdout.write(`\n===== test-delta 结果 =====\n`);
process.stdout.write(`基线既有失败: ${baseKeys.size}   本次失败: ${current.size}${only ? `   (--only "${only}",不与基线比对增减)` : ""}\n\n`);

if (added.length) {
  process.stdout.write(`🔴 新增失败 ${added.length} 条(本次改动引入,必须处理):\n`);
  for (const k of added) process.stdout.write(`   ${current.get(k).file} :: ${current.get(k).name}\n`);
  process.stdout.write(`\n`);
}
if (fixed.length) {
  process.stdout.write(`✅ 已修复 ${fixed.length} 条(基线里有、现在通过了,可从基线移除):\n`);
  for (const k of fixed) process.stdout.write(`   ${k.replace("::", " :: ")}\n`);
  process.stdout.write(`   → 确认后跑: node scripts/test-delta.mjs --update-baseline\n\n`);
}
if (!added.length && !fixed.length) process.stdout.write(`⚪ 无变化:失败集合与基线完全一致(${current.size} 条都是既有的)。\n\n`);

// 基线里仍失败的 code-* 单独提醒:它们不是环境问题,该修还得修。
const stillCode = [...current.keys()].filter((k) => { const e = baseMap.get(k); return e && !isEnv(e.cause); });
if (stillCode.length) {
  process.stdout.write(`🟡 提醒:基线里有 ${stillCode.length} 条是真实代码问题(code-*),不是环境性的,长期应处理:\n`);
  const byC = {};
  for (const k of stillCode) { const c = baseMap.get(k).cause; (byC[c] ||= []).push(k); }
  for (const [c, ks] of Object.entries(byC).sort((a, b) => b[1].length - a[1].length)) {
    process.stdout.write(`   ${c} (${CAUSE_NOTES[c] || ""}) —— ${ks.length} 条\n`);
    for (const k of ks.slice(0, 3)) process.stdout.write(`       ${k.replace("::", " :: ")}\n`);
    if (ks.length > 3) process.stdout.write(`       … 及另外 ${ks.length - 3} 条(见基线 ${BASELINE})\n`);
  }
  process.stdout.write(`\n`);
}

process.stdout.write(added.length ? `结论: 有 ${added.length} 条新增失败 → 退出码 1\n` : `结论: 无新增失败 → 退出码 0\n`);
process.exit(added.length ? 1 : 0);
