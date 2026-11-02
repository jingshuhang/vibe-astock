/**
 * 界面截图工具：对页面里的某个元素截一张图，用来**肉眼验排版**。
 *
 * 用法（先起好服务，见 scripts/start.cmd；默认 5940 / 8770）：
 *   node scripts/ui-shot.mjs <页面地址> <选择器> <输出.png> [宽] [高] [点击文字] [超时ms]
 *
 * 例：
 *   node scripts/ui-shot.mjs "http://127.0.0.1:5940/research?symbol=600519" \
 *     "js:[...document.querySelectorAll('h3')].find(h=>h.textContent.includes('个股分析'))?.closest('div')?.parentElement" \
 *     shot.png 1440 2400 "取更全"
 *
 * 选择器以 `js:` 开头时按 JS 表达式求值，表达式要返回元素；否则按 CSS 选择器找。
 * 第十个参数「点击文字」会在截图前点一下文字包含它的按钮（比如「取更全」），用来截需要交互才出现的状态。
 *
 * 🔴 两个必须记住的坑（都踩过，都会让人以为「内容没渲染」）：
 *   1. 无头浏览器默认视口只有 ~1440×450，而主内容区是 `overflow-auto` 的 —— 屏幕外的部分**不会被绘制**，
 *      截出来下半截是纯黑。所以必须先 `Emulation.setDeviceMetricsOverride` 把视口撑高（本脚本已做）。
 *   2. 别为了「展开内容」去改祖先元素的 height/overflow —— 那会把 flex 列布局压塌，
 *      卡片宽度会从 1188 掉到 468，截出来是另一套排版。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EDGE_PATHS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
];
const EDGE = EDGE_PATHS.find((p) => fs.existsSync(p));
if (!EDGE) {
  console.error("找不到 Edge / Chrome。");
  process.exit(1);
}

const [, , URL_, SELECTOR, OUT, wArg, hArg, CLICK = "", waitArg, REQUIRE = ""] = process.argv;
if (!URL_ || !SELECTOR || !OUT) {
  console.error("用法: node scripts/ui-shot.mjs <url> <selector> <out.png> [宽] [高] [点击文字] [超时ms] [等页面出现这段文字]");
  process.exit(1);
}
const WIDTH = Number(wArg || 1440);
const HEIGHT = Number(hArg || 2400);
const WAIT = Number(waitArg || 30000);

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等到元素出现、有内容、且高度连续几次不变;给了 REQUIRE 还要等页面文字里出现它
 *  (只按高度稳定会截到「等待取数中」这种骨架 —— 那时页面高度也是稳的) */
async function settle(send, pick, budget, require = "") {
  const started = Date.now();
  let prev = -1;
  let stable = 0;
  while (Date.now() - started < budget) {
    const r = await send("Runtime.evaluate", {
      expression: `(() => { const el = (${pick}); if (!el) return null;
        const b = el.getBoundingClientRect();
        const hit = ${require ? `document.body.innerText.includes(${JSON.stringify(require)})` : "true"};
        return { w: b.width, h: b.height, text: (el.innerText || "").length, hit }; })()`,
      returnByValue: true,
    });
    const v = r.result?.result?.value;
    if (v && v.w > 0 && v.h > 0 && v.text > 100 && v.hit) {
      if (Math.abs(v.h - prev) < 2) {
        if (++stable >= 3) return v;
      } else stable = 0;
      prev = v.h;
    } else stable = 0;
    await delay(400);
  }
  return null;
}

async function main() {
  const proc = spawn(EDGE, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--remote-debugging-port=9333",
    `--window-size=${WIDTH},${HEIGHT}`,
    // profile 放系统临时目录，别在仓库里留目录
    "--user-data-dir=" + path.join(os.tmpdir(), "vra-ui-shot-profile"),
    "about:blank",
  ], { stdio: "ignore" });

  let targets = null;
  for (let i = 0; i < 80; i++) {
    try {
      targets = await (await fetch("http://127.0.0.1:9333/json")).json();
      if (targets.some((t) => t.type === "page")) break;
    } catch {}
    await delay(250);
  }
  const page = targets?.find((t) => t.type === "page");
  if (!page) throw new Error("没找到 page target（端口 9333 被占用？）");

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  await new Promise((r) => ws.addEventListener("open", r));
  const send = (method, params = {}) => new Promise((res) => {
    const myId = ++id;
    pending.set(myId, res);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });

  await send("Page.enable");
  await send("Runtime.enable");
  // 坑 1：必须在导航前把视口撑高，否则主内容区滚动出屏幕的部分画不出来
  await send("Emulation.setDeviceMetricsOverride", {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false,
  });
  await send("Page.navigate", { url: URL_ });
  await delay(3000);

  const pick = SELECTOR.startsWith("js:")
    ? SELECTOR.slice(3)
    : `document.querySelector(${JSON.stringify(SELECTOR)})`;

  if (!await settle(send, pick, WAIT, REQUIRE)) throw new Error(`元素没渲染出来、内容太少,或页面一直没出现「${REQUIRE}」: ${SELECTOR}`);

  if (CLICK) {
    const hit = await send("Runtime.evaluate", {
      expression: `(() => {
        const btn = [...document.querySelectorAll('button')].find(b => (b.innerText || '').includes(${JSON.stringify(CLICK)}));
        if (!btn) return 'not-found';
        btn.click(); return 'clicked';
      })()`,
      returnByValue: true,
    });
    console.log(`点击「${CLICK}」: ${hit.result.result.value}`);
    await delay(1500);
    if (!await settle(send, pick, WAIT)) throw new Error("点击后内容一直没稳定下来");
  }

  const meas = await send("Runtime.evaluate", {
    expression: `(() => { const el = (${pick}); const b = el.getBoundingClientRect();
      return { x: b.x + window.scrollX, y: b.y + window.scrollY, w: b.width, h: b.height }; })()`,
    returnByValue: true,
  });
  const box = meas.result.result.value;
  console.log(`尺寸 ${Math.round(box.w)}x${Math.round(box.h)}`);
  if (box.h > HEIGHT) console.log(`⚠️ 元素高 ${Math.round(box.h)} 超过视口 ${HEIGHT}，下端会被裁 —— 把高参数调大`);

  const shot = await send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    clip: { x: box.x, y: box.y, width: box.w, height: box.h, scale: 1 },
  });
  if (!shot.result?.data) throw new Error("截图返回空");
  fs.writeFileSync(OUT, Buffer.from(shot.result.data, "base64"));
  console.log("已写出 " + OUT);

  ws.close();
  proc.kill();
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("失败: " + e.message);
  process.exit(1);
});
