"""Cross-check the app's numbers against Excel semantics.

The app evaluates the workbook's formulas in Python (src/py/webapp/view.py).
This test builds the workbook with the reference generator, lets the
independent `formulas` engine compute every cell the way Excel would, and
compares the two - sheet by sheet, row by row.

usage: python verify_formulas.py <workbook.xlsx> [more.xlsx ...]
Needs: networth (the reference package) and `formulas` importable; the app's
src/py on sys.path is added here. Row budgets are shrunk for the build so the
engine finishes quickly (formulas are per-row, so the budget doesn't matter).
"""
import os
import sys
import tempfile
import warnings
from datetime import date

warnings.filterwarnings("ignore")
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "src", "py"))

import formulas  # noqa: E402

from networth import model as M  # noqa: E402
from networth.generate import build_workbook  # noqa: E402
from networth.reader import read_workbook  # noqa: E402
from webapp import api  # noqa: E402
from webapp.view import build_view  # noqa: E402


def shrink_budgets(data):
    """Rows the data needs + 2 spare, per sheet (the generator writes every
    budget row's formulas; the engine is slow on thousands of them)."""
    def need(n):
        return M.FIRST_DATA_ROW + n + 1
    M.EQUITY_LAST_ROW = need(len(data.equity))
    M.EQUITY_TOTAL_ROW = M.EQUITY_LAST_ROW + 2
    M.MF_LAST_ROW = need(len(data.mutual_funds))
    M.MF_TOTAL_ROW = M.MF_LAST_ROW + 2
    M.SIP_LAST_ROW = need(len(data.sip))
    M.FD_LAST_ROW = need(len(data.fixed_deposits))
    M.PPF_LAST_ROW = need(len(data.ppf))
    M.PPF_LEDGER_LAST_ROW = need(len(data.ppf_ledger))
    M.BOND_LAST_ROW = need(len(data.bonds))
    M.BYSCRIP_LAST_ROW = need(len(data.by_scrip))
    M.CA_LAST_ROW = need(len(data.corporate_actions))
    M.DIV_LAST_ROW = need(len(data.dividends))
    M.EQSELL_LAST_ROW = need(len(data.equity_sells))
    M.MA_LAST_ROW = need(len(data.manual_assets))
    M.EPF_LAST_ROW = need(len(data.epf))
    M.GS_LAST_ROW = need(len(data.bullion))
    M.NPS_LAST_ROW = need(len(data.nps))
    M.HISTORY_LAST_ROW = need(len(data.history))
    M.IMPORTMAP_LAST_ROW = need(max(len(data.import_map), len(data.imported_files)))
    M.TAXRULES_LAST_ROW = need(40)
    # keep only master rows a holding uses (lookups still resolve)
    used = ({r.scrip for r in data.equity} | {r.scrip for r in data.equity_sells}
            | {r.scheme for r in data.mutual_funds} | {r.scheme for r in data.sip})
    ms = data.masters
    ms.stock_rows = [r for r in ms.stock_rows if r[1] in used]
    ms.mf_rows = [r for r in ms.mf_rows if r[1] in used]
    ms.nps_rows = [r for r in ms.nps_rows if r[1] in {n.scheme for n in data.nps}]


class Book:
    def __init__(self, path):
        xl = formulas.ExcelModel().loads(path).finish()
        sol = xl.calculate()
        self.v = {}
        for k, val in sol.items():
            # keys look like "'[file.xlsx]SHEET'!A1" (upper-cased sheet)
            ref = str(k)
            if "]" not in ref or "!" not in ref:
                continue
            sheet = ref.split("]", 1)[1].split("'!")[0]
            cell = ref.split("!")[1]
            if ":" in cell:
                continue
            try:
                x = val.value[0][0]
            except Exception:  # noqa: BLE001
                x = val
            self.v[(sheet.upper(), cell.upper())] = x

    def get(self, sheet, cell):
        x = self.v.get((sheet.upper(), cell.upper()))
        if x is None:
            return None
        s = str(x)
        if s in ("", "empty") or s.startswith("#"):
            return None if s in ("", "empty") else s
        try:
            return float(x)
        except (TypeError, ValueError):
            return s


def close(a, b, tol=0.02):
    if a in (None, "", 0) and b in (None, "", 0, 0.0):
        return True
    if isinstance(a, str) or isinstance(b, str):
        return str(a) == str(b)
    if a is None or b is None:
        return False
    return abs(a - b) <= tol + 1e-6 * max(abs(a), abs(b))


def check(path, all_classes=False):
    today = date.today()
    data = read_workbook(path)
    if all_classes:
        for c in M.ASSET_CLASSES:
            data.class_settings.setdefault(c.key, M.ClassSetting()).enabled = True
        data.show_capital_gains = True
    shrink_budgets(data)
    api.STATE["data"] = data
    api.STATE["today"] = today.isoformat()
    api.recompute()
    v = build_view(data, today)
    tmp = tempfile.NamedTemporaryFile(suffix=".xlsx", delete=False).name
    # the dropdown-list names (range:INDEX(...)) feed only data validation,
    # never a cell value - and the engine can't parse them
    import re
    import xlsxwriter
    from xlsxwriter.worksheet import Worksheet
    saved = xlsxwriter.Workbook.define_name, Worksheet.write_formula
    whole_col = re.compile(r"\$([A-Z]{1,2}):\$([A-Z]{1,2})\b")

    def bounded(self, row, col, formula=None, *rest, **kw):
        # A1-notation calls arrive as ("I4", formula, fmt)
        if isinstance(row, str):
            args = [row, col, formula, *rest]
            args[1] = whole_col.sub(r"$\1$1:$\2$400", args[1])
            return saved[1](self, *args, **kw)
        formula = whole_col.sub(r"$\1$1:$\2$400", formula)
        return saved[1](self, row, col, formula, *rest, **kw)

    xlsxwriter.Workbook.define_name = lambda *a, **k: None
    Worksheet.write_formula = bounded
    try:
        build_workbook(data, tmp, today=today)
    finally:
        xlsxwriter.Workbook.define_name, Worksheet.write_formula = saved
    book = Book(tmp)
    bad, n = [], 0

    def cmp(label, mine, sheet, cell, tol=0.02):
        nonlocal n
        n += 1
        theirs = book.get(sheet, cell)
        if not close(mine, theirs, tol):
            bad.append(f"{label}: app={mine!r} excel={theirs!r} ({sheet}!{cell})")

    S = v["sheets"]
    for r in S["equity"]:
        row = 4 + r["i"]
        c = r["c"]
        for key, col in (("cur_val", "I"), ("invested", "J"), ("net_chg", "K"),
                         ("day_chg", "L"), ("qty_today", "O"),
                         ("avg_cost_today", "P")):
            cmp(f"Equity r{row} {key}", c.get(key), "Equity", f"{col}{row}")
        cmp(f"Equity r{row} xirr", c.get("xirr"), "Equity", f"N{row}", 1e-6)
        cmp(f"Equity r{row} isin", c.get("isin") or None, "Equity", f"B{row}")
    for r in S["mutual_funds"]:
        row = 4 + r["i"]
        for key, col in (("units", "E"), ("avg_nav", "F"), ("invested", "H"),
                         ("cur_val", "I"), ("net_chg", "J")):
            cmp(f"MF r{row} {key}", r["c"].get(key), "MutualFunds", f"{col}{row}")
        cmp(f"MF r{row} return", r["c"].get("return_pct"), "MutualFunds", f"K{row}", 1e-6)
    for r in S["sip"]:
        row = 4 + r["i"]
        cmp(f"SIP r{row} units", r["c"].get("units"), "MF_SIP", f"H{row}", 1e-4)
    for r in S["fixed_deposits"]:
        row = 4 + r["i"]
        cmp(f"FD r{row} value", r["c"].get("value_today"), "FixedDeposits", f"I{row}")
        cmp(f"FD r{row} maturity", r["c"].get("maturity_value"), "FixedDeposits", f"J{row}")
    for r in S["ppf"]:
        row = 4 + r["i"]
        cmp(f"PPF r{row} balance", r["c"].get("balance_today"), "PPF", f"H{row}")
    for r in S["epf"]:
        row = 4 + r["i"]
        cmp(f"EPF r{row} balance", r["c"].get("balance_today"), "EPF", f"H{row}")
    for r in S["bonds"]:
        row = 4 + r["i"]
        for key, col in (("invested", "J"), ("cur_val", "K"), ("net_chg", "L"),
                         ("maturity_value", "O"), ("coupons_left", "P")):
            cmp(f"Bond r{row} {key}", r["c"].get(key), "Bonds", f"{col}{row}")
    for r in S["bullion"]:
        row = 4 + r["i"]
        for key, col in (("cur_val", "K"), ("invested", "L"), ("net_chg", "M")):
            cmp(f"Gold r{row} {key}", r["c"].get(key), "Gold_Silver", f"{col}{row}")
    for r in S["nps"]:
        row = 4 + r["i"]
        cmp(f"NPS r{row} value", r["c"].get("cur_val"), "NPS", f"G{row}")
    for r in S["manual_assets"]:
        row = 4 + r["i"]
        cmp(f"Manual r{row} net", r["c"].get("net_chg"), "Manual_Assets", f"I{row}")
    for r in S["equity_sells"]:
        row = 4 + r["i"]
        cmp(f"Sell r{row} proceeds", r["c"].get("proceeds"), "Equity_Sells", f"I{row}")
        cmp(f"Sell r{row} gain", r["c"].get("gain"), "Equity_Sells", f"J{row}")
    for r in S["dividends"]:
        row = 4 + r["i"]
        cmp(f"Div r{row} amount", r["c"].get("amount"), "Dividends", f"I{row}")
    persons = v["meta"]["persons"]
    for r in S["by_scrip"]:
        row = 4 + r["i"]
        cmp(f"ByScrip r{row} qty", r["c"].get("total_qty"), "By Scrip", f"C{row}")
        for j, p in enumerate(persons):
            cmp(f"ByScrip r{row} {p}", (r["c"].get("by_person") or {}).get(p),
                "By Scrip", f"{chr(ord('D') + j)}{row}")
        cmp(f"ByScrip r{row} value", r["c"].get("cur_val"), "By Scrip",
            f"{chr(ord('D') + len(persons))}{row}")
    for i, m in enumerate(v["dashboard"]["matrix"]):
        row = 6 + i
        for j, a in enumerate(v["dashboard"]["alloc"]):
            cmp(f"Dashboard {m['name']} {a['label']}", m["values"][a["key"]],
                "Dashboard", f"{chr(ord('B') + j)}{row}")
        cmp(f"Dashboard {m['name']} total", m["total"], "Dashboard",
            f"{chr(ord('B') + len(v['dashboard']['alloc']))}{row}")
    cmp("Dashboard net worth", v["dashboard"]["net_worth"], "Dashboard", "B3")
    cmp("Dashboard real return", v["dashboard"]["real_return"], "Dashboard", "E4", 1e-9)
    for j, a in enumerate(v["dashboard"]["alloc"]):
        row = 20 + j
        cmp(f"Alloc {a['label']} actual", a["actual"], "Dashboard", f"D{row}", 1e-9)
        cmp(f"Alloc {a['label']} drift", a["drift"], "Dashboard", f"F{row}", 1e-9)
    if v["dashboard"]["dividends_fy"] is not None:
        cmp("Dashboard dividends FY", v["dashboard"]["dividends_fy"], "Dashboard", "B17")
    for i, p in enumerate(v["projection"]):
        row = 4 + i
        cmp(f"Projection {p['year']} xirr", p["at_xirr"], "Projection", f"B{row}", 0.5)
        cmp(f"Projection {p['year']} infl", p["at_inflation"], "Projection", f"C{row}", 0.5)
        cmp(f"Projection {p['year']} real", p["real"], "Projection", f"D{row}", 0.5)
    tabs = M.person_tab_map(persons)
    for p in v["people"]:
        for j, c in enumerate(p["classes"]):
            cmp(f"Person {p['name']} {c['label']}", c["value"], tabs[p["name"]], f"B{6 + j}")
            cmp(f"Person {p['name']} {c['label']} count", c["count"], tabs[p["name"]], f"C{6 + j}")
    for i, mth in enumerate(v["dividends_by_month"]):
        cmp(f"Div month {mth['m']}", mth["v"], "Dividends", f"N{4 + i}")
    os.unlink(tmp)
    return n, bad


if __name__ == "__main__":
    total_bad = 0
    for p in sys.argv[1:]:
        for all_on in (False, True):
            n, bad = check(p, all_classes=all_on)
            print(f"{os.path.basename(p)}{' (every class on)' if all_on else ''}: "
                  f"{n} values compared, {len(bad)} differ")
            for b in bad:
                print("   ", b)
            total_bad += len(bad)
    sys.exit(1 if total_bad else 0)
