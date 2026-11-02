"""Agent Town SDK for Python >= 3.9 — one file, standard library only.

Docs: {{BASE_URL}}/agents.md ("Agents built with SDKs, on servers and in CI"). Contract: docs/protocol.md.

    import agenttown
    town = agenttown.connect(persona="Scout", kind="my-bot")
    s = town.session()
    s.thinking("Summarize the inbox")   # new task; the title is encrypted here, the server sees ciphertext only
    s.tool("search"); s.thinking(); s.idle(); s.end()

Every call is fire-and-forget: it only queues the report for a background thread, never raises, and gives up after
a short timeout, so Agent Town being down or misconfigured can't slow or break the host agent.

Task titles are end-to-end encrypted (AES-256-GCM). The standard library has no AES-GCM, so titles are sent only when
the `cryptography` package is importable (`pip install cryptography`); without it you get status and task numbers
(`task #12`), never a plaintext title. Adapters for agent frameworks are at the bottom; none imports a framework
unless it is already installed.
"""

import atexit
import base64
import hashlib
import hmac
import json
import os
import queue
import re
import secrets
import sys
import threading
import time
import urllib.error
import urllib.request

try:  # optional: only for task titles
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
except Exception:  # pragma: no cover - depends on the environment
    AESGCM = None

_BASE_URL = "{{BASE_URL}}"  # the site fills this in when it serves the file
DEFAULT_SERVER = "https://agenttown.xyz" if _BASE_URL.startswith("{{") else _BASE_URL
SDK_VERSION = "1.0.0"
STATUSES = ("thinking", "tool", "background", "waiting", "idle", "ended")
_BUSY = {"thinking", "tool", "background"}
_TOKEN_RE = re.compile(r"^[0-9a-f]{64}$")
# Default persona names for the kinds the adapters use (any other kind: "Agent").
_DEFAULT_PERSONAS = {
    "claude-agent-sdk": "Claude", "openai-agents": "Agents", "langchain": "LangChain", "langgraph": "LangGraph",
    "ai-sdk": "AI SDK", "github-actions": "CI",
}


def _debug(env, msg):
    if env.get("AGENTTOWN_DEBUG") == "1":
        try:
            print("agenttown: " + msg, file=sys.stderr)
        except Exception:
            pass


# ---------- crypto (same as the CLI, see docs/protocol.md) ----------

def auth_token(owner_key):
    return hmac.new(owner_key.encode("utf-8"), b"agenttown/auth/v1", hashlib.sha256).hexdigest()


def enc_key(owner_key):
    return hmac.new(owner_key.encode("utf-8"), b"agenttown/enc/v1", hashlib.sha256).digest()


def _b64url(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")


def _unb64url(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def task_title(text):
    """First non-empty line, whitespace collapsed, at most 80 characters (what the CLI's hooks send as a title)."""
    for line in str(text if text is not None else "").splitlines():
        line = " ".join(line.split())
        if line:
            return line[:79] + "…" if len(line) > 80 else line
    return ""


def can_encrypt():
    return AESGCM is not None


def encrypt_title(key, title):
    """title_enc = "v1." + b64url(iv) + "." + b64url(AES-256-GCM(utf8(title) <= 480 bytes, zero-padded) || tag).

    Returns None when the `cryptography` package is missing: then no title is sent at all.
    """
    if AESGCM is None:
        return None
    s = str(title)
    while len(s.encode("utf-8")) > 480:
        s = s[:-1]
    raw = s.encode("utf-8")
    pt = raw + b"\0" * (((len(raw) + 1 + 31) // 32) * 32 - len(raw))
    iv = secrets.token_bytes(12)
    return "v1." + _b64url(iv) + "." + _b64url(AESGCM(key).encrypt(iv, pt, None))


# ---------- credentials ----------

def _parse_json(s):
    try:
        v = json.loads(s)
        return v if isinstance(v, dict) else None
    except Exception:
        return None


def _as_key(v):
    try:
        b = _unb64url(v) if isinstance(v, str) else bytes(v)
        return b if len(b) == 32 else None
    except Exception:
        return None


def load_credentials(credentials=None, owner_key=None, token=None, enc_key_b64=None, config=None, server=None, env=None):
    """Where the credentials come from, first match wins:

    arguments: credentials (a config.json dict or string) | owner_key | token (+ enc_key_b64)
    env:       AGENTTOWN_CREDENTIALS (the JSON of a config.json) | AGENTTOWN_OWNER_KEY | AGENTTOWN_TOKEN (+ AGENTTOWN_ENC_KEY)
    file:      config | AGENTTOWN_CONFIG | ~/.agenttown/config.json (what `agenttown register` / `join` write)

    Returns None when there are none (the SDK then does nothing). Never raises.
    """
    env = os.environ if env is None else env
    cfg = None
    try:
        if credentials:
            cfg = _parse_json(credentials) if isinstance(credentials, str) else dict(credentials)
        elif owner_key or token:
            cfg = {"owner_key": owner_key, "device_token": token, "enc_key": enc_key_b64}
        elif env.get("AGENTTOWN_CREDENTIALS"):
            cfg = _parse_json(env["AGENTTOWN_CREDENTIALS"])
        elif env.get("AGENTTOWN_OWNER_KEY") or env.get("AGENTTOWN_TOKEN"):
            cfg = {"owner_key": env.get("AGENTTOWN_OWNER_KEY"), "device_token": env.get("AGENTTOWN_TOKEN"),
                   "enc_key": env.get("AGENTTOWN_ENC_KEY")}
        else:
            path = config or env.get("AGENTTOWN_CONFIG") or os.path.join(os.path.expanduser("~"), ".agenttown", "config.json")
            try:
                with open(path, encoding="utf-8") as f:
                    cfg = _parse_json(f.read())
            except Exception:
                cfg = None
    except Exception:
        cfg = None
    if not cfg:
        return None
    ok = cfg.get("owner_key")
    ok = ok if isinstance(ok, str) and ok.startswith("atk_") else None
    tok = auth_token(ok) if ok else str(cfg.get("device_token") or "").strip().lower()
    if not _TOKEN_RE.match(tok):
        _debug(env, "credentials found but no owner key or 64-hex token in them")
        return None
    personas = cfg.get("personas")
    return {
        "server": str(server or env.get("AGENTTOWN_SERVER") or cfg.get("server") or DEFAULT_SERVER).rstrip("/"),
        "token": tok,
        # No key (a bare token): status only, no titles.
        "enc_key": enc_key(ok) if ok else _as_key(cfg.get("enc_key") or enc_key_b64 or ""),
        "home_id": cfg.get("home_id"),
        "personas": personas if isinstance(personas, dict) else {},
        "titles": cfg.get("titles") is not False and env.get("AGENTTOWN_TITLES") != "0",
        "disabled": cfg.get("disabled") is True or env.get("AGENTTOWN_DISABLED") == "1",
    }


# ---------- town & sessions ----------

def _safe_id(v, n=128):
    return re.sub(r"[^\w.:-]", "-", v, flags=re.ASCII)[:n] if isinstance(v, str) and v else None


def _new_id():
    return "sdk-" + secrets.token_hex(6)


class Town:
    """One per process (or per persona). Reports go out on one background thread, in order per session."""

    def __init__(self, persona=None, kind=None, server=None, credentials=None, owner_key=None, token=None,
                 enc_key=None, config=None, timeout=3.0, titles=True, tool_names=True, keep_alive=False,
                 heartbeat=240.0, busy_max=7200.0, on_error=None, auto_end=True, env=None):
        self.env = os.environ if env is None else env
        self.creds = load_credentials(credentials, owner_key, token, enc_key, config, server, self.env)
        self.enabled = bool(self.creds) and not self.creds["disabled"]
        self.kind = (_safe_id(kind or self.env.get("AGENTTOWN_KIND") or "") or "sdk").lower()
        personas = self.creds["personas"] if self.creds else {}
        self.persona = str(persona or self.env.get("AGENTTOWN_PERSONA") or personas.get(self.kind)
                           or _DEFAULT_PERSONAS.get(self.kind) or "Agent")[:32]
        self.timeout = timeout
        # Titles need the home's key and `cryptography`; titles=False sends task numbers only.
        self.titles = bool(titles) and bool(self.creds and self.creds["titles"] and self.creds["enc_key"]) and can_encrypt()
        self.tool_names = tool_names
        self.keep_alive = keep_alive
        self.heartbeat = heartbeat
        self.busy_max = busy_max
        self.on_error = on_error
        self.sessions = {}
        self._default = None
        self._lock = threading.RLock()
        self._ready = queue.Queue()
        self._outstanding = 0
        self._drained = threading.Condition(self._lock)
        self._thread = None
        if self.enabled and auto_end:
            atexit.register(self.close, 2.0)
        if not self.creds:
            _debug(self.env, "no credentials (run `agenttown register` or `join`, or set AGENTTOWN_CREDENTIALS); not reporting")
        elif self.creds["titles"] and self.creds["enc_key"] and titles and not can_encrypt():
            _debug(self.env, "`cryptography` is not installed: sending task numbers without titles")

    def session(self, id=None, persona=None, kind=None, parent=None, keep_alive=None):
        """A desk in the home. Without arguments: this town's default session (one per Town)."""
        with self._lock:
            if not (id or persona or kind or parent):
                if self._default is None or self._default._ended_for_good:
                    self._default = self.session(id=_new_id())
                return self._default
            sid = _safe_id(id) or _new_id()
            s = self.sessions.get(sid)
            if s is None:
                s = Session(self, sid, str(persona)[:32] if persona else self.persona,
                            (_safe_id(kind) or self.kind).lower() if kind else self.kind,
                            _safe_id(parent) if parent else None, self.keep_alive if keep_alive is None else keep_alive)
                self.sessions[sid] = s
            return s

    def persona_update(self, name=None, kind=None, appearance=None):
        """Create or update the persona (appearance: one sentence; a character is drawn for it). Queued like reports."""
        body = {"name": str(name or self.persona)[:32], "kind": (_safe_id(kind) or self.kind).lower() if kind else self.kind}
        if appearance is not None:
            body["appearance"] = appearance
        self._submit(("/personas", body))

    def flush(self, timeout=None):
        """Waits until everything queued is sent (or timeout seconds pass). Returns True if drained."""
        end = None if timeout is None else time.monotonic() + timeout
        with self._drained:
            while self._outstanding:
                left = None if end is None else end - time.monotonic()
                if left is not None and left <= 0:
                    return False
                self._drained.wait(left)
        return True

    def close(self, timeout=2.0):
        """Ends every open session, then flushes (at most `timeout` seconds)."""
        try:
            with self._lock:
                open_sessions = [s for s in self.sessions.values() if s.status and s.status != "ended"]
            for s in open_sessions:
                s.end()
            self.flush(timeout)
        except Exception:
            pass

    # -- internals --

    def _submit(self, item):
        """item: a Session (send its next queued report) or a (path, body) tuple."""
        if not self.enabled:
            return
        with self._lock:
            self._outstanding += 1
            if self._thread is None or not self._thread.is_alive():
                self._thread = threading.Thread(target=self._run, name="agenttown", daemon=True)
                self._thread.start()
        self._ready.put(item)

    def _run(self):
        checked = time.monotonic()
        while True:
            if time.monotonic() - checked >= min(self.heartbeat, 60.0):
                checked = time.monotonic()
                self._heartbeats()
            try:
                item = self._ready.get(timeout=min(self.heartbeat, 60.0))
            except queue.Empty:
                continue
            try:
                if isinstance(item, Session):
                    body = item._next()
                    if body is not None:
                        self._post("/report", body)
                    item._sent()
                else:
                    self._post(*item)
            except Exception:
                pass
            finally:
                with self._drained:
                    self._outstanding -= 1
                    if not self._outstanding:
                        self._drained.notify_all()

    def _heartbeats(self):
        with self._lock:
            sessions = list(self.sessions.values())
        for s in sessions:
            try:
                s._heartbeat()
            except Exception:
                pass

    def _post(self, path, body):
        if not self.enabled:
            return None
        req = urllib.request.Request(
            self.creds["server"] + "/v1" + path, data=json.dumps(body).encode("utf-8"), method="POST",
            headers={"content-type": "application/json", "authorization": "Bearer " + self.creds["token"],
                     "user-agent": "agenttown-sdk/%s (python)" % SDK_VERSION})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:
                return json.loads(res.read() or b"{}")
        except Exception as e:
            if isinstance(e, urllib.error.HTTPError):
                try:
                    code = json.loads(e.read() or b"{}").get("error")
                except Exception:
                    code = None
                # Revoked/unknown credential or a banned home: stop trying for the rest of this process.
                if e.code == 401 or (e.code == 403 and code == "banned"):
                    self.enabled = False
            _debug(self.env, "%s: %s" % (path, e))
            if self.on_error:
                try:
                    self.on_error(e)
                except Exception:
                    pass
            return None


class Session:
    def __init__(self, town, id, persona, kind, parent, keep_alive):
        self.town, self.id, self.persona, self.kind, self.parent, self.keep_alive = town, id, persona, kind, parent, keep_alive
        self.status = None
        self.tool_name = None
        self._pending = []
        self._scheduled = False
        self._last_sent = 0.0
        self._last_real = 0.0
        self._ended_for_good = False

    def report(self, status, tool=None, task=None):
        """status: thinking | tool | background | waiting | idle | ended.

        task: a string starts a new task with that (encrypted) title; True starts one without a title.
        """
        if status not in STATUSES:
            return
        t = self.town
        with t._lock:
            self.status = status
            self.tool_name = ((str(tool)[:64] if tool else "Other") if t.tool_names else "Tool") if status == "tool" else None
            self._last_real = time.monotonic()
            if not t.enabled:
                return
            body = self._body()
            if task is not None and task is not False:
                title = task_title(task) if isinstance(task, str) else ""
                enc = encrypt_title(t.creds["enc_key"], title) if t.titles and title else None
                body["task"] = {"title_enc": enc} if enc else {}
            # Only the latest status matters, but every task start must reach the server (it numbers tasks).
            self._pending = [b for b in self._pending if "task" in b] + [body]
            if self._scheduled:
                return
            self._scheduled = True
        t._submit(self)

    def thinking(self, task=None):
        self.report("thinking", task=task)

    def tool(self, name=None):
        self.report("tool", tool=name)

    def background(self):
        self.report("background")

    def waiting(self):
        self.report("waiting")

    def idle(self):
        self.report("idle")

    def end(self):
        if self.town._default is self:
            self._ended_for_good = True
        self.report("ended")

    def child(self, id, persona=None):
        """A subagent: its own desk next to this one."""
        return self.town.session(id=("%s:%s" % (self.id, _safe_id(str(id))))[:128], persona=persona or self.persona,
                                 kind=self.kind, parent=self.id)

    # -- internals (called on the town's thread) --

    def _body(self):
        body = {"persona": {"name": self.persona, "kind": self.kind}, "session": self.id, "status": self.status}
        if self.parent:
            body["parent"] = self.parent
        if self.tool_name:
            body["tool"] = self.tool_name
        return body

    def _next(self):
        with self.town._lock:
            if not self._pending:
                return None
            self._last_sent = time.monotonic()
            return self._pending.pop(0)

    def _sent(self):
        t = self.town
        with t._lock:
            if self._pending:
                again = True
            else:
                again = self._scheduled = False
                if self.status == "ended" and t.sessions.get(self.id) is self:
                    del t.sessions[self.id]
        if again:
            t._submit(self)

    def _heartbeat(self):
        # Sessions silent for 10 min (30 if busy) leave their desk on the server, so long busy stretches are repeated
        # every few minutes (at most busy_max: a stuck "thinking" must not live forever); idle desks only with keep_alive.
        t = self.town
        now = time.monotonic()
        with t._lock:
            if not self.keep_alive and self.status not in _BUSY and now - self._last_real > 3600 and not self._scheduled:
                t.sessions.pop(self.id, None)  # long quiet: the server ended it already; it comes back on the next report
            if not self.status or self.status == "ended" or self._scheduled or now - self._last_sent < t.heartbeat:
                return
            if (now - self._last_real > t.busy_max) if self.status in _BUSY else not self.keep_alive:
                return
            self._pending.append(self._body())
            self._scheduled = True
        t._submit(self)


def connect(**opts):
    """connect(persona=, kind=, ...) -> Town. Without credentials (or AGENTTOWN_DISABLED=1) everything is a no-op."""
    return Town(**opts)


_towns = {}
_towns_lock = threading.Lock()


def _as_town(town, kind, opts):
    """Adapters given options instead of a Town share one Town per distinct options."""
    if isinstance(town, Town):
        return town
    opts = dict(opts)
    opts.setdefault("kind", kind)
    key = repr(sorted((k, repr(v)) for k, v in opts.items() if not callable(v)))
    with _towns_lock:
        if key not in _towns:
            _towns[key] = Town(**opts)
        return _towns[key]


def _title_of(opt, *args):
    try:
        v = opt(*args) if callable(opt) else opt
        return v or True
    except Exception:
        return True


def _quiet(fn):
    def wrapper(*args, **kwargs):
        try:
            fn(*args, **kwargs)
        except Exception:
            pass
    return wrapper


# ---------- adapters (duck-typed: a framework is imported only if it is installed) ----------

# Claude Agent SDK (claude-agent-sdk): ClaudeAgentOptions(hooks=...). Sessions follow the SDK's session_id; subagents
# (agent_id) get their own desk; the prompt's first line becomes the encrypted task title. The Python SDK has no
# SessionStart/SessionEnd callback hooks, so a session that finishes simply goes idle (and leaves after 10 minutes).
CLAUDE_AGENT_SDK_EVENTS = ("UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest",
                           "Notification", "SubagentStart", "SubagentStop", "Stop")
_WAIT_NOTIFICATIONS = {"permission_prompt", "idle_prompt", "elicitation_dialog", "agent_needs_input"}


def claude_agent_sdk_hooks(town=None, existing=None, **opts):
    """ClaudeAgentOptions(hooks=agenttown.claude_agent_sdk_hooks(town)) — `existing`: your own hooks dict to extend."""
    town = _as_town(town, "claude-agent-sdk", opts)

    @_quiet
    def handle(d):
        sid = _safe_id(d.get("session_id"))
        if not sid:
            return
        main = town.session(id=sid)
        sub = main.child(d["agent_id"]) if d.get("agent_id") else None
        here = sub or main
        ev = d.get("hook_event_name")
        if ev == "UserPromptSubmit":
            main.thinking(task_title(d.get("prompt")) or True)
        elif ev == "PreToolUse":
            here.tool(d.get("tool_name"))
        elif ev in ("PostToolUse", "PostToolUseFailure"):
            here.thinking()
        elif ev == "PermissionRequest" or (ev == "Notification" and d.get("notification_type") in _WAIT_NOTIFICATIONS):
            here.waiting()
        elif ev == "SubagentStart" and sub:
            sub.thinking(d.get("agent_type") or True)
        elif ev == "SubagentStop" and sub:
            sub.end()
        elif ev == "Stop":
            main.idle()

    async def callback(input_data, tool_use_id=None, context=None):
        handle(input_data if isinstance(input_data, dict) else dict(getattr(input_data, "__dict__", {})))
        return {}

    try:
        from claude_agent_sdk import HookMatcher

        def matcher():
            return HookMatcher(hooks=[callback])
    except Exception:  # not installed (tests, or a fork with plain dicts)
        def matcher():
            return {"matcher": None, "hooks": [callback]}

    hooks = dict(existing or {})
    for ev in CLAUDE_AGENT_SDK_EVENTS:
        hooks[ev] = list(hooks.get(ev) or []) + [matcher()]
    return hooks


def _base(module, name):
    try:
        mod = __import__(module, fromlist=[name])
        return getattr(mod, name)
    except Exception:
        return object


def openai_agents_hooks(town=None, title=None, session=None, **opts):
    """OpenAI Agents SDK (openai-agents): Runner.run(agent, input, hooks=agenttown.openai_agents_hooks(town)).

    title: a string or a function(agent) -> str for each run's task title.
    """
    town = _as_town(town, "openai-agents", opts)
    s = session or town.session()
    base = _base("agents", "RunHooks")

    class AgentTownRunHooks(base):
        def __init__(self):
            self._busy = False

        async def on_agent_start(self, context, agent, *a, **k):
            if self._busy:
                s.thinking()
            else:
                self._busy = True
                s.thinking(_title_of(title, agent))

        async def on_llm_start(self, *a, **k):
            s.thinking()

        async def on_llm_end(self, *a, **k):
            pass

        async def on_tool_start(self, context, agent, tool, *a, **k):
            s.tool(getattr(tool, "name", None))

        async def on_tool_end(self, *a, **k):
            s.thinking()

        async def on_handoff(self, *a, **k):
            s.thinking()

        async def on_agent_end(self, *a, **k):
            self._busy = False
            s.idle()

        def __getattr__(self, name):  # hooks added by later SDK versions: no-ops
            if name.startswith("on_"):
                async def noop(*a, **k):
                    return None
                return noop
            raise AttributeError(name)

    for n in [n for n in vars(AgentTownRunHooks) if n.startswith("on_") and n != "__getattr__"]:
        setattr(AgentTownRunHooks, n, _quiet_async(getattr(AgentTownRunHooks, n)))
    return AgentTownRunHooks()


def _quiet_async(fn):
    async def wrapper(*args, **kwargs):
        try:
            await fn(*args, **kwargs)
        except Exception:
            pass
    wrapper.__name__ = getattr(fn, "__name__", "hook")
    return wrapper


def openai_agents_tracing(town=None, title=None, session=None, **opts):
    """OpenAI Agents SDK, for every run in the process: agents.add_trace_processor(agenttown.openai_agents_tracing(town)).

    title: a string or a function(trace) -> str. Needs tracing enabled (it is by default).
    """
    town = _as_town(town, "openai-agents", opts)
    s = session or town.session()
    base = _base("agents.tracing", "TracingProcessor")

    class AgentTownTracing(base):
        def __init__(self):
            self._traces = set()
            self._lock = threading.Lock()

        @_quiet
        def on_trace_start(self, trace):
            with self._lock:
                first = not self._traces
                self._traces.add(getattr(trace, "trace_id", id(trace)))
            s.thinking(_title_of(title, trace) if first else None)

        @_quiet
        def on_trace_end(self, trace):
            with self._lock:
                self._traces.discard(getattr(trace, "trace_id", id(trace)))
                done = not self._traces
            s.idle() if done else s.thinking()

        @_quiet
        def on_span_start(self, span):
            data = getattr(span, "span_data", None)
            kind = getattr(data, "type", None)
            if kind == "function":
                s.tool(getattr(data, "name", None))
            elif kind in ("generation", "response", "agent", "handoff"):
                s.thinking()

        @_quiet
        def on_span_end(self, span):
            if getattr(getattr(span, "span_data", None), "type", None) == "function":
                s.thinking()

        def shutdown(self):
            pass

        def force_flush(self):
            town.flush(1.0)

    return AgentTownTracing()


def langchain_handler(town=None, title=None, session=None, **opts):
    """LangChain / LangGraph: pass it in callbacks=[...] (or config={"callbacks": [...]}).

    title: a string or a function(inputs) -> str for each top-level run's task title.
    """
    town = _as_town(town, "langchain", opts)
    s = session or town.session()
    base = _base("langchain_core.callbacks", "BaseCallbackHandler")

    class AgentTownCallbackHandler(base):
        raise_error = False
        run_inline = True  # every method only queues a report, so it is safe on the event loop
        ignore_llm = ignore_chain = ignore_agent = ignore_chat_model = False
        ignore_retriever = ignore_retry = ignore_custom_event = True

        def __init__(self):
            self._roots = set()
            self._lock = threading.Lock()

        def _start(self, run_id, parent_run_id, arg, status):
            if parent_run_id is not None:
                return status()
            with self._lock:
                first = not self._roots
                self._roots.add(run_id)
            if first:
                s.thinking(_title_of(title, arg))
            if status != s.thinking:
                status()

        def _end(self, run_id, only_roots=False):
            with self._lock:
                was_root = run_id in self._roots
                self._roots.discard(run_id)
                left = len(self._roots)
            if was_root and not left:
                s.idle()
            elif left and not only_roots:
                s.thinking()

        @_quiet
        def on_chain_start(self, serialized, inputs, *, run_id=None, parent_run_id=None, **kw):
            self._start(run_id, parent_run_id, inputs, s.thinking)

        @_quiet
        def on_chain_end(self, outputs, *, run_id=None, **kw):
            self._end(run_id)

        @_quiet
        def on_chain_error(self, error, *, run_id=None, **kw):
            self._end(run_id)

        @_quiet
        def on_llm_start(self, serialized, prompts, *, run_id=None, parent_run_id=None, **kw):
            self._start(run_id, parent_run_id, prompts, s.thinking)

        @_quiet
        def on_chat_model_start(self, serialized, messages, *, run_id=None, parent_run_id=None, **kw):
            self._start(run_id, parent_run_id, messages, s.thinking)

        @_quiet
        def on_llm_end(self, response, *, run_id=None, **kw):
            self._end(run_id, only_roots=True)

        @_quiet
        def on_llm_error(self, error, *, run_id=None, **kw):
            self._end(run_id, only_roots=True)

        @_quiet
        def on_tool_start(self, serialized, input_str, *, run_id=None, parent_run_id=None, **kw):
            name = kw.get("name") or (serialized or {}).get("name")
            self._start(run_id, parent_run_id, input_str, lambda: s.tool(name))

        @_quiet
        def on_tool_end(self, output, *, run_id=None, **kw):
            self._end(run_id)

        @_quiet
        def on_tool_error(self, error, *, run_id=None, **kw):
            self._end(run_id)

        def __getattr__(self, name):  # callbacks we don't use (and ones added later): no-ops
            if name.startswith("on_"):
                return lambda *a, **k: None
            raise AttributeError(name)

    return AgentTownCallbackHandler()
