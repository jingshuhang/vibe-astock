"""新浪源:复权因子 / 财报三表 / 个股资金流(备源)/ ETF 期权链(合约清单 + T 型报价 + 希腊字母)。移植自 a-stock-data SKILL.md §1.4 / §6.4 / §9.1 / 备用源。零鉴权。"""
from __future__ import annotations

import json
import os
import re
import sys
from typing import Any, Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from common import UA, norm_ticker  # noqa: E402
from sources._http import DataNotAvailable, http_get, http_json, last_raw_ref  # noqa: E402

_HDR = {"User-Agent": "Mozilla/5.0", "Referer": "https://finance.sina.com.cn/"}
SINA_OPT_HDR = {"Referer": "https://stock.finance.sina.com.cn/", "User-Agent": UA}


def _sina_symbol(code: str) -> str:
    digits, market = norm_ticker(code, stock_only=False)
    return f"{market.lower()}{digits}"


# ---------- 1.4 复权因子 ----------
def sina_adjust_factor(code: str, kind: str = "qfq") -> list[dict]:
    """复权因子序列(最新在前):[{date, factor}];kind=qfq 前复权(因子为除数)| hfq 后复权(乘数)。"""
    if kind not in ("qfq", "hfq"):
        raise ValueError(f"kind 只能是 'qfq' 或 'hfq',收到 {kind!r}")
    symbol = _sina_symbol(code)
    text = http_get(f"https://finance.sina.com.cn/realstock/company/{symbol}/{kind}.js", headers=_HDR, timeout=10, ext="js").text
    return parse_adjust_factor_js(text, f"{symbol}/{kind}")


def parse_adjust_factor_js(text: str, label: str = "") -> list[dict]:
    """解析新浪复权因子 js 原文(落盘的 raw 也是它)。回测 / K 线工具读 raw 时用同一份解析,不另写一份。"""
    brace = text.find("{")
    if brace < 0:
        raise RuntimeError(f"新浪复权因子响应无 JSON({label}): {text[:120]}")
    data, _ = json.JSONDecoder().raw_decode(text[brace:])
    return [{"date": it["d"], "factor": float(it["f"])} for it in data.get("data", [])]


def apply_adjust(bars: list[dict], factors: list[dict], kind: str = "qfq", price_keys=("open", "high", "low", "close")) -> list[dict]:
    """把复权因子套到不复权 K 线(list[dict],含 date)。qfq: 价 ÷ factor;hfq: 价 × factor。因子为空 / 未覆盖 → 显式失败,绝不原样放行。"""
    if kind not in ("qfq", "hfq"):
        raise ValueError(f"kind 只能是 'qfq' 或 'hfq',收到 {kind!r}")
    if not factors:
        raise ValueError("复权因子列表为空,无法复权(新浪对不支持的标的返回空 data),不要用未复权价继续计算")
    if hasattr(bars, "to_dict"):
        bars = bars.to_dict("records")
    rows = []
    for b in bars:
        r = dict(b)
        dk = "date" if "date" in r else ("datetime" if "datetime" in r else None)
        if dk is None:
            raise ValueError(f"每根 K 线需含 date/datetime 键,实际键={sorted(r)}")
        r["date"] = str(r[dk])[:10]
        rows.append(r)
    fac = sorted(factors, key=lambda x: x["date"])
    out, i, cur = [], 0, None
    for bar in sorted(rows, key=lambda b: b["date"]):
        while i < len(fac) and fac[i]["date"] <= bar["date"]:
            cur = fac[i]["factor"]
            i += 1
        if cur is None:
            raise RuntimeError(f"K 线日期 {bar['date']} 早于因子序列最早日 {fac[0]['date']},无法复权")
        if cur == 0:
            raise RuntimeError(f"复权因子为 0({bar['date']}),无法换算")
        nb = dict(bar)
        for k in price_keys:
            if k in nb and nb[k] is not None:
                nb[k] = round(float(nb[k]) / cur if kind == "qfq" else float(nb[k]) * cur, 4)
        nb["adj_factor"] = cur
        out.append(nb)
    return out


# ---------- 6.4 财报三表 ----------
def sina_financial_report(code: str, report_type: str = "lrb", num: int = 8) -> list[dict]:
    """report_type: fzb 资产负债表 / lrb 利润表 / llb 现金流量表;返回按报告期倒序 [{报告期, <科目>: 原始字符串, <科目>_同比: ...}]"""
    if report_type not in ("fzb", "lrb", "llb"):
        raise ValueError("report_type 只能是 fzb / lrb / llb")
    digits, market = norm_ticker(code, stock_only=True)
    params = {"paperCode": f"{market.lower()}{digits}", "source": report_type, "type": "0", "page": "1", "num": str(num)}
    j = http_json("https://quotes.sina.cn/cn/api/openapi.php/CompanyFinanceService.getFinanceReport2022", params=params, headers={"User-Agent": UA}, timeout=15) or {}
    report_list = ((j.get("result") or {}).get("data") or {}).get("report_list") or {}
    rows = []
    for period in sorted(report_list.keys(), reverse=True)[:num]:
        obj = report_list[period] or {}
        rec = {"报告期": f"{period[:4]}-{period[4:6]}-{period[6:8]}"}
        for it in obj.get("data", []) or []:
            title = it.get("item_title", "")
            if not title or it.get("item_value") is None:
                continue
            rec[title] = it.get("item_value")
            tb = it.get("item_tongbi")
            if tb not in (None, ""):
                rec[title + "_同比"] = tb
        rows.append(rec)
    return rows


# ---------- 备源:个股资金流(日度) ----------
def sina_fund_flow(code: str, days: int = 60) -> list[dict]:
    """新浪个股资金流(日度):[{date, close, net_amount, turnover}](东财 push2his 不通时的备源)"""
    digits, market = norm_ticker(code, stock_only=True)
    url = f"https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssl_qsfx_zjlrqs?page=1&num={days}&sort=opendate&asc=0&daima={market.lower()}{digits}"
    t = http_get(url, headers={"User-Agent": UA, "Referer": "https://finance.sina.com.cn/"}, timeout=15, ext="json").text
    if "[" not in t:
        raise RuntimeError(f"新浪资金流响应异常: {t[:120]}")
    arr = json.loads(t[t.index("["): t.rindex("]") + 1])
    return [{"date": x.get("opendate"), "close": x.get("trade"), "net_amount": x.get("netamount"), "turnover": x.get("turnover")} for x in arr]


# ---------- 9.1 ETF 期权 ----------
def _opt_f(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return x


def _sina_hq_multi(params: list[str]) -> dict[str, Any]:
    """hq.sinajs.cn 批量取值:{参数名: 逗号分隔的值列表}(GBK);键 "_raw" = 本次响应的 raw_ref。"""
    if not params:
        return {}
    r = http_get(f"https://hq.sinajs.cn/list={','.join(params)}", headers=SINA_OPT_HDR, timeout=10, encoding="gbk", ext="txt")
    out: dict[str, Any] = {"_raw": getattr(r, "_vra_raw_ref", None)}
    for line in r.text.split(";"):
        m = re.search(r"hq_str_([^=]+)=\"([^\"]*)\"", line)
        if m:
            out[m.group(1)] = m.group(2).split(",") if m.group(2) else []
    return out


def sina_option_codes(underlying: str = "510050", call: bool = True) -> dict:
    """ETF 期权合约清单 {月份 YYMM: [合约代码]},首个 key 为近月。underlying: 510050/510300/588000/510500"""
    cate = {"510050": "50ETF", "510300": "300ETF", "588000": "科创50ETF", "510500": "500ETF"}.get(underlying, "50ETF")
    d = http_json(f"https://stock.finance.sina.com.cn/futures/api/openapi.php/StockOptionService.getStockName?exchange=null&cate={cate}", headers=SINA_OPT_HDR, timeout=10)
    months = (((d or {}).get("result") or {}).get("data") or {}).get("contractMonth") or []
    months = [m.replace("-", "")[2:] for m in months[1:]]
    flag = "OP_UP_" if call else "OP_DOWN_"
    lists = _sina_hq_multi([f"{flag}{underlying}{m}" for m in months])
    out = {}
    for m in months:
        codes = [c.replace("CON_OP_", "") for c in lists.get(f"{flag}{underlying}{m}", []) if c.startswith("CON_OP_")]
        if codes:
            out[m] = codes
    return out


def _parse_tquote(v: list) -> dict:
    if len(v) < 43:
        return {}
    return {"bid_vol": _opt_f(v[0]), "bid": _opt_f(v[1]), "last": _opt_f(v[2]), "ask": _opt_f(v[3]), "ask_vol": _opt_f(v[4]), "open_interest": _opt_f(v[5]), "pct": _opt_f(v[6]), "strike": _opt_f(v[7]),
            "prev_close": _opt_f(v[8]), "open": _opt_f(v[9]), "limit_up": _opt_f(v[10]), "limit_down": _opt_f(v[11]), "name": v[37], "amplitude": _opt_f(v[38]), "high": _opt_f(v[39]), "low": _opt_f(v[40]),
            "volume": _opt_f(v[41]), "amount": _opt_f(v[42])}


def _parse_greeks(raw: list) -> dict:
    if len(raw) < 16:
        return {}
    v = [raw[0]] + raw[4:]
    return {"name": v[0], "volume": _opt_f(v[1]), "delta": _opt_f(v[2]), "gamma": _opt_f(v[3]), "theta": _opt_f(v[4]), "vega": _opt_f(v[5]), "iv": _opt_f(v[6]), "high": _opt_f(v[7]), "low": _opt_f(v[8]),
            "trade_code": v[9], "strike": _opt_f(v[10]), "last": _opt_f(v[11]), "theory": _opt_f(v[12])}


def sina_option_chain(underlying: str = "510050", side: str = "call", month: Optional[str] = None, max_contracts: int = 40) -> dict:
    """某月(默认近月)全部合约的 T 型报价 + 希腊字母:{underlying, side, month, months, contracts:[{code, tquote, greeks}]}"""
    by_month = sina_option_codes(underlying, call=(side == "call"))
    if not by_month:
        raise DataNotAvailable(f"{underlying} 无期权合约清单(非 ETF 期权标的或源变更)")
    month = month or next(iter(by_month))
    if month not in by_month:
        raise ValueError(f"月份 {month} 无合约,可选 {list(by_month)}")
    codes = by_month[month][:max_contracts]
    tq = _sina_hq_multi([f"CON_OP_{c}" for c in codes])
    gk = _sina_hq_multi([f"CON_SO_{c}" for c in codes])
    contracts = [{"code": c, "tquote": _parse_tquote(tq.get(f"CON_OP_{c}", [])), "greeks": _parse_greeks(gk.get(f"CON_SO_{c}", [])), "_raw_tq": tq.get("_raw"), "_raw_gk": gk.get("_raw")} for c in codes]
    return {"underlying": underlying, "side": side, "month": month, "months": list(by_month), "contracts": contracts}


# ---------- 美股日 K(global-stock-data §2.1) ----------
def us_stock_kline_sina(ticker: str, num: int = 120) -> list[dict]:
    """新浪美股日 K(可回溯到 1984):[{date, open, high, low, close, volume}]"""
    from sources._http import assert_us_ticker
    t = http_get("https://stock.finance.sina.com.cn/usstock/api/jsonp.php/var/US_MinKService.getDailyK", params={"symbol": assert_us_ticker(ticker), "num": num},
                 headers={"Referer": "https://finance.sina.com.cn/", "User-Agent": UA}, timeout=15, ext="js").text
    m = re.search(r"\((\[.+\])\)", t, re.S)
    if not m:
        return []
    return [{"date": it.get("d"), "open": float(it.get("o", 0)), "high": float(it.get("h", 0)), "low": float(it.get("l", 0)), "close": float(it.get("c", 0)), "volume": int(float(it.get("v", 0) or 0))}
            for it in json.loads(m.group(1))]



# ---------- 复盘备源:全市场成交额榜 / 板块资金流(东财列表接口 2026-09-22 起大面积取不到) ----------
_SINA_JSON = "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/"
_SINA_HDR = {"User-Agent": UA, "Referer": "https://finance.sina.com.cn/"}


def _sina_list(path: str, params: dict) -> list:
    t = http_get(_SINA_JSON + path, params=params, headers=_SINA_HDR, timeout=15, ext="json").text
    if "[" not in t:
        raise RuntimeError(f"新浪{path}响应异常: {t[:120]}")
    arr = json.loads(t[t.index("["): t.rindex("]") + 1])
    if not isinstance(arr, list):
        raise RuntimeError(f"新浪{path}不是列表")
    return arr


def _f(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def sina_turnover_rank(top_n: int = 20) -> dict:
    """新浪「沪深京 A 股」(hs_a 节点)按成交额降序前 N 只。

    {total, returned, rows: [{rank, code, name, price, pct(%), amount(元), mcap(元), float_cap(元), turnover_rate(%)}]}
    ⚠️ 新浪市值字段单位是**万元**,这里换成元,和东财成交额榜同口径;新浪不给行业,留空。
    ⚠️ 客观公开榜单,非推荐、非预测。
    """
    top_n = int(top_n)
    if not 1 <= top_n <= 100:
        raise ValueError("top_n 须在 1~100 之间")
    arr = _sina_list("Market_Center.getHQNodeData", {"page": 1, "num": top_n, "sort": "amount", "asc": 0, "node": "hs_a", "symbol": "", "_s_r_a": "page"})
    ref = last_raw_ref()
    total = None
    try:
        total = int(str(http_get(_SINA_JSON + "Market_Center.getHQNodeStockCount", params={"node": "hs_a"}, headers=_SINA_HDR, timeout=10, ext="json").text).strip().strip('"'))
    except (ValueError, OSError, RuntimeError):
        total = None  # 只影响「共 N 只」那句说明
    rows = []
    for i, x in enumerate(arr[:top_n]):
        if not isinstance(x, dict) or not re.fullmatch(r"\d{6}", str(x.get("code") or "")):
            continue
        mul = lambda v: None if _f(v) is None else _f(v) * 1e4  # noqa: E731  万元 → 元
        rows.append({"rank": i + 1, "code": str(x["code"]), "name": str(x.get("name") or ""), "price": _f(x.get("trade")), "pct": _f(x.get("changepercent")),
                     "amount": _f(x.get("amount")), "mcap": mul(x.get("mktcap")), "float_cap": mul(x.get("nmc")), "turnover_rate": _f(x.get("turnoverratio")), "_raw": ref})
    return {"total": total, "returned": len(rows), "rows": rows}


_SINA_BK = {"industry": "0", "concept": "1"}


def sina_board_flow(board_type: str = "industry") -> dict:
    """新浪板块资金流(当日,不认日期):{board_type, rows: [{rank, code, name, change_pct(%), net, inflow, outflow(元), net_ratio(%), leader, leader_pct(%)}]}

    🔴 口径和东财「主力净额」不同:这里是新浪的「流入 − 流出」,板块也是新浪自己的分类(行业约 48 个)。
       两边的数不能互相比较,也不能接起来画趋势。
    """
    if board_type not in _SINA_BK:
        raise ValueError(f"board_type 须为 {list(_SINA_BK)}")
    arr = _sina_list("MoneyFlow.ssl_bkzj_bk", {"page": 1, "num": 500, "sort": "netamount", "asc": 0, "fenlei": _SINA_BK[board_type]})
    ref = last_raw_ref()
    pct = lambda v: None if _f(v) is None else round(_f(v) * 100, 4)  # noqa: E731  新浪给的是小数(0.0123 = 1.23%)
    rows = []
    for i, x in enumerate(arr):
        if not isinstance(x, dict) or not x.get("name"):
            continue
        rows.append({"rank": i + 1, "code": str(x.get("category") or ""), "name": str(x["name"]), "change_pct": pct(x.get("avg_changeratio")),
                     "net": _f(x.get("netamount")), "inflow": _f(x.get("inamount")), "outflow": _f(x.get("outamount")), "net_ratio": pct(x.get("ratioamount")),
                     "leader": str(x.get("ts_name") or ""), "leader_pct": pct(x.get("ts_changeratio")), "_raw": ref})
    return {"board_type": board_type, "rows": rows}


# ---------- 复盘备源:全市场涨跌分布(东财 getTopicZDFenBu 断连时的独立备源) ----------
def _sina_hs_a_count() -> int:
    """hs_a(沪深京 A 股)标的总数,用于决定要翻几页。取不到返回 0。"""
    try:
        t = http_get(_SINA_JSON + "Market_Center.getHQNodeStockCount", params={"node": "hs_a"}, headers=_SINA_HDR, timeout=10, ext="json").text.strip().strip('"')
        return int(t) if t.isdigit() else 0
    except (ValueError, OSError, RuntimeError):
        return 0


def _sina_dist_date() -> str:
    """分布数据日:优先交易所日历(已开盘则今天,否则上一交易日),拿不到退回本机今天。"""
    try:
        from sources.astock_defaults import latest_trading_day
        return latest_trading_day(9)
    except Exception:  # noqa: BLE001
        from datetime import date as _d
        return _d.today().isoformat()


def _is_limit(pct: float, code: str, name: str) -> bool:
    """本地近似涨停 / 跌停判定(按代码前缀区分板块涨跌幅限制)。

    主板 10% / ST 5% / 科创板·创业板 20% / 北交所 30%;阈值取限制的 98% 容错(东财对涨停池也是近似)。
    新股上市前五日无涨跌幅限制无法识别,备源场景下少量误判可接受。
    """
    c = (code or "").strip()
    up = (name or "").upper()
    if "ST" in up:
        lim = 5.0
    elif c.startswith(("688", "689")):
        lim = 20.0
    elif c.startswith(("300", "301")):
        lim = 20.0
    elif c.startswith(("8", "4", "920")):
        lim = 30.0
    else:
        lim = 10.0
    return pct >= lim * 0.98 or pct <= -lim * 0.98


def _aggregate_distribution(rows: list) -> dict:
    """把 hs_a 全量快照(每支含 changepercent)聚合成与东财 getTopicZDFenBu 同口径的 23 档分布。纯函数,便于单测。

    涨停 / 跌停按板块涨跌幅限制判定(键 11 / -11);其余按涨跌幅绝对值落到 1~10 / -1~-10 档,
    label 直接复用东财 `_zdfb_label`,保证备源和主源产出的 buckets 键与文案完全一致,breadthFrom / MarketState 无需感知来源。
    空档(计数为 0)不输出,与东财只回有数据的档位一致。
    返回 {date, buckets:[{key,label,count}], source:"sina"}。
    """
    import math

    from sources.eastmoney import _zdfb_label

    counts: dict[int, int] = {}
    for x in rows:
        if not isinstance(x, dict):
            continue
        pct = _f(x.get("changepercent"))
        if pct is None:
            continue
        if _is_limit(pct, str(x.get("code") or ""), str(x.get("name") or "")):
            key = 11 if pct > 0 else -11
        elif pct > 0.05:
            key = 10 if pct > 9 else max(1, int(math.ceil(pct)))
        elif pct < -0.05:
            key = -10 if pct < -9 else -max(1, int(math.ceil(-pct)))
        else:
            key = 0
        counts[key] = counts.get(key, 0) + 1
    if not counts:
        raise RuntimeError("新浪涨跌分布聚合结果为 0 家,源可能异常")
    buckets = [
        {"key": k, "label": _zdfb_label(k), "count": counts[k]}
        for k in sorted(counts, reverse=True)
    ]
    return {"date": _sina_dist_date(), "buckets": buckets, "source": "sina"}


def sina_updown_distribution(max_pages: int = 200) -> dict:
    """新浪全市场涨跌分布(东财 push2ex 断连时的独立备源)。

    新浪没有公开的「涨跌分布」汇总接口(CN_UpDownFlucDaytime 等 service 在新浪服务端已不存在),
    这里从 `hs_a` 全量快照(每支 A 股的涨跌幅)本地聚合成与东财同口径的分布,供 market_breadth 在
    push2ex 取不到时填充 buckets。

    ⚠️ 一次要拉全市场(约 5500 支,新浪单页上限 100),只在东财主源失败时才走这条;
       上游按 120s 缓存,实际频率很低。失败抛异常(交给 market_breadth 标缺口)。
    {date, buckets:[{key,label,count}], source:"sina"}
    """
    from concurrent.futures import ThreadPoolExecutor, as_completed

    total = _sina_hs_a_count()
    if not total:
        raise RuntimeError("新浪 hs_a 家数没取到,无法聚合涨跌分布")
    pages = min((total + 99) // 100, max_pages)
    if pages <= 0:
        raise RuntimeError("新浪 hs_a 页数计算异常")

    def _page(p: int) -> list:
        t = http_get(_SINA_JSON + "Market_Center.getHQNodeData",
                     params={"page": p, "num": 100, "sort": "symbol", "asc": 1, "node": "hs_a", "symbol": "", "_s_r_a": "auto"},
                     headers=_SINA_HDR, timeout=15, ext="json").text
        if "[" not in t:
            return []
        return json.loads(t[t.index("["): t.rindex("]") + 1])

    rows: list = []
    failed = 0
    # 并发拉页以压低延迟(本地聚合,不依赖 last_raw_ref 的上下文语义)
    with ThreadPoolExecutor(max_workers=10) as ex:
        futs = [ex.submit(_page, p) for p in range(1, pages + 1)]
        for fu in as_completed(futs):
            try:
                rows.extend(fu.result() or [])
            except Exception:  # noqa: BLE001
                failed += 1
    if failed and failed * 2 >= pages:
        raise RuntimeError(f"新浪涨跌分布拉取失败过多({failed}/{pages} 页)")
    return _aggregate_distribution(rows)
