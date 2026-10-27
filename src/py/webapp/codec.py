"""PortfolioData <-> plain JSON, driven by the dataclass type hints.

The web app keeps the portfolio as JSON in the browser (IndexedDB): loading
it is instant, where re-reading an .xlsx with openpyxl takes seconds on a
phone. The Excel file is produced only on export, by the unmodified
generator, so the two representations hold exactly the same fields.

Dates travel as "YYYY-MM-DD" strings, tuples as lists. Unknown keys are
ignored and missing keys take the dataclass default, so a backup made by an
older app version still loads.
"""
from __future__ import annotations

import dataclasses
import types
import typing
from datetime import date

from networth import model as M

_HINTS: dict = {}


def _hints(cls):
    h = _HINTS.get(cls)
    if h is None:
        h = typing.get_type_hints(cls, vars(M))
        _HINTS[cls] = h
    return h


def to_jsonable(obj):
    if obj is None or isinstance(obj, (bool, int, float, str)):
        return obj
    if isinstance(obj, date):
        return obj.isoformat()
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        return {f.name: to_jsonable(getattr(obj, f.name))
                for f in dataclasses.fields(obj)}
    if isinstance(obj, dict):
        return {str(k): to_jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple, set)):
        return [to_jsonable(v) for v in obj]
    raise TypeError(f"cannot serialise {type(obj).__name__}")


def _parse_date(v):
    if v in (None, ""):
        return None
    if isinstance(v, date):
        return v
    return date.fromisoformat(str(v)[:10])


def from_jsonable(tp, v):
    """Convert JSON value `v` to type `tp` (a resolved type hint)."""
    origin = typing.get_origin(tp)
    if origin in (typing.Union, types.UnionType):
        args = [a for a in typing.get_args(tp) if a is not type(None)]
        if v is None:
            return None
        return from_jsonable(args[0], v) if len(args) == 1 else v
    if tp is date:
        return _parse_date(v)
    if tp is float:
        return None if v in (None, "") else float(v)
    if tp is int:
        return None if v in (None, "") else int(round(float(v)))
    if tp is bool:
        return bool(v)
    if tp is str:
        return "" if v is None else str(v)
    if origin is list:
        (inner,) = typing.get_args(tp) or (typing.Any,)
        return [from_jsonable(inner, x) for x in (v or [])]
    if origin is tuple:
        args = typing.get_args(tp)
        return tuple(from_jsonable(a, x) for a, x in zip(args, v or []))
    if origin is dict:
        _k, vt = typing.get_args(tp)
        return {str(k): from_jsonable(vt, x) for k, x in (v or {}).items()}
    if dataclasses.is_dataclass(tp):
        return build(tp, v or {})
    return v


def build(cls, d: dict):
    """A `cls` instance from a dict; unknown keys ignored, missing = default."""
    hints = _hints(cls)
    kwargs = {}
    for f in dataclasses.fields(cls):
        if f.name in d:
            kwargs[f.name] = from_jsonable(hints[f.name], d[f.name])
    return cls(**kwargs)


def dump_portfolio(data: M.PortfolioData) -> dict:
    out = to_jsonable(data)
    out.pop("warnings", None)     # reader findings, not data (model.py says so)
    return out


def load_portfolio(d: dict) -> M.PortfolioData:
    data = build(M.PortfolioData, d)
    # a class missing from an old backup keeps its registry default
    for key, s in M.default_class_settings().items():
        data.class_settings.setdefault(key, s)
    return data


# Row collections the app edits, with their row class and sheet name.
COLLECTIONS: dict[str, tuple[type, str]] = {
    "equity": (M.EquityRow, "Equity"),
    "equity_sells": (M.EquitySellRow, "Equity_Sells"),
    "mutual_funds": (M.MFRow, "MutualFunds"),
    "sip": (M.SIPRow, "MF_SIP"),
    "fixed_deposits": (M.FDRow, "FixedDeposits"),
    "ppf": (M.PPFRow, "PPF"),
    "ppf_ledger": (M.PPFLedgerRow, "PPF_Ledger"),
    "epf": (M.EPFRow, "EPF"),
    "bonds": (M.BondRow, "Bonds"),
    "bullion": (M.BullionRow, "Gold_Silver"),
    "nps": (M.NPSRow, "NPS"),
    "manual_assets": (M.ManualAssetRow, "Manual_Assets"),
    "by_scrip": (M.ScripRef, "By Scrip"),
    "corporate_actions": (M.CorporateAction, "Corporate_Actions"),
    "dividends": (M.DividendRow, "Dividends"),
    "tax_rules": (M.TaxRule, "Tax_Rules"),
    "import_map": (M.ImportMapRow, "Import_Map"),
    "imported_files": (M.ImportedFileRow, "Import_Map"),
    "history": (M.HistorySnapshot, "History"),
}

CAPACITY: dict[str, int] = {attr: last - M.FIRST_DATA_ROW + 1
                            for attr, last, _sheet in M.CAPACITIES}
CAPACITY.update({
    "by_scrip": M.BYSCRIP_LAST_ROW - M.FIRST_DATA_ROW + 1,
    "corporate_actions": M.CA_LAST_ROW - M.FIRST_DATA_ROW + 1,
    "dividends": M.DIV_LAST_ROW - M.FIRST_DATA_ROW + 1,
    "history": M.HISTORY_LAST_ROW - M.FIRST_DATA_ROW + 1,
})
