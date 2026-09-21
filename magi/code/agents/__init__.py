"""Coding agents: every way a MAGI unit can work on a project.

Three kinds, one interface (base.CodingAgent):

  * **CLI agents** -- Claude (Claude Code CLI) and Codex (Codex CLI). They run
    their own tool loop: read, search, and in later phases edit and run.
  * **Browser agents** -- every council unit reached through its logged-in
    chat session. They cannot run tools, so MAGI does it for them: gathers the
    context, asks for a structured answer, and applies any edits itself.

The chain (chain.py) walks them in priority order and hands a task to the next
one when the current one runs out of allowance or is signed out -- which is
what makes "any unit can code" true rather than aspirational.

Nothing here is paid. Both CLIs run on the account signed into them; browser
agents use the same sessions the council does. No API keys.
"""
