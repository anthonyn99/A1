"""agent_guard: a coding agent's processes cannot drive the engine on loopback.

Real processes, a real socket, the real job object -- the thing under test is
what Windows reports, so nothing here is mocked. See agent_guard.py for why
(Codex's Windows sandbox reaches 127.0.0.1 whatever its network setting).
"""

from __future__ import annotations

import socket
import subprocess
import sys
import time

import pytest

from magi import agent_guard as G

pytestmark = pytest.mark.skipif(not G.WIN, reason="the guard is Windows-only")

# Connects to the port in argv[1] and holds the connection open.
CONNECT = ("import socket,sys,time;s=socket.create_connection(('127.0.0.1',int(sys.argv[1])));"
           "print('up',flush=True);time.sleep(60)")
# Starts CONNECT as a grandchild, then exits: the grandchild is an orphan.
ORPHAN = ("import subprocess,sys;subprocess.Popen([sys.executable,'-c',sys.argv[2],sys.argv[1]],"
          "creationflags=0x08000000);print('spawned',flush=True)")


@pytest.fixture
def server():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    s.listen(8)
    s.settimeout(20)
    yield s
    s.close()


def _connect(server, adopt: bool, code=CONNECT, *extra):
    p = subprocess.Popen([sys.executable, "-c", code, str(server.getsockname()[1]), *extra],
                         stdout=subprocess.PIPE, text=True)
    if adopt:
        assert G.adopt(p)
    conn, (_, cport) = server.accept()
    return p, conn, cport


def _kill(*ps):
    for p in ps:
        subprocess.run(["taskkill", "/PID", str(p.pid), "/T", "/F"], capture_output=True)


def test_an_adopted_process_is_traced_and_refused(server):
    sport = server.getsockname()[1]
    p, conn, cport = _connect(server, adopt=True)
    try:
        assert G.agents_running()
        # Not necessarily p.pid: a venv's python.exe is a launcher that runs
        # the real interpreter as its child -- exactly the .cmd-shim shape of
        # the agent CLIs, and why the check is the job, not a PID list.
        pid = G.client_pid(cport, sport)
        assert pid is not None
        assert G.in_job(pid) is True
        assert G.refuse("POST", "/api/code/tasks/t1/approve", cport, sport)
        assert G.refuse("GET", "/api/token", cport, sport)
        assert G.refuse("GET", "/api/code/state", cport, sport)
    finally:
        conn.close()
        _kill(p)


def test_the_mcp_servers_reads_stay_open(server):
    sport = server.getsockname()[1]
    p, conn, cport = _connect(server, adopt=True)
    try:
        for path in ("/api/code/projects/proj_1/repo", "/api/code/projects/proj_1/repo/issues/12",
                     "/api/code/projects/proj_1/repo/actions/99"):
            assert not G.refuse("GET", path, cport, sport), path
        assert G.refuse("POST", "/api/code/projects/proj_1/repo", cport, sport)
        assert G.refuse("GET", "/api/code/projects/proj_1/push", cport, sport)
        assert G.refuse("GET", "/api/code/projects/proj_1/repo/../../token", cport, sport)
    finally:
        conn.close()
        _kill(p)


def test_anyone_else_is_let_through_while_an_agent_runs(server):
    sport = server.getsockname()[1]
    agent, c1, _ = _connect(server, adopt=True)
    other, c2, cport = _connect(server, adopt=False)
    try:
        assert G.agents_running()
        assert G.in_job(other.pid) is False
        assert not G.refuse("POST", "/api/code/tasks/t1/approve", cport, sport)
    finally:
        c1.close(); c2.close()
        _kill(agent, other)


def test_an_orphaned_grandchild_is_still_the_agent(server):
    """A parent-PID walk loses this one: its parent has exited."""
    sport = server.getsockname()[1]
    p, conn, cport = _connect(server, True, ORPHAN, CONNECT)
    try:
        p.wait(timeout=20)                         # the parent is gone
        pid = G.client_pid(cport, sport)
        assert pid and pid != p.pid
        assert G.in_job(pid) is True
        assert G.refuse("POST", "/api/code/tasks/t1/approve", cport, sport)
    finally:
        conn.close()
        if pid:
            subprocess.run(["taskkill", "/PID", str(pid), "/F"], capture_output=True)


def test_nothing_is_refused_once_the_agents_are_gone(server):
    sport = server.getsockname()[1]
    p, conn, cport = _connect(server, adopt=True)
    conn.close()
    _kill(p)
    p.wait(timeout=20)
    for _ in range(50):
        if not G.agents_running():
            break
        time.sleep(0.1)
    assert not G.agents_running()
    assert not G.refuse("POST", "/api/code/tasks/t1/approve", 1, sport)
