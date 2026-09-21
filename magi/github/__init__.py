"""GitHub, for Code Mode: accounts, the REST client, and the push credential.

The dividing line (docs/magi-plan.md §6): local git for anything about the
working tree, REST for anything about GitHub as a service. This package is
the REST half plus the one thing git needs from it -- a token, handed over at
the moment git asks and never written anywhere git would keep it.

    accounts.py   which GitHub logins MAGI holds a token for, per profile.
                  The token lives in the OS credential store (keyring);
                  nothing here ever returns it.
    client.py     REST: the pinned API version, ETags, pagination,
                  rate-limit accounting and typed errors.
    askpass.py    the tiny program git runs to ask for a password. It reads
                  the token from the credential store at that moment.
"""
