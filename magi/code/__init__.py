"""Code Mode: MAGI working on the files of the machine the engine runs on.

Deliberation asks several models a question. Code Mode asks Claude to change
something -- read files, edit them, run tests, drive git -- with the rest of
the council still reachable for the things a council is good at.

Nothing in this package writes to disk or runs a command. That arrives in a
later phase, deliberately last, so the part which can damage a project is the
last thing switched on and the first thing tested. What is here is the model
everything else hangs off: what a project is, where it lives, and how to look
at it without walking the whole tree.
"""
