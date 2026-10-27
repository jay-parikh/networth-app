"""The 2026-10-25 patch to the vendored reference code: AMFI's NAVAll.txt
gained Plan/Option columns, and renamed schemes must not orphan user rows.

Run with pytest, with the patched `networth` package importable."""
from networth.fetch import amfi
from networth.update import _replace_mf_master

NEW = """Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date

Open Ended Schemes(Equity Scheme - Flexi Cap Fund)

PPFAS Mutual Fund

122639;INF879O01027;-;Parag Parikh Flexi Cap Fund;Direct Plan;Growth;88.9695;23-Oct-2026
119598;INF200K01QX4;-;SBI Large Cap Fund;Direct Plan;Growth;96.9993;23-Oct-2026
100001;INF000X01AA1;INF000X01AB9;Some Fund;Regular Plan;IDCW;12.5;23-Oct-2026
100002;INF000X01AC7;-;Broken Fund;Direct Plan;Growth;N.A.;23-Oct-2026
"""

OLD = """Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Net Asset Value;Date

PPFAS Mutual Fund
122639;INF879O01027;-;Parag Parikh Flexi Cap Fund - Direct Plan - Growth;88.9695;23-Oct-2026
"""


def test_new_layout_reads_navs_and_full_names():
    d = amfi.parse(NEW)
    assert d.nav_by_isin["INF879O01027"] == 88.9695
    assert d.nav_by_isin["INF000X01AB9"] == 12.5          # reinvestment ISIN too
    assert "INF000X01AC7" not in d.nav_by_isin           # N.A. skipped
    names = {i: n for _h, n, i in d.master_rows}
    assert names["INF879O01027"] == "Parag Parikh Flexi Cap Fund - Direct Plan - Growth"
    assert names["INF000X01AA1"] == "Some Fund - Regular Plan - IDCW"
    assert d.nav_date == "23-Oct-2026"


def test_old_layout_still_reads():
    d = amfi.parse(OLD)
    assert d.nav_by_isin == {"INF879O01027": 88.9695}
    assert d.master_rows[0][1] == "Parag Parikh Flexi Cap Fund - Direct Plan - Growth"


def test_renamed_referenced_fund_keeps_its_old_name_as_alias():
    existing = [("SBI Mutual Fund", "SBI Large Cap FUND-DIRECT PLAN -GROWTH", "INF200K01QX4"),
                ("X", "Unheld Old Name", "INF000X01AA1")]
    fetched = [("SBI Mutual Fund", "SBI Large Cap Fund - Direct Plan - Growth", "INF200K01QX4"),
               ("X", "Some Fund - Regular Plan - IDCW", "INF000X01AA1")]
    merged = _replace_mf_master(existing, fetched, referenced={"INF200K01QX4"})
    by_name = {n: i for _h, n, i in merged}
    # the user's typed name still resolves, the new name is pickable too
    assert by_name["SBI Large Cap FUND-DIRECT PLAN -GROWTH"] == "INF200K01QX4"
    assert by_name["SBI Large Cap Fund - Direct Plan - Growth"] == "INF200K01QX4"
    # nobody holds the other fund: the wholesale refresh replaces its name
    assert "Unheld Old Name" not in by_name
    assert [n for _h, n, _i in merged] == sorted((n for _h, n, _i in merged), key=str.casefold)


# ---- IBJA (bullion) - the 2026 page redesign -------------------------------

from networth.fetch import bullion  # noqa: E402

IBJA_2026 = (
    '<span id="GoldRatesCompare999">14163</span> <span class="gm">(1 Gram)</span>'
    '<input type="hidden" name="HdnGold" id="HdnGold" value="{&quot;labels&quot;:'
    '[&quot;21/10/2026&quot;,&quot;22/10/2026&quot;,&quot;23/10/2026&quot;],'
    '&quot;purity999&quot;:[144105,142694,141630],&quot;purity916&quot;:[132000,130708,129733]}" />'
    '<input type="hidden" name="HdnSilver" id="HdnSilver" value="{&quot;labels&quot;:'
    '[&quot;21/10/2026&quot;,&quot;22/10/2026&quot;,&quot;23/10/2026&quot;],'
    '&quot;silverRate&quot;:[206783,199777,194415]}" />')


def test_ibja_2026_layout_reads_newest_rates_per_gram():
    assert bullion.parse_ibja(IBJA_2026) == {"gold": 14163.0, "silver": 194.41}


def test_ibja_old_spans_still_win():
    old = '<span id="lblGold999_PM">72,500</span><span id="lblSilver999_PM">88,000</span>'
    assert bullion.parse_ibja(old + IBJA_2026) == {"gold": 7250.0, "silver": 88.0}


def test_ibja_garbage_gives_nothing():
    assert bullion.parse_ibja("<html>maintenance</html>") == {}
    assert bullion.parse_ibja('<input id="HdnGold" value="not json" />') == {}
