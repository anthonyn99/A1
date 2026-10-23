"""Build the ready-made read-aloud narrations that ship with Shruti.

    magi\\.venv\\Scripts\\python Shruti\\tools\\narrate.py [chapters] [--voice NAME]

Default: the introduction and chapters 1-3 of the Gita in Ava, the default
voice. Writes Shruti/books/gita/media/chNN-read.mp3, chNN-read.json and
index.json. The page plays these with no Orca call (narrate.js, "file" mode).

The voice is Microsoft Edge's neural read-aloud, the same service Orca's
/v1/audio/speech uses, through the edge-tts package (7.3.1 or newer: older
versions send the old Sec-MS-GEC token and get 403).

Segments are cut like the page cuts them (text.js segmentsFor): one per
block, long blocks at sentence ends into parts of at most 1,500 characters.
Each segment's text is stored with it, so the page never has to cut the
same way to line words up. The MP3 is 48 kbps constant bitrate, so a
segment's length in bytes gives its duration exactly.
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
MEDIA = BOOK / "media"
SEG_MAX = 1500
BYTES_PER_SECOND = 48000 / 8
PARALLEL = 5


def block_text(bl):
    if bl.get("k") == "p":
        return " ".join(s["t"] for s in bl.get("s", []))
    return str(bl.get("t") or "")


SENT = re.compile(r"[^.!?;:]+(?:[.!?;:]+[\"'’”)\]]*|$)\s*")


def split_sentences(text, mx=SEG_MAX):
    text = text.strip()
    if len(text) <= mx:
        return [text] if text else []
    out, cur = [], ""
    for s in SENT.findall(text) or [text]:
        while len(s) > mx:
            if cur.strip():
                out.append(cur.strip())
            cur = ""
            cut = s.rfind(" ", 0, mx)
            cut = cut if cut > 0 else mx
            out.append(s[:cut].strip())
            s = s[cut:]
        if cur and len(cur + s) > mx:
            out.append(cur.strip())
            cur = ""
        cur += s
    if cur.strip():
        out.append(cur.strip())
    return out


def segments(ch):
    out = []
    for b, bl in enumerate(ch["blocks"]):
        for part, text in enumerate(split_sentences(block_text(bl))):
            out.append({"b": b, "part": part, "text": text})
    return out




async def chapter(n, voice):
    ch = json.loads((BOOK / f"ch{n:02d}.json").read_text(encoding="utf-8"))
    segs = segments(ch)
    sem = asyncio.Semaphore(PARALLEL)
    print(f"ch{n:02d}: {len(segs)} segments")
    results = await asyncio.gather(*(speak(s["text"], voice, sem) for s in segs))
    mp3, t = bytearray(), 0.0
    for s, (audio, words) in zip(segs, results):
        dur = len(audio) / BYTES_PER_SECOND
        s.update(start=round(t, 3), dur=round(dur, 3), words=words)
        mp3 += audio
        t += dur
    meta = {"v": 1, "book": "gita", "n": n, "voice": voice, "engine": "edge", "duration": round(t, 3), "segs": segs}
    MEDIA.mkdir(exist_ok=True)
    (MEDIA / f"ch{n:02d}-read.mp3").write_bytes(bytes(mp3))
    (MEDIA / f"ch{n:02d}-read.json").write_text(json.dumps(meta, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"ch{n:02d}: {t / 60:.1f} min, {len(mp3) / 1e6:.1f} MB")
    return {"voice": voice, "mp3": f"ch{n:02d}-read.mp3", "json": f"ch{n:02d}-read.json", "duration": round(t, 3)}


async def main():
    args = sys.argv[1:]
    voice = "en-GB-SoniaNeural"   # the read-aloud default (Tony, 2026-10-22)
    if "--voice" in args:
        i = args.index("--voice")
        voice = args[i + 1]
        del args[i:i + 2]
    chapters = [int(a) for a in args] or [0, 1, 2, 3]
    idx_path = MEDIA / "index.json"
    index = json.loads(idx_path.read_text(encoding="utf-8")) if idx_path.exists() else {}
    for n in chapters:
        index[str(n)] = await chapter(n, voice)
    idx_path.write_text(json.dumps(dict(sorted(index.items(), key=lambda kv: int(kv[0]))), indent=2), encoding="utf-8")


if __name__ == "__main__":
    asyncio.run(main())
