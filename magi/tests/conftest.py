"""Shared test setup: nothing a test does may land in the engine's own data."""

import pytest


@pytest.fixture(autouse=True)
def _map_cache_in_tmp(tmp_path_factory, monkeypatch):
    # Track V7: context.plan() caches each folder's project map in the
    # engine's data folder; a test's scratch folders must not end up there.
    from magi.code.agents import symbols
    d = tmp_path_factory.mktemp("maps")
    monkeypatch.setattr(symbols, "_cache_file", lambda root: d / "map.json")
