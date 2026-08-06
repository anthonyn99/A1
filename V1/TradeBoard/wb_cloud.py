#!/usr/bin/env python3
"""
═══════════════════════════════════════════════════════════════════════════
 wb_cloud.py — push a Webull sync straight into the TradeBoard cloud (Firestore)
═══════════════════════════════════════════════════════════════════════════
 The hosted TradeBoard (https://tradeboard-6b2ea.web.app) and every device that
 opens tradeboard.html read ONE Firestore document PER USER: tradeboard/{uid},
 where uid is the Firebase user id of the signed-in TradeBoard account. This
 script signs in with that same email/password (see _load_login) to get the
 uid, then writes to that user's doc — matching firestore.rules, which only
 allow a write when request.auth.uid == the doc id. The web page stores each
 section as a JSON *string* field on that doc:

     trades      = JSON.stringify(<array of trade objects>)
     positions   = JSON.stringify({broker,equity,positions[],generated_at})
     _updated    = Date.now()      (millis; makes onSnapshot fire everywhere)

 This module writes those two fields via the Firestore REST API, using the same
 anonymous auth the web page uses. As soon as it writes, every open device
 updates live through its onSnapshot listener — no clicking, no local server,
 works on your phone and the hosted site while your PC runs the sync.

 MIRROR SEMANTICS (must match tradeboard.html's mergeBroker exactly):
   • trades: read the current cloud `trades`, DROP the broker-tagged rows
     (tags contain "webull" or "broker"), then append the fresh broker rows.
     → Your MANUAL journal entries are preserved. Broker rows are replaced
       wholesale each sync (idempotent / self-healing).
   • positions: broker-owned data — overwritten wholesale each sync.

 If the cloud is unreachable, this fails soft (prints a warning, returns False)
 so wb_sync.py's local JSON files still work.

 READ-ONLY toward Webull. Toward the cloud it writes only trades/positions.
═══════════════════════════════════════════════════════════════════════════
"""

import json
import os
import sys
import urllib.error
import urllib.request
import uuid

# Windows consoles default to cp1252 and can't encode non-ASCII; make our prints
# safe whether this runs standalone or is imported by wb_sync/wb_server.
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, "webull_config.json")

# ── These MUST match the TBCloud CFG in tradeboard.html ───────────────────────
FIREBASE_API_KEY = "AIzaSyDx7PhEyPQO3fsr6aM516iZPp69vnSO0_8"
PROJECT_ID = "tradeboard-6b2ea"

# Tags that mark a trade as broker-synced (mirror of TB.jr.BROKER_TAGS).
BROKER_TAGS = ("webull", "broker")

# The web app now uses per-user email/password auth: each account owns exactly
# one Firestore doc at tradeboard/{uid}, and firestore.rules only allow a write
# when request.auth.uid == the doc id. So we must sign in as the SAME user the
# website uses (not anonymously) and write to tradeboard/{that user's uid}.
_SIGNIN_URL = (
    "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key="
    + FIREBASE_API_KEY
)


def _load_login():
    """
    TradeBoard email + password for the cloud push. Env vars win over the file:
      TRADEBOARD_EMAIL / TRADEBOARD_PASSWORD
    else "cloud_email" / "cloud_password" in webull_config.json.
    """
    email = os.environ.get("TRADEBOARD_EMAIL")
    password = os.environ.get("TRADEBOARD_PASSWORD")
    if not (email and password) and os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, encoding="utf-8") as fh:
                cfg = json.load(fh)
            email = email or cfg.get("cloud_email")
            password = password or cfg.get("cloud_password")
        except Exception:  # noqa: BLE001
            pass
    return email, password


def _doc_url(uid):
    return (
        f"https://firestore.googleapis.com/v1/projects/{PROJECT_ID}"
        f"/databases/(default)/documents/tradeboard/{uid}"
    )


# ── tiny HTTP helper ──────────────────────────────────────────────────────────
def _http_json(url, method="GET", body=None, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=20) as resp:
        raw = resp.read().decode("utf-8")
        return json.loads(raw) if raw else {}


def _sign_in(email, password):
    """
    Email/password sign-in → (idToken, uid), exactly like the web page's auth.
    The uid tells us which per-user Firestore doc to write (tradeboard/{uid}).
    """
    out = _http_json(
        _SIGNIN_URL,
        method="POST",
        body={"email": email, "password": password, "returnSecureToken": True},
    )
    tok = out.get("idToken")
    uid = out.get("localId")
    if not tok or not uid:
        raise RuntimeError("no idToken/uid from Firebase email sign-in")
    return tok, uid


# ── Firestore value <-> our field encoding ────────────────────────────────────
# The web page stores each field as a plain JSON *string*. In Firestore REST that
# is a stringValue whose content is the JSON text.
def _is_broker_trade(t):
    tags = t.get("tags")
    return isinstance(tags, list) and any(x in BROKER_TAGS for x in tags)


def _read_cloud_trades(token, doc_url):
    """Return the current trades array from the cloud doc (or [] if absent)."""
    try:
        doc = _http_json(doc_url, method="GET", token=token)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return []  # doc doesn't exist yet — first write creates it
        raise
    fields = doc.get("fields") or {}
    raw = fields.get("trades", {}).get("stringValue")
    if not raw:
        return []
    try:
        arr = json.loads(raw)
        return arr if isinstance(arr, list) else []
    except (ValueError, TypeError):
        return []


def _normalize_for_journal(t):
    """
    Shape a wb_sync trade the way the web journal expects. wb_sync rows already
    carry date/symbol/side/qty/entry/exit/fees/tags/notes; the page just needs a
    stable id per row (TB.jr.normalize would otherwise mint one on import).
    """
    out = dict(t)
    out.setdefault("id", uuid.uuid4().hex[:12])
    return out


def _build_merged_trades(cloud_trades, broker_trades):
    """
    Mirror of tradeboard.html mergeBroker: keep non-broker (manual) trades,
    replace all broker-tagged rows with the fresh set.
    """
    manual = [t for t in cloud_trades if not _is_broker_trade(t)]
    fresh = [_normalize_for_journal(t) for t in broker_trades]
    return manual + fresh


def _patch_doc(token, doc_url, trades, positions):
    """
    Write trades + positions + _updated to tradeboard/{uid}, touching ONLY those
    fields (updateMask) so strats/settings/account stay intact.
    """
    import time

    fields = {
        "trades": {"stringValue": json.dumps(trades)},
        "positions": {"stringValue": json.dumps(positions)},
        "_updated": {"integerValue": str(int(time.time() * 1000))},
    }
    # updateMask ensures a merge (not a full replace) of the document.
    url = (
        doc_url
        + "?updateMask.fieldPaths=trades"
        + "&updateMask.fieldPaths=positions"
        + "&updateMask.fieldPaths=_updated"
    )
    _http_json(url, method="PATCH", body={"fields": fields}, token=token)


# ── public entry point ────────────────────────────────────────────────────────
def push(trades, positions):
    """
    Push a completed sync to the TradeBoard cloud. `trades` is the list wb_sync
    produced; `positions` is the {broker,equity,positions[...],...} dict.

    Returns True on success, False on a (soft) failure. Never raises — a cloud
    outage must not break the local-file sync.
    """
    email, password = _load_login()
    if not (email and password):
        print(
            "⚠ Cloud push skipped: no TradeBoard login configured. Add \"cloud_email\"\n"
            "  and \"cloud_password\" to webull_config.json (or set TRADEBOARD_EMAIL /\n"
            "  TRADEBOARD_PASSWORD env vars) so the sync can write to your account.",
            file=sys.stderr,
        )
        return False
    try:
        token, uid = _sign_in(email, password)
        doc_url = _doc_url(uid)
        cloud_trades = _read_cloud_trades(token, doc_url)
        merged = _build_merged_trades(cloud_trades, trades)
        _patch_doc(token, doc_url, merged, positions)
        manual_n = sum(1 for t in cloud_trades if not _is_broker_trade(t))
        print(
            f"[cloud] Pushed to tradeboard/{uid}: "
            f"{len(trades)} broker trade(s) + {manual_n} manual kept, "
            f"{len(positions.get('positions', []))} position(s). "
            f"Every device will update live."
        )
        return True
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8")[:300]
        except Exception:  # noqa: BLE001
            pass
        print(f"⚠ Cloud push failed (HTTP {e.code}): {detail}", file=sys.stderr)
        return False
    except Exception as e:  # noqa: BLE001
        print(f"⚠ Cloud push skipped ({e}). Local files are still updated.",
              file=sys.stderr)
        return False


if __name__ == "__main__":
    # Manual test: push whatever the last local sync produced.
    tpath = os.path.join(HERE, "broker_import.json")
    ppath = os.path.join(HERE, "broker_positions.json")
    if not (os.path.exists(tpath) and os.path.exists(ppath)):
        print("Run wb_sync.py first (need broker_import.json + broker_positions.json).")
        sys.exit(1)
    with open(tpath, encoding="utf-8") as fh:
        _tr = json.load(fh)
    with open(ppath, encoding="utf-8") as fh:
        _po = json.load(fh)
    ok = push(_tr, _po)
    sys.exit(0 if ok else 1)
