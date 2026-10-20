"""Dev tool: turn dump.py's line dump of the IGS Gita PDF into Shruti book JSON.

  python dump.py lines.json            (stage 1, needs pymupdf)
  python extract.py lines.json ../books/gita

Each chapter file is {n, title, blocks:[...]} where a block is
  {"k":"h", "t": heading}
  {"k":"p", "s":[{"t": text, "v": "2.23-24" | null, "key": bool}]}   body text split at verse refs
  {"k":"a", "style": "commentary"|"note"|"gloss", "t": text}           asides that are not verses
`key` marks the verses the source highlights in yellow ("read these first").
The text is never reworded: only line joins, de-hyphenation and spacing are touched.
"""
import json, re, sys, os, collections

LINES, OUT = sys.argv[1], sys.argv[2]
L = json.load(open(LINES, encoding="utf-8"))

def text(l): return "".join(s["t"] for s in l["s"])
def chars(l):
    for s in l["s"]:
        for ch, h in zip(s["t"], s["h"]): yield ch, h == "1", s
def cls(l):
    """body | red | aside, by the style carrying most of the line's visible characters."""
    w = collections.Counter()
    for ch, _, s in chars(l):
        if ch.isspace(): continue
        if s["c"] == "0xff0000": w["red"] += 1
        elif s["f"].startswith("ArialMT") and s["z"] == 11.0 and not s["it"]: w["body"] += 1
        elif s["it"] or "Italic" in s["f"]: w["gloss"] += 1
        else: w["aside"] += 1
    return w.most_common(1)[0][0] if w else None

RUNHEAD = re.compile(r"^\s*(\d+\s+International Gita Society|Bhagavad-Gita\s+\d+)\s*$")
lines = []
started = False
for l in L:
    t = text(l)
    if not started:
        if l["p"] >= 4 and t.strip() == "INTRODUCTION": started = True
        else: continue
    if RUNHEAD.match(t) or not t.strip(): continue
    if t.strip().startswith("Glossary of Sanskrit words"): break
    lines.append(l)

# vocabulary from words that are not split at a line end, for de-hyphenation
vocab = set()
for l in lines:
    for w in re.findall(r"[A-Za-z][A-Za-z'’-]*[A-Za-z]", text(l).rstrip(" -")):
        vocab.add(w.lower())

def hyphen_rule(left, right):
    """A line ended in '-'. left/right are the word pieces either side. 'keep' or 'drop' the hyphen."""
    if left[-1:].isdigit() and right[:1].isdigit(): return "keep"          # (4.25-28)
    whole, hy = (left + right).lower(), (left + "-" + right).lower()
    if whole in vocab and hy not in vocab: return "drop"
    if hy in vocab: return "keep"
    if left.lower() in vocab and right.lower() in vocab and left[:1].isupper(): return "keep"
    return "drop"

def resolve(buf):
    """buf holds (char, hl) with ('
', False) between source lines; glue the lines."""
    out = []
    for i, (c, h) in enumerate(buf):
        if c != "
": out.append((c, h)); continue
        while out and out[-1][0] == " ": out.pop()
        if out and out[-1][0] == "-":
            prev = "".join(x for x, _ in out)
            nxt = "".join(x for x, _ in buf[i + 1:i + 40]).lstrip()
            m1 = re.search(r"([A-Za-z0-9]+)-$", prev); m2 = re.match(r"([A-Za-z0-9]+)", nxt)
            if m1 and m2 and hyphen_rule(m1.group(1), m2.group(1)) == "drop": out.pop()
            elif not (m1 and m2): out.append((" ", False))
        else:
            out.append((" ", False))
    return out

chapters, intro = [], {"n": 0, "title": "Introduction", "blocks": []}
cur = intro
para = None   # {"cls", "buf": [(ch, hl)]}

def flush():
    global para
    if not para: return
    para["buf"] = resolve(para["buf"])
    s = "".join(c for c, _ in para["buf"])
    hl = [h for _, h in para["buf"]]
    s2 = re.sub(r"[ \t]+", " ", s).strip()
    if para["cls"] == "body": cur["blocks"].append(split_verses(para["buf"]))
    else:
        style = para["cls"]
        if s2.startswith("NOTE"): style = "note"
        cur["blocks"].append({"k": "a", "style": {"aside": "commentary", "gloss": "gloss"}.get(style, style), "t": s2})
    para = None

REF = re.compile(r"\((?:Verse\s+)?(\d{1,2})\.(\d{2})(?:\s*-\s*(\d{2}))?\)")
def split_verses(buf):
    s = "".join(c for c, _ in buf); hl = [h for _, h in buf]
    segs, start = [], 0
    for m in REF.finditer(s):
        v = f"{int(m.group(1))}.{m.group(2)}" + (f"-{m.group(3)}" if m.group(3) else "")
        segs.append((start, m.start(), v)); start = m.end()
    if s[start:].strip(): segs.append((start, len(s), None))
    out = []
    for a, b, v in segs:
        t = re.sub(r"\s+", " ", s[a:b]).strip()
        if not t: continue
        span = [hl[i] for i in range(a, b) if not s[i].isspace()]
        out.append({"t": t, "v": v, "key": bool(span) and sum(span) / len(span) > 0.5})
    return {"k": "p", "s": out}

def add_line(l, kind):
    global para
    cs = [(c, h) for c, h, _ in chars(l)]
    indent = l["x"] > 35
    if para and (para["cls"] != kind or indent): flush()
    if not para:
        para = {"cls": kind, "buf": []}
        while cs and cs[0][0].isspace(): cs.pop(0)
    else:
        while cs and cs[0][0].isspace(): cs.pop(0)
        para["buf"].append(("
", False))
    para["buf"].extend(cs)

pending_title = False
for l in lines:
    t = text(l).strip()
    m = re.match(r"^CHAPTER (\d+)$", t)
    if m:
        flush(); cur = {"n": int(m.group(1)), "title": "", "blocks": []}; chapters.append(cur); pending_title = True; continue
    if t == "INTRODUCTION": continue
    if t.startswith("Thus ends the Bhagavad-Gita"):
        flush(); cur["blocks"].append({"k": "a", "style": "closing", "t": t}); continue
    k = cls(l)
    if k == "red":
        flush()
        if pending_title:
            cur["title"] = re.sub(r"^\d+\.\s*", "", t); pending_title = False
        else:
            cur["blocks"].append({"k": "h", "t": t})
        continue
    if t == "Commentary":
        flush(); cur["blocks"].append({"k": "h", "t": t, "minor": True}); continue
    if t == "Teachings of the Gita begins":
        flush(); cur["blocks"].append({"k": "a", "style": "marker", "t": t}); continue
    if t.startswith("Important verses are high"):
        flush(); cur["blocks"].append({"k": "a", "style": "gloss", "t": "Important verses are highlighted. First time readers should read and understand these verses first."}); continue
    add_line(l, k)
flush()

os.makedirs(OUT, exist_ok=True)
def dump(obj, name):
    with open(os.path.join(OUT, name), "w", encoding="utf-8", newline="\n") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1); f.write("\n")
dump(intro, "ch00.json")
for c in chapters: dump(c, f"ch{c['n']:02d}.json")
nverse = sum(1 for c in chapters for b in c["blocks"] if b["k"] == "p" for s in b["s"] if s["v"])
nkey = sum(1 for c in chapters for b in c["blocks"] if b["k"] == "p" for s in b["s"] if s["key"])
print(len(chapters), "chapters,", nverse, "verse refs,", nkey, "key verses")
