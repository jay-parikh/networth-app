"""The web worker's entry points. Every function takes/returns JSON-able
values (the worker passes strings across the Pyodide boundary).

All behaviour is delegated to the unmodified NetWorth reference
implementation (`networth` package):

  * Update  = networth.update.run() itself, with only its two file steps
              redirected: the workbook "read" hands over the in-memory
              portfolio and the "regenerate" step keeps the result in memory.
              Fetching, every computation, every warning are the original.
  * Import  = networth.reader.read_workbook (Excel) and the importers
              package (CAS PDF / broker CSV / XLSX), exactly as the exe.
  * Export  = networth.generate.build_workbook (+ crypto for the Lock), so the
              file the app hands back is the file the desktop updater writes.
"""
from __future__ import annotations

import contextlib
import copy
import io
import json
import sys
from datetime import date, timedelta
from pathlib import Path

import requests  # the shim in lib/requests

from networth import crypto
from networth import model as M
from networth import update as U
from networth.generate import build_workbook
from networth.reader import read_workbook

from . import codec
from . import view as V

WORK = Path("/tmp/nw")
WORK.mkdir(parents=True, exist_ok=True)

STATE: dict = {
    "data": None,          # PortfolioData
    "password": None,      # privacy password, kept for this session only
    "today": None,         # the device's local date, set by the app
    "pending": None,       # parsed import batches awaiting the user's answers
    "notices": [],         # reader warnings to show once after an import
}

# Warnings run() prints about the FILE's privacy state. The app keeps the
# mask/lock itself (on screen and in its own storage), so these describe a
# situation that does not exist here.
_PRIVACY_NOISE = (
    "privacy is switched on in Settings but no password is set",
    "Lock file is switched on but the password wasn't confirmed",
    "the file is now locked; backups made BEFORE locking",
    "the password didn't match",
    "older readable backup",
)


# What an offline run (import, no fetching) says about the feeds it skipped.
_OFFLINE_NOISE = ("price fetch failed", "AMFI fetch failed",
                  "corporate-actions fetch failed",
                  "corporate actions could NOT be verified",
                  "NPS NAV fetch failed", "gold/silver rate unavailable")


def _today() -> date:
    return date.fromisoformat(STATE["today"]) if STATE["today"] else date.today()


def _data() -> M.PortfolioData:
    if STATE["data"] is None:
        raise RuntimeError("no portfolio loaded")
    return STATE["data"]


def _out(obj) -> str:
    return json.dumps(obj, default=_json_default, ensure_ascii=False,
                      allow_nan=False)


def _json_default(o):
    try:
        return codec.to_jsonable(o)
    except TypeError:
        return str(o)


def _clean_floats(o):
    """NaN/inf cannot travel as JSON - Excel would show an error; we blank."""
    if isinstance(o, float):
        return o if o == o and o not in (float("inf"), float("-inf")) else None
    if isinstance(o, dict):
        return {k: _clean_floats(v) for k, v in o.items()}
    if isinstance(o, list):
        return [_clean_floats(v) for v in o]
    return o


# ------------------------------------------------------------ lifecycle ----

def set_today(iso: str) -> None:
    STATE["today"] = iso or None


def new_portfolio(kind: str) -> str:
    """'sample' = the shipped template's fictional family; 'empty' = no rows."""
    if kind == "sample":
        from networth.sample_data import sample_portfolio
        data = sample_portfolio()
    else:
        data = M.PortfolioData(persons=[], masters=M.load_masters(),
                               tax_rules=M.load_tax_rules())
    STATE["data"] = data
    STATE["password"] = None
    recompute()
    return dump_json()


def load_json(text: str) -> str:
    STATE["data"] = codec.load_portfolio(json.loads(text))
    return _out({"ok": True})


def dump_json() -> str:
    return json.dumps(codec.dump_portfolio(_data()), ensure_ascii=False,
                      separators=(",", ":"))


def get_view() -> str:
    data = _data()
    today = _today()
    rep = None
    if data.equity_sells or data.show_capital_gains:
        from networth.compute.capital_gains import capital_gains_report
        try:
            rep = capital_gains_report(data, today)
        except Exception as e:  # noqa: BLE001 - a report bug must not blank the app
            rep = None
            STATE["notices"].append(f"Capital gains report failed: {e}")
    v = V.build_view(data, today, capgains=rep)
    v["notices"] = list(STATE["notices"])
    return json.dumps(_clean_floats(v), default=_json_default,
                      ensure_ascii=False, allow_nan=False)


def clear_notices() -> None:
    STATE["notices"] = []


def get_masters() -> str:
    ms = _data().masters
    status = {isin: st for isin, (st, _d) in ms.stock_status.items()}
    return _out({
        "mf": [list(r) for r in ms.mf_rows],
        "stock": [list(r) + [status.get(r[2], "")] for r in ms.stock_rows],
        "nps": [list(r) for r in ms.nps_rows],
        "banks": [list(r) for r in M.load_banks()],
        "refreshed": {"mf": ms.mf_refreshed, "stock": ms.stock_refreshed,
                      "nps": ms.nps_refreshed},
    })


def get_guide() -> str:
    return _out(V.guide_rows())


# ------------------------------------------------------------ recompute ----

def recompute() -> None:
    """What the workbook would show after the user typed a change and ran
    the updater WITHOUT internet: the compute half of networth.update.run(),
    call for call, minus every fetch. Factors from the stored corporate
    actions, By Scrip sync, FY back-fill, FMV fallback, EPF/PPF rates and
    ledger accrual, XIRR and the FY-end estimate. (History snapshots are
    only taken by a real update, as in the desktop app.)"""
    from networth.compute.cashflows import compute_all_xirr, ppf_ledger_by_account
    from networth.compute.ppf import current_rate, load_ppf_rates, ppf_cashflows, ppf_value
    from networth.compute.projections import fy_expected_by_person
    from networth.compute.xirr import xirr

    data = _data()
    today = _today()
    isin_by_name = {name: isin for _s, name, isin in data.masters.stock_rows}
    adj_actions = M.adjusting_actions(data)    # Settings "Splits & bonuses"
    for row in data.equity:
        isin = row.isin_override or isin_by_name.get(row.scrip, "")
        anchor = M.qty_anchor(row)
        f = M.chained_adjustment_factor(isin, anchor, today, adj_actions)
        row.ca_factor = f if abs(f - 1.0) > 1e-9 else None
        cf = M.cost_adjustment_factor(isin, anchor, today, adj_actions)
        row.cost_factor = cf if abs(cf - 1.0) > 1e-9 else None
    U.sync_by_scrip(data, isin_by_name)
    for d in data.dividends:
        if not d.fy and d.ex_date:
            d.fy = M.fy_label(d.ex_date)
    # FMV 31-01-2018 fallback (SPEC §6.6) - same rule as run()
    try:
        fmv_by_isin, fmv_by_symbol = M.load_fmv()
    except OSError:
        fmv_by_isin, fmv_by_symbol = {}, {}
    symbol_by_isin = {isin: sym for sym, _n, isin in data.masters.stock_rows}
    for row in data.equity:
        if row.avg_cost is not None or not row.qty:
            continue
        if not row.cost_date or row.cost_date >= date(2018, 2, 1):
            continue
        isin = row.isin_override or isin_by_name.get(row.scrip, "")
        fmv = fmv_by_isin.get(isin) or fmv_by_symbol.get(symbol_by_isin.get(isin, ""))
        if fmv:
            if row.qty_asof:
                f = M.chained_adjustment_factor(isin, row.cost_date, row.qty_asof,
                                                data.corporate_actions)
                fmv = round(fmv / f, 4) if f > 0 else fmv
            row.avg_cost = fmv
            row.fmv_used = True
    if data.epf:
        try:
            rate = M.current_epf_rate()
            for r in data.epf:
                if r.rate is None:
                    r.rate = rate
        except OSError:
            pass
    rates = load_ppf_rates()
    led = ppf_ledger_by_account(data, today)
    for row in data.ppf:
        if row.rate is None:
            row.rate = current_rate(rates)
        deposits = led.get((row.owner, row.account_no))
        if deposits:
            bal, interest = ppf_value(deposits, rates, today)
            row.balance_today = round(bal, 2)
            row.interest_earned = round(interest, 2)
            row.xirr = xirr(ppf_cashflows(deposits, bal, today))
        else:
            row.balance_today = row.interest_earned = row.xirr = None
    data.xirr = compute_all_xirr(data, today)
    data.fy_expected = fy_expected_by_person(data, today)


# ---------------------------------------------------------------- edits ----

_CANON_METAL = {"gold": "Gold", "silver": "Silver", "sgb": "SGB"}
_CANON_CLASS = {lbl.casefold(): lbl for lbl in M.MANUAL_CLASS_LABELS}
_CANON_CLASS["real estate"] = "Property"


def _canon(data, row) -> None:
    """The reader's canonicalisation (v1.6.2), applied to app edits too."""
    owners = {p.casefold(): p for p in data.persons}
    for f in ("owner",):
        if hasattr(row, f) and isinstance(getattr(row, f), str):
            v = getattr(row, f).strip()
            setattr(row, f, owners.get(v.casefold(), v))
    if isinstance(row, M.BullionRow):
        row.metal_type = _CANON_METAL.get(row.metal_type.strip().casefold(),
                                          row.metal_type.strip())
    if isinstance(row, M.ManualAssetRow):
        row.asset_class = _CANON_CLASS.get(row.asset_class.strip().casefold(),
                                           row.asset_class.strip())
    for f in ("scrip", "scheme", "isin_override", "isin", "description"):
        if hasattr(row, f) and isinstance(getattr(row, f), str):
            setattr(row, f, getattr(row, f).strip())


def _row_from(cls, base: dict, values: dict):
    merged = {**base, **values}
    return codec.build(cls, merged)


def edit(op_json: str) -> str:
    """One user change. Ops:
      {op:'set'|'add', coll, i?, values}   add/replace a row (partial values)
      {op:'delete', coll, i}               remove a row
      {op:'move', coll, i, to}             reorder (rows are positions, §3.6)
      {op:'settings', values}              Dashboard/Settings inputs
      {op:'class', key, enabled?, target?} one Settings class row
      {op:'person_add', name} / {op:'person_rename', old, new} /
      {op:'person_delete', name} / {op:'person_move', name, to}
    Returns {ok, error?}. Recomputes afterwards."""
    op = json.loads(op_json)
    data = _data()
    kind = op.get("op")
    try:
        if kind in ("set", "add", "delete", "move"):
            coll = op["coll"]
            cls, _sheet = codec.COLLECTIONS[coll]
            rows = getattr(data, coll)
            if kind == "add":
                cap = codec.CAPACITY.get(coll)
                if cap is not None and len(rows) >= cap:
                    return _out({"ok": False, "error":
                                 f"This list is full ({cap} rows - the Excel "
                                 "sheet's limit). Delete an old row first."})
                row = _row_from(cls, {}, op.get("values") or {})
                _canon(data, row)
                rows.append(row)
            elif kind == "set":
                i = int(op["i"])
                row = _row_from(cls, codec.to_jsonable(rows[i]), op.get("values") or {})
                _canon(data, row)
                rows[i] = row
            elif kind == "delete":
                del rows[int(op["i"])]
            else:
                r = rows.pop(int(op["i"]))
                rows.insert(int(op["to"]), r)
        elif kind == "settings":
            v = op.get("values") or {}
            for key in ("inflation_pct", "expected_return_pct", "drift_tolerance_pct"):
                if key in v and v[key] not in (None, ""):
                    setattr(data, key, float(v[key]))
            for key in ("show_references", "show_capital_gains",
                        "apply_split_bonus", "fetch_dividends"):
                if key in v:
                    setattr(data, key, bool(v[key]))
        elif kind == "class":
            s = data.class_settings.setdefault(op["key"], M.ClassSetting())
            if "enabled" in op:
                s.enabled = bool(op["enabled"])
            if "target" in op:
                t = op["target"]
                s.target_pct = None if t in (None, "") else float(t)
        elif kind == "tax_rule":
            # The screen shows the MERGED rules (bundled defaults + the
            # user's rows, §3.22). An edit upserts the user's row by
            # (asset, applies-from); a delete removes the user's row - a
            # shipped default then shows again, exactly as in the workbook.
            old = op.get("old")
            if old:
                a, d = old[0].casefold(), codec._parse_date(old[1])
                data.tax_rules = [t for t in data.tax_rules
                                  if not ((t.asset or "").casefold() == a
                                          and t.effective_from == d)]
            if op.get("values") is not None:
                t = _row_from(M.TaxRule, {}, op["values"])
                t.asset = (t.asset or "").strip().casefold()
                data.tax_rules.append(t)
        elif kind == "person_add":
            name = (op.get("name") or "").strip()
            if not name:
                return _out({"ok": False, "error": "Type a name."})
            if name.casefold() in {p.casefold() for p in data.persons}:
                return _out({"ok": False, "error": f"{name} is already in the family list."})
            if len(data.persons) >= 10:
                return _out({"ok": False, "error": "The Dashboard holds at most 10 people."})
            if not M.is_person_label(name):
                return _out({"ok": False, "error": f"'{name}' is a heading name in the "
                             "workbook - please choose another name."})
            data.persons.append(name)
        elif kind == "person_rename":
            old, new = op["old"], (op.get("new") or "").strip()
            if not new:
                return _out({"ok": False, "error": "Type a name."})
            if new.casefold() != old.casefold() and new.casefold() in {
                    p.casefold() for p in data.persons}:
                return _out({"ok": False, "error": f"{new} is already in the family list."})
            if not M.is_person_label(new):
                return _out({"ok": False, "error": f"'{new}' is a heading name in the "
                             "workbook - please choose another name."})
            data.persons = [new if p == old else p for p in data.persons]
            _rename_owner(data, old, new)
        elif kind == "person_delete":
            data.persons = [p for p in data.persons if p != op["name"]]
        elif kind == "person_move":
            p = op["name"]
            data.persons.remove(p)
            data.persons.insert(int(op["to"]), p)
        else:
            return _out({"ok": False, "error": f"unknown edit {kind}"})
    except (ValueError, KeyError, IndexError, TypeError) as e:
        return _out({"ok": False, "error": f"That value can't be saved: {e}"})
    recompute()
    return _out({"ok": True})


def _rename_owner(data, old: str, new: str) -> None:
    """Renaming a person on the Dashboard is a rename everywhere their name
    is the Owner - in Excel the user would retype each Owner cell; the app
    does it for them (same casefold match SUMIFS uses)."""
    for coll in codec.COLLECTIONS:
        for row in getattr(data, coll):
            if hasattr(row, "owner") and (row.owner or "").casefold() == old.casefold():
                row.owner = new
    if old in data.fy_expected:
        data.fy_expected[new] = data.fy_expected.pop(old)


# -------------------------------------------------------------- privacy ----

def privacy_set_password(pw: str) -> str:
    if len(pw or "") < 4:
        return _out({"ok": False, "error": "Use at least 4 characters."})
    _data().privacy_hash = crypto.hash_password(pw)
    STATE["password"] = pw
    return _out({"ok": True})


def privacy_verify(pw: str) -> str:
    ok = bool(pw) and crypto.verify_password(pw, _data().privacy_hash)
    if ok:
        STATE["password"] = pw
    return _out({"ok": ok})


def privacy_set(mask: bool, lock: bool) -> str:
    data = _data()
    if (mask or lock) and not data.privacy_hash:
        return _out({"ok": False, "error": "Set a password first."})
    if lock and not STATE["password"]:
        return _out({"ok": False, "error": "Type your password first."})
    data.privacy_enabled = bool(mask)
    data.lock_enabled = bool(lock)
    return _out({"ok": True})


def privacy_reset() -> str:
    """RESET (SPEC §3.19): mask off, fingerprint cleared - only while the
    Lock is off (a locked store can't be opened without the password)."""
    data = _data()
    if data.lock_enabled:
        return _out({"ok": False, "error": "The Lock is on - it has no reset."})
    data.privacy_enabled = False
    data.privacy_hash = ""
    STATE["password"] = None
    return _out({"ok": True})


def privacy_forget() -> None:
    STATE["password"] = None


# --------------------------------------------------------- excel in/out ----

def inspect_xlsx(path: str) -> str:
    return _out({"encrypted": crypto.is_encrypted(path)})


def import_xlsx(path: str, password: str = "") -> str:
    """Read a NetWorth workbook (any version the desktop reader accepts)."""
    try:
        if crypto.is_encrypted(path):
            if not password:
                return _out({"ok": False, "needs_password": True})
            try:
                src = crypto.decrypt_workbook(path, password)
            except crypto.WrongPassword:
                return _out({"ok": False, "needs_password": True,
                             "error": "That password doesn't open this file."})
            data = read_workbook(src)
        else:
            data = read_workbook(path)
    except Exception as e:  # noqa: BLE001
        return _out({"ok": False, "error": "This doesn't look like a NetWorth "
                     f"tracker workbook ({e.__class__.__name__}: {e})"})
    if not data.persons and not data.equity and not data.sip and not data.masters.mf_rows:
        return _out({"ok": False, "error": "No portfolio found in this file - is it "
                     "the Family_Portfolio_Tracker workbook?"})
    if not data.masters.mf_rows or not data.masters.stock_rows:
        seed = M.load_masters()
        data.masters.mf_rows = data.masters.mf_rows or seed.mf_rows
        data.masters.stock_rows = data.masters.stock_rows or seed.stock_rows
        data.masters.nps_rows = data.masters.nps_rows or seed.nps_rows
    STATE["data"] = data
    STATE["notices"] = list(data.warnings)
    STATE["password"] = password or None
    if data.privacy_hash and password and not crypto.verify_password(
            password, data.privacy_hash):
        # the file's open-password differs from the stored mask fingerprint
        STATE["password"] = password
    recompute()
    return _out({"ok": True, "warnings": data.warnings,
                 "persons": data.persons,
                 "privacy": {"mask": data.privacy_enabled, "lock": data.lock_enabled,
                             "has_password": bool(data.privacy_hash)},
                 "counts": {c: len(getattr(data, c)) for c in codec.COLLECTIONS}})


def export_xlsx(path: str, unmasked: bool = False) -> str:
    """Build the workbook with the reference generator. Masked/locked per
    the Settings switches, like the desktop updater writes it."""
    data = _data()
    today = _today()
    mask_active = data.privacy_enabled and bool(data.privacy_hash)
    lock_active = data.lock_enabled and bool(data.privacy_hash)
    pw = STATE["password"]
    if lock_active and not pw:
        return _out({"ok": False, "needs_password": True,
                     "error": "Type your password to export a locked file."})
    masked = mask_active and not (unmasked and pw and crypto.verify_password(
        pw, data.privacy_hash))
    rep = None
    if data.equity_sells or data.show_capital_gains:
        from networth.compute.capital_gains import capital_gains_report
        rep = capital_gains_report(data, today)
    try:
        U._refuse_overfull(data)
    except SystemExit:
        return _out({"ok": False, "error": "A list holds more rows than its Excel "
                     "sheet can save - delete some rows first."})
    buf = io.BytesIO()
    if data.privacy_enabled or data.lock_enabled:
        data.masked_at_rest = masked
    build_workbook(data, buf, masked=masked, today=today, capgains=rep)
    out = buf.getvalue()
    if lock_active:
        out = crypto.encrypt_workbook(out, pw)
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_bytes(out)
    return _out({"ok": True, "masked": masked, "locked": lock_active,
                 "size": len(out)})


# --------------------------------------------------------------- update ----

@contextlib.contextmanager
def _in_memory_run(data):
    """Point update.run()'s two file steps at memory: the workbook read
    returns `data`, the regenerate step keeps what it was handed."""
    path = WORK / M.TEMPLATE_FILENAME
    path.write_bytes(b"in-memory")          # ensure_closed() opens it
    captured: dict = {}
    saved = (U.read_workbook, U._regenerate_atomic, U._purge_unmasked_backups)

    def fake_read(_src):
        return data

    def fake_regen(_path, data_, **kw):
        captured["data"] = data_
        captured["capgains"] = kw.get("capgains")

    U.read_workbook = fake_read
    U._regenerate_atomic = fake_regen
    U._purge_unmasked_backups = lambda *a, **k: 0
    try:
        yield path, captured
    finally:
        U.read_workbook, U._regenerate_atomic, U._purge_unmasked_backups = saved


def _run(online: bool, **kw) -> dict:
    data = copy.deepcopy(_data())
    data.warnings = []
    requests.online = online
    err = io.StringIO()
    try:
        with _in_memory_run(data) as (path, captured), \
                contextlib.redirect_stderr(err):
            summary = U.run(path, password=STATE["password"], do_backup=False,
                            today=_today(), **kw)
    except SystemExit:
        msg = err.getvalue().replace("ERROR:", "").strip()
        return {"ok": False, "error": msg or "The update stopped."}
    finally:
        requests.online = True
    if "data" not in captured:
        return {"ok": False, "error": "The update did not finish."}
    STATE["data"] = captured["data"]
    summary["warnings"] = [w for w in summary.get("warnings", [])
                           if not any(n in w for n in _PRIVACY_NOISE)]
    for k in ("backup", "workbook", "privacy"):
        summary.pop(k, None)
    return {"ok": True, "summary": summary}


def run_update() -> str:
    """Update Portfolio: fetch AMFI/BSE/NSE/NPS/IBJA + corporate actions and
    recompute everything - networth.update.run()."""
    return _out(_clean_floats(_run(online=True)))


# --------------------------------------------------------------- import ----

def parse_imports(files_json: str) -> str:
    """Step 1 of a statement/broker import (SPEC §6.17): parse each file and
    return the preview and the questions the desktop updater would ask.
    files = [{path, name, password?}]"""
    from networth.importers import detect_format
    from networth.importers.cams import looks_like_cas
    from networth.importers.cams import parse as cas_parse
    from networth.importers.merge import _validate_fund
    from networth.importers.pdftext import NeedsPassword, WrongPassword, extract_text

    data = _data()
    today = _today()
    files = json.loads(files_json)
    known = {f.fingerprint for f in data.imported_files}
    results, batches = [], []
    for f in files:
        p = Path(f["path"])
        name = f.get("name") or p.name
        fp = U._fingerprint(p)
        res = {"name": name, "fingerprint": fp, "already": fp in known}
        try:
            kind, payload = detect_format(p, with_payload=True)
        except Exception as e:  # noqa: BLE001
            kind, payload = None, None
            res["error"] = f"couldn't be read ({e.__class__.__name__})"
        if kind is None:
            res.setdefault("error", "not recognised - only the CAMS/KFintech fund "
                           "statement (PDF) and broker tradebook/holdings files "
                           "(CSV or Excel) can be imported")
            results.append(res)
            continue
        res["kind"] = kind
        batch = None
        if kind == "cas":
            try:
                text = extract_text(p, f.get("password") or None)
            except NeedsPassword:
                res["needs_password"] = True
                results.append(res)
                continue
            except WrongPassword:
                res["needs_password"] = True
                res["error"] = "that password doesn't open it"
                results.append(res)
                continue
            except Exception as e:  # noqa: BLE001
                res["error"] = f"the file couldn't be read - it may be damaged ({e.__class__.__name__})"
                results.append(res)
                continue
            if not looks_like_cas(text):
                res["error"] = ("doesn't look like a CAMS/KFintech statement - only the "
                                "consolidated fund statement (CAS) is supported for PDFs")
                results.append(res)
                continue
            try:
                batch = cas_parse(text, today, name)
            except ValueError as e:
                res["error"] = str(e)
        else:
            batch, reason = U._parse_candidate(p, kind, today, False, payload=payload)
            if batch is None:
                res["error"] = reason
        if batch is None:
            results.append(res)
            continue
        if any(not a for a, _h in batch.accounts):
            for t in batch.trades:
                t.account = t.account or name
            for h in batch.holdings:
                h.account = h.account or name
            batch.accounts = sorted({(a or name, hint) for a, hint in batch.accounts})
        batch.fingerprint = fp
        # the preview: per fund, does it prove itself against the closing balance?
        funds = {}
        for t in batch.sip_txns:
            funds.setdefault((t.folio, t.isin), []).append(t)
        lines = []
        for (folio, isin), txns in sorted(funds.items()):
            txns.sort(key=lambda t: (t.txn_date or today))
            reason = _validate_fund(txns, batch.closing_units.get((folio, isin)), today)
            lines.append({
                "name": txns[0].scheme_name or isin, "folio": folio, "isin": isin,
                "txns": len(txns),
                "invested": sum(t.amount or 0 for t in txns if (t.amount or 0) > 0),
                "units": sum(t.units or 0 for t in txns),
                "ok": not reason, "reason": reason,
                "checked": (folio, isin) in batch.closing_units})
        res["funds"] = lines
        res["trades"] = {"buys": sum(1 for t in batch.trades if t.side == "BUY"),
                         "sells": sum(1 for t in batch.trades if t.side == "SELL"),
                         "stocks": len({t.isin or t.symbol for t in batch.trades})}
        res["holdings"] = {
            "funds": sum(1 for h in batch.holdings if (h.isin or "").upper().startswith("INF")),
            "shares": sum(1 for h in batch.holdings if not (h.isin or "").upper().startswith("INF"))}
        res["warnings"] = list(batch.warnings)
        res["ok"] = True
        results.append(res)
        batches.append((name, fp, batch))
    STATE["pending"] = batches

    stored = {m.account: m.owner for m in data.import_map
              if m.owner.casefold() in {p.casefold() for p in data.persons}}
    accounts = []
    seen = set()
    for _n, _fp, b in batches:
        for account, hint in b.accounts:
            if account in seen:
                continue
            seen.add(account)
            guess = stored.get(account) or next(
                (per for per in data.persons if hint and per.casefold() in hint.casefold()), "")
            accounts.append({"account": account, "hint": hint, "source": b.source,
                             "owner": guess, "stored": account in stored})
    openings = []
    for _n, _fp, b in batches:
        net, names = {}, {}
        for t in b.trades:
            if t.side not in ("BUY", "SELL") or not t.isin:
                continue
            k = (t.account, t.isin)
            net[k] = net.get(k, 0.0) + (t.qty if t.side == "SELL" else -t.qty)
            names.setdefault(k, t.symbol or t.isin)
        for (account, isin), n in sorted(net.items()):
            if n > 0:
                openings.append({"account": account, "ident": isin, "name": names[(account, isin)],
                                 "kind": "uncovered_sell", "qty": n})
        for h in b.holdings:
            if h.avg_cost is not None or not h.qty:
                continue
            ident = h.isin or (h.name or "").upper().strip()
            if ident:
                openings.append({"account": h.account, "ident": ident, "name": h.name or h.isin,
                                 "kind": "no_cost", "qty": h.qty})
    sip_new = sum(len(b.sip_txns) for _n, _fp, b in batches)
    sip_cap = M.SIP_LAST_ROW - M.FIRST_DATA_ROW + 1
    return _out(_clean_floats({
        "files": results, "accounts": accounts, "openings": openings,
        "persons": data.persons,
        "may_overflow": bool(sip_new and len(data.sip) + sip_new > sip_cap),
        "sip_used": len(data.sip), "sip_new": sip_new, "sip_cap": sip_cap,
        "cg_on": data.show_capital_gains}))


def commit_imports(answers_json: str) -> str:
    """Step 2: write the parsed files in, with the user's answers -
    networth.update.run(import_batches=...) without fetching, so only the
    import (plus the usual recalculation) happens."""
    a = json.loads(answers_json)
    pending = STATE["pending"] or []
    if not pending:
        return _out({"ok": False, "error": "Nothing to import - pick the files again."})
    owner_map = {k: v for k, v in (a.get("owners") or {}).items() if v}
    openings = set()
    for o in a.get("openings") or []:
        owner = owner_map.get(o["account"]) or next(
            (m.owner for m in _data().import_map if m.account == o["account"]), "")
        if owner:
            openings.add((owner, o["ident"]))
    decisions = [(n, fp, "imported") for n, fp, _b in pending]
    res = _run(online=bool(a.get("online")),
               import_batches=[b for _n, _fp, b in pending],
               import_owner_map=owner_map,
               import_replace=a.get("mode", "replace") == "replace",
               import_decisions=decisions,
               import_openings=openings,
               import_condense=bool(a.get("condense")))
    if res.get("ok"):
        STATE["pending"] = None
        if not a.get("online"):
            res["summary"].pop("bullion", None)    # no rates were fetched
            res["summary"]["warnings"] = [
                w for w in res["summary"]["warnings"]
                if not w.startswith(_OFFLINE_NOISE)]
    return _out(_clean_floats(res))
