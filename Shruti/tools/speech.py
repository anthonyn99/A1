"""One way the build tools speak (podcast.py, video.py, narrate.py).

Edge's neural voices through edge-tts (7.3.1 or newer), with word timings,
after Shruti's pronunciation lexicon (Shruti/lexicon.json, the same one the
page's orca.js uses): a word an English voice gets wrong is spoken respelled,
and the word timings come back with the true spelling, one word for one word,
so captions and highlighting line up with the text exactly.

A clip must be whole Edge frames (24 kHz mono 48 kbps, 144 bytes each):
everything is timed from byte counts.
"""
import asyncio
import json
import re
from pathlib import Path

import edge_tts

LEXICON = {k: v for k, v in json.loads((Path(__file__).resolve().parent.parent / "lexicon.json").read_text(encoding="utf-8")).items() if k != "_"}
_WORD = re.compile(r"[A-Za-z]+")


def _key(w):
    """A word as the lexicon knows it: as written, or with its first letter in the other case."""
    if w in LEXICON:
        return w
    alt = (w[0].lower() if w[0].isupper() else w[0].upper()) + w[1:]
    return alt if alt in LEXICON else None


def respell(text):
    """The text as the voice should say it, and {spoken word: written word}."""
    back = {}

    def sub(m):
        w = m.group(0)
        k = _key(w)
        if not k:
            return w
        say = LEXICON[k]
        if w[0].isupper() != say[0].isupper():
            say = (say[0].upper() if w[0].isupper() else say[0].lower()) + say[1:]
        back[say.lower()] = w
        return say
    return _WORD.sub(sub, text), back


def unspell(words, back):
    """Word timings with the written spelling put back."""
    if not back:
        return words
    out = []
    for t, d, w in words:
        m = _WORD.search(w)
        if m and m.group(0).lower() in back:
            w = w[:m.start()] + back[m.group(0).lower()] + w[m.end():]
        out.append([t, d, w])
    return out


async def speak(text, voice, sem, rate="+0%", tries=5):
    """(mp3 bytes, [[t, d, word]]) for one clip."""
    said, back = respell(text)
    async with sem:
        for attempt in range(tries):
            try:
                audio, words = bytearray(), []
                async for c in edge_tts.Communicate(said, voice, rate=rate, boundary="WordBoundary").stream():
                    if c["type"] == "audio":
                        audio += c["data"]
                    elif c["type"] == "WordBoundary":
                        words.append([round(c["offset"] / 1e7, 3), round(c["duration"] / 1e7, 3), c["text"]])
                if not audio or len(audio) % 144 or not words:
                    raise RuntimeError("not whole Edge frames with timings")
                # Edge sometimes cuts a clip short while still sending every
                # word's timing (2026-10-22: 0.36 s of audio for a whole
                # sentence in three Libby chapters). Ask again.
                if words[-1][0] > len(audio) / 6000 + 0.3:
                    raise RuntimeError("audio cut short of its words")
                return bytes(audio), unspell(words, back)
            except Exception as e:  # a dropped socket, or a clip that cannot be timed: try again
                if attempt == tries - 1:
                    raise
                print(f"    retry ({e})")
                await asyncio.sleep(1 + attempt)
