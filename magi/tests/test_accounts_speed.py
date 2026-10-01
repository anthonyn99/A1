"""/api/accounts must not freeze the engine (2026-10-01).

Every console page load asks for the accounts listing, which reported each
unit's profile size by walking the whole Chrome profile -- ~7 s for seven,
done on the event loop, so every other request in the page's opening burst
waited behind it (9-17 s each). Sizes are now cached for SIZE_TTL_S and the
route runs the listing in a thread.
"""

from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace

from magi import accounts as A


def _settings(ids):
    site = SimpleNamespace(display_name="X", accent="#fff", url="https://x")
    return SimpleNamespace(sites={i: site for i in ids}, enabled={})


def _profiles(tmp_path, monkeypatch, ids):
    for i in ids:
        (tmp_path / i).mkdir()
        (tmp_path / i / "Cookies").write_bytes(b"x" * 2048)
    monkeypatch.setattr(A, "_profiles_root", lambda: tmp_path)
    monkeypatch.setattr(A, "_load", lambda: {})
    monkeypatch.setattr(A, "_sizes", {})
    walks = []
    real = A._dir_bytes
    monkeypatch.setattr(A, "_dir_bytes", lambda p: walks.append(p.name) or real(p))
    return walks


def test_a_profile_is_measured_once_per_window(tmp_path, monkeypatch):
    walks = _profiles(tmp_path, monkeypatch, ["claude", "gemini"])
    s = _settings(["claude", "gemini"])
    first = A.listing(s)
    A.listing(s)
    A.listing(s)
    assert sorted(walks) == ["claude", "gemini"], "three listings, one walk each"
    assert all(e["size_mb"] == 0.0 for e in first)      # 2 KB rounds to 0.0 MB
    assert all(e["profile"] for e in first)


def test_the_size_is_measured_again_after_the_window(tmp_path, monkeypatch):
    walks = _profiles(tmp_path, monkeypatch, ["claude"])
    d = tmp_path / "claude"
    A._size_mb("claude", d, now=1000.0)
    A._size_mb("claude", d, now=1000.0 + A.SIZE_TTL_S - 1)
    assert walks == ["claude"]
    A._size_mb("claude", d, now=1000.0 + A.SIZE_TTL_S + 1)
    assert walks == ["claude", "claude"]


def test_a_sign_in_or_out_forgets_the_size(tmp_path, monkeypatch):
    walks = _profiles(tmp_path, monkeypatch, ["claude"])
    s = _settings(["claude"])
    A.listing(s)
    A.forget_size("claude")
    A.listing(s)
    assert walks == ["claude", "claude"]
    # sign_out forgets it on its own (the folder goes; a new sign-in refills it)
    monkeypatch.setattr(A, "_save", lambda st: None)
    A.sign_out("claude")
    assert "claude" not in A._sizes


def test_the_route_does_not_block_the_event_loop(monkeypatch):
    """A slow listing runs in a thread: other work on the loop keeps going."""
    from magi import app as app_mod

    monkeypatch.setattr(app_mod, "_reload_settings", lambda: None)
    monkeypatch.setattr(app_mod.accounts_mod, "listing", lambda s: time.sleep(0.6) or [])

    async def main():
        ticks = 0

        async def ticker():
            nonlocal ticks
            for _ in range(20):
                await asyncio.sleep(0.02)
                ticks += 1

        t0 = time.monotonic()
        await asyncio.gather(app_mod.list_accounts(), ticker())
        return ticks, time.monotonic() - t0

    ticks, took = asyncio.run(main())
    assert ticks == 20
    assert took < 0.9, "the ticker ran DURING the listing, not after it"
