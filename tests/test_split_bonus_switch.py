"""Web patch 3 (2026-10-27): the Settings switches "Splits & bonuses" and
"Dividends" (vendor/PATCHES.md §3).

Uses the real NSE/BSE corporate-action records for PRECWIRE and RECLTD
(fixtures/ca_precwire_recltd.json, fetched 2026-10-27) and the user's lots as
the broker's holdings breakdown lists them. Broker totals: PRECWIRE 2,500,
RECLTD 300.

Run with pytest, with the patched `networth` package importable."""
import json
from datetime import date
from pathlib import Path

import pytest

from networth import model as M
from networth.fetch.amfi import AmfiData
from networth.fetch.bhavcopy import PriceData
from networth.fetch.corporate_actions import (
    dedupe, parse_bse_records, parse_dividend_records, parse_records)
from networth.generate import build_workbook
from networth.model import DividendRow, EquityRow
from networth.reader import read_workbook
from networth.sample_data import sample_portfolio
from networth.update import run

TODAY = date(2026, 10, 27)
PREC, REC = "INE372C01037", "INE020B01018"
FEED = json.loads((Path(__file__).parent / "fixtures" / "ca_precwire_recltd.json")
                  .read_text())

# what each lot was when bought (cost date, qty, price)
AS_BOUGHT = {
    PREC: [("2016-11-04", 250, 115.75), ("2016-11-21", 50, 105.70),
           ("2024-11-25", 2, 174.40), ("2024-11-25", 108, 174.45),
           ("2025-01-22", 140, 158.50)],
    REC: [("2016-04-06", 50, 159.08), ("2018-02-15", 100, 147.93),
          ("2020-03-09", 25, 109.30)],
}
# the broker's breakdown: split and bonus shares as their own lines, prices
# already adjusted (Zerodha "SPLIT", "BONUS" and "DISCREPANT" rows)
BROKER = {
    PREC: [("2016-11-04", 1000, 23.15), ("2016-11-04", 250, 23.15),
           ("2016-11-21", 200, 21.14), ("2016-11-21", 50, 21.14),
           ("2022-12-22", 750, 0.0), ("2024-11-25", 2, 174.40),
           ("2024-11-25", 108, 174.45), ("2025-01-22", 140, 158.50)],
    REC: [("2016-04-06", 50, 159.08), ("2016-09-28", 50, 0.0),
          ("2018-02-15", 100, 147.93), ("2020-03-09", 25, 109.30),
          ("2022-08-17", 75, 0.0)],
}


def _feed():
    acts, divs = [], []
    for sym, isin in (("PRECWIRE", PREC), ("RECLTD", REC)):
        f = FEED[sym]
        acts += dedupe(parse_records(f["nse"], isin, sym),
                       parse_bse_records(f["bse"], isin, sym))
        divs += parse_dividend_records(f["nse"], isin, sym)[0]
    return acts, divs


def _workbook(tmp_path, lots, *, split_bonus=True, dividends=True):
    data = sample_portfolio()
    name = {i: n for _s, n, i in data.masters.stock_rows}
    owner = data.persons[0]
    data.equity = [EquityRow(owner=owner, scrip=name[isin], qty=q, avg_cost=p,
                             cost_date=date.fromisoformat(d))
                   for isin, rows in lots.items() for d, q, p in rows]
    data.corporate_actions = []
    data.dividends = []
    data.apply_split_bonus = split_bonus
    data.fetch_dividends = dividends
    path = tmp_path / "wb.xlsx"
    build_workbook(data, str(path))
    return path


def _update(path, **kw):
    acts, divs = _feed()
    return run(path, price_data=PriceData(trade_date=TODAY, source="TEST"),
               amfi_data=AmfiData(), ca_data=acts, div_data=divs,
               restructures=[], today=TODAY, do_backup=False, **kw)


def _shares(data):
    isin_by_name = {n: i for _s, n, i in data.masters.stock_rows}
    out = {}
    for r in data.equity:
        isin = isin_by_name[r.scrip]
        out[isin] = out.get(isin, 0) + r.qty * (r.ca_factor or 1)
    return out


def test_feed_has_the_events_the_broker_shows():
    acts, _ = _feed()
    got = {(a.isin, a.type, a.ex_date.isoformat()): a.factor() for a in acts}
    assert got[(PREC, "SPLIT", "2021-12-22")] == 5.0
    assert got[(PREC, "BONUS", "2022-12-22")] == 1.5
    assert got[(REC, "BONUS", "2016-09-28")] == 2.0
    assert got[(REC, "BONUS", "2022-08-17")] == pytest.approx(4 / 3)


def test_on_with_lots_as_bought_matches_broker(tmp_path):
    path = _workbook(tmp_path, AS_BOUGHT)
    s = _update(path)
    assert "split_bonus_off" not in s
    sh = _shares(read_workbook(str(path)))
    assert sh[PREC] == pytest.approx(2500)
    assert sh[REC] == pytest.approx(300)


def test_on_with_broker_lines_double_counts(tmp_path):
    # the reported problem: the broker's lines already hold the split/bonus
    path = _workbook(tmp_path, BROKER)
    _update(path)
    sh = _shares(read_workbook(str(path)))
    assert sh[PREC] == pytest.approx(12250)
    assert sh[REC] == pytest.approx(441.6667, rel=1e-4)


def test_off_uses_broker_lines_as_entered(tmp_path):
    path = _workbook(tmp_path, BROKER, split_bonus=False)
    s = _update(path)
    assert s["split_bonus_off"] is True
    assert s["ca_adjusted_rows"] == 0
    back = read_workbook(str(path))
    assert _shares(back) == {PREC: pytest.approx(2500), REC: pytest.approx(300)}
    assert all(r.ca_factor is None for r in back.equity)
    # the actions are still on file, as a record
    assert {(a.isin, a.type) for a in back.corporate_actions} >= {
        (PREC, "SPLIT"), (PREC, "BONUS"), (REC, "BONUS")}
    assert back.apply_split_bonus is False


def test_off_dividend_count_uses_quantities_as_entered(tmp_path):
    path = _workbook(tmp_path, BROKER, split_bonus=False)
    _update(path)
    rows = [d for d in read_workbook(str(path)).dividends
            if d.isin == REC and d.ex_date == date(2026, 8, 14)]
    assert len(rows) == 1 and rows[0].qty == pytest.approx(300)
    assert rows[0].rate == pytest.approx(1.55)


def test_dividends_off_leaves_the_list_alone(tmp_path, monkeypatch):
    import networth.update as U
    path = _workbook(tmp_path, AS_BOUGHT, dividends=False)
    data = read_workbook(str(path))
    data.dividends = [DividendRow(fy="2026-27", owner=data.persons[0],
                                  scrip="REC LIMITED", isin=REC,
                                  div_type="Final", ex_date=date(2026, 8, 14),
                                  rate=9.99, qty=1, source="Manual")]
    build_workbook(data, str(path))
    acts, divs = _feed()
    monkeypatch.setattr(U.ca_mod, "fetch",
                        lambda *a, **kw: (acts, {PREC, REC}, divs, 0))
    s = run(path, price_data=PriceData(trade_date=TODAY, source="TEST"),
            amfi_data=AmfiData(), restructures=[], today=TODAY,
            do_backup=False)
    assert s["dividends_off"] is True
    back = read_workbook(str(path))
    assert [(d.rate, d.source) for d in back.dividends] == [(9.99, "Manual")]
    # splits & bonuses are still on: the feed was fetched and applied
    assert _shares(back)[PREC] == pytest.approx(2500)


def test_both_off_asks_the_exchanges_nothing(tmp_path, monkeypatch):
    import networth.update as U
    path = _workbook(tmp_path, BROKER, split_bonus=False, dividends=False)

    def boom(*a, **kw):
        raise AssertionError("corporate-actions feed must not be called")
    monkeypatch.setattr(U.ca_mod, "fetch", boom)
    s = run(path, price_data=PriceData(trade_date=TODAY, source="TEST"),
            amfi_data=AmfiData(), restructures=[], today=TODAY,
            do_backup=False)
    assert s["split_bonus_off"] and s["dividends_off"]
    assert _shares(read_workbook(str(path))) == {PREC: pytest.approx(2500),
                                                 REC: pytest.approx(300)}


def test_switches_round_trip_through_the_workbook(tmp_path):
    path = _workbook(tmp_path, AS_BOUGHT, split_bonus=False, dividends=False)
    back = read_workbook(str(path))
    assert (back.apply_split_bonus, back.fetch_dividends) == (False, False)
    path2 = _workbook(tmp_path, AS_BOUGHT)
    back2 = read_workbook(str(path2))
    assert (back2.apply_split_bonus, back2.fetch_dividends) == (True, True)


def test_older_workbook_without_the_rows_means_on(tmp_path):
    from openpyxl import load_workbook
    path = _workbook(tmp_path, AS_BOUGHT, split_bonus=False, dividends=False)
    wb = load_workbook(path)
    st = wb["Settings"]
    for r in (M.SETTINGS_CA_ROW - 1, M.SETTINGS_CA_ROW, M.SETTINGS_DIV_ROW):
        for c in "ABCDE":
            st[f"{c}{r}"].value = None
    wb.save(path)
    back = read_workbook(str(path))
    assert (back.apply_split_bonus, back.fetch_dividends) == (True, True)
