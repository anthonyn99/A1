"""Build the two-host podcasts that ship with Shruti from their scripts.

    magi\\.venv\\Scripts\\python -I Shruti\\tools\\podcast.py [chapters]

Reads Shruti/books/gita/scripts/chNN-podcast.json (written by hand: every
lesson of the chapter tagged on the turns that teach it) and writes
Shruti/books/gita/media/chNN-podcast.mp3, chNN-podcast.json and podcasts.json.

Each turn is spoken in its host's Edge voice (edge-tts 7.3.1 or newer, the
same voices as Orca's /v1/audio/speech). Edge's MP3 is 24 kHz mono, 48 kbps
constant bitrate, so turns are joined byte for byte with tools/silence.mp3
(0.288 s of silence in the same format, made with lamejs) between them: no
decoding, no re-encoding, and every time comes exactly from byte counts.
The page builds generated podcasts the same way (podcast.js build()).

Transcript: {v, book, n, title, hosts, duration, segments:[{title, start}],
turns:[{s, start, end, text, L, words:[[t, d, w]]}]}; turn word times are
relative to the turn's start.
"""
import asyncio
import json
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
BPS = 48000 / 8
PARALLEL = 5
# Pauses, in silence clips (0.288 s each): a change of speaker, the same
# speaker again, and between segments.
GAP_TURN, GAP_SAME, GAP_SEGMENT = 1, 1, 3
# A touch slower than Edge's default: a conversation, not a read-out (Tony, 2026-10-22).
RATE = "-5%"




async def build(n):
    script = json.loads((SCRIPTS / f"ch{n:02d}-podcast.json").read_text(encoding="utf-8"))
    voices = {h["id"]: h["voice"] for h in script["hosts"]}
    flat = [(si, t) for si, seg in enumerate(script["segments"]) for t in seg["turns"]]
    sem = asyncio.Semaphore(PARALLEL)
    print(f"ch{n:02d}: {len(flat)} turns")
    spoken = await asyncio.gather(*(speak(t["t"], voices[t["s"]], sem, rate=RATE) for _, t in flat))
    mp3, turns, segments, prev = bytearray(), [], [], None
    for (si, t), (audio, words) in zip(flat, spoken):
        if prev is not None:
            gaps = GAP_SEGMENT if si != prev[0] else (GAP_SAME if t["s"] == prev[1] else GAP_TURN)
            mp3 += SILENCE * gaps
        if not segments or segments[-1]["i"] != si:
            segments.append({"i": si, "title": script["segments"][si]["title"], "start": round(len(mp3) / BPS, 3)})
        start = len(mp3) / BPS
        mp3 += audio
        turns.append({"s": t["s"], "start": round(start, 3), "end": round(len(mp3) / BPS, 3), "text": t["t"], "L": t.get("L", []), "words": words})
        prev = (si, t["s"])
    for s in segments:
        del s["i"]
    duration = round(len(mp3) / BPS, 3)
    meta = {"v": 1, "book": script["book"], "n": n, "title": script["title"], "hosts": script["hosts"],
            "duration": duration, "segments": segments, "turns": turns}
    (MEDIA / f"ch{n:02d}-podcast.mp3").write_bytes(bytes(mp3))
    (MEDIA / f"ch{n:02d}-podcast.json").write_text(json.dumps(meta, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"ch{n:02d}: {duration / 60:.1f} min, {len(mp3) / 1e6:.1f} MB")
    return {"mp3": f"ch{n:02d}-podcast.mp3", "json": f"ch{n:02d}-podcast.json", "duration": duration,
            "hosts": [h["name"] for h in script["hosts"]]}


async def main():
    chapters = [int(a) for a in sys.argv[1:]] or sorted(int(p.name[2:4]) for p in SCRIPTS.glob("ch??-podcast.json"))
    idx_path = MEDIA / "podcasts.json"
    index = json.loads(idx_path.read_text(encoding="utf-8")) if idx_path.exists() else {}
    for n in chapters:
        index[str(n)] = await build(n)
        # after every chapter, so a run cut short (the network drops) keeps what it built
        idx_path.write_text(json.dumps(dict(sorted(index.items(), key=lambda kv: int(kv[0]))), indent=2), encoding="utf-8")


if __name__ == "__main__":
    asyncio.run(main())
