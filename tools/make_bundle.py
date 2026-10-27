"""Pack the Python side of the app into one zip that Pyodide unpacks at start.

Layout inside the zip (extracted to /home/pyodide/nw):
  src/networth/...   the unmodified NetWorth reference implementation (vendor/)
  src/webapp/...     our bridge: requests shim, view builder, worker API (src/py/)
  data/...           the reference implementation's bundled CSVs
  lib/...            pure-Python wheels Pyodide does not ship (openpyxl, ...)

model.DATA_DIR is resolved as <networth>/../../data, which is why src/ and data/
sit side by side exactly as in the repository.

usage: python make_bundle.py <out.zip>
"""
import os
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VENDOR = os.path.join(ROOT, "vendor")


def add_tree(z, src_dir, arc_prefix):
    for base, dirs, files in os.walk(src_dir):
        dirs[:] = sorted(d for d in dirs if d != "__pycache__")
        for f in sorted(files):
            if f.endswith(".pyc"):
                continue
            full = os.path.join(base, f)
            rel = os.path.relpath(full, src_dir)
            info = zipfile.ZipInfo(arc_prefix + "/" + rel.replace(os.sep, "/"),
                                   date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            with open(full, "rb") as fh:
                z.writestr(info, fh.read())


def add_wheel(z, whl):
    with zipfile.ZipFile(whl) as w:
        for name in sorted(w.namelist()):
            if name.endswith("/") or ".dist-info/" in name:
                continue
            info = zipfile.ZipInfo("lib/" + name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, w.read(name))


def main(out):
    with zipfile.ZipFile(out, "w") as z:
        add_tree(z, os.path.join(VENDOR, "networth"), "src/networth")
        add_tree(z, os.path.join(ROOT, "src", "py", "webapp"), "src/webapp")
        add_tree(z, os.path.join(ROOT, "src", "py", "shims"), "lib")
        add_tree(z, os.path.join(VENDOR, "data"), "data")
        wheels = os.path.join(VENDOR, "wheels")
        for f in sorted(os.listdir(wheels)):
            if f.endswith(".whl"):
                add_wheel(z, os.path.join(wheels, f))
    print(out, os.path.getsize(out))


if __name__ == "__main__":
    main(sys.argv[1])
