"""One job's live events, delivered to EVERY stream watching it.

Every job (a council run, a Studio card, a refine, a brainstorm round) used to
put its events on one `asyncio.Queue` and every `/stream` endpoint read from
that same queue. A queue hands each item to exactly one reader, so a second
reader did not get a copy -- it got HALF. Two MAGI tabs open on one run (the
morning launcher opens a fresh console beside the one Brave restored), or an
EventSource reconnecting while its dead predecessor was still parked on
`get()`, split the events between them: each tab missed units finishing,
showed "0/5 resolved" beside units marked RESOLVED, left Grok on "awaiting
response" after it had failed, and one of them never saw the verdict at all.
Observed 2026-09-22.

`put` keeps the old signature, so producers are unchanged. A reader calls
`subscribe()` BEFORE taking its snapshot of the job's state -- both happen
without an await in between, so no event can fall into the gap -- and
`unsubscribe()` when its stream closes.
"""

from __future__ import annotations

import asyncio


class Broadcast:
    def __init__(self) -> None:
        self._subs: list[asyncio.Queue] = []

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        self._subs.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        try:
            self._subs.remove(q)
        except ValueError:
            pass

    async def put(self, item: dict) -> None:
        for q in list(self._subs):
            q.put_nowait(item)

    def put_nowait(self, item: dict) -> None:
        for q in list(self._subs):
            q.put_nowait(item)

    @property
    def listeners(self) -> int:
        return len(self._subs)
