"""Who this engine process is.

A tunnel can be adopted from a previous engine (see tunnel.py), and "does this
hostname still reach MAGI?" is not a strong enough question to adopt on: a 401
is also what an ORPHANED tunnel returns, and what a second PC sharing the token
returns. Both would be adopted, and the phone would be pointed at a backend
that is not this one.

So every engine stamps itself with a fresh id and /api/health reports it. The
proof then becomes: the request left this machine, crossed Cloudflare, came
back through that hostname, and landed in THIS process.
"""

from __future__ import annotations

import json
import socket
import time
import uuid

INSTANCE = uuid.uuid4().hex
STARTED_AT = time.time()


# ── the engine, as opposed to the process ─────────────────────────────────
# INSTANCE above is a fresh id per PROCESS, which is exactly what tunnel
# adoption needs: it answers "did that hostname reach the engine running
# right now?". It is the wrong thing for anything that must survive a
# restart.
#
# A console listing several engines needs to say "Tony PC" and still mean
# the same machine tomorrow, so that identity is written down once and read
# back forever. It lives beside the profile's data, so a profile's engine on
# one machine and the same profile's engine on another are two records, not
# one fought over.
def engine_identity() -> dict:
    """{id, label} for this profile's engine on this machine, created once."""
    from .settings import active_profile, data_dir

    path = data_dir() / "engine.json"
    try:
        rec = json.loads(path.read_text(encoding="utf-8"))
        if rec.get("id"):
            return rec
    except Exception:
        pass
    rec = {
        "id": "eng_" + uuid.uuid4().hex[:12],
        # A name you can read. Defaults to the machine, because "DESKTOP-4F2"
        # is still a better answer to "which engine is this?" than a uuid.
        "label": f"{socket.gethostname()} · {active_profile()}",
        "profile": active_profile(),
    }
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(rec, indent=1), encoding="utf-8")
    except Exception:
        pass
    return rec


def set_engine_label(label: str) -> dict:
    from .settings import data_dir

    rec = engine_identity()
    rec["label"] = (label or "").strip() or rec["label"]
    try:
        (data_dir() / "engine.json").write_text(
            json.dumps(rec, indent=1), encoding="utf-8"
        )
    except Exception:
        pass
    return rec
