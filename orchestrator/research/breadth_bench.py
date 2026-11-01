#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
板块宽度的「基准化」与「预测力」验证脚本。

为什么留这个脚本（而不是删掉当一次性探针）：
    2026-10-30 用它得出一条结论 —— **把大盘减掉之后，板块宽度的预测力归零**
    （裸宽度对次日超额涨幅 Spearman +0.27 → 超额宽度 +0.03）。
    但这个结论只有 8 个交易日、70 个观测，样本量**不足以做统计推断**。
    缓存 `repoRoot/.local/cache/tdx_daily/` 会随每天取数自动增长，
    所以每过一两个月重跑一次，就能看这条结论是站住了还是翻了。

    这不是「攒数据」，是「回看已有数据」—— 数据本身就是按 date 回溯拿到的。
    重跑前先跑一次 `day_opportunity`（会顺手把最近 5 天包拉齐），再跑本脚本。

依赖：
    - 可选 `scipy`（有就用 scipy.stats.spearmanr，没有用内置实现，结果一致）
    - 数据：`.local/cache/tdx_daily/*.json`（涨跌幅）+ `.local/mcp/default/raw/extracted_*constituent*.json`（成分）
    - 用 `D:\\Python311\\python.exe` 跑

输出四块：
    ① 真·全市场（仅 A 股）逐日上涨占比 —— 大盘噪声有多大
    ② 板块裸宽度 / 相对宽度矩阵
    ③ 裸差 vs 超额差 —— 符号相反的占比（护栏：这个数决定页面该显示哪个）
    ④ 预测力检验 —— 第 t 日信号 → 第 t+1 日超额中位涨幅的秩相关
"""
import glob
import json
import os
import re
import statistics as st

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
CACHE = os.path.join(REPO, ".local", "cache", "tdx_daily")
RAW = os.path.join(REPO, ".local", "mcp", "default", "raw")

BOARDS = {
    "000928": "能源", "000929": "材料", "000930": "工业", "000931": "可选消费", "000932": "主要消费",
    "000933": "医药卫生", "000934": "金融地产", "000935": "信息技术", "000936": "电信业务",
    "000937": "公用事业",
}

# 与 src/finance/tdx_package.ts 的 isAStock 必须完全一致，否则基准不可比
SH = ("600", "601", "603", "605", "688", "689")
SZ = ("000", "001", "002", "003", "300", "301")
BJ = ("43", "83", "87", "88", "92")


def is_stock(key):
    m, c = key[:2], key[2:]
    if not re.fullmatch(r"\d{6}", c):
        return False
    return ((m == "sh" and c[:3] in SH) or (m == "sz" and c[:3] in SZ)
            or (m == "bj" and c[:2] in BJ))


def key_of(code):
    """代码 → 带市场前缀的键，按上面的号段表逐段判。

    🔴 不能只看首位(原来按首位在 "69" / "48" 里判):5x 是沪市 ETF、900x 是沪 B 股、
    920x 是北交所，只按首位归会把它们全算进深市，而且不报错、只是数错。
    认不出号段返回 None(调用方按「这一只不在行情里」跳过)。
    """
    if code[:3] in SH:
        return "sh" + code
    if code[:3] in SZ:
        return "sz" + code
    if code[:2] in BJ:
        return "bj" + code
    return None


def load_members():
    members = {}
    for f in glob.glob(os.path.join(RAW, "extracted_*constituent*.json")):
        try:
            doc = json.load(open(f, encoding="utf-8"))
        except Exception:
            continue
        for r in doc.get("rows") or []:
            ic, c = str(r.get("index_code") or ""), str(r.get("code") or "")
            if ic in BOARDS and re.fullmatch(r"\d{6}", c):
                members.setdefault(ic, set()).add(c)
    return members


def load_days():
    out = {}
    for f in sorted(glob.glob(os.path.join(CACHE, "*.json"))):
        doc = json.load(open(f, encoding="utf-8"))
        out[doc["date"]] = doc["chg"]
    return out


def spearman(xs, ys):
    try:
        from scipy.stats import spearmanr
        return float(spearmanr(xs, ys).statistic)
    except Exception:
        pass

    def rank(a):
        order = sorted(range(len(a)), key=lambda i: a[i])
        r, i = [0.0] * len(a), 0
        while i < len(order):
            j = i
            while j + 1 < len(order) and a[order[j + 1]] == a[order[i]]:
                j += 1
            avg = (i + j) / 2
            for k in range(i, j + 1):
                r[order[k]] = avg
            i = j + 1
        return r

    rx, ry = rank(xs), rank(ys)
    n = len(xs)
    mx, my = sum(rx) / n, sum(ry) / n
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    den = (sum((a - mx) ** 2 for a in rx) * sum((b - my) ** 2 for b in ry)) ** 0.5
    return num / den if den else None


def main():
    members = load_members()
    days = load_days()
    dates = sorted(days)
    if len(dates) < 3:
        print("缓存里不足 3 个交易日，先跑一次 day_opportunity")
        return
    print(f"成分板块 {len(members)} 个；交易日 {len(dates)} 个：{dates[0]} ~ {dates[-1]}\n")

    MKT, M = {}, {}
    for dt in dates:
        chg = days[dt]
        stocks = [v for k, v in chg.items() if is_stock(k)]
        MKT[dt] = (sum(1 for v in stocks if v > 0) / len(stocks), st.median(stocks), len(stocks))
        row = {}
        for ic, codes in members.items():
            vals = [chg[k] for k in (key_of(c) for c in codes) if k in chg]
            if len(vals) < 5:
                continue
            row[ic] = (sum(1 for v in vals if v > 0) / len(vals), st.median(vals))
        M[dt] = row

    print("=== ① 真·全市场（仅 A 股）逐日 ===")
    for dt in dates:
        u, med, n = MKT[dt]
        print(f"{dt}  {n} 只  上涨 {u*100:5.1f}%  中位 {med:+6.2f}%")
    us = [MKT[d][0] for d in dates]
    print(f"区间 {min(us)*100:.1f}% ~ {max(us)*100:.1f}%  极差 {100*(max(us)-min(us)):.1f}pp"
          f"  一阶自相关 {spearman(us[:-1], us[1:]):+.2f}（负=隔日反转）\n")

    print("=== ② 板块绝对宽度 / (相对宽度 = 减同日基准) ===")
    print("板块      " + "".join(f"{d[5:]:>13}" for d in dates))
    for ic, name in BOARDS.items():
        line = f"{name:9s} "
        for dt in dates:
            if ic in M[dt]:
                u = M[dt][ic][0]
                line += f"{u*100:5.1f}%{(u-MKT[dt][0])*100:+5.1f}"
            else:
                line += f"{'—':>11}"
        print(line)

    print("\n=== ③ 裸差 vs 超额差（决定页面该显示哪个） ===")
    raw_all, ex_all, flip = [], [], 0
    for i in range(1, len(dates)):
        a, b = dates[i - 1], dates[i]
        for ic in BOARDS:
            if ic not in M[a] or ic not in M[b]:
                continue
            raw = (M[b][ic][0] - M[a][ic][0]) * 100
            ex = ((M[b][ic][0] - MKT[b][0]) - (M[a][ic][0] - MKT[a][0])) * 100
            raw_all.append(raw)
            ex_all.append(ex)
            if abs(raw) > 3 and (raw > 0) != (ex > 0):
                flip += 1
    if raw_all:
        print(f"样本 {len(raw_all)} 个（板块×相邻日）")
        print(f"裸差   绝对值中位 {st.median([abs(x) for x in raw_all]):5.1f}pp")
        print(f"超额差 绝对值中位 {st.median([abs(x) for x in ex_all]):5.1f}pp")
        print(f"→ 大盘噪声占裸差波动的 {100*(1-st.median([abs(x) for x in ex_all])/st.median([abs(x) for x in raw_all])):.0f}%")
        print(f"→ 裸差与超额差**符号相反**的 {flip}/{len(raw_all)}（{100*flip/len(raw_all):.0f}%）"
              f"  ← 这个数就是「页面不能显示裸差」的依据\n")

    print("=== ④ 预测力：第 t 日信号 → 第 t+1 日「超额」中位涨幅 ===")
    sig = {"裸宽度": [], "超额宽度": [], "裸宽度日变化": [], "超额宽度日变化": []}
    for i in range(1, len(dates)):
        a, b = dates[i - 1], dates[i]
        for ic in BOARDS:
            if ic not in M[a] or ic not in M[b]:
                continue
            y = M[b][ic][1] - MKT[b][1]
            sig["裸宽度"].append((M[a][ic][0], y))
            sig["超额宽度"].append((M[a][ic][0] - MKT[a][0], y))
            if i >= 2 and ic in M[dates[i - 2]]:
                p = dates[i - 2]
                sig["裸宽度日变化"].append(((M[a][ic][0] - M[p][ic][0]) * 100, y))
                sig["超额宽度日变化"].append((
                    ((M[a][ic][0] - MKT[a][0]) - (M[p][ic][0] - MKT[p][0])) * 100, y))
    for k, v in sig.items():
        if len(v) < 20:
            print(f"{k:14s} 样本不足({len(v)})")
            continue
        print(f"{k:14s} n={len(v):3d}  Spearman {spearman([x for x, _ in v], [y for _, y in v]):+.3f}")
    print("\n说明：n<100 时 Spearman 标准误约 1/sqrt(n-1) ≈ 0.12，"
          "0.27 只是约 2 个标准误（弱证据），0.03 等于没有。\n"
          "解读：宽度里那点预测力是「当天大盘强弱」的代理，扣掉大盘就没了。")


if __name__ == "__main__":
    main()
