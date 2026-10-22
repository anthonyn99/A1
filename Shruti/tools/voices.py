"""Voice previews: one short clip per voice Shruti offers (Tony, 2026-10-22:
"we should be able to preview voices before using them to generate content").

    python Shruti/tools/voices.py

Writes Shruti/media/voices/<voice id>.mp3 for every voice in orca.js VOICES,
spoken through the same lexicon as everything else (tools/speech.py). The page
plays these with no key and no Orca call (narrate.js preview); a voice without
a clip here falls back to a live Orca sample. A host pair's preview plays the
two clips one after the other, so each line introduces one host.
"""
import asyncio
import re
from pathlib import Path

from speech import speak

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "media" / "voices"


def voices():
    """[(id, name)] read from orca.js, so the list is never kept twice."""
    src = (ROOT / "orca.js").read_text(encoding="utf-8")
    block = src[src.index("export const VOICES = ["):]
    block = block[:block.index("].map(")]
    return re.findall(r"\['([a-zA-Z-]+Neural)', '([^']+)'", block)


def line(name):
    return f"Hello, I'm {name}. Welcome to Shruti, where we read, listen to and study the Bhagavad-Gita together."


async def main():
    OUT.mkdir(parents=True, exist_ok=True)
    sem = asyncio.Semaphore(4)
    vs = voices()

    async def one(vid, name):
        audio, _ = await speak(line(name), vid, sem)
        (OUT / (vid + ".mp3")).write_bytes(audio)
        print(f"  {name:12s} {len(audio) / 6000:4.1f} s")
    await asyncio.gather(*(one(v, n) for v, n in vs))
    print(f"{len(vs)} previews in {OUT}")

asyncio.run(main())
