"""Test files for the statement import: a password-protected CAS-like PDF
(the reference test-suite's CAS text, AES-256 like real CAMS statements,
password ABCDE1234F) and a Zerodha tradebook CSV. Fictional data."""
import os
import sys

from pypdf import PdfReader, PdfWriter

OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)
CAS = """Consolidated Account Statement
CAMS + KFintech
01-Jan-2015 To 18-Jul-2026

AMIT KUMAR
email@example.com

XYZ123 - Parag Parikh Flexi Cap Fund - Direct Plan - Growth (Advisor: ARN-0000)  ISIN: INF879O01027
Folio No: 12345678 / 90
PAN: ABCDE1234F   KYC: OK
Opening Unit Balance: 0.000
01-Jan-2024      Purchase - Systematic                 10,000.00      200.0000      50.0000       200.000
01-Jan-2024      *** Stamp Duty ***                         0.50
05-Feb-2024      Purchase                               10,000.00      196.0784      51.0000       396.078
10-Mar-2024      Redemption                            (5,100.00)     (100.0000)     51.0000       296.078
Closing Unit Balance: 296.078   NAV on 18-Jul-2026: INR 95.50
""".splitlines()


def mini_pdf(lines, path):
    def esc(s):
        return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    stream = ("BT /F1 7 Tf 20 800 Td " + " ".join(
        f"({esc(ln)}) Tj 0 -12 Td" for ln in lines) + " ET").encode()
    objs = [b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] "
            b"/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
            b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>"]
    out, offsets = b"%PDF-1.4\n", []
    for i, body in enumerate(objs, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += (f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF").encode()
    with open(path, "wb") as fh:
        fh.write(out)


plain = os.path.join(OUT, "cas_plain.pdf")
mini_pdf(CAS, plain)
w = PdfWriter(clone_from=PdfReader(plain))
w.encrypt("ABCDE1234F", algorithm="AES-256")
with open(os.path.join(OUT, "CAS_locked.pdf"), "wb") as fh:
    w.write(fh)
os.unlink(plain)
with open(os.path.join(OUT, "tradebook.csv"), "w") as fh:
    fh.write("symbol,isin,trade_date,exchange,segment,series,trade_type,quantity,price,trade_id,order_id,order_execution_time\n"
             "INFY,INE009A01021,2025-01-10,NSE,EQ,EQ,buy,5,1800.00,t1,o1,2025-01-10T10:00:01\n"
             "INFY,INE009A01021,2025-01-10,NSE,EQ,EQ,buy,5,1810.00,t2,o1,2025-01-10T10:00:02\n"
             "INFY,INE009A01021,2025-03-12,NSE,EQ,EQ,sell,4,1900.00,t3,o2,2025-03-12T11:00:00\n")
print("fixtures in", OUT)
