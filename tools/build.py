"""Build the deployable site.

    python tools/build.py            -> dist/ (+ dist.zip)

dist/
  public/                 the website (Netlify "publish directory")
    index.html, app.css, js/, worker.js, sw.js, manifest.webmanifest, icons/
    py/nw-bundle.zip      NetWorth Python code + bundled data + pure wheels
    pyodide/              the Python runtime (only the pieces the app uses)
    _redirects, _headers  Netlify rules (the /px/ relay works even on Drop)
  netlify/functions/fetch.mjs   market-data relay (Git / CLI deploys)
  netlify.toml
  DEPLOY.md

Needs Pillow for the icons (falls back to keeping existing icons).
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import zipfile
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, "src", "web")
DIST = os.path.join(ROOT, "dist")
PUB = os.path.join(DIST, "public")

# public data hosts the relay may fetch (keep in sync with fetch.mjs ALLOWED)
PX_HOSTS = {
    "www.amfiindia.com": "https://portal.amfiindia.com",   # 302s there anyway
    "portal.amfiindia.com": "https://portal.amfiindia.com",
    "www.bseindia.com": "https://www.bseindia.com",
    "api.bseindia.com": "https://api.bseindia.com",
    "www.nseindia.com": "https://www.nseindia.com",
    "nsearchives.nseindia.com": "https://nsearchives.nseindia.com",
    "archives.nseindia.com": "https://archives.nseindia.com",
    "npstrust.org.in": "https://npstrust.org.in",
    "npscra.nsdl.co.in": "https://npscra.nsdl.co.in",
    "www.ibjarates.com": "https://www.ibjarates.com",
    "raw.githubusercontent.com": "https://raw.githubusercontent.com",
    "api.github.com": "https://api.github.com",
}


def icons(out):
    os.makedirs(out, exist_ok=True)
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        print("Pillow missing - icons not regenerated")
        return

    def draw(size, pad_frac, rounded):
        s = size * 4
        img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        bg = (31, 78, 121, 255)
        if rounded:
            d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.22), fill=bg)
        else:
            d.rectangle([0, 0, s, s], fill=bg)
        pad = s * pad_frac
        inner = s - 2 * pad
        # three rising bars + a trend line: "your money, growing"
        bw = inner * 0.18
        gap = inner * 0.11
        base = pad + inner * 0.86
        heights = [0.34, 0.52, 0.74]
        x = pad + (inner - (3 * bw + 2 * gap)) / 2
        tops = []
        for h in heights:
            top = base - inner * h
            d.rounded_rectangle([x, top, x + bw, base], radius=bw * 0.28,
                                fill=(255, 255, 255, 235))
            tops.append((x + bw / 2, top - inner * 0.08))
            x += bw + gap
        d.line(tops, fill=(126, 209, 166, 255), width=int(inner * 0.045), joint="curve")
        for cx, cy in tops:
            r = inner * 0.04
            d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(126, 209, 166, 255))
        return img.resize((size, size), Image.LANCZOS)

    draw(192, 0.16, True).save(os.path.join(out, "icon-192.png"))
    draw(512, 0.16, True).save(os.path.join(out, "icon-512.png"))
    draw(512, 0.24, False).save(os.path.join(out, "icon-maskable-512.png"))
    draw(180, 0.16, False).convert("RGB").save(os.path.join(out, "apple-touch-icon.png"))


def manifest():
    return {
        "name": "NetWorth - family portfolio",
        "short_name": "NetWorth",
        "description": "Family net-worth tracker that works offline; your data stays on your device.",
        "start_url": "./",
        "scope": "./",
        "display": "standalone",
        "orientation": "any",
        "background_color": "#f6f6f4",
        "theme_color": "#1f4e79",
        "icons": [
            {"src": "icons/icon-192.png", "sizes": "192x192", "type": "image/png"},
            {"src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png"},
            {"src": "icons/icon-maskable-512.png", "sizes": "512x512", "type": "image/png",
             "purpose": "maskable"},
        ],
    }


# the Netlify CLI's link to the user's site lives in dist/ - never delete it
KEEP = (".netlify", ".gitignore")


def main():
    if os.path.isdir(DIST):
        for name in os.listdir(DIST):
            if name in KEEP:
                continue
            p = os.path.join(DIST, name)
            shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)
    os.makedirs(PUB)
    # web sources
    for name in ("app.css", "worker.js"):
        shutil.copy2(os.path.join(WEB, name), PUB)
    shutil.copytree(os.path.join(WEB, "js"), os.path.join(PUB, "js"))
    # python bundle
    os.makedirs(os.path.join(PUB, "py"))
    subprocess.check_call([sys.executable, os.path.join(ROOT, "tools", "make_bundle.py"),
                           os.path.join(PUB, "py", "nw-bundle.zip")])
    # pyodide subset
    shutil.copytree(os.path.join(ROOT, "vendor", "pyodide"), os.path.join(PUB, "pyodide"),
                    ignore=shutil.ignore_patterns("SOURCE.txt"))
    icons(os.path.join(PUB, "icons"))
    with open(os.path.join(PUB, "manifest.webmanifest"), "w") as f:
        json.dump(manifest(), f, indent=2)
    # netlify rules
    with open(os.path.join(PUB, "_redirects"), "w") as f:
        f.write("# Market-data relay for deploys WITHOUT functions (e.g. Netlify Drop):\n"
                "# /px/<host>/<path> is proxied server-side to https://<host>/<path>.\n")
        for host, target in PX_HOSTS.items():
            f.write(f"/px/{host}/*  {target}/:splat  200\n")
    with open(os.path.join(PUB, "_headers"), "w") as f:
        f.write("/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: same-origin\n"
                "  Permissions-Policy: camera=(), microphone=(), geolocation=()\n"
                "/sw.js\n  Cache-Control: no-cache\n"
                "/index.html\n  Cache-Control: no-cache\n"
                "/pyodide/*\n  Cache-Control: public, max-age=31536000, immutable\n")
    # version = hash of everything shipped
    files = []
    for base, _dirs, names in os.walk(PUB):
        for n in names:
            rel = os.path.relpath(os.path.join(base, n), PUB).replace(os.sep, "/")
            if n.startswith("_"):
                continue
            files.append(rel)
    files.sort()
    h = hashlib.sha256()
    for rel in files:
        h.update(rel.encode())
        with open(os.path.join(PUB, rel), "rb") as fh:
            h.update(fh.read())
    with open(os.path.join(WEB, "index.html"), encoding="utf-8") as fh:
        index = fh.read()
    h.update(index.encode())
    with open(os.path.join(WEB, "sw.js"), encoding="utf-8") as fh:
        sw_src = fh.read()
    h.update(sw_src.encode())
    version = h.hexdigest()[:10]
    build = f"{datetime.now(timezone.utc):%Y-%m-%d} · {version}"
    with open(os.path.join(PUB, "index.html"), "w", encoding="utf-8") as fh:
        fh.write(index.replace("__BUILD__", build))
    precache = ["./", "index.html"] + [f for f in files if f != "index.html"]
    with open(os.path.join(PUB, "sw.js"), "w", encoding="utf-8") as fh:
        fh.write(sw_src.replace("'__VERSION__'", json.dumps(version))
                 .replace("__FILES__", json.dumps(precache, indent=0)))
    # functions + config + docs
    shutil.copytree(os.path.join(ROOT, "site-extra", "netlify"), os.path.join(DIST, "netlify"))
    shutil.copy2(os.path.join(ROOT, "site-extra", "netlify.toml"), DIST)
    shutil.copy2(os.path.join(ROOT, "DEPLOY.md"), DIST)
    # zip of the whole deployable folder
    zpath = os.path.join(ROOT, "networth-web.zip")
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        for base, dirs, names in os.walk(DIST):
            if base == DIST:
                dirs[:] = [d for d in dirs if d not in KEEP]
                names = [n for n in names if n not in KEEP]
            for n in sorted(names):
                full = os.path.join(base, n)
                z.write(full, os.path.join("networth-web", os.path.relpath(full, DIST)))
    size = sum(os.path.getsize(os.path.join(PUB, f)) for f in files)
    print(f"built {DIST}  version {version}  {len(files)} files  {size / 1e6:.1f} MB")
    print(f"zip   {zpath}  {os.path.getsize(zpath) / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
