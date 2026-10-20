"""Dev tool: parse Tony and Veda's chapter notes PDFs into Shruti lessons JSON.

  python lessons.py "C:/Users/antho/Desktop/Gita" ../books/gita/lessons.json

Output: {"<chapter>": {"lessons": [{"id": "L1", "title", "body"}], "summary": str|null}}
The notes are kept word for word; only line wraps are joined.
"""
import json, os, re, sys, glob
import pymupdf

SRC, OUT = sys.argv[1], sys.argv[2]

def lines_of(path):
    """[(text, bold_text)] per visual line, page order."""
    out = []
    for page in pymupdf.open(path):
        for b in page.get_text("dict")["blocks"]:
            for l in b.get("lines", []):
                t = "".join(s["text"] for s in l["spans"])
                bold = "".join(s["text"] for s in l["spans"] if (s["flags"] & 16) or "Bold" in s["font"])
                if t.strip(): out.append((t.strip(), bold.strip()))
    return out

LESSON = re.compile(r"^Lesson\s+(\d+)\s*:\s*(.*)$")
CHAPTER = re.compile(r"^Chapter\s+(\d+)\s*:\s*(.*)$")
SUMMARY = re.compile(r"^These (\d+ )?(lessons|are the core)")

def join(parts):
    s = ""
    for p in parts:
        if p.startswith(("•", "·")): s += "\n• " + p.lstrip("•· ").strip()
        elif s.endswith(":") and not s.endswith("\n"): s += "\n" + p
        else: s += (" " if s else "") + p
    return re.sub(r"[ \t]+", " ", s).strip()

def parse(path, default_ch):
    data, ch = {}, default_ch
    cur = None; summary = None; in_summary = False
    def close():
        nonlocal cur
        if cur: data.setdefault(ch, {"lessons": [], "summary": None})["lessons"].append(
            {"id": "L" + cur["n"], "title": cur["title"], "body": join(cur["body"])})
        cur = None
    for t, bold in lines_of(path):
        m = CHAPTER.match(t)
        if m:
            close(); in_summary = False; ch = int(m.group(1)); continue
        m = LESSON.match(t)
        if m:
            close(); in_summary = False
            rest = m.group(2).strip()
            bm = LESSON.match(bold) if bold else None
            if bm and bm.group(2).strip() and bm.group(2).strip() != rest:
                title = bm.group(2).strip()           # bold title runs into the body on one line
                body = [rest[len(title):].strip()] if rest.startswith(title) else []
            else:
                title, body = rest, []
            cur = {"n": m.group(1), "title": title, "body": [b for b in body if b]}
            continue
        if SUMMARY.match(t):
            close(); in_summary = True
            data.setdefault(ch, {"lessons": [], "summary": None})["summary"] = t; continue
        if in_summary:
            data[ch]["summary"] += " " + t; continue
        if cur:
            # a wrapped title continues in bold on the next line
            if bold and bold == t and not cur["body"] and not cur["title"].endswith((".", "!", "?")):
                cur["title"] += " " + t
            else:
                cur["body"].append(t)
    close()
    return data

result = {}
for f in sorted(glob.glob(os.path.join(SRC, "Gita * notes.pdf"))):
    m = re.search(r"Gita (\d+) notes", os.path.basename(f))
    for ch, v in parse(f, int(m.group(1)) if m else None).items():
        if v["summary"]: v["summary"] = re.sub(r"\s+", " ", v["summary"]).strip()
        result[str(ch)] = v
result = dict(sorted(result.items(), key=lambda kv: int(kv[0])))
with open(OUT, "w", encoding="utf-8", newline="\n") as fh:
    json.dump(result, fh, ensure_ascii=False, indent=1); fh.write("\n")
for ch, v in result.items():
    print(ch, len(v["lessons"]), "lessons", "summary" if v["summary"] else "-")
