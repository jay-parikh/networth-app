"""Everything the app's screens display, computed from PortfolioData.

In the workbook these numbers are Excel formulas (SPEC §3): the generator
writes them and Excel evaluates them. The app has no Excel, so this module
evaluates the SAME formulas in Python, sheet by sheet, citing the column each
value mirrors. Updater-written values (prices, NAVs, XIRR, FY-end estimates)
are read from the data as-is - they come from the reference implementation.

Excel semantics kept on purpose:
  * a blank cell in arithmetic counts as 0 (e.g. Cur. val with no price = 0);
  * SUMIFS/COUNTIFS owner matching is case-insensitive;
  * YEARFRAC uses Excel's default basis 0 (US 30/360), not actual/365;
  * a formula that would show an Excel error (#DIV/0!, #VALUE!) shows blank.
"""
from __future__ import annotations

import calendar
from datetime import date, timedelta

from networth import __version__
from networth import model as M
from networth.guide_text import GUIDE_ROWS
from networth.model import (ASSET_CLASSES, class_has_data, effective_enabled,
                            enabled_classes, fy_label)

from .codec import CAPACITY, to_jsonable

STALE_PRICE_DAYS = 7          # Equity F:H amber (SPEC §6.5)
STALE_METAL_DAYS = 7          # Gold_Silver I amber (SPEC §3.15)
STALE_MANUAL_DAYS = 90        # Manual_Assets H amber (SPEC §3.18)


# ------------------------------------------------------------- helpers ----

def _cf(s) -> str:
    return (s or "").strip().casefold()


def _last_of_feb(d: date) -> bool:
    return d.month == 2 and d.day == calendar.monthrange(d.year, 2)[1]


def yearfrac(a: date, b: date) -> float:
    """Excel YEARFRAC(a, b) with the default basis 0 (US NASD 30/360)."""
    if a > b:
        a, b = b, a
    d1, d2 = a.day, b.day
    if _last_of_feb(a) and _last_of_feb(b):
        d2 = 30
    if _last_of_feb(a):
        d1 = 30
    if d2 == 31 and d1 >= 30:
        d2 = 30
    if d1 == 31:
        d1 = 30
    return ((b.year - a.year) * 360 + (b.month - a.month) * 30
            + (d2 - d1)) / 360.0


def _num(v):
    """Excel's view of a blank cell inside arithmetic."""
    return 0.0 if v is None else v


def _safe_pow(base, exp):
    try:
        if base < 0 and int(exp) != exp:
            return None
        r = base ** exp
        return r if isinstance(r, float) or isinstance(r, int) else None
    except (OverflowError, ZeroDivisionError, ValueError):
        return None


def _r(v, nd=2):
    return None if v is None else round(v, nd)


# ------------------------------------------------------------ lookups ----

class Lookups:
    def __init__(self, data: M.PortfolioData):
        ms = data.masters
        self.stock_isin = {name: isin for _s, name, isin in ms.stock_rows}
        self.stock_name = {isin: name for _s, name, isin in ms.stock_rows}
        self.mf_isin = {scheme: isin for _f, scheme, isin in ms.mf_rows}
        self.mf_house = {scheme: house for house, scheme, _i in ms.mf_rows}
        self.nps_code = {name: code for code, name, _p in ms.nps_rows}
        self.status = ms.stock_status

    def equity_isin(self, row) -> str:
        return row.isin_override or self.stock_isin.get(row.scrip, "")

    def mf_isin_of(self, row) -> str:
        return row.isin_override or self.mf_isin.get(row.scheme, "")

    def mf_house_of(self, row) -> str:
        return row.fund_house_override or self.mf_house.get(row.scheme, "")


# ---------------------------------------------------------- sheet rows ----

def equity_rows(data, today, lk: Lookups):
    out = []
    for i, r in enumerate(data.equity):
        isin = lk.equity_isin(r)
        s = r.ca_factor if r.ca_factor is not None else 1.0
        t = r.cost_factor if r.cost_factor is not None else 1.0
        price = r.close if r.close is not None else r.manual_price
        c = {"isin": isin}
        if r.qty is not None:
            c["cur_val"] = r.qty * s * _num(price)                       # I
            c["qty_today"] = r.qty * s                                   # O
        if r.qty is not None and r.avg_cost is not None:
            c["invested"] = r.qty * r.avg_cost * t                       # J
            c["net_chg"] = c["cur_val"] - c["invested"]                  # K
            c["avg_cost_today"] = r.avg_cost * t / s if s else None      # P
        if r.prev_close is not None and r.qty is not None:
            c["day_chg"] = r.qty * s * (_num(r.close) - r.prev_close)    # L
        inv = c.get("invested")
        if (r.cost_date and inv and "cur_val" in c and today > r.cost_date):
            ratio = c["cur_val"] / inv
            p = _safe_pow(ratio, 365 / (today - r.cost_date).days)
            c["xirr"] = None if p is None else p - 1                     # N
        flags = []
        if r.close_date and (today - r.close_date).days > STALE_PRICE_DAYS:
            flags.append("stale")
        st = (lk.status.get(isin) or ("", None))[0]
        if st in ("Suspended", "Delisted"):
            flags.append(st.lower())
        if r.fmv_used:
            flags.append("fmv")
        if r.close is None and r.manual_price is not None:
            flags.append("unlisted")
        c["status"] = st
        out.append({"i": i, **to_jsonable(r), "c": c, "flags": flags})
    return out


def sip_units(r):
    """MF_SIP H: typed Units win, else Amount / NAV (blank when either is)."""
    if r.units_override is not None:
        return r.units_override
    if r.amount is not None and r.nav:
        return r.amount / r.nav
    return None


def sip_rows(data, today, lk):
    out = []
    for i, r in enumerate(data.sip):
        c = {"isin": lk.mf_isin_of(r), "fund_house": lk.mf_house_of(r),
             "units": sip_units(r)}
        flags = ["future"] if r.txn_date and r.txn_date > today else []
        out.append({"i": i, **to_jsonable(r), "c": c, "flags": flags})
    return out


def mf_rows(data, today, lk):
    # SUMIFS(MF_SIP!H / F, owner, ISIN) - every ledger row, as the sheet does
    units: dict = {}
    invested: dict = {}
    for s in data.sip:
        key = (_cf(s.owner), lk.mf_isin_of(s))
        u = sip_units(s)
        if u is not None:
            units[key] = units.get(key, 0.0) + u
        if s.amount is not None:
            invested[key] = invested.get(key, 0.0) + s.amount
    out = []
    for i, r in enumerate(data.mutual_funds):
        isin = lk.mf_isin_of(r)
        key = (_cf(r.owner), isin)
        c = {"isin": isin, "fund_house": lk.mf_house_of(r)}
        if r.owner:
            e = units.get(key, 0.0)
            h = invested.get(key, 0.0)
            c["units"], c["invested"] = e, h                             # E, H
            if e:
                c["avg_nav"] = h / e                                     # F
                if r.current_nav is not None:
                    c["cur_val"] = e * r.current_nav                     # I
                    c["net_chg"] = c["cur_val"] - h                      # J
                    if h and c["net_chg"]:
                        c["return_pct"] = c["net_chg"] / h               # K
        out.append({"i": i, **to_jsonable(r), "c": c, "flags": []})
    return out


def _fd_value(r, to: date):
    if r.principal is None:
        return None
    if not (r.rate is not None and r.comp_per_year and r.start and to):
        return None
    n = r.comp_per_year
    growth = _safe_pow(1 + (r.rate / 100) / n, n * yearfrac(r.start, to))
    return None if growth is None else r.principal * growth


def fd_rows(data, today, lk):
    out = []
    for i, r in enumerate(data.fixed_deposits):
        c = {}
        if r.maturity:
            c["value_today"] = _fd_value(r, min(today, r.maturity))      # I
            c["maturity_value"] = _fd_value(r, r.maturity)               # J
        flags = []
        if r.maturity and r.maturity <= today:
            flags.append("matured")
        out.append({"i": i, **to_jsonable(r), "c": c, "flags": flags})
    return out


def ppf_rows(data, today, lk):
    out = []
    for i, r in enumerate(data.ppf):
        bal = r.balance_today if r.balance_today is not None else r.balance
        c = {"balance_today": bal,                                       # H
             "ledger": r.balance_today is not None}
        out.append({"i": i, **to_jsonable(r), "c": c, "flags": []})
    return out


def epf_balance(r, today):
    """EPF H: =IF(D="","",IF(OR(E="",F=""),D,D*(1+F/100)^YEARFRAC(E,TODAY())))"""
    if r.balance is None:
        return None
    if not r.as_on or r.rate is None:
        return r.balance
    return r.balance * (1 + r.rate / 100) ** yearfrac(r.as_on, today)


def epf_rows(data, today, lk):
    return [{"i": i, **to_jsonable(r), "c": {"balance_today": epf_balance(r, today)},
             "flags": []} for i, r in enumerate(data.epf)]


def bond_rows(data, today, lk):
    out = []
    for i, r in enumerate(data.bonds):
        c = {}
        if r.qty is not None and r.buy_price is not None:
            c["invested"] = r.qty * r.buy_price                          # J
        if r.qty is not None and r.cur_price is not None:
            c["cur_val"] = r.qty * r.cur_price                           # K
        if "invested" in c and "cur_val" in c:
            c["net_chg"] = c["cur_val"] - c["invested"]                  # L
        if r.qty is not None and r.face is not None:
            c["maturity_value"] = r.qty * r.face                         # O
            if (r.coupon is not None and r.maturity and r.maturity > today):
                c["coupons_left"] = (r.qty * r.face * (r.coupon / 100)
                                     * yearfrac(today, r.maturity))      # P
        flags = ["matured"] if r.maturity and r.maturity <= today else []
        out.append({"i": i, **to_jsonable(r), "c": c, "flags": flags})
    return out


def bullion_rows(data, today, lk):
    out = []
    stale = (data.bullion_rate_asof is not None
             and (today - data.bullion_rate_asof).days > STALE_METAL_DAYS)
    for i, r in enumerate(data.bullion):
        c = {}
        rate = r.rate_override if r.rate_override is not None else r.rate_auto
        if r.qty is not None and rate is not None:
            c["cur_val"] = r.qty * (r.purity if r.purity is not None else 1) * rate  # K
        if r.qty is not None and r.buy_price is not None:
            c["invested"] = r.qty * r.buy_price                          # L
        if "cur_val" in c and "invested" in c:
            c["net_chg"] = c["cur_val"] - c["invested"]                  # M
        flags = []
        if (stale and r.rate_auto is not None and r.metal_type != "SGB"):
            flags.append("stale")
        if r.rate_override is not None:
            flags.append("override")
        out.append({"i": i, **to_jsonable(r), "c": c, "flags": flags})
    return out


def nps_rows(data, today, lk):
    out = []
    for i, r in enumerate(data.nps):
        c = {"code": r.scheme_code_override or lk.nps_code.get(r.scheme, "")}
        if r.units is not None and r.current_nav is not None:
            c["cur_val"] = r.units * r.current_nav                       # G
        out.append({"i": i, **to_jsonable(r), "c": c, "flags": []})
    return out


def manual_rows(data, today, lk):
    out = []
    for i, r in enumerate(data.manual_assets):
        c = {}
        if r.invested is not None and r.value is not None:
            c["net_chg"] = r.value - r.invested                          # I
        flags = []
        if r.as_on and (today - r.as_on).days > STALE_MANUAL_DAYS:
            flags.append("stale")
        if r.asset_class and r.asset_class not in M.MANUAL_CLASS_LABELS:
            flags.append("bad_class")
        out.append({"i": i, **to_jsonable(r), "c": c, "flags": flags})
    return out


def sell_rows(data, today, lk):
    out = []
    for i, r in enumerate(data.equity_sells):
        c = {"isin": r.isin_override or lk.stock_isin.get(r.scrip, "")}
        if r.qty is not None and r.sell_price is not None:
            c["proceeds"] = r.qty * r.sell_price                         # I
            if r.buy_price is not None:
                c["gain"] = r.qty * (r.sell_price - r.buy_price)         # J
        out.append({"i": i, **to_jsonable(r), "c": c, "flags": []})
    return out


def ca_rows(data, today, lk):
    out = []
    for i, a in enumerate(data.corporate_actions):
        c = {}
        if a.type and a.ratio_from is not None and a.ratio_to:
            if a.type == "BONUS":
                c["factor"] = 1 + a.ratio_from / a.ratio_to
            elif a.type in ("DEMERGER", "ISIN_CHANGE"):
                c["factor"] = 1.0
            else:
                c["factor"] = a.ratio_from / a.ratio_to
        flags = ["future"] if a.ex_date and a.ex_date > today else []
        out.append({"i": i, **to_jsonable(a), "c": c, "flags": flags})
    return out


def dividend_rows(data, today, lk):
    out = []
    for i, d in enumerate(data.dividends):
        c = {}
        if d.rate is not None and d.qty is not None:
            c["amount"] = d.rate * d.qty                                 # I
        flags = ["future"] if d.ex_date and d.ex_date > today else []
        out.append({"i": i, **to_jsonable(d), "c": c, "flags": flags})
    return out


def by_scrip_rows(data, eq_rows, persons):
    out = []
    for i, s in enumerate(data.by_scrip):
        c = {}
        if s.isin:
            mine = [e for e in eq_rows if e["c"]["isin"] == s.isin]
            c["total_qty"] = sum(e["c"].get("qty_today") or 0 for e in mine)
            c["by_person"] = {p: sum(e["c"].get("qty_today") or 0 for e in mine
                                     if _cf(e["owner"]) == _cf(p))
                              for p in persons}
            c["cur_val"] = sum(e["c"].get("cur_val") or 0 for e in mine)
        out.append({"i": i, **to_jsonable(s), "c": c, "flags": []})
    return out


# ------------------------------------------------- class values / totals --

def class_value_rows(key, sheets):
    """(rows, value field, owner field, class filter) - the SUMIFS ranges of
    AssetClass.value_col / owner_col, expressed on the computed rows."""
    if key == "equity":
        return sheets["equity"], lambda r: r["c"].get("cur_val")
    if key == "mutual_funds":
        return sheets["mutual_funds"], lambda r: r["c"].get("cur_val")
    if key == "fixed_deposits":
        return sheets["fixed_deposits"], lambda r: r["c"].get("value_today")
    if key == "ppf":
        return sheets["ppf"], lambda r: r["c"].get("balance_today")
    if key == "epf":
        return sheets["epf"], lambda r: r["c"].get("balance_today")
    if key == "bonds":
        return sheets["bonds"], lambda r: r["c"].get("cur_val")
    if key == "gold_silver":
        return sheets["bullion"], lambda r: r["c"].get("cur_val")
    if key == "nps":
        return sheets["nps"], lambda r: r["c"].get("cur_val")
    label = next(c.class_filter[1] for c in ASSET_CLASSES if c.key == key)
    rows = [r for r in sheets["manual_assets"]
            if _cf(r["asset_class"]) == _cf(label)]
    return rows, lambda r: r.get("value")


def person_class_value(key, person, sheets):
    rows, val = class_value_rows(key, sheets)
    return sum(val(r) or 0 for r in rows if _cf(r["owner"]) == _cf(person))


def person_class_count(key, person, sheets):
    rows, _val = class_value_rows(key, sheets)
    return sum(1 for r in rows if _cf(r["owner"]) == _cf(person))


# ----------------------------------------------------------------- view ----

def build_view(data: M.PortfolioData, today: date, capgains=None) -> dict:
    lk = Lookups(data)
    fy_now = fy_label(today)
    sheets = {
        "equity": equity_rows(data, today, lk),
        "equity_sells": sell_rows(data, today, lk),
        "mutual_funds": mf_rows(data, today, lk),
        "sip": sip_rows(data, today, lk),
        "fixed_deposits": fd_rows(data, today, lk),
        "ppf": ppf_rows(data, today, lk),
        "ppf_ledger": [{"i": i, **to_jsonable(r), "c": {},
                        "flags": ["future"] if r.txn_date and r.txn_date > today else []}
                       for i, r in enumerate(data.ppf_ledger)],
        "epf": epf_rows(data, today, lk),
        "bonds": bond_rows(data, today, lk),
        "bullion": bullion_rows(data, today, lk),
        "nps": nps_rows(data, today, lk),
        "manual_assets": manual_rows(data, today, lk),
        "corporate_actions": ca_rows(data, today, lk),
        "dividends": dividend_rows(data, today, lk),
        "import_map": [{"i": i, **to_jsonable(r), "c": {}, "flags": []}
                       for i, r in enumerate(data.import_map)],
        "imported_files": [{"i": i, **to_jsonable(r), "c": {}, "flags": []}
                           for i, r in enumerate(data.imported_files)],
    }
    persons = list(data.persons)
    sheets["by_scrip"] = by_scrip_rows(data, sheets["equity"], persons)

    # ---- Dashboard (SPEC §3.3) ----
    enabled = enabled_classes(data)
    matrix = []
    for p in persons[:10]:
        vals = {c.key: person_class_value(c.key, p, sheets) for c in enabled}
        matrix.append({"name": p, "values": vals,
                       "total": sum(vals.values()),
                       "expected": data.fy_expected.get(p)})
    col_totals = {c.key: sum(m["values"][c.key] for m in matrix) for c in enabled}
    net_worth = sum(col_totals.values())
    exp_sum = sum(m["expected"] or 0 for m in matrix)
    px = data.xirr.portfolio
    infl = data.inflation_pct
    real = None if px is None else (1 + px) / (1 + infl / 100) - 1
    verdict = (None if px is None else
               "Beats inflation ✓" if px > infl / 100 else "Below inflation ✗")
    tol = data.drift_tolerance_pct
    alloc = []
    for cls in enabled:
        v = col_totals[cls.key]
        s = data.class_settings.get(cls.key)
        target = (s.target_pct / 100) if s and s.target_pct is not None else None
        actual = v / net_worth if net_worth else None
        drift = None if target is None or actual is None else actual - target
        hint = None
        if target is not None and drift is not None:
            hint = ("On target" if abs(drift) <= tol / 100
                    else {"move": abs(drift) * net_worth,
                          "dir": "out" if drift > 0 else "in"})
        alloc.append({"key": cls.key, "label": cls.label, "value": v,
                      "xirr": getattr(data.xirr, cls.key, None) if cls.has_xirr else None,
                      "has_xirr": cls.has_xirr, "actual": actual,
                      "target": target, "drift": drift, "hint": hint,
                      "on_target": None if drift is None else abs(drift) <= tol / 100})
    div_rows = sheets["dividends"]
    dividends_fy = sum(r["c"].get("amount") or 0 for r in div_rows if r["fy"] == fy_now)
    months = [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3]
    by_month = []
    for m in months:
        tot = 0.0
        for r in div_rows:
            if r["fy"] == fy_now and r["ex_date"] and int(r["ex_date"][5:7]) == m:
                tot += r["c"].get("amount") or 0
        by_month.append({"m": calendar.month_abbr[m], "v": tot})
    fy_year = today.year if today <= date(today.year, 3, 31) else today.year + 1
    off = M.off_with_data_classes(data)

    dashboard = {
        "net_worth": net_worth, "portfolio_xirr": px, "real_return": real,
        "verdict": verdict, "inflation_pct": infl,
        "expected_return_pct": data.expected_return_pct,
        "matrix": matrix, "col_totals": col_totals,
        "expected_total": exp_sum or None,
        "expected_label": f"Expected @ 31-Mar-{fy_year}",
        "alloc": alloc, "dividends_fy": dividends_fy if "equity" in col_totals else None,
        "hidden_notice": [c.label for c in off],
    }

    # ---- Projection (SPEC §3.4) ----
    projection = []
    for n in range(M.PROJECTION_YEARS + 1):
        b = net_worth * (1 + (px or 0)) ** n
        projection.append({"year": today.year + n, "at_xirr": b,
                           "at_inflation": net_worth * (1 + infl / 100) ** n,
                           "real": b / (1 + infl / 100) ** n})

    # ---- person sheets (SPEC §3.5) ----
    people = []
    for p in persons:
        rows = [{"key": c.key, "label": c.label,
                 "value": person_class_value(c.key, p, sheets),
                 "count": person_class_count(c.key, p, sheets)} for c in enabled]
        people.append({
            "name": p, "tab": M.person_tab_map(persons).get(p, p),
            "classes": rows, "total": sum(r["value"] for r in rows),
            "count": sum(r["count"] for r in rows),
            "dividends_fy": (sum(r["c"].get("amount") or 0 for r in div_rows
                                 if r["fy"] == fy_now and _cf(r["owner"]) == _cf(p))
                             if "equity" in col_totals else None),
        })

    # ---- Settings (SPEC §3.14) ----
    classes = []
    for cls in ASSET_CLASSES:
        s = data.class_settings.get(cls.key)
        on = effective_enabled(data, cls)
        has = class_has_data(data, cls.key)
        classes.append({
            "key": cls.key, "label": cls.label, "enabled": on,
            "target": s.target_pct if s else None, "has_data": has,
            "has_xirr": cls.has_xirr, "sheets": list(cls.sheets),
            "status": ("Shown" if on else
                       "Hidden - has data (not counted)" if has else "Hidden"),
        })
    targets_total = sum((c["target"] or 0) for c in classes)

    # ---- totals per sheet (the TOTAL rows) ----
    def tot(name, field):
        return sum(r["c"].get(field) or 0 for r in sheets[name])
    totals = {
        "equity": {k: tot("equity", k) for k in ("cur_val", "invested", "net_chg", "day_chg")},
        "mutual_funds": {k: tot("mutual_funds", k) for k in ("invested", "cur_val", "net_chg")},
        "fixed_deposits": {k: tot("fixed_deposits", k) for k in ("value_today", "maturity_value")},
        "ppf": {"balance_today": tot("ppf", "balance_today")},
        "epf": {"balance_today": tot("epf", "balance_today")},
        "bonds": {k: tot("bonds", k) for k in ("invested", "cur_val", "net_chg",
                                               "maturity_value", "coupons_left")},
        "bullion": {k: tot("bullion", k) for k in ("cur_val", "invested")},
        "nps": {"cur_val": tot("nps", "cur_val")},
        "manual_assets": {"value": sum(r.get("value") or 0 for r in sheets["manual_assets"])},
    }
    mf_tot = totals["mutual_funds"]
    mf_tot["return_pct"] = (mf_tot["net_chg"] / mf_tot["invested"]
                            if mf_tot["invested"] else None)

    # ---- Tax rules as the engine sees them (SPEC §3.22) ----
    valid, invalid, tr_warn = M.effective_tax_rules(data.tax_rules)
    tax_rules = ([{**to_jsonable(t), "valid": True} for t in valid]
                 + [{**to_jsonable(t), "valid": False} for t in invalid])

    # ---- History (SPEC §6.11) ----
    hist_classes = [c for c in ASSET_CLASSES
                    if effective_enabled(data, c)
                    or any(getattr(s, c.key, 0) for s in data.history)]
    history = [{"date": h.snap_date.isoformat(),
                "values": {c.key: getattr(h, c.key, 0.0) for c in hist_classes},
                "total": sum(getattr(h, c.key, 0.0) for c in hist_classes)}
               for h in data.history if h.snap_date]

    notes = []
    for r in sheets["manual_assets"]:
        if "bad_class" in r["flags"]:
            notes.append(f"Other assets: '{r['description'] or r['owner']}' has "
                         f"Class '{r['asset_class']}' - pick Property / Cash / "
                         "Insurance / Other, or it is counted nowhere")
    notes.extend(tr_warn)

    return {
        "meta": {"today": today.isoformat(), "fy_now": fy_now,
                 "app_version": __version__, "persons": persons,
                 "capacity": CAPACITY,
                 "stamps": {"mf": data.masters.mf_refreshed,
                            "stock": data.masters.stock_refreshed,
                            "nps": data.masters.nps_refreshed,
                            "bullion": (data.bullion_rate_asof.isoformat()
                                        if data.bullion_rate_asof else None)},
                 "last_update": to_jsonable(max((h.snap_date for h in data.history
                                                 if h.snap_date), default=None)),
                 "xirr": to_jsonable(data.xirr)},
        "settings": {
            "classes": classes, "show_references": data.show_references,
            "show_capital_gains": data.show_capital_gains,
            "apply_split_bonus": data.apply_split_bonus,
            "fetch_dividends": data.fetch_dividends,
            "drift_tolerance_pct": tol, "targets_total": targets_total,
            "privacy_enabled": data.privacy_enabled,
            "lock_enabled": data.lock_enabled,
            "has_password": bool(data.privacy_hash),
            "inflation_pct": infl,
            "expected_return_pct": data.expected_return_pct,
        },
        "dashboard": dashboard, "projection": projection, "people": people,
        "sheets": sheets, "totals": totals, "tax_rules": tax_rules,
        "history": history,
        "history_classes": [{"key": c.key, "label": c.label,
                             "enabled": effective_enabled(data, c)}
                            for c in hist_classes],
        "dividends_by_month": by_month,
        "capital_gains": to_jsonable(capgains) if capgains is not None else None,
        "notes": notes,
    }


def guide_rows():
    return [list(r) for r in GUIDE_ROWS]
