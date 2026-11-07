/**
 * 闸门三态离线回放器（只读，不写任何数据）。
 *
 * 用途：遍历 .local/snapshots 里的 em_market_trend 历史快照，逐档打印三道门
 *      （广度 / 量能 / MA20）是 pass、fail 还是 unknown，以及当时的缺口说明。
 *      改 positionCapOf、evaluateMarketGate 或排查「那天为什么给了这个仓位上限」时，
 *      在改动前后各跑一次做对照，比翻后台日志可靠。
 *
 * 跑法（不依赖当前目录）：
 *      node --experimental-strip-types orchestrator/scripts/gate_probe.ts
 *
 * 2026-11-06 由 orchestrator/gate_probe.tmp.ts 转正：原文件写死 ../.local/snapshots，
 * 必须从 orchestrator/ 目录里跑才对；也不在 tsconfig.include 里、没进版本库，换台机器就没。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { gateDataFrom } from "../src/finance/market_state.ts";
import { evaluateMarketGate } from "../src/finance/market_score.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(path.resolve(here, "../.."), ".local", "snapshots");

if (!fs.existsSync(dir)) {
  console.error(`快照目录不存在：${dir}`);
  process.exit(1);
}

const files = fs.readdirSync(dir).filter((x) => x.startsWith("em_market_trend")).sort();
console.log(`共 ${files.length} 份 em_market_trend 快照（${dir}）`);
for (const f of files) {
  const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
  const { gate, notes } = gateDataFrom(j.payload?.envelope, { evidence: [] });
  const r = evaluateMarketGate(50, 0.6, gate);
  console.log(
    String(j.fetched_at).slice(0, 19),
    f,
    "| gate:", gate ? JSON.stringify(gate) : "null",
    "| items:", (r.items ?? []).map((i) => `${i.key}=${i.state}`).join(" "),
    notes.length ? "| notes: " + notes.join(";") : "",
  );
}
