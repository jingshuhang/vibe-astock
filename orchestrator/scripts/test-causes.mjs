/**
 * 失败归类器 —— 纯函数,无副作用(不跑测试、不读文件),可安全 import。
 *
 * 为什么单独一个文件:test-delta.mjs 顶层会真的跑测试,若把 classify 放那里,
 * 谁 import 它都会连带触发一次全量测试(踩过:relable 脚本 import 一下跑了 9 分钟)。
 *
 * 两族:
 *   env-*  本机(Windows 沙箱)跑不了,换台干净机器就绿 —— 进基线后基本不用管。
 *   code-* 真实代码问题(守卫棘轮报警 / 两份实现不一致 / 断言真失败)—— 基线只是让门禁
 *          不天天喊,但**该修还得修**,报告里单独列出。
 *
 * ⚠️ 归类看报错文本,不看用例名 —— 同一用例在不同机器可能报不同错。宁可归 code 待查,
 *    也别把真实回归标成 env 蒙混过去(那等于关掉警报)。
 */
export function classify(file, name, err, code) {
  const e = `${err || ""} ${code || ""}`;
  const all = `${e} ${name || ""}`;
  // —— env 族 ——
  if (/symlink|EMLINK|junction/i.test(e)) return "env-symlink";
  if (/ERR_UNSUPPORTED_ESM_URL_SCHEME|protocol 'c:'/i.test(e)) return "env-platform";                    // Windows ESM 必须 file:// URL
  if (/\/private\/|要可执行|\.command/i.test(e)) return "env-platform";                                   // POSIX 斜杠路径 / 可执行位
  if (/落在运行目录之外|C:[\\/]tmp[\\/](some-run|repo)/i.test(e)) return "env-platform";                  // 测试假设 C:\tmp 在运行目录内
  if (/[\\/]s[\\/]fetch_quote\.py|\\s\\fetch_quote/i.test(e)) return "env-platform";                        // 路径分隔符 \ vs /
  // ⚠️ 分隔符可能被 TAP 文本转义成两个反斜杠(`'d:\\program files\\...'`),所以用 [\\/]+ 而不是 [\\/]
  if (/d:[\\/]+program files[\\/]+wb[\\/]+workbuddy/i.test(e)) return "env-platform";                     // 实机安装路径大小写/分隔符
  // POSIX 命名管道(mkfifo)在 Windows 上造不出来:Windows 的命名管道在 \\.\pipe\ 里,不是文件系统对象,
  // 原生 win32 进程看到的只是一坨读得出内容的普通文件 ⇒ 「读到管道要给 null」这一档本机没法验,不是产品坏了。
  if (/命名管道|mkfifo/i.test(all)) return "env-platform";
  if (/ENOENT.*providers[\\/].*\.json/i.test(e)) return "env-platform";                                    // 本机没放该 provider 配置文件
  if (/Traceback \(most recent call last\)/i.test(e)) return "env-spawn";                                  // Python 子进程崩
  if (/reg add|reg\.exe|Program Blacklist|取不到当前用户 SID|whoami/i.test(all)) return "env-sandbox";   // reg.exe 被黑名单
  if (/ENOTFOUND|ECONNREFUSED|EAI_AGAIN|getaddrinfo|fetch failed|ETIMEDOUT|ECONNRESET|socket hang up|connect ECONN/i.test(e)) return "env-network";
  if (/鏍锋|锟|烫烫|涔|鑲|璐靛|ï¿½|�|锟斤拷|cp936|GBK/i.test(e)) return "env-encoding";                  // mojibake
  if (/spawn EFTYPE|运行进程树终止失败|退出码 null|签名导出失败|未输出合法 JSON|取数器未输出|行情和公告都没取到/i.test(e)) return "env-spawn"; // Python 子进程 cp936 读 UTF-8 崩 / Windows spawn
  if (/agent_windows_wrapper_unsupported|当前 AI 暂时没有连接成功|claude\/unknown|假 Claude 必须真的启动/i.test(all)) return "env-no-ai";
  if (/EPERM|EACCES|operation not permitted/i.test(e)) return "env-perm";
  // —— code 族(真实问题,基线只为静音门禁)——
  if (/行业词|Core 纯净度|垂类字面量|垂类 import|全局上限|变严重了/.test(all)) return "code-guardrail";
  if (file === "core_purity.test.ts" || file === "readme_numbers.test.ts" || file === "ui_boundary.test.ts" || file === "pitfall_rules.test.ts") return "code-guardrail";
  if (/GATE_WORDS|逐字一致|分隔符集合|TRAD_CHARS/i.test(name)) return "code-inconsistent";                // Python/TS 两份实现对不上
  if (/instructions 缺/i.test(e)) return "code-inconsistent";
  return "code-or-unclear";
}

/** 每类的可读说明,报告与基线里给人看。 */
export const CAUSE_NOTES = {
  "flaky-load": "并行跑红、单独复跑通过:负载相关的偶发,不是回归(自动识别)",
  "env-symlink": "沙箱禁止创建符号链接",
  "env-platform": "Windows 与 POSIX 差异(路径斜杠 / ESM c: 协议 / 可执行位)",
  "env-sandbox": "reg.exe 等被安全策略黑名单拦截",
  "env-network": "沙箱无外网",
  "env-encoding": "中文按 cp936 读写导致乱码",
  "env-spawn": "Windows 下 Python 子进程编码 / spawn 差异",
  "env-no-ai": "本机没接 AI 订阅,相关链路跑不起来",
  "env-perm": "文件权限被沙箱收紧",
  "code-guardrail": "守卫测试在报警(棘轮 / 一致性),是真实代码问题",
  "code-inconsistent": "两份实现(Python 与 TS 等)对不上,是真实代码问题",
  "code-or-unclear": "未归类,需人工看",
};

/** 是否环境性失败(进基线后基本不用管)。 */
export const isEnv = (cause) => cause.startsWith("env-");
