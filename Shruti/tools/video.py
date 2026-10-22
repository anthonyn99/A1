"""Build the narrated videos that ship with Shruti from their scene scripts.

    magi\\.venv\\Scripts\\python -I Shruti\\tools\\video.py [chapters]

Reads Shruti/books/gita/scripts/chNN-video.json (written by hand: every
lesson of the chapter tagged on the scenes that teach it) and writes
Shruti/books/gita/media/chNN-video.mp3, chNN-video.json and videos.json.
The page draws the pictures itself (video.js, a canvas); only the narration
is a file.

A scene: {layout, headline, visual, say, L, ref, beyond}. layout is one of
title, verse, story, lesson, compare, steps, closing. A verse scene names a
verse (`ref`, e.g. "2.47"); its on-screen text is copied here from the
chapter file, exactly as the book prints it, and "{verse}" in `say` is
replaced by it for the voice (without "(Also see ...)" cross references).
A lesson scene with no headline takes the lesson's title from lessons.json.

One narrator voice (Edge neural, edge-tts 7.3.1 or newer). Each scene is
LEAD silence, the narration, then TAIL silence (more after a verse, so it
can be read), padded to a minimum length; scenes are joined byte for byte
with tools/silence.mp3 like tools/podcast.py, so every time comes from byte
counts.

Output: {v, book, n, title, narrator, duration, scenes:[{layout, headline,
visual, L, ref, verse, key, beyond, say, vs, start, end, at, words}]}.
start/end/at are seconds from the start (at: when the voice begins); words
[[t, d, w]] are relative to `at`; vs [from, to) are the whitespace tokens of
`say` that are the verse.
"""
import asyncio
import json
import re
import sys
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))   # -I leaves the tool's folder off the path
from speech import speak  # noqa: E402  the lexicon, word timings, whole frames


ROOT = Path(__file__).resolve().parent.parent
BOOK = ROOT / "books" / "gita"
SCRIPTS = BOOK / "scripts"
MEDIA = BOOK / "media"
SILENCE = (Path(__file__).parent / "silence.mp3").read_bytes()
CLIP = len(SILENCE) / 6000          # 0.288 s
BPS = 48000 / 8
PARALLEL = 5
LAYOUTS = {"title", "verse", "story", "lesson", "compare", "steps", "closing"}
# In silence clips: before the voice, after it, after a verse, and the
# shortest a scene may be (in seconds).
LEAD, TAIL, TAIL_VERSE = 2, 3, 5
MIN_SCENE = {"title": 5.0, "closing": 6.0}
XREF = re.compile(r"\s*\((?:also\s+)?see\b[^)]*\)", re.I)


def verses_of(n):
    ch = json.loads((BOOK / f"ch{n:02d}.json").read_text(encoding="utf-8"))
    out = {}
    for bl in ch["blocks"]:
        for s in bl.get("s", []) if bl.get("k") == "p" else []:
            if s.get("v"):
                out[s["v"]] = s
    return out


def norm_ref(ref):
    """'2.47' -> '2.47', '6.5' -> '6.05': the book pads verse numbers."""
    c, _, v = ref.partition(".")
    return c + "." + "-".join(p.zfill(2) for p in v.split("-"))




def prepare(n, script, lessons, verses):
    """Fill in what comes from the book; return scenes ready to speak."""
    L = {l["id"]: l for l in lessons.get(str(n), {}).get("lessons", [])}
    out = []
    for i, sc in enumerate(script["scenes"]):
        lay = sc.get("layout")
        if lay not in LAYOUTS:
            raise SystemExit(f"ch{n:02d} scene {i + 1}: unknown layout {lay!r}")
        say = sc["say"].strip()
        s = {"layout": lay, "headline": sc.get("headline", ""), "visual": sc.get("visual", []), "L": sc.get("L", [])}
        for id_ in s["L"]:
            if id_ not in L:
                raise SystemExit(f"ch{n:02d} scene {i + 1}: no lesson {id_}")
        if lay == "lesson" and not s["headline"]:
            s["headline"] = L[s["L"][0]]["title"]
        if sc.get("beyond"):
            s["beyond"] = True
        if lay == "verse":
            ref = norm_ref(sc["ref"])
            if ref not in verses:
                raise SystemExit(f"ch{n:02d} scene {i + 1}: no verse {ref}")
            v = verses[ref]
            s.update(ref=ref, verse=v["t"], key=bool(v.get("key")))
            if "{verse}" not in say:
                raise SystemExit(f"ch{n:02d} scene {i + 1}: a verse scene says {{verse}}")
            pre = say.split("{verse}")[0]
            spoken = XREF.sub("", v["t"]).strip()
            say = say.replace("{verse}", spoken)
            k = len(pre.split())
            s["vs"] = [k, k + len(spoken.split())]
        elif "{verse}" in say:
            raise SystemExit(f"ch{n:02d} scene {i + 1}: {{verse}} outside a verse scene")
        s["say"] = say
        out.append(s)
    return out


async def build(n, lessons):
    script = json.loads((SCRIPTS / f"ch{n:02d}-video.json").read_text(encoding="utf-8"))
    voice = script["narrator"]["voice"]
    scenes = prepare(n, script, lessons, verses_of(n))
    sem = asyncio.Semaphore(PARALLEL)
    print(f"ch{n:02d}: {len(scenes)} scenes")
    spoken = await asyncio.gather(*(speak(s["say"], voice, sem) for s in scenes))
    mp3 = bytearray()
    for s, (audio, words) in zip(scenes, spoken):
        s["start"] = round(len(mp3) / BPS, 3)
        mp3 += SILENCE * LEAD
        s["at"] = round(len(mp3) / BPS, 3)
        mp3 += audio
        mp3 += SILENCE * (TAIL_VERSE if s["layout"] == "verse" else TAIL)
        least = MIN_SCENE.get(s["layout"], 0)
        while len(mp3) / BPS - s["start"] < least:
            mp3 += SILENCE
        s["end"] = round(len(mp3) / BPS, 3)
        s["words"] = words
    duration = round(len(mp3) / BPS, 3)
    meta = {"v": 1, "book": script["book"], "n": n, "title": script["title"], "narrator": script["narrator"],
            "duration": duration, "scenes": scenes}
    (MEDIA / f"ch{n:02d}-video.mp3").write_bytes(bytes(mp3))
    (MEDIA / f"ch{n:02d}-video.json").write_text(json.dumps(meta, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"ch{n:02d}: {duration / 60:.1f} min, {len(mp3) / 1e6:.1f} MB")
    return {"mp3": f"ch{n:02d}-video.mp3", "json": f"ch{n:02d}-video.json", "duration": duration,
            "scenes": len(scenes), "narrator": script["narrator"]["name"]}


async def main():
    chapters = [int(a) for a in sys.argv[1:]] or sorted(int(p.name[2:4]) for p in SCRIPTS.glob("ch??-video.json"))
    lessons = json.loads((BOOK / "lessons.json").read_text(encoding="utf-8"))
    idx_path = MEDIA / "videos.json"
    index = json.loads(idx_path.read_text(encoding="utf-8")) if idx_path.exists() else {}
    for n in chapters:
        index[str(n)] = await build(n, lessons)
    idx_path.write_text(json.dumps(dict(sorted(index.items(), key=lambda kv: int(kv[0]))), indent=2), encoding="utf-8")


if __name__ == "__main__":
    asyncio.run(main())
