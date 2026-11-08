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
//   node scripts/test-delta.mjs --update-baseline  # 用当前失败覆盖基线;有新增失败时**拒绝**,要收编再加 --force
//   node scripts/test-delta.mjs --only "market_call,schedule"  # 只跑部分文件(快验,不与基线比对)
//   node scripts/test-delta.mjs --flaky "service_api_mcp.test.ts::请求体上限"  # 把基线里**已有**的条目标成不稳定
//   ... --flaky "文件::用例" --allow-new      # 显式给基线新增一条(会校验文件存在)
//   node scripts/test-delta.mjs --show-code   # 报告末尾打印基线内 code-* 的逐条清单(默认只打一行汇总)
//   node scripts/test-delta.mjs --concurrency 8
//
// 判定:
//   🔴 新增失败(不在基线) → 退出码 1。这就是「本次操作造成的」,必须处理。
//   ✅ 已修复(在基线但现在通过) → 提示从基线移除,退出码 0。
//   ⚪ 基线内失败(仍在失败) → 只计数,不打扰;其中 code-* 会单独提醒。
//
// ⚠️ 不稳定用例(flaky):有的失败是偶发的(网络抖一下、子进程时序),这条这次过了不代表
//    修好了。基线条目可标 "flaky": true —— 它即使本轮通过也不移除(否则下次偶发失败
//    会被报成「新增」,又回到人工核对);报告里单列「本轮偶然通过」而不是「已修复」。
//    标记办法:node scripts/test-delta.mjs --flaky "service_api_mcp.test.ts::请求体上限"
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

/** 逐文件跑全量,复用 run-all-tests.mjs 的输出。返回 { results(只含失败文件), files(跑过的全部) }。 */
function runSweep(concurrency, only) {
  const argv = [join(HERE, "run-all-tests.mjs"), "--concurrency", String(concurrency)];
  if (only) argv.push("--only", only);   // 透传:不传的话 --only 会跑完整全量却谎称只跑部分
  const out = execFileSync(process.execPath, argv, {
    encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], windowsHide: true,
    cwd: join(HERE, ".."),
  });
  const report = JSON.parse(out);
  return { results: report.results, files: report.files || [] };
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
const flakyPat = getArg("--flaky", "");

// --flaky:把基线里匹配的条目标成不稳定(不跑测试)。匹配串可以是「文件名::用例名」的一部分。
if (flakyPat) {
  if (!existsSync(BASELINE)) {
    process.stderr.write(`[test-delta] 没有基线文件 ${BASELINE}\n`);
    process.exit(2);
  }
  const b = JSON.parse(readFileSync(BASELINE, "utf8"));
  const hit = (b.entries || []).filter((e) => `${e.file}::${e.name}`.includes(flakyPat));
  if (!hit.length) {
    // 🔴 旧行为:没匹配到就**凭空新增**一条 flaky:true,既不验证文件/用例是否存在、
    //    也不跑测试。报告里「可标 flaky」的提示配上这条,是把一条真实回归洗进基线的最短路径:
    //    只要名字拼错(或用例本轮没失败)就多一条永久免检项,门禁从此不再报它。
    //    现在默认拒绝;确实要登记(你单跑确认过它偶发)必须显式 --allow-new,且文件必须真实存在。
    const [file, ...rest] = flakyPat.split("::");
    const name = rest.join("::").trim();
    const fileNorm = file.trim();
    const fileOk = /^[A-Za-z0-9_.-]+\.test\.ts$/.test(fileNorm) && existsSync(join(HERE, "..", "test", fileNorm));
    const miss = `[test-delta] 基线里没有匹配 "${flakyPat}" 的条目。\n`;
    if (!name || !fileOk) {
      process.stderr.write(miss
        + `  按「文件名::用例名」写、且 test/ 下得真有这个文件;拼错了就别登记。\n`
        + `  只标**已有**条目: node scripts/test-delta.mjs --flaky "<已有用例名>"\n`);
      process.exit(2);
    }
    if (!has("--allow-new")) {
      process.stderr.write(miss
        + `  ⚠️ 往基线里加一条 flaky 等于把它从门禁里免检,一条真实回归能被这样洗掉。\n`
        + `  先单跑 \`node --test test/${fileNorm}\` 确认它确实偶发失败;\n`
        + `  确认后显式登记: node scripts/test-delta.mjs --flaky "${flakyPat}" --allow-new\n`);
      process.exit(2);
    }
    const entry = { file: fileNorm, name, cause: classify(fileNorm, name, "", ""), err: "(人工标记为不稳定,尚未观察到本轮失败)", flaky: true };
    b.entries = [...(b.entries || []), entry].sort((x, y) => (x.file + x.name).localeCompare(y.file + y.name));
    b.count = b.entries.length;
    b.flakyCount = b.entries.filter((e) => e.flaky).length;
    writeFileSync(BASELINE, JSON.stringify(b, null, 2));
    process.stdout.write(`已登记 flaky(新增,--allow-new): ${entry.file} :: ${entry.name}\n`);
    process.exit(0);
  }
  for (const e of hit) e.flaky = true;
  b.flakyCount = (b.entries || []).filter((e) => e.flaky).length;
  writeFileSync(BASELINE, JSON.stringify(b, null, 2));
  for (const e of hit) process.stdout.write(`已标 flaky: ${e.file} :: ${e.name}\n`);
  process.exit(0);
}

process.stderr.write(`[test-delta] 逐文件跑${only ? `(--only ${only})` : "全量"}(concurrency=${concurrency}${only ? "" : ",约 3-5 分钟"})...\n`);
const sweep = runSweep(concurrency, only);

// --only 拼错匹配到 0 个文件时必须报错退出,不能输出「无变化 + 退出码 0」——
// 那是假绿:一个测试都没跑却看起来全过(fail-open)。
// 判据用「跑过的文件数」而不是「失败文件数」:匹配到的文件全过时后者也是 0,
// 会把这个正常结果误判成拼错(实测踩过)。
if (only && sweep.files.length === 0) {
  process.stderr.write(`[test-delta] --only "${only}" 没匹配到任何测试文件。检查拼写(test/ 下 *.test.ts)。\n`);
  process.exit(2);
}

// 展平成 当前失败集合:key = "file::normName"
const current = new Map();
for (const r of sweep.results) for (const n of r.fail) current.set(`${r.file}::${normName(n)}`, { file: r.file, name: normName(n) });

if (has("--update-baseline")) {
  const prevEntries = existsSync(BASELINE) ? (JSON.parse(readFileSync(BASELINE, "utf8")).entries || []) : [];
  // 🔴 旧行为:用当前**所有**失败覆盖基线,一句二次确认都没有。一次负载抖动、或一条
  //    本次改动引入的真实回归,只要跑一次 --update-baseline 就变成「既有失败」,
  //    门禁从此不再报它 —— 与「拿基线洗回归」只差一条命令。
  //    现在默认拒绝有新增失败的重建;确认过是环境性/既有问题才加 --force,并且逐条打出来。
  const prevKeys = new Set(prevEntries.map((e) => `${e.file}::${e.name}`));
  const newcomers = [...current.keys()].filter((k) => !prevKeys.has(k));
  if (newcomers.length && !has("--force")) {
    process.stderr.write(`[test-delta] 拒绝重建基线:本轮有 ${newcomers.length} 条失败不在旧基线里。\n`);
    for (const k of newcomers) process.stderr.write(`   + ${k.replace("::", " :: ")}\n`);
    process.stderr.write(`   先逐条单跑 \`node --test test/<文件>\` 确认是环境性还是真回归;\n`
      + `   确认要收编才跑: node scripts/test-delta.mjs --update-baseline --force\n`);
    process.exit(1);
  }
  if (newcomers.length) {
    process.stderr.write(`[test-delta] --force:本次收编 ${newcomers.length} 条新增失败(会写进基线,事后请复核)\n`);
    for (const k of newcomers) process.stderr.write(`   + ${k.replace("::", " :: ")}\n`);
  }
  process.stderr.write(`[test-delta] 抓取报错用于打标签...\n`);
  const errMap = harvestErrors([...new Set([...current.values()].map((v) => v.file))]);
  // 旧基线里标了 flaky 的条目:本轮仍在失败时要**继承**标记,
  // 否则重建一次就把「这条不稳」的知识清掉了(实测踩过:标记丢了,下次它偶发通过就被报成「已修复」)。
  const prevFlaky = new Map();
  for (const e of prevEntries) {
    if (e.flaky) prevFlaky.set(`${e.file}::${e.name}`, true);
  }
  const fresh = [...current.values()]
    .map((v) => {
      const hit = (errMap[v.file] || []).find((e) => e.name === v.name);
      // 🔴 `harvestErrors` 是**单独重跑**失败文件来抓错误文本的。所以:
      //    - 找到了 ⇒ 单跑也失败,报错就是真实的;
      //    - 没找到 ⇒ 并行跑红、单独复跑通过 ⇒ 负载相关的偶发,**自动标 flaky**。
      //    以前这里 `|| {}` 直接把"没找到"吞成空 err,归类器只能给 code-or-unclear,
      //    于是三条负载偶发在报告里长得像"待修的真实代码问题"(而且没有错误文本,根本无从下手)。
      if (!hit) {
        const flakyEntry = {
          file: v.file, name: v.name, cause: "flaky-load", flaky: true,
          err: "(并行跑红、单独复跑通过:负载相关,不是回归)",
        };
        return flakyEntry;
      }
      const err = (hit.err || "").replace(/\s+/g, " ");
      const entry = {
        file: v.file, name: v.name, cause: classify(v.file, v.name, err, hit.code),
        // 单跑也失败、却没抓到错误文本(被取消 / 顶层崩溃):照实写出来,别留一个空字符串
        // 让人误以为"没有报错"。归类器只能给 code-or-unclear,所以这里必须自己说清楚。
        err: (err || "(失败但没抓到错误文本:被取消或顶层崩溃,用 node --test test/<file> 复现)").slice(0, 140),
      };
      if (prevFlaky.get(`${v.file}::${v.name}`)) entry.flaky = true;
      return entry;
    });
  // 标了 flaky 的条目本轮即使通过也要留下:偶发失败不能当成「已修复」扔掉,
  // 否则下次它再偶发一次就会被报成「新增」,又回到人工核对。
  const kept = [];
  const freshKeys = new Set(fresh.map((e) => `${e.file}::${e.name}`));
  for (const e of prevEntries) {
    if (e.flaky && !freshKeys.has(`${e.file}::${e.name}`)) {
      // 保留下来的旧条目也可能是空 err(上一版把它吞掉了),同样要补一句,别留白
      kept.push({ ...e, err: e.err || "(本轮通过;历史上是负载偶发,没抓到过错误文本)" });
    }
  }
  const entries = [...fresh, ...kept].sort((a, b) => (a.file + a.name).localeCompare(b.file + b.name));
  const byCause = {};
  for (const e of entries) byCause[e.cause] = (byCause[e.cause] || 0) + 1;
  writeFileSync(BASELINE, JSON.stringify({
    _comment: "本机既有失败基线。由 scripts/test-delta.mjs --update-baseline 生成。门禁只认 file+name;cause 是给人看的归类(env-*=环境性换机即绿,code-*=真实代码问题待修)。flaky:true 的条目偶发失败,本轮通过也不移除。",
    generatedAt: new Date().toISOString(),
    count: entries.length,
    flakyCount: entries.filter((e) => e.flaky).length,
    byCause,
    entries,
  }, null, 2));
  process.stdout.write(`[test-delta] 基线已写入 ${BASELINE}\n  共 ${entries.length} 条\n`);
  if (newcomers.length) process.stdout.write(`    ⚠️ 本次 --force 收编了 ${newcomers.length} 条新增失败,请回头复核\n`);
  if (kept.length) process.stdout.write(`    其中本轮通过但按 flaky 保留 ${kept.length} 条\n`);
  const envN = entries.filter((e) => isEnv(e.cause)).length;
  // ⚠️ 只数"非环境性的 flaky":否则一条既 env-* 又 flaky 的会被三类同时数一遍,
  //    三数之和比总数还大,读的人第一眼就会怀疑这份汇总。
  const flakyN = entries.filter((e) => e.flaky && !isEnv(e.cause)).length;
  // ⚠️ 三类要分开报:环境性 / 负载偶发 / 真实代码问题。把偶发算进 code-* 会让"待修债务"
  //    每重建一次基线就虚高一次,久了就没人再看这个数字。
  const codeN = entries.filter((e) => !isEnv(e.cause) && !e.flaky).length;
  process.stdout.write(`    其中 环境性(env-*) ${envN} 条 / 负载偶发(flaky) ${flakyN} 条 / 代码问题(code-*) ${codeN} 条\n`);
  for (const [c, n] of Object.entries(byCause).sort((a, b) => b[1] - a[1])) process.stdout.write(`    ${String(n).padStart(3)}  ${c.padEnd(18)} ${CAUSE_NOTES[c] || ""}\n`);
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  process.stderr.write(`[test-delta] 没有基线文件 ${BASELINE}\n  先跑: node scripts/test-delta.mjs --update-baseline\n`);
  process.exit(2);
}
const base = JSON.parse(readFileSync(BASELINE, "utf8"));
// --only 时只在「实际跑过的文件」范围内比对:否则基线里其他文件的失败会全被误报成「已修复」。
const sweptFiles = new Set(sweep.files);
const scope = only ? (e) => sweptFiles.has(e.file) : () => true;
const baseMap = new Map((base.entries || []).filter(scope).map((e) => [`${e.file}::${e.name}`, e]));
const baseKeys = new Set(baseMap.keys());

const fixed = [...baseKeys].filter((k) => !current.has(k) && !baseMap.get(k).flaky);
// 标了 flaky 的条目本轮通过,只说明这次赶上了好的那一次,不代表修好 —— 不提示移除
const flakyPassed = [...baseKeys].filter((k) => !current.has(k) && baseMap.get(k).flaky);
const addedCandidates = [...current.keys()].filter((k) => !baseKeys.has(k));

// 并行跑 124 个文件时,少数用例会因机器负载失败(本地起假 endpoint 拿随机端口,
// 重负载下超时;实测 direct_transport 单独跑 3/3 全过、只在全量里红)。
// 对「疑似新增」做一次单独重跑:单独也红 = 真是本次改动引入;单独通过 = 并行负载导致,
// 记为不稳定不判回归。只重跑可疑文件,平时是 0 个,不会拖慢日常检查。
const flakyNow = new Set();
const uncovered = [];
if (addedCandidates.length) {
  const suspectFiles = [...new Set(addedCandidates.map((k) => current.get(k).file))];
  process.stderr.write(`[test-delta] 疑似新增 ${addedCandidates.length} 条,单独重跑 ${suspectFiles.length} 个文件确认...\n`);
  // 🔴 必须按「用例名」判定，不能用「文件是否零失败」：
  //    基线里本来就有必挂用例（如 audit_chain 的 EPERM symlink）的文件，单独重跑
  //    永远不可能零失败 → 该文件里任何负载偶发都会被误报成「本次改动引入的真实回归」。
  //    2026-11-06 实测：连续两次门禁分别误报 startup_* 3 条、audit_chain 1 条，逐条单跑均通过。
  //    反过来，候选用例单跑仍红时必须保留为真实新增，不许被这层判定吞掉。
  // 🔴 第二道：`runSweep` 匹配不到文件 / 单跑进程异常时 results 同样是空数组，
  //    只看 results 会把「根本没跑」当成「单独通过」→ 整批真实回归被标 flaky、退出码假 0。
  //    必须拿 files（这次真跑过的文件）确认覆盖到了，没覆盖的一律保留为新增失败。
  const reruns = suspectFiles.map((f) => ({ requested: f, sweep: runSweep(1, f) }));
  const reranFiles = new Set(reruns.flatMap((r) => r.sweep.files));
  const rerun = reruns.flatMap((r) => r.sweep.results);
  const stillFailing = new Set(
    rerun.flatMap((x) => (x.fail ?? []).map((n) => `${x.file}::${normName(n)}`)),
  );
  for (const k of addedCandidates) {
    if (!reranFiles.has(current.get(k).file)) { uncovered.push(k); continue; }
    if (!stillFailing.has(k)) flakyNow.add(k);
  }
}
const added = addedCandidates.filter((k) => !flakyNow.has(k));

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
if (flakyNow.size) {
  process.stdout.write(`⚪ 并行跑时红、单独重跑通过 ${flakyNow.size} 条(负载导致,不判为回归):\n`);
  for (const k of flakyNow) process.stdout.write(`   ${k.replace("::", " :: ")}\n`);
  process.stdout.write(`   确认是长期不稳的(先单跑复现),再显式登记: node scripts/test-delta.mjs --flaky "${[...flakyNow][0]}" --allow-new\n\n`);
}
if (uncovered.length) {
  process.stdout.write(`⚠️ 单独重跑没覆盖到 ${uncovered.length} 条(不判 flaky,保留为新增失败):\n`);
  for (const k of uncovered) process.stdout.write(`   ${k.replace("::", " :: ")}\n`);
  process.stdout.write(`   → 重跑没跑起来就别下「偶发」结论,先查 run-all-tests 的 --only 匹配。\n\n`);
}
if (flakyPassed.length) {
  process.stdout.write(`⚪ 本轮偶然通过 ${flakyPassed.length} 条(基线里标了 flaky,不算修好,仍留在基线):\n`);
  for (const k of flakyPassed) process.stdout.write(`   ${k.replace("::", " :: ")}\n`);
  process.stdout.write(`\n`);
}
if (!added.length && !fixed.length && !flakyPassed.length && !flakyNow.size) {
  // 只有 current 为空才是「真全过」;有失败但都在基线内,要照实说「无增减」
  if (only) {
    process.stdout.write(current.size === 0
      ? `⚪ 这 ${sweep.files.length} 个文件全过(基线在这几个文件里的 ${baseKeys.size} 条也没有失败)。\n\n`
      : `⚪ 无增减:这 ${sweep.files.length} 个文件里 ${current.size} 条失败都在基线内。\n\n`);
  } else {
    process.stdout.write(`⚪ 无变化:失败集合与基线完全一致(${current.size} 条都是既有的)。\n\n`);
  }
}

// 基线里仍失败的 code-*:历史上是「该修还得修」的债务提醒。私人版不再把断言当约束
// (合规类断言已按个人版放宽),所以这里只留一行汇总,不再逐条刷屏;
// 想看明细直接读基线文件,或加 --show-code 打印清单。
const stillCode = [...current.keys()].filter((k) => {
  const e = baseMap.get(k);
  // 标了 flaky 的已经在上面的 ⚪ 段落里单独报过,不再算进"待修债务"
  return e && !isEnv(e.cause) && !e.flaky;
});
if (stillCode.length) {
  const byC = {};
  for (const k of stillCode) { const c = baseMap.get(k).cause; byC[c] = (byC[c] || 0) + 1; }
  const parts = Object.entries(byC).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`);
  process.stdout.write(`🟡 基线内另有 ${stillCode.length} 条 code-*(非环境性):${parts.join(" / ")}\n`);
  if (has("--show-code")) {
    for (const k of stillCode) process.stdout.write(`   ${k.replace("::", " :: ")}\n`);
  } else {
    process.stdout.write(`   明细: node scripts/test-delta.mjs --show-code,或读 test/known-failures.json\n`);
  }
  process.stdout.write(`\n`);
}

process.stdout.write(added.length ? `结论: 有 ${added.length} 条新增失败 → 退出码 1\n` : `结论: 无新增失败 → 退出码 0\n`);
process.exit(added.length ? 1 : 0);
