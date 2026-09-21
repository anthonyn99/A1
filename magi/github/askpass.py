"""What git runs when it needs a GitHub password (GIT_ASKPASS).

git.push() points GIT_ASKPASS at a two-line shell script that execs this
file. git then runs it twice, with the prompt as the only argument:

    Username for 'https://github.com':
    Password for 'https://<login>@github.com':

and reads one line of stdout each time. The password is the account's token,
read from the credential store at that moment -- so it is never in
.git/config, a command line, or the environment of git or anything git
starts. The environment carries only WHICH account (MAGI_GH_SERVICE,
MAGI_GH_LOGIN) and the one host the answer is for (MAGI_GH_HOST).

It answers for that host and nothing else. A remote that redirects, a
submodule on another server, a URL rewritten by some insteadOf rule: git
would ask for their credentials too, and they get an exit code, not a token.

Standalone on purpose -- no MAGI imports -- because it starts once per
prompt and every import is startup time on a push.
"""

from __future__ import annotations

import os
import re
import sys

_PROMPT = re.compile(r"^(Username|Password) for '(https?)://(?:([^@'/]*)@)?([^'/]+)'", re.I)


def answer(prompt: str, env) -> str | None:
    m = _PROMPT.match((prompt or "").strip())
    service = env.get("MAGI_GH_SERVICE", "")
    login = env.get("MAGI_GH_LOGIN", "")
    host = env.get("MAGI_GH_HOST", "")
    if not m or not service or not login or not host:
        return None
    what, scheme, _user, where = m.groups()
    if where.lower() != host.lower():
        return None
    # Plain http only for a loopback test server, never for a real host.
    if scheme.lower() != "https" and not where.split(":")[0] in ("127.0.0.1", "localhost"):
        return None
    if what.lower() == "username":
        return login
    import keyring
    return keyring.get_password(service, login)


def main() -> int:
    ans = answer(sys.argv[1] if len(sys.argv) > 1 else "", os.environ)
    if not ans:
        return 1
    sys.stdout.write(ans + "\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
