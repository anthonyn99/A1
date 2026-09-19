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

import time
import uuid

INSTANCE = uuid.uuid4().hex
STARTED_AT = time.time()
