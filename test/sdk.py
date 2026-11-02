"""Python half of test/sdk.ts: the served public/sdk/agenttown.py against a capture server and the real test server.

Run by test/sdk.ts with AGENTTOWN_TEST_SDK (path of the served file), AGENTTOWN_TEST_BASE, AGENTTOWN_TEST_OWNER_KEY.
"""
import asyncio
import importlib.util
import json
import os
import socket
import tempfile
import threading
import time
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location("agenttown", os.environ["AGENTTOWN_TEST_SDK"])
at = importlib.util.module_from_spec(spec)
spec.loader.exec_module(at)
BASE = os.environ["AGENTTOWN_TEST_BASE"]
OWNER_KEY = os.environ["AGENTTOWN_TEST_OWNER_KEY"]
NOCFG = {"AGENTTOWN_CONFIG": "/nonexistent/agenttown.json"}

assert at.DEFAULT_SERVER == BASE, "the site filled in {{BASE_URL}}"

# ---- crypto & titles ----
assert at.task_title("\n   Fix   the login\tpage  \nsecond line") == "Fix the login page"
assert at.task_title("x" * 100) == "x" * 79 + "…"
assert at.task_title(None) == ""
assert at.auth_token("atk_abc") == __import__("hmac").new(b"atk_abc", b"agenttown/auth/v1", "sha256").hexdigest()
key = at.enc_key(OWNER_KEY)
if at.can_encrypt():
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    for title in ("hi", "猫" * 200, "x" * 31, "x" * 32):
        enc = at.encrypt_title(key, title)
        v, iv, ct = enc.split(".")
        pt = AESGCM(key).decrypt(at._unb64url(iv), at._unb64url(ct), None)
        assert v == "v1" and len(pt) % 32 == 0 and pt.endswith(b"\0") and len(pt.rstrip(b"\0")) <= 480
        assert pt.rstrip(b"\0").decode() == title[: len(pt.rstrip(b"\0").decode())]
else:
    assert at.encrypt_title(key, "hi") is None

# ---- credentials ----
assert at.load_credentials(env=NOCFG) is None
c = at.load_credentials(env={"AGENTTOWN_OWNER_KEY": OWNER_KEY, "AGENTTOWN_SERVER": "http://x/"})
assert c["token"] == at.auth_token(OWNER_KEY) and c["enc_key"] == key and c["server"] == "http://x"
dev = {"device_token": "ab" * 32, "enc_key": at._b64url(key), "server": "http://dev", "personas": {"langchain": "Lang"}}
c = at.load_credentials(env={"AGENTTOWN_CREDENTIALS": json.dumps(dev), "AGENTTOWN_OWNER_KEY": OWNER_KEY})
assert c["token"] == "ab" * 32 and c["enc_key"] == key and c["server"] == "http://dev", "AGENTTOWN_CREDENTIALS wins"
c = at.load_credentials(env={"AGENTTOWN_TOKEN": "CD" * 32})
assert c["token"] == "cd" * 32 and c["enc_key"] is None, "bare token: no titles"
assert at.load_credentials(env={"AGENTTOWN_TOKEN": "nope"}) is None
with tempfile.TemporaryDirectory() as d:
    p = os.path.join(d, "config.json")
    with open(p, "w") as f:
        json.dump({**dev, "titles": False}, f)
    c = at.load_credentials(env={"AGENTTOWN_CONFIG": p})
    assert c["token"] == "ab" * 32 and c["titles"] is False
    t = at.Town(kind="langchain", env={"AGENTTOWN_CONFIG": p})
    assert t.persona == "Lang" and not t.titles, "persona from config.personas[kind]; titles off by config"
assert at.load_credentials(env={"AGENTTOWN_CREDENTIALS": json.dumps(dev), "AGENTTOWN_DISABLED": "1"})["disabled"]
assert not at.Town(env={"AGENTTOWN_CREDENTIALS": json.dumps(dev), "AGENTTOWN_DISABLED": "1"}).enabled
assert at.Town(env=NOCFG).persona == "Agent" and at.Town(kind="openai-agents", env=NOCFG).persona == "Agents"
# No credentials: everything is a silent no-op.
nt = at.Town(env=NOCFG)
nt.session().thinking("x"); nt.session().end(); assert nt.flush(0.1)

# ---- capture server ----
captured = []
mode = {"status": 200}


class Capture(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("content-length") or 0))
        captured.append({"path": self.path, "raw": raw.decode(), "body": json.loads(raw), "auth": self.headers.get("authorization"),
                         "ua": self.headers.get("user-agent")})
        out = json.dumps({"error": "unauthorized"} if mode["status"] == 401 else {"session_id": "s_x", "task_no": len(captured)}).encode()
        self.send_response(mode["status"])
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


cap = ThreadingHTTPServer(("127.0.0.1", 0), Capture)
threading.Thread(target=cap.serve_forever, daemon=True).start()
CAP = "http://127.0.0.1:%d" % cap.server_address[1]


def town(**kw):
    kw.setdefault("auto_end", False)
    return at.Town(owner_key=OWNER_KEY, server=CAP, env=NOCFG, **kw)


def last(n=1):
    return [x["body"] for x in captured[-n:]]


T = town(persona="Pip", kind="my-bot")
s = T.session()
assert s is T.session() and s.id.startswith("sdk-"), "one default session per town"
s.thinking("Secret title\nnot this line"); T.flush(5)
b = last()[0]
assert b["persona"] == {"name": "Pip", "kind": "my-bot"} and b["session"] == s.id and b["status"] == "thinking"
assert captured[-1]["auth"] == "Bearer " + at.auth_token(OWNER_KEY) and captured[-1]["ua"].startswith("agenttown-sdk/")
if at.can_encrypt():
    assert set(b["task"]) == {"title_enc"} and b["task"]["title_enc"].startswith("v1.")
    v, iv, ct = b["task"]["title_enc"].split(".")
    assert AESGCM(key).decrypt(at._unb64url(iv), at._unb64url(ct), None).rstrip(b"\0") == b"Secret title"
else:
    assert b["task"] == {}
s.tool("web_search"); T.flush(5); assert last()[0]["status"] == "tool" and last()[0]["tool"] == "web_search" and "task" not in last()[0]
s.thinking(True); T.flush(5); assert last()[0]["task"] == {}, "True: a new task without a title"
s.waiting(); T.flush(5); assert last()[0]["status"] == "waiting" and "tool" not in last()[0]
s.idle(); T.flush(5)
kid = s.child("helper-1")
kid.thinking("sub"); T.flush(5); assert last()[0]["parent"] == s.id and last()[0]["session"] == s.id + ":helper-1"
s.end(); T.flush(5); assert last()[0]["status"] == "ended" and s.id not in T.sessions
assert T.session() is not s, "a new default session after end()"
s.report("bogus"); T.flush(1)
assert all("Secret title" not in x["raw"] and "not this line" not in x["raw"] for x in captured), "never a plaintext title"

# Coalescing: only the latest status is kept, every task start goes out, in order.
n0 = len(captured)
c = T.session(id="burst")
for i in range(30):
    c.tool("t%d" % i)
c.thinking("A"); c.tool("x"); c.thinking("B"); c.idle()
T.flush(5)
burst = [x["body"] for x in captured[n0:]]
assert burst[-1]["status"] == "idle" and sum(1 for x in burst if "task" in x) == 2 and len(burst) <= 6, burst

# Titles off / tool names off / no cryptography.
T2 = town(titles=False, tool_names=False)
T2.session().thinking("hidden"); T2.session().tool("secret_tool"); T2.flush(5)
assert last(2)[0]["task"] == {} and last()[0]["tool"] == "Tool"
saved = at.AESGCM
at.AESGCM = None
try:
    T3 = town()
    assert not T3.titles
    T3.session().thinking("no crypto here"); T3.flush(5)
    assert last()[0]["task"] == {} and "no crypto here" not in captured[-1]["raw"]
finally:
    at.AESGCM = saved

# Heartbeats: busy desks and keep_alive idle desks are repeated, plain idle ones are not.
T4 = town(heartbeat=0.2)
h = T4.session(id="hb-idle"); h.idle(); T4.flush(5)
hk = T4.session(id="hb-keep", keep_alive=True); hk.idle()
hb = T4.session(id="hb-busy"); hb.tool("build")
time.sleep(1.2); T4.flush(5)
count = lambda sid: sum(1 for x in captured if x["body"].get("session") == sid)
assert count("hb-idle") == 1 and count("hb-keep") >= 2 and count("hb-busy") >= 2
assert [x["body"] for x in captured if x["body"].get("session") == "hb-busy"][-1]["tool"] == "build"
T4.close(); time.sleep(0.4)
assert captured[-1]["body"]["status"] == "ended"

# 401: stop trying.
mode["status"] = 401
T5 = town()
T5.session().thinking(); T5.flush(5)
assert not T5.enabled
n0 = len(captured); T5.session().idle(); T5.flush(1); assert len(captured) == n0
mode["status"] = 200

# Never blocks: a server that never answers, and one that isn't there.
hang = socket.socket(); hang.bind(("127.0.0.1", 0)); hang.listen(5)
Th = at.Town(owner_key=OWNER_KEY, server="http://127.0.0.1:%d" % hang.getsockname()[1], timeout=0.5, env=NOCFG, auto_end=False)
t0 = time.monotonic()
for _ in range(5):
    Th.session().thinking("x")
assert time.monotonic() - t0 < 0.2, "reports only queue"
assert Th.flush(5) and time.monotonic() - t0 < 3
free = socket.socket(); free.bind(("127.0.0.1", 0)); port = free.getsockname()[1]; free.close()
Tu = at.Town(owner_key=OWNER_KEY, server="http://127.0.0.1:%d" % port, timeout=0.5, env=NOCFG, auto_end=False)
Tu.session().thinking("x"); assert Tu.flush(5)
errors = []
Te = at.Town(owner_key=OWNER_KEY, server="http://127.0.0.1:%d" % port, timeout=0.5, env=NOCFG, on_error=errors.append,
             auto_end=False)
Te.session().idle(); Te.flush(5); assert len(errors) == 1

# ---- adapters with fake framework payloads ----
A = town(kind="claude-agent-sdk")
mine = {"PreToolUse": ["my-matcher"]}
hooks = at.claude_agent_sdk_hooks(A, existing=mine)
assert hooks["PreToolUse"][0] == "my-matcher" and len(hooks["PreToolUse"]) == 2 and "SessionEnd" not in hooks
assert mine == {"PreToolUse": ["my-matcher"]}, "existing hooks are not mutated"


def cb(ev):
    m = hooks[ev][-1]
    return m["hooks"][0] if isinstance(m, dict) else m.hooks[0]


def fire(ev, **d):
    r = asyncio.run(cb(ev)({"hook_event_name": ev, "session_id": "cas-1", "cwd": "/tmp", **d}, None, {}))
    assert r == {}
    A.flush(5)
    return last()[0]


assert fire("UserPromptSubmit", prompt="Refactor auth\nwith details")["task"] != {} or not at.can_encrypt()
assert last()[0]["status"] == "thinking" and last()[0]["session"] == "cas-1" and last()[0]["persona"]["kind"] == "claude-agent-sdk"
assert fire("PreToolUse", tool_name="Bash", tool_input={"command": "rm -rf secret"})["tool"] == "Bash"
assert "rm -rf" not in captured[-1]["raw"]
assert fire("PostToolUse", tool_name="Bash")["status"] == "thinking"
b = fire("SubagentStart", agent_id="ag1", agent_type="Explore")
assert b["session"] == "cas-1:ag1" and b["parent"] == "cas-1" and "task" in b
assert fire("PreToolUse", tool_name="Grep", agent_id="ag1", agent_type="Explore")["session"] == "cas-1:ag1"
assert fire("SubagentStop", agent_id="ag1", agent_type="Explore")["status"] == "ended"
assert fire("Notification", notification_type="permission_prompt", message="?")["status"] == "waiting"
assert fire("PermissionRequest", tool_name="Bash")["status"] == "waiting"
assert fire("Stop")["status"] == "idle"
assert all("Refactor auth" not in x["raw"] for x in captured)
asyncio.run(cb("Stop")({"no": "session"}, None, None))  # junk payloads never raise
asyncio.run(cb("Stop")(None, None, None))

O = town(kind="openai-agents")
rh = at.openai_agents_hooks(O, title=lambda agent: "Run of " + agent.name)


async def run_openai():
    ctx, agent = object(), SimpleNamespace(name="Planner")
    await rh.on_agent_start(ctx, agent); O.flush(5)
    assert last()[0]["status"] == "thinking" and "task" in last()[0]
    await rh.on_llm_start(ctx, agent, "sys", []); await rh.on_tool_start(ctx, agent, SimpleNamespace(name="get_weather")); O.flush(5)
    assert last()[0]["tool"] == "get_weather"
    await rh.on_tool_end(ctx, agent, SimpleNamespace(name="get_weather"), "sunny")
    await rh.on_handoff(ctx, agent, SimpleNamespace(name="Writer"))
    await rh.on_agent_start(ctx, SimpleNamespace(name="Writer")); O.flush(5)
    assert "task" not in last()[0], "a handoff is not a new task"
    await rh.on_some_future_hook(ctx, 1, 2)
    await rh.on_tool_start(ctx, agent, None)  # odd payloads never raise
    await rh.on_agent_end(ctx, agent, "done"); O.flush(5)
    assert last()[0]["status"] == "idle"
asyncio.run(run_openai())
assert all("Run of Planner" not in x["raw"] for x in captured)

tp = at.openai_agents_tracing(O)
tp.on_trace_start(SimpleNamespace(trace_id="trace_1", name="wf")); O.flush(5); assert "task" in last()[0]
tp.on_trace_start(SimpleNamespace(trace_id="trace_2", name="wf")); O.flush(5); assert "task" not in last()[0], "already busy"
tp.on_span_start(SimpleNamespace(span_data=SimpleNamespace(type="function", name="lookup"))); O.flush(5)
assert last()[0]["tool"] == "lookup"
tp.on_span_end(SimpleNamespace(span_data=SimpleNamespace(type="function", name="lookup"))); O.flush(5)
assert last()[0]["status"] == "thinking"
tp.on_trace_end(SimpleNamespace(trace_id="trace_1")); O.flush(5); assert last()[0]["status"] == "thinking"
tp.on_trace_end(SimpleNamespace(trace_id="trace_2")); O.flush(5); assert last()[0]["status"] == "idle"
tp.on_span_start(None); tp.force_flush(); tp.shutdown()

L = town(kind="langchain")
lh = at.langchain_handler(L)
root, child, tool = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
lh.on_chain_start({}, {"input": "hi"}, run_id=root, parent_run_id=None); L.flush(5)
assert last()[0]["status"] == "thinking" and "task" in last()[0]
lh.on_chain_start({}, {}, run_id=child, parent_run_id=root)
lh.on_chat_model_start({}, [[]], run_id=uuid.uuid4(), parent_run_id=child)
lh.on_tool_start({"name": "calculator"}, "2+2", run_id=tool, parent_run_id=child); L.flush(5)
assert last()[0]["tool"] == "calculator"
lh.on_tool_end("4", run_id=tool, parent_run_id=child); L.flush(5); assert last()[0]["status"] == "thinking"
lh.on_chain_end({}, run_id=child, parent_run_id=root); lh.on_chain_end({}, run_id=root); L.flush(5)
assert last()[0]["status"] == "idle"
bare = uuid.uuid4()
lh.on_llm_start({}, ["p"], run_id=bare); lh.on_llm_end(None, run_id=bare); L.flush(5)
assert [x["status"] for x in last(2)] == ["thinking", "idle"]
lh.on_text("x", run_id=uuid.uuid4()); lh.on_retriever_start({}, "q", run_id=uuid.uuid4())  # unused callbacks are no-ops

try:
    from langchain_core.runnables import RunnableLambda
    from langchain_core.tools import tool as lc_tool

    @lc_tool
    def add_numbers(a: int, b: int) -> int:
        """Add two numbers."""
        time.sleep(0.4)  # long enough for the tool status to go out before the next one replaces it
        return a + b

    n0 = len(captured)
    chain = RunnableLambda(lambda x: add_numbers.invoke({"a": x, "b": 1})) | RunnableLambda(lambda y: y * 2)
    assert chain.invoke(1, config={"callbacks": [at.langchain_handler(L)]}) == 4
    L.flush(5)
    real = [x["body"] for x in captured[n0:]]
    assert real[0]["status"] == "thinking" and "task" in real[0], real
    assert any(x.get("tool") == "add_numbers" for x in real) and real[-1]["status"] == "idle", real

    async def arun():
        return await chain.ainvoke(2, config={"callbacks": [at.langchain_handler(L)]})
    assert asyncio.run(arun()) == 6
    L.flush(5)
    assert captured[-1]["body"]["status"] == "idle"
    print("sdk.py: real LangChain run ok")
except ImportError:
    print("sdk.py: langchain_core not installed, skipping the real LangChain run")

# ---- the real server ----
R = at.Town(owner_key=OWNER_KEY, server=BASE, persona="Pyra", kind="langchain", env=NOCFG, auto_end=False)
rs = R.session(id="py-real")
rs.thinking("Python title"); rs.tool("mcp__srv__x"); R.flush(10)
home = json.loads(urllib.request.urlopen(BASE + "/v1/homes/" + os.environ["AGENTTOWN_TEST_HOME"], timeout=5).read())
p = next(p for p in home["personas"] if p["name"] == "Pyra")
sess = next(x for x in home["sessions"] if x["persona_id"] == p["id"])
assert p["kind"] == "langchain" and sess["status"] == "tool" and sess["tool"] == "MCP" and sess["task_no"] >= 1
assert (sess["task_enc"] is not None) == at.can_encrypt()
print("sdk.py: crypto=%s" % at.can_encrypt())
print("sdk.py: all checks passed")
