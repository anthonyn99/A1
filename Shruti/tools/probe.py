import pymupdf, sys, collections
doc = pymupdf.open(r"C:\Users\antho\Desktop\Gita\bhagavad-gita-english.pdf")
print("pages", doc.page_count)
p = doc[11]
print("annots", [ (a.type, a.rect) for a in p.annots()][:5])
dr = p.get_drawings()
fills = collections.Counter(tuple(round(c,2) for c in d["fill"]) for d in dr if d.get("fill"))
print("fills", fills.most_common(6))
for b in p.get_text("dict")["blocks"][:6]:
    for l in b.get("lines", []):
        for s in l["spans"]:
            print(hex(s["color"]), s["font"], round(s["size"],1), repr(s["text"][:60]))
