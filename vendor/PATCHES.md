# Changes to the vendored NetWorth code

`vendor/networth` and `vendor/data` are NetWorth v1.7.7
(github.com/jay-parikh/NetWorth, commit 101f11d) with exactly the changes
below. Both fix live-data breakages found on 2026-10-25. They affect the
desktop `Update Portfolio` app too, so they belong upstream (with tests:
`tests/test_source_patches.py` here).

The full reference test suite (404 tests) passes with both patches.

## 1. AMFI NAVAll.txt layout change: `fetch/amfi.py`, `update.py`

AMFI's file now has 8 columns:
`Scheme Code;ISIN…;ISIN…;Scheme Name;Plan;Option;Net Asset Value;Date`.
The parser took fixed positions, so it read "Direct Plan" as the NAV, parsed
nothing, and `AMFI_MIN_SCHEMES` then rejected the feed. Fund NAVs stopped
updating.

- `amfi.parse` locates columns by header name. With Plan/Option columns it
  rebuilds the full scheme name as `<scheme> - <plan> - <option>`; the old
  6-column layout parses exactly as before.
- AMFI's names changed style too ("SBI Large Cap FUND-DIRECT PLAN -GROWTH" →
  "SBI Large Cap Fund - Direct Plan - Growth"). User rows find their ISIN by
  name, so `update._replace_mf_master` now keeps a *referenced* fund's old row
  as an alias whenever its name changed. New picks get the new names (the
  wholesale-refresh rule and `test_etf_lands_in_stock_master_on_a_bse_only_day`
  hold).

## 2. IBJA page redesign: `fetch/bullion.py`

ibjarates.com no longer has the `lblGold999_*` / `lblSilver999_*` spans, so
the IBJA rate was never found and every run fell back to the market-implied
rate. `parse_ibja` still tries the old spans first; when they are missing it
reads the new page's hidden inputs (`HdnGold` → `purity999` ₹/10 g,
`HdnSilver` → `silverRate` ₹/kg; the newest dated value), with the visible
`GoldRatesCompare999` (₹/g) as a gold fallback. Anything unexpected yields
nothing, as before.

## 3. Settings switches "Splits & bonuses" and "Dividends" (2026-10-27)

Asked for by the user after their holdings were entered the way the broker's
breakdown lists them (Zerodha shows split and bonus shares as their own
lines, at adjusted prices). NetWorth treats every Equity row as *as bought*
and adds splits/bonuses on top, so those rows were counted twice
(PRECWIRE 12,250 instead of 2,500; RECLTD 441.67 instead of 300).

- `model.py`: `PortfolioData.apply_split_bonus` / `fetch_dividends` (default
  True), Settings rows `SETTINGS_CA_ROW` (26) / `SETTINGS_DIV_ROW` (27), and
  `adjusting_actions(data)`: all actions, or without SPLIT / BONUS /
  CONSOLIDATION when the switch is off (mergers still convert shares).
- `reader.py` / `generate.py`: the two rows under "Update (optional)" on the
  Settings sheet; missing rows (older files) read as Yes. Readers that scan
  only to `SETTINGS_LOCK_ROW` (unpatched desktop v1.7.7) ignore them.
- `update.py`: Splits & bonuses off → the feed is still saved on
  Corporate_Actions as a record but no quantity changes, and the dividend
  share count uses the quantities as entered. Dividends off → the dividend
  feed is not used and the Dividends rows are left as they are. Both off →
  NSE/BSE are not asked at all (unless a merger/demerger needs verifying).
  The summary carries `split_bonus_off` / `dividends_off`.
- `compute/restructures.py`, `importers/merge.py`: demerger child quantities
  and the broker-holdings cross-check use `adjusting_actions` too.

Tests: `tests/test_split_bonus_switch.py` (real NSE/BSE records for both
stocks in `tests/fixtures/ca_precwire_recltd.json`). The 404-test reference
suite passes with all three patches.
