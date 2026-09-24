"""Which port `magi onboard` gives an engine.

On a PC of its own (Veda's), 8000 -- the port every console default, script
and doc assumes -- so her engine is set up exactly like Tony's. The profile's
spare port (veda: 8001) only when another engine already holds 8000, which is
the case for the veda engine on Tony's PC. A port already owned is never moved.
"""

from __future__ import annotations

from magi.cli import onboard as O


def _world(monkeypatch, *, free, ours=(), owned=0):
    monkeypatch.setattr(O, "_port_free", lambda p: p in free)
    monkeypatch.setattr(O, "_ours", lambda p: p in ours)
    monkeypatch.setattr(O, "_owned_port", lambda: owned)
    monkeypatch.setattr(O, "active_profile", lambda: "veda")


def test_a_fresh_pc_of_her_own_gets_8000(monkeypatch):
    _world(monkeypatch, free=set(range(8000, 8040)))
    assert O._pick_port(0) == 8000


def test_beside_tonys_engine_she_gets_her_spare(monkeypatch):
    _world(monkeypatch, free=set(range(8001, 8040)))
    assert O._pick_port(0) == 8001


def test_an_owned_port_is_never_moved(monkeypatch):
    _world(monkeypatch, free=set(range(8000, 8040)), owned=8001)
    assert O._pick_port(0) == 8001


def test_her_running_engine_keeps_8000(monkeypatch):
    _world(monkeypatch, free=set(range(8001, 8040)), ours={8000}, owned=8000)
    assert O._pick_port(0) == 8000
