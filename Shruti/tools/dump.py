"""Dev tool: dump the Gita PDF to lines with style + highlight flags (stage 1 of extract)."""
import pymupdf, json, sys, collections
SRC = r"C:\Users\antho\Desktop\Gita\bhagavad-gita-english.pdf"
doc = pymupdf.open(SRC)
out = []
colors = collections.Counter()
for pno in range(doc.page_count):
    page = doc[pno]
    yel = [pymupdf.Rect(d["rect"]) for d in page.get_drawings()
           if d.get("fill") and all(abs(a-b) < .15 for a, b in zip(d["fill"], (1, 1, 0)))]
    raw = page.get_text("rawdict")
    for b in raw["blocks"]:
        for l in b.get("lines", []):
            spans = []
            for s in l["spans"]:
                txt = "".join(c["c"] for c in s["chars"])
                if not txt: continue
                h = ""
                for c in s["chars"]:
                    r = pymupdf.Rect(c["bbox"]); pt = pymupdf.Point((r.x0+r.x1)/2, (r.y0+r.y1)/2)
                    h += "1" if any(y.contains(pt) for y in yel) else "0"
                colors[hex(s["color"])] += len(txt)
                spans.append({"t": txt, "c": hex(s["color"]), "f": s["font"], "z": round(s["size"], 1),
                              "it": bool(s["flags"] & 2), "b": bool(s["flags"] & 16), "h": h})
            if spans:
                out.append({"p": pno, "y": round(l["bbox"][1], 1), "x": round(l["bbox"][0], 1), "s": spans})
json.dump(out, open(sys.argv[1], "w", encoding="utf-8"), ensure_ascii=False)
print(len(out), "lines", colors.most_common(8))
