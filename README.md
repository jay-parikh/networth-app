# NetWorth web app (offline PWA for phones, iPad and desktop)

The NetWorth Excel tracker + `Update Portfolio` updater as an installable,
offline web app. It is hosted on Netlify; the data stays on the device.

**How it stays faithful to the Excel/exe:** the app runs the *actual* NetWorth
Python code (`vendor/networth`, v1.7.7 + the three changes in `vendor/PATCHES.md`) in the browser
with Pyodide (Python compiled to WebAssembly). Imports use the desktop reader,
updates use `networth.update.run()`, and exports use the desktop generator. An
exported file is the same workbook the desktop app writes: charts, dropdowns,
formulas, privacy mask/lock included.

## Layout

```
src/web/            the app: index.html, app.css, worker.js (Pyodide), sw.js, js/
src/py/webapp/      Python bridge: api.py (entry points), view.py (screen numbers =
                    the workbook's formulas evaluated in Python), codec.py (JSON)
src/py/shims/       a tiny `requests` stand-in routing GETs to the relay
site-extra/         netlify.toml + netlify/functions/fetch.mjs (market-data relay)
vendor/             NetWorth reference code + data, pure wheels, Pyodide subset
tools/build.py      -> dist/ (deployable) + networth-web.zip
tests/              see below
DEPLOY.md           deployment + install guide (ships inside the zip)
```

## Build

```
python3.12 tools/build.py        # needs Pillow for the icons
```

## Tests

| Test | What it proves |
|---|---|
| `tests/verify_formulas.py <xlsx>` | every number the app shows equals what Excel computes (an independent formula engine, `formulas`, evaluates the generated workbook); run with all classes on and off |
| `tests/test_source_patches.py` | the AMFI and IBJA fixes |
| `tests/test_split_bonus_switch.py` | the Settings switches "Splits & bonuses" / "Dividends" (PATCHES.md §3), with real NSE/BSE records |
| `tests/browser_test.js` | real Chromium: import your xlsx, every page, add/edit rows, live update via the relay, export, offline reload, iPad layout |
| `tests/browser_import_test.js` | CAS PDF (password) + broker tradebook import, idempotent re-import |
| `tests/browser_privacy_test.js` | mask, lock screen, encrypted device data, locked export/import |
| `tests/browser_settings_test.js` | one Update button, the two switches, Actions tab, the floating Add button on every list page |
| `tests/browser_search_fab_test.js` | the search box on long lists (filter, count, kept per page, sticky) and the draggable + button (tap vs drag, kept on screen, remembered) |
| `tests/browser_passkey_test.js` | unlock with Face ID / fingerprint (js/passkey.js): setup, unlock, cancel, mismatch, password change, Lock off - with a stand-in passkey; plus Chromium's real WebAuthn (no PRF → explained, not turned on) |
| `tests/pyhost.js` | runs the Python side under Node (Pyodide) for scripted checks |

The browser tests need `node tests/devserver.mjs [port] [--no-fn]`. It serves
`dist/public` and runs the real relay function; `--no-fn` imitates a
drag-and-drop deploy. On this VM use the Node 20 / Chromium 99 noted in
the session memory.
