#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
「位置」与「持续性」因子研究 —— 涨停股的位置特征能不能预测次日。

背景：宽度类指标（板块上涨占比）已被证明**没有预测力**（扣掉大盘后 ρ≈0，
见 `research/breadth_bench.py`）。于是换一类变量：不看「今天涨了多少」，
看「昨天涨停的时候处在什么位置、封得多硬」。这就是「位置」。

数据：`.local/cache/limit_pool/samples.json`（先跑 `node research/limit_pool_fetch.ts`）

⚠️ 样本边界（读结论前先看这三条）：
    ① 只含**前一日收盘留在涨停池**的票（冲板没封住的不在内）→ 是「打板成功」样本，不能外推到全部。
    ② 东财只保留约一个月，N ≤ 20 个交易日，所以每条结论都是「一个月内的观察」，不是长期规律。
    ③ 20cm（创业板/科创板）样本少，默认只统计 10cm，避免把两套涨跌停制度混在一起。

用法：D:\\Python311\\python.exe research/position_factor.py
"""
import collections
import json
import os
import statistics as st

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SRC = os.path.join(REPO, ".local", "cache", "limit_pool", "samples.json")

D = json.load(open(SRC, encoding="utf-8"))
settled, ladders = D["settleds"], D["ladders"]
sd = sorted(settled)
prev_of = {sd[i]: sd[i - 1] for i in range(1, len(sd))}
lad = {(dt, str(s.get("code"))): s for dt, ss in ladders.items() for s in ss}


def is20(code):
    return code[:3] in ("300", "301", "688", "689")


def clock(t):
    if not t or len(str(t)) != 6:
        return None
    return int(str(t)[:2]) * 60 + int(str(t)[2:4])


rows = []
for dt in sd:
    p = prev_of.get(dt)
    for r in settled[dt]:
        if not isinstance(r.get("ret"), (int, float)):
            continue
        code = str(r.get("code"))
        f = lad.get((p, code)) if p else None
        rec = dict(date=dt, code=code, name=r.get("name"), ret=float(r["ret"]),
                   lu=bool(r.get("limit_up")), boards=int(r.get("prev_boards") or 0),
                   last=str(r.get("seal_time") or ""), sector=r.get("sector"), ten=not is20(code))
        if f:
            rec.update(
                first=str(f.get("first_seal") or ""), last2=str(f.get("last_seal") or ""),
                broken=f.get("broken_times"),
                ratio=(f["seal_fund"] / f["float_cap"] * 100) if f.get("seal_fund") and f.get("float_cap") else None,
                fund=(f["seal_fund"] / 1e8) if f.get("seal_fund") else None,
                fcap=(f["float_cap"] / 1e8) if f.get("float_cap") else None,
                turn=f.get("turnover"),
            )
        rows.append(rec)

ten = [r for r in rows if r["ten"]]
rich = [r for r in ten if r.get("ratio") is not None]
print(f"全部 {len(rows)} 行 / {len(sd)} 天；10cm {len(ten)} 行；10cm 且有封单数据 {len(rich)} 行\n")


def stats(rs):
    if not rs:
        return None
    n = len(rs)
    rets = [r["ret"] for r in rs]
    lim = sum(1 for r in rs if r["ret"] <= (-19.5 if not r["ten"] else -9.5))
    return dict(n=n, lu=sum(1 for r in rs if r["lu"]) / n, med=st.median(rets),
                mean=sum(rets) / n, win=sum(1 for x in rets if x > 0) / n,
                big=sum(1 for x in rets if x <= -5) / n, lim=lim / n,
                fcap=st.median([r["fcap"] for r in rs if r.get("fcap")]))


def show(rs, title, keyfn, order, extra=None):
    print(f"=== {title} ===")
    head = f"{'分组':<16}{'n':>5}{'再涨停':>8}{'中位':>8}{'胜率':>7}{'跌超5%':>8}{'跌停':>7}"
    if extra:
        head += f"{extra[0]:>16}"
    print(head)
    g = collections.defaultdict(list)
    for r in rs:
        g[keyfn(r)].append(r)
    for k in order:
        s = stats(g.get(k, []))
        if not s or s["n"] == 0:
            continue
        line = f"{k:<16}{s['n']:>5}{s['lu']*100:>7.0f}%{s['med']:>+8.2f}{s['win']*100:>6.0f}%{s['big']*100:>7.0f}%{s['lim']*100:>6.0f}%"
        if extra:
            line += f"{s['fcap']:>16.1f}"
        print(line)
    print()


def board_bucket(r):
    b = r["boards"]
    return "1板(首板)" if b <= 1 else ("2板" if b == 2 else ("3板" if b == 3 else ("4板" if b == 4 else "5板+")))


def time_bucket(t):
    m = clock(t)
    if m is None:
        return "无"
    if m < 600:
        return "A 10:00前"
    if m <= 690:
        return "B 10:00-11:30"
    if m < 840:
        return "C 13:00-14:00"
    return "D 14:00后"


def ratio_bucket(r):
    v = r.get("ratio")
    if v is None:
        return "无"
    return "A <0.5%" if v < 0.5 else ("B 0.5-1.5%" if v < 1.5 else ("C 1.5-3%" if v < 3 else ("D 3-6%" if v < 6 else "E >6%")))


BOARDS = ["1板(首板)", "2板", "3板", "4板", "5板+"]
TIMES = ["A 10:00前", "B 10:00-11:30", "C 13:00-14:00", "D 14:00后"]
RATIOS = ["A <0.5%", "B 0.5-1.5%", "C 1.5-3%", "D 3-6%", "E >6%"]

# ── 一、位置：连板高度（= 持续性的直接度量）
show(ten, "一、位置 = 连板高度（买在第 N 板，看次日）", board_bucket, BOARDS)
print("  ⚠️ 这张表**不能直接读成「2 板是坑」**。整体中位看 2 板为负、跌停率最高，")
print("     但按日配对只有 7/17 天（41%）「2 板比其余差」成立，接近抛硬币 —— 见第四节末。")
print("     原因是每天 2 板只有 3~14 只，单日中位数被一两只极端票决定（10/15 −9.59%、10/30 −8.54%）。")
print("     5 板+ 那个 83% 胜率同理：n=18，且是幸存者（能走到 5 板的本就是市场共识最强的那批）。")
print("     ⇒ **高度这一维的每日样本太薄**，只有封单厚度和末封时点在按日配对下站得住。\n")

# ── 二、位置：末封 vs 首封（对照组）
show(ten, "二、位置 = 末封时间（现有页面用的这个）", lambda r: time_bucket(r.get("last2") or r["last"]), TIMES)
show(rich, "二b、位置 = 首封时间（天梯独有；这里基数与上一表不同，是「有封单数据」的子集）", lambda r: time_bucket(r.get("first")), TIMES)
print("  🔴 首封的区分度明显弱于末封：末封 <10:00 组 38%/+2.78，首封 <10:00 组只有 29%/−0.05。")
print("     而且首封 >14:00 组反而最好（18%/+2.08）。→ **不要换成首封时间。**\n")

# ── 三、封单厚度：最强的一维
show(rich, "三、位置 = 封单 ÷ 流通市值（三个位置变量里最强）", ratio_bucket, RATIOS, extra=("流通市值中位(亿)",))

print("=== 三b、混杂控制：封单比是「封得死」还是「盘子小」？ ===")
print(f"{'市值层':<14}{'封单≤1.5%':>26}{'封单>1.5%':>26}{'中位差':>9}")


def capk(r):
    c = r.get("fcap") or 0
    return "小盘 <50亿" if c < 50 else ("中盘 50-200亿" if c < 200 else "大盘 >200亿")


for ck in ["小盘 <50亿", "中盘 50-200亿", "大盘 >200亿"]:
    sub = [r for r in rich if capk(r) == ck]
    a, b = stats([r for r in sub if r["ratio"] <= 1.5]), stats([r for r in sub if r["ratio"] > 1.5])
    if not a or not b:
        continue
    fa = "n=%d %2.0f%%/%+.1f" % (a["n"], a["lu"] * 100, a["med"])
    fb = "n=%d %2.0f%%/%+.1f" % (b["n"], b["lu"] * 100, b["med"])
    print("%-14s%26s%26s%+9.2f" % (ck, fa, fb, b["med"] - a["med"]))
print("  🔴 同一市值层内，封单 >1.5% 依然把再涨停率从 15~16% 提到 42~44% → 混杂存在但不致命。")
print("     反过来的检验也做了：控制封单比后，市值从 <50 亿到 >200 亿，再涨停率都在 13~16%，几乎没差别。")
print("     ⚠️ 但大盘股（>200 亿）几乎做不到封单 >1.5% —— 流通盘大，这个因子天然只在中小盘可用。\n")

# ── 四、稳健性：按日配对
print("=== 四、稳健性：按日配对（同一天内比较，剔除环境差异）===")
byday = collections.defaultdict(list)
for r in rich:
    byday[r["date"]].append(r)
byday_ten = collections.defaultdict(list)
for r in ten:
    byday_ten[r["date"]].append(r)


def paired(sel, label, bucket=None):
    bd = bucket if bucket is not None else byday
    print(f"-- {label}")
    print(f"{'日期':<12}{'好档 n':>8}{'再涨停':>8}{'中位':>8}   {'差档 n':>8}{'再涨停':>8}{'中位':>8}   {'方向':>5}")
    agree = tot = 0
    for dt in sorted(bd):
        rs = bd[dt]
        good = [r for r in rs if sel(r)]
        bad = [r for r in rs if not sel(r)]
        if len(good) < 3 or len(bad) < 3:
            continue
        x = sum(1 for r in good if r["lu"]) / len(good)
        y = sum(1 for r in bad if r["lu"]) / len(bad)
        mx = st.median([r["ret"] for r in good])
        my = st.median([r["ret"] for r in bad])
        tot += 1
        ok = (x >= y) and (mx >= my)
        agree += ok
        print(f"{dt:<12}{len(good):>8}{x*100:>7.0f}%{mx:>+8.2f}   {len(bad):>8}{y*100:>7.0f}%{my:>+8.2f}   {'一致' if ok else '不一致':>5}")
    print(f"  → 方向一致 {agree}/{tot} 天（{agree/tot*100:.0f}%）\n")


paired(lambda r: r["ratio"] > 1.5, "封单 >1.5% vs ≤1.5%")
paired(lambda r: (clock(r["last"]) or 9999) < 600, "末封 <10:00 vs 其余")
paired(lambda r: r["boards"] == 2, "2 板 vs 其余（全 10cm 样本，同一天内）", byday_ten)

# ── 五、组合
print("=== 五、门槛 × 放大器：封单厚度 × 板数（样本≥8）===")
print(f"{'板数':<8}{'封单>1.5%':>26}{'封单≤1.5%':>26}")
for b in (1, 2, 3):
    line = f"{b}板     "
    for sel in (lambda r: r["ratio"] > 1.5, lambda r: r["ratio"] <= 1.5):
        rs = [r for r in rich if r["boards"] == b and sel(r)]
        s = stats(rs)
        line += "%26s" % (("n=%d %.0f%%/%+.1f" % (s["n"], s["lu"] * 100, s["med"])) if s and s["n"] >= 8 else ("n=%d" % len(rs)))
    print(line)
line = "4板+    "
for sel in (lambda r: r["ratio"] > 1.5, lambda r: r["ratio"] <= 1.5):
    rs = [r for r in rich if r["boards"] >= 4 and sel(r)]
    s = stats(rs)
    line += "%26s" % (("n=%d %.0f%%/%+.1f" % (s["n"], s["lu"] * 100, s["med"])) if s and s["n"] >= 8 else ("n=%d" % len(rs)))
print(line + "\n")

print("=== 六、换手率（涨停当天的换手，越低越好）===")
show(ten, "换手分档", lambda r: ("A <3%" if (r.get("turn") or 0) < 3 else ("B 3-8%" if (r.get("turn") or 0) < 8 else ("C 8-15%" if (r.get("turn") or 0) < 15 else "D >15%"))),
     ["A <3%", "B 3-8%", "C 8-15%", "D >15%"])

print("=== 七、三条件叠加（封单>1.5% / 板数≥2 / 零开板且换手<8%）===")
def score(r):
    return sum([r["ratio"] > 1.5, r["boards"] >= 2,
                (r.get("broken") or 0) == 0 and (r.get("turn") or 99) < 8])
g = collections.defaultdict(list)
for r in rich:
    g[score(r)].append(r)
print(f"{'满足条数':<10}{'n':>5}{'再涨停':>8}{'中位':>8}{'胜率':>7}{'跌超5%':>8}")
for k in sorted(g):
    s = stats(g[k])
    print(f"{k:<10}{s['n']:>5}{s['lu']*100:>7.0f}%{s['med']:>+8.2f}{s['win']*100:>6.0f}%{s['big']*100:>7.0f}%")
print()
print(f"基线：10cm 涨停股次日再涨停 {sum(1 for r in ten if r['lu'])/len(ten)*100:.0f}%，中位 {st.median([r['ret'] for r in ten]):+.2f}%")
