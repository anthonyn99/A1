"""Which models each coding account may use, which one a task gets, and the
caps you set on how much of an allowance MAGI may spend.

Three questions, each answered from the provider rather than guessed:

**What can this account run?** Asked of the provider with the slot's own
login, the same reads the CLIs make for their model pickers:

    Claude   GET https://api.anthropic.com/v1/models       (+ /api/oauth/profile for the plan)
    Codex    GET https://chatgpt.com/backend-api/codex/models?client_version=<cli>

Cached for hours -- a plan does not change by the minute -- and never a
model call. Codex also writes that answer to `$CODEX_HOME/models_cache.json`,
which is the fallback when the read fails.

**May it run that one right now?** Some models run on usage credits rather
than the plan (verified live: Fable 5.1 on a Pro account with credits off is
refused `credits_required`, and nothing is billed). Whether credits are on is
in each provider's usage answer (usage_fetch.py), read every minute or five,
so turning credits on at claude.ai is noticed without a restart -- and the
same goes for an account that has used its plan's allowance and then turned
credits on. A model the provider refuses for credits is REMEMBERED for that
account, so the next task does not rediscover it.

**Should MAGI stop before the provider does?** Your caps: "stop Claude at
80% of the weekly limit". A capped account is skipped by the chain exactly as
if it were out of usage, until that window resets or you change the cap.

And one decision: **Auto** reads the prompt -- length, what it asks for,
whether it edits -- and picks the strongest model the task needs from the
ones the account can run now. Local and instant: no model call decides which
model to call.
"""

from __future__ import annotations

import json
import re
import threading
import time
from pathlib import Path
from typing import Any

from ...settings import data_dir
from . import limits, slots

CATALOG_TTL = 6 * 3600          # a plan's model list, re-read every few hours
FAIL_TTL = 10 * 60              # a failed read is not retried every minute
TIMEOUT = 10
EFFORTS = ("low", "medium", "high", "xhigh", "max")
WARN_DEFAULT = 80

CLAUDE_MODELS_URL = "https://api.anthropic.com/v1/models?limit=100"
CLAUDE_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile"
CODEX_MODELS_URL = "https://chatgpt.com/backend-api/codex/models"

# Claude families, weakest to strongest. A family nobody has heard of yet
# still lists (tier 2); it just is not Auto's first choice until named here.
FAMILY_TIER = {"haiku": 1, "sonnet": 2, "opus": 3, "fable": 4, "mythos": 4}
# Families a Pro or Free plan runs only on usage credits. Seeded from what
# Anthropic's own CLI says ("Fable 5 requires usage credits") and confirmed
# live; anything else the provider refuses for credits is learned per account.
CREDIT_FAMILIES = {"fable", "mythos"}
CREDIT_PLANS = {"pro", "free", ""}

WINDOW_LABEL = {"five_hour": "session (5h)", "seven_day": "weekly",
                "seven_day_opus": "weekly Opus", "seven_day_sonnet": "weekly Sonnet"}

_LOCK = threading.Lock()


def window_label(win: str) -> str:
    if win in WINDOW_LABEL:
        return WINDOW_LABEL[win]
    m = re.fullmatch(r"(\d+)([mhd])", win or "")
    if m:
        n, u = int(m.group(1)), m.group(2)
        if u == "d" and n == 7:
            return "weekly"
        return f"{n}-{dict(m='minute', h='hour', d='day')[u]}"
    return win


# ── storage: one catalog file and one preferences file, per profile ───────

def _catalog_path() -> Path:
    return data_dir() / "agent_models.json"


def _prefs_path() -> Path:
    return data_dir() / "code_models.json"


def _read(p: Path) -> dict:
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _write(p: Path, d: dict) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(d, indent=1), encoding="utf-8")
    tmp.replace(p)


# ── your choices: model, effort, caps, when to warn ───────────────────────

def default_prefs() -> dict:
    return {"choice": {a: {"model": "auto", "effort": "auto"} for a in slots.AGENTS},
            "caps": {a: {} for a in slots.AGENTS}, "warn_at": WARN_DEFAULT}


def prefs() -> dict:
    d = default_prefs()
    got = _read(_prefs_path())
    for a in slots.AGENTS:
        d["choice"][a].update({k: v for k, v in ((got.get("choice") or {}).get(a) or {}).items()
                               if k in ("model", "effort")})
        caps = (got.get("caps") or {}).get(a) or {}
        d["caps"][a] = {str(k): int(v) for k, v in caps.items()
                        if isinstance(v, (int, float)) and 1 <= v <= 100}
    w = got.get("warn_at")
    if isinstance(w, (int, float)) and 50 <= w <= 99:
        d["warn_at"] = int(w)
    return d


_MODEL_OK = re.compile(r"^[a-z0-9][a-z0-9._\-\[\]]{1,80}$")
_WIN_OK = re.compile(r"^[a-z0-9_]{1,24}$")


def _check_agent(agent: str) -> str:
    if agent not in slots.AGENTS:
        raise ValueError(f"Unknown agent {agent!r}.")
    return agent


def set_choice(agent: str, model: str, effort: str = "auto") -> dict:
    _check_agent(agent)
    model = (model or "auto").strip()
    effort = (effort or "auto").strip()
    if model != "auto" and not _MODEL_OK.match(model):
        raise ValueError("That is not a model name.")
    if effort != "auto" and effort not in EFFORTS:
        raise ValueError("Effort is auto, " + ", ".join(EFFORTS) + ".")
    with _LOCK:
        d = _read(_prefs_path())
        d.setdefault("choice", {})[agent] = {"model": model, "effort": effort}
        _write(_prefs_path(), d)
    return prefs()


def set_cap(agent: str, window: str, percent: int | None) -> dict:
    """`percent` 1..100 caps that window; None removes the cap."""
    _check_agent(agent)
    if not _WIN_OK.match(window or ""):
        raise ValueError("Unknown usage window.")
    if percent is not None:
        if isinstance(percent, bool) or not isinstance(percent, (int, float)) or not 1 <= percent <= 100:
            raise ValueError("A cap is a percentage from 1 to 100.")
        percent = int(percent)
    with _LOCK:
        d = _read(_prefs_path())
        caps = d.setdefault("caps", {}).setdefault(agent, {})
        if percent is None:
            caps.pop(window, None)
        else:
            caps[window] = percent
        _write(_prefs_path(), d)
    return prefs()


def set_warn(percent: int) -> dict:
    if isinstance(percent, bool) or not isinstance(percent, (int, float)) or not 50 <= percent <= 99:
        raise ValueError("Warn between 50% and 99%.")
    with _LOCK:
        d = _read(_prefs_path())
        d["warn_at"] = int(percent)
        _write(_prefs_path(), d)
    return prefs()


# ── the catalog: parsing what each provider says ──────────────────────────

_CLAUDE_ID = re.compile(r"^claude-(?P<fam>[a-z]+)-(?P<ver>\d+(?:-\d{1,2})*)(?:-(?P<date>\d{8}))?$")


def parse_claude_models(body: dict) -> list[dict]:
    """/v1/models -> models, strongest first, the newest of each family
    marked `latest` (the rest are still listed: an older model is a real
    choice, just rarely the right one)."""
    out = []
    for m in (body or {}).get("data") or []:
        mid = str((m or {}).get("id") or "")
        g = _CLAUDE_ID.match(mid)
        if not g:
            continue
        fam = g.group("fam")
        ver = tuple(int(x) for x in g.group("ver").split("-"))
        label = str(m.get("display_name") or mid)
        out.append({"id": mid, "label": label.removeprefix("Claude ").strip(),
                    "family": fam, "tier": FAMILY_TIER.get(fam, 2), "version": list(ver),
                    "created": m.get("created_at") or "",
                    "efforts": [e for e in EFFORTS
                                if (((m.get("capabilities") or {}).get("effort") or {})
                                    .get(e) or {}).get("supported")]})
    # Versions padded before comparing: [5] must rank below [5, 5] (Opus 5
    # vs Opus 5.5), and a bare list compare puts the shorter one first.
    out.sort(key=lambda x: (-x["tier"], [-v for v in (x["version"] + [0, 0, 0])[:4]], x["id"]))
    seen = set()
    for m in out:
        m["latest"] = m["family"] not in seen
        seen.add(m["family"])
    return out


def claude_plan(profile: dict) -> str:
    """/api/oauth/profile -> "max", "pro", "team", "enterprise", "free"."""
    acct = (profile or {}).get("account") or {}
    org = (profile or {}).get("organization") or {}
    t = str(org.get("organization_type") or "").lower()
    if acct.get("has_claude_max") or "max" in t:
        return "max"
    if acct.get("has_claude_pro") or t.endswith("pro"):
        return "pro"
    for k in ("enterprise", "team"):
        if k in t:
            return k
    return "free" if profile else ""


_CODEX_VER = re.compile(r"(\d+(?:\.\d+)*)")
_LIGHT = re.compile(r"\b(fast|affordable|mini|efficient|easier|lightweight|cheap)\b", re.I)
_STRONG = re.compile(r"\b(balanced|frontier|flagship|most capable|strongest|complex|max)\b", re.I)


def codex_capability(m: dict) -> float:
    """A rank for Codex models, from what the list says about each: the
    family version (6 > 5.6 > 5.5), up for "balanced/frontier", down for
    "fast/affordable", down for "older/legacy". The provider publishes no
    tier number, and its `priority` is a display order, not a strength."""
    slug = str(m.get("id") or "")
    desc = str(m.get("description") or "")
    v = _CODEX_VER.search(slug)
    parts = v.group(1).split(".") if v else []
    score = float(parts[0]) * 10 + (float(parts[1]) if len(parts) > 1 else 0) if parts else 0.0
    if re.search(r"terra|pro|max", slug):
        score += 2
    if _STRONG.search(desc):
        score += 2
    if _LIGHT.search(desc) or re.search(r"luna|mini|nano", slug):
        score -= 3
    if re.search(r"\b(older|legacy|previous)\b", desc, re.I):
        score -= 4
    return round(score, 2)


def parse_codex_models(body: dict) -> list[dict]:
    """codex/models -> the models its picker LISTS (visibility "list"), the
    strongest first. Hidden entries (review helpers, reserves) are left out:
    the CLI does not offer them either."""
    out = []
    for m in (body or {}).get("models") or []:
        if not isinstance(m, dict) or m.get("visibility") != "list" or not m.get("slug"):
            continue
        row = {"id": m["slug"], "label": str(m.get("display_name") or m["slug"]),
               "description": str(m.get("description") or "")[:160],
               "priority": m.get("priority"),
               "default_effort": m.get("default_reasoning_level") or "",
               "efforts": [str(e.get("effort")) for e in m.get("supported_reasoning_levels") or []
                           if isinstance(e, dict) and e.get("effort") in EFFORTS]}
        row["capability"] = codex_capability(row)
        row["light"] = bool(_LIGHT.search(row["description"]) or re.search(r"luna|mini|nano", row["id"]))
        out.append(row)
    out.sort(key=lambda x: (-x["capability"], x["priority"] if isinstance(x["priority"], int) else 99))
    if out:
        out[0]["latest"] = True
    return out


# ── the catalog: reading it from the provider ─────────────────────────────

def _http_json(url: str, headers: dict[str, str]) -> dict | None:
    from . import usage_fetch
    return usage_fetch._get(url, headers)


def _claude_token(slot: str) -> str | None:
    from . import usage_fetch
    try:
        cred = json.loads(usage_fetch._claude_creds(slot).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    oauth = cred.get("claudeAiOauth") or {}
    tok = oauth.get("accessToken")
    exp = float(oauth.get("expiresAt") or 0) / 1000.0
    if not tok or (exp and exp < time.time() + 30):
        return None           # expired: the CLI renews it on its next run, not us
    return tok


def fetch_claude(slot: str) -> dict | None:
    tok = _claude_token(slot)
    if not tok:
        return None
    h = {"Authorization": f"Bearer {tok}", "anthropic-beta": "oauth-2025-04-20",
         "anthropic-version": "2023-06-01", "User-Agent": "magi-models/1"}
    body = _http_json(CLAUDE_MODELS_URL, h)
    if not isinstance(body, dict) or not body.get("data"):
        return None
    prof = _http_json(CLAUDE_PROFILE_URL, h)
    return {"models": parse_claude_models(body),
            "plan": claude_plan(prof) if isinstance(prof, dict) else ""}


_codex_version: list[str] = []


def codex_cli_version() -> str:
    """The installed CLI's version: the models endpoint answers for a client
    version, and asking for the wrong one lists models the CLI cannot run."""
    if _codex_version:
        return _codex_version[0]
    v = ""
    exe = slots.cli_path("codex")
    if exe:
        try:
            from ... import proc
            import subprocess
            r = proc.run([exe, "--version"], capture_output=True, text=True, timeout=20,
                         stdin=subprocess.DEVNULL, encoding="utf-8", errors="replace")
            m = re.search(r"(\d+\.\d+\.\d+)", r.stdout or "")
            v = m.group(1) if m else ""
        except Exception:  # noqa: BLE001 -- a version is a nicety, not a need
            v = ""
    _codex_version.append(v)
    return v


def fetch_codex(slot: str) -> dict | None:
    d = slots.slot_dir("codex", slot)
    if d is None:
        return None
    try:
        auth = json.loads((d / "auth.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        auth = {}
    tok = auth.get("tokens") or {}
    body = None
    if tok.get("access_token"):
        ver = codex_cli_version()
        body = _http_json(CODEX_MODELS_URL + (f"?client_version={ver}" if ver else ""), {
            "Authorization": f"Bearer {tok['access_token']}",
            "chatgpt-account-id": tok.get("account_id") or "",
            "originator": "codex_cli_rs", "User-Agent": "magi-models/1"})
    if not isinstance(body, dict) or not body.get("models"):
        body = _read(d / "models_cache.json")          # what the CLI itself last saw
    models = parse_codex_models(body)
    return {"models": models, "plan": ""} if models else None


def catalog(agent: str, slot: str, *, force: bool = False) -> dict:
    """{models, plan, fetched_at} for one account, from cache when fresh.
    Blocking (network); run it in an executor."""
    _check_agent(agent)
    k = limits.key(agent, slot)
    now = time.time()
    with _LOCK:
        cat = _read(_catalog_path())
    hit = (cat.get("slots") or {}).get(k) or {}
    if not force and hit.get("models") and now - float(hit.get("fetched_at") or 0) < CATALOG_TTL:
        return hit
    if not force and now - float(hit.get("failed_at") or 0) < FAIL_TTL:
        return hit
    try:
        got = fetch_claude(slot) if agent == "claude" else fetch_codex(slot)
    except Exception:  # noqa: BLE001 -- a model list must never break a page
        got = None
    with _LOCK:
        cat = _read(_catalog_path())
        rows = cat.setdefault("slots", {})
        if got:
            rows[k] = {**got, "fetched_at": now}
        else:
            rows[k] = {**(rows.get(k) or {}), "failed_at": now}
        _write(_catalog_path(), cat)
        return rows[k]


# ── what the provider refused for credits, remembered per account ────────

def gated(agent: str, slot: str) -> set[str]:
    return set(((_read(_catalog_path()).get("gated") or {}).get(limits.key(agent, slot))) or [])


def note_gated(agent: str, slot: str, model: str, is_gated: bool) -> None:
    if not model:
        return
    with _LOCK:
        cat = _read(_catalog_path())
        g = set((cat.setdefault("gated", {}).get(limits.key(agent, slot))) or [])
        was = model in g
        (g.add if is_gated else g.discard)(model)
        if was != is_gated:
            cat["gated"][limits.key(agent, slot)] = sorted(g)
            _write(_catalog_path(), cat)


# ── may this account run this model now? ─────────────────────────────────

def credits(agent: str, slot: str) -> dict:
    """{enabled: True/False/None, exhausted: bool, ...} from the last usage
    read. None = not known yet (treated as off: MAGI does not spend credits
    it has not been told are on)."""
    return dict(limits.account(agent, slot).get("credits") or {})


def plan_of(agent: str, slot: str) -> str:
    if agent == "claude":
        return str(catalog_cached(agent, slot).get("plan") or "")
    return str(limits.account(agent, slot).get("plan") or "")


def catalog_cached(agent: str, slot: str) -> dict:
    return (_read(_catalog_path()).get("slots") or {}).get(limits.key(agent, slot)) or {}


def plan_used_up(agent: str, slot: str) -> float | None:
    """When the plan's own allowance is spent: the reset of the window that
    is full, or None while there is room."""
    until = None
    for w in limits.aged(limits.usage(agent, slot)).values():
        if isinstance(w, dict) and float(w.get("utilization") or 0) >= 1.0:
            r = w.get("resets_at")
            until = max(until or 0, float(r)) if r else (until or time.time() + limits.DEFAULT_BACKOFF_S)
    if until is None and limits.account(agent, slot).get("allowed") is False:
        until = time.time() + limits.DEFAULT_BACKOFF_S
    return until


def needs_credits(agent: str, slot: str, model: dict) -> bool:
    if model.get("id") in gated(agent, slot):
        return True
    return (agent == "claude" and model.get("family") in CREDIT_FAMILIES
            and plan_of(agent, slot) in CREDIT_PLANS)


def availability(agent: str, slot: str, model: dict) -> tuple[bool, str]:
    cr = credits(agent, slot)
    on = cr.get("enabled") is True and not cr.get("exhausted")
    label = model.get("label") or model.get("id") or "This model"
    if needs_credits(agent, slot, model):
        if cr.get("exhausted"):
            return False, f"{label} runs on usage credits, and this month's are used up."
        if not on:
            return False, (f"{label} runs on usage credits for this account, and they are off. "
                           "Turn them on in the account's usage settings; MAGI notices within a few minutes.")
        return True, "on usage credits"
    if plan_used_up(agent, slot):
        if on:
            return True, "plan limit reached — on usage credits"
        return False, "The plan's limit is reached and usage credits are off."
    return True, ""


def models_for(agent: str, slot: str) -> list[dict]:
    """The catalog with availability filled in, for the console."""
    out = []
    for m in catalog_cached(agent, slot).get("models") or []:
        ok, why = availability(agent, slot, m)
        out.append({**m, "available": ok, "why": why,
                    "credits": needs_credits(agent, slot, m)})
    return out


# ── caps ─────────────────────────────────────────────────────────────────

def cap_block(agent: str, slot: str, p: dict | None = None) -> tuple[float | None, str]:
    """(until, sentence) when one of YOUR caps has been reached on this
    account, else (None, ""). Until = the capped window's reset."""
    caps = ((p or prefs())["caps"] or {}).get(agent) or {}
    if not caps:
        return None, ""
    for win, w in limits.aged(limits.usage(agent, slot)).items():
        cap = caps.get(win)
        if not cap or not isinstance(w, dict):
            continue
        used = float(w.get("utilization") or 0) * 100
        if used >= cap:
            until = w.get("resets_at") or (time.time() + limits.DEFAULT_BACKOFF_S)
            return float(until), (f"Stopped at your {cap}% cap on the {window_label(win)} limit "
                                  f"({round(used)}% used)")
    return None, ""


def cap_crossed(agent: str, window: str, utilization: float, p: dict | None = None) -> int | None:
    """The cap a live usage reading has just reached, or None."""
    cap = (((p or prefs())["caps"] or {}).get(agent) or {}).get(window)
    return cap if cap and float(utilization or 0) * 100 >= cap else None


def alerts(p: dict | None = None) -> list[dict]:
    """What the console's usage popup should say, one row per window that is
    over the warning line or capped. Keyed so the console shows each once per
    reset: the same 84% is not announced every minute."""
    p = p or prefs()
    out = []
    for agent in slots.AGENTS:
        caps = (p["caps"] or {}).get(agent) or {}
        for slot in slots.list_slots(agent):
            for win, w in limits.aged(limits.usage(agent, slot)).items():
                if not isinstance(w, dict):
                    continue
                used = round(float(w.get("utilization") or 0) * 100)
                cap = caps.get(win)
                level = ("capped" if cap and used >= cap else
                         "limit" if used >= 100 else
                         "near_cap" if cap and used >= cap - 5 else
                         "warn" if used >= p["warn_at"] else "")
                if not level:
                    continue
                out.append({"key": f"{agent}:{slot}:{win}:{w.get('resets_at') or ''}:{level}",
                            "agent": agent, "slot": slot, "label": slots.label_of(agent, slot) or slot,
                            "window": win, "window_label": window_label(win), "used": used,
                            "cap": cap, "resets_at": w.get("resets_at"), "level": level})
    return out


# ── Auto ─────────────────────────────────────────────────────────────────

_HEAVY = re.compile(
    r"\b(architect\w*|design|redesign|refactor\w*|rewrite|migrat\w*|overhaul|restructur\w*|"
    r"security|vulnerab\w*|race condition|deadlock|concurren\w*|thread[- ]safe|memory leak|"
    r"performance|optimi[sz]\w*|profil\w*|root cause|intermittent|flak\w*|"
    r"across (the|all|every)|whole (codebase|project|repo)|entire|end[- ]to[- ]end|"
    r"multi[- ]file|every file|all files|algorithm|protocol|schema|"
    r"implement\w*|build (a|an|the)|new feature|add support)\b", re.I)
_HARDEST = re.compile(
    r"\b(think (hard|deeply|carefully)|hardest|very (hard|complex|tricky)|subtle|"
    r"from scratch|whole new|complete (rewrite|system)|formal|prove)\b", re.I)
_LIGHT_ASK = re.compile(
    r"^\s*(what|where|which|who|when|is|are|does|do|can|list|show|find|explain|summari[sz]e|"
    r"describe|tell me|how many|count)\b|\b(typo|rename|comment|docstring|format(ting)?|"
    r"spelling|one[- ]liner|quick question|briefly|in one sentence)\b", re.I)
_CODEY = re.compile(r"```|Traceback \(most recent|^\s+at .+\(.+:\d+", re.M)


def classify(prompt: str, mode: str = "read") -> dict:
    """The task's weight, 1 (a lookup) to 4 (the hardest), and why.

    A handful of cheap signals, each worth a point either way; a code block
    or stack trace and Write mode count too. It is not a judgement of the
    work -- only of which model is worth spending on it."""
    text = prompt or ""
    n = len(text)
    score = 2.0
    why = []
    heavy = len(set(m.group(0).lower() for m in _HEAVY.finditer(text)))
    if heavy:
        score += min(1.2, 0.6 * heavy)
        why.append("design/refactor/debugging work" if heavy > 1 else "substantial change")
    if _HARDEST.search(text):
        score += 1.25
        why.append("asks for depth")
    if _LIGHT_ASK.search(text) and not heavy:
        score -= 1.0
        why.append("a question or small edit")
    if n > 1500:
        score += 0.75
        why.append("long brief")
    elif n < 140 and not heavy:
        score -= 0.5
    if _CODEY.search(text):
        score += 0.5
        why.append("includes code or a trace")
    if mode == "write":
        score += 0.25
        why.append("edits files")
    tier = max(1, min(4, int(score + 0.5)))     # half up, not to even
    return {"tier": tier, "effort": {1: "low", 2: "medium", 3: "high", 4: "xhigh"}[tier],
            "why": ", ".join(why) or "an everyday task"}


def _pick_claude(models: list[dict], tier: int) -> dict | None:
    ok = [m for m in models if m.get("available")]
    if not ok:
        return None
    latest = [m for m in ok if m.get("latest")] or ok
    # The newest model of the family the tier wants; if that family is not
    # available (Fable without credits), the next family down; never a
    # stronger one than asked for unless nothing weaker exists.
    want = {1: 2, 2: 2, 3: 3, 4: 4}[tier]     # a lookup still gets Sonnet: Haiku reads code poorly
    for t in range(want, 0, -1):
        hit = [m for m in latest if m.get("tier") == t]
        if hit:
            return hit[0]
    return sorted(latest, key=lambda m: m.get("tier", 2))[0]


def _pick_codex(models: list[dict], tier: int) -> dict | None:
    ok = [m for m in models if m.get("available")]
    if not ok:
        return None
    ranked = sorted(ok, key=lambda m: -float(m.get("capability") or 0))
    if tier >= 3:
        return ranked[0]
    if tier == 1:
        light = [m for m in ranked if m.get("light")]
        if light:
            return light[0]
    # Everyday work: the provider's own recommended model (the head of its
    # picker), which is what Codex would have used anyway.
    by_pick = sorted(ok, key=lambda m: m["priority"] if isinstance(m.get("priority"), int) else 99)
    return by_pick[0]


def _effort_for(model: dict, want: str) -> str:
    efforts = model.get("efforts") or []
    if not efforts or want in efforts:
        return want
    order = list(EFFORTS)
    lower = [e for e in efforts if order.index(e) <= order.index(want)] if want in order else []
    return (lower[-1] if lower else efforts[0])


def _under_pressure(agent: str, slot: str, warn_at: int) -> bool:
    return any(isinstance(w, dict) and float(w.get("utilization") or 0) * 100 >= warn_at
               for w in limits.aged(limits.usage(agent, slot)).values())


def choose(agent: str, slot: str, prompt: str, mode: str = "read",
           p: dict | None = None) -> dict:
    """The model and effort this task runs with on this account.

    {"model": id|None, "effort": str|None, "auto": bool, "label": str,
     "why": str, "note": str}. `note` is set when your choice could not be
    honoured (it needs credits that are off) and Auto stood in for it. A
    None model means "let the CLI use its default" -- only when the account's
    model list could not be read at all.
    """
    p = p or prefs()
    ch = (p["choice"] or {}).get(agent) or {"model": "auto", "effort": "auto"}
    models = models_for(agent, slot)
    c = classify(prompt, mode)
    note = ""
    pick = None
    auto = ch.get("model", "auto") == "auto"
    if not auto:
        pick = next((m for m in models if m["id"] == ch["model"]), None)
        if pick is None and models:
            note = f"{ch['model']} is not offered to this account; Auto chose instead."
        elif pick is not None and not pick["available"]:
            note = f"{pick['label']}: {pick['why']} Auto chose instead."
            pick = None
        if pick is None and not models:
            # The list could not be read: pass your choice through and let
            # the CLI say if it cannot.
            return {"model": ch["model"], "effort": None if ch.get("effort") == "auto" else ch["effort"],
                    "auto": False, "label": ch["model"], "why": "your choice", "note": ""}
    if pick is None:
        tier = c["tier"]
        pressed = _under_pressure(agent, slot, p["warn_at"])
        if pressed and tier in (2, 3):
            tier -= 1
        pick = (_pick_claude if agent == "claude" else _pick_codex)(models, tier)
        if pick is None:
            return {"model": None, "effort": None, "auto": True, "label": "default",
                    "why": "the account's model list is not available yet", "note": note}
        why = c["why"] + (" — usage is high, one step lighter" if pressed and tier != c["tier"] else "")
        auto_pick = True
    else:
        why = "your choice"
        auto_pick = False
    want_effort = ch.get("effort", "auto")
    effort = _effort_for(pick, c["effort"] if want_effort == "auto" else want_effort)
    return {"model": pick["id"], "effort": effort, "auto": auto_pick, "label": pick["label"],
            "why": why, "note": note, "tier": c["tier"]}


async def cap_watch(agent: str, slot: str, trip, every: float = 60.0) -> None:
    """While a run is going, re-read the account's usage every minute and
    call `trip(sentence)` if one of your caps is reached -- the run is then
    stopped and handed on. Claude also reports usage in its own stream (and
    is tripped from there at once); Codex does not, so this is how a cap
    holds for it mid-task. Nothing to do when no cap is set."""
    import asyncio
    from . import usage_fetch
    if not (prefs()["caps"].get(agent)):
        return
    loop = asyncio.get_running_loop()
    try:
        while True:
            await asyncio.sleep(every)
            await loop.run_in_executor(None, usage_fetch.refresh, agent, slot)
            until, why = cap_block(agent, slot)
            if until:
                trip(why)
                return
    except asyncio.CancelledError:
        return
