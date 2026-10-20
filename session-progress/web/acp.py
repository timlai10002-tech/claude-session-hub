"""ACP sessions for the web view: the server as an Agent Client Protocol client.

Each session is its own claude-agent-acp process (../acp/node_modules), spoken
to in newline-delimited JSON-RPC over stdio. The server keeps what a page
needs to draw the conversation: messages, tool calls, the plan, and the
permission request the agent is waiting on, which the page answers with one
of the agent's own options (allow once, allow always, reject).

Sessions live as long as this server process; a restart ends them.
"""
import json, os, subprocess, threading, time, uuid

HERE = os.path.dirname(os.path.abspath(__file__))
HOME = os.path.expanduser("~")
AGENT = os.path.join(os.path.dirname(HERE), "acp", "node_modules", ".bin", "claude-agent-acp")
PROTOCOL_VERSION = 1
MAX_ITEMS = 400
MAX_TEXT = 20_000
# Modes a page may switch to; bypassPermissions is left out on purpose.
MODES = ("default", "acceptEdits", "plan", "auto")


def clip(s, n=MAX_TEXT):
    s = s if isinstance(s, str) else json.dumps(s, ensure_ascii=False)
    return s if len(s) <= n else s[:n] + " …"


def tool_text(content):
    """The readable part of a tool call's content list: text blocks and diffs' paths."""
    out = []
    for c in content or []:
        if c.get("type") == "content" and (c.get("content") or {}).get("type") == "text":
            out.append(c["content"].get("text") or "")
        elif c.get("type") == "diff":
            out.append(f"diff {c.get('path', '')}")
    return clip("\n".join(out), 4000)


class Session:
    def __init__(self, cwd):
        self.id = uuid.uuid4().hex[:12]
        self.cwd = cwd
        self.title = os.path.basename(cwd.rstrip("/")) or cwd
        self.status = "starting"  # starting | idle | running | waiting | closed | error
        self.error = ""
        self.created = self.updated = time.time()
        self.version = 0
        self.items = []  # what the page draws, oldest first
        self.by_key = {}  # message id / tool call id -> item
        self.pending = None  # {"rpc": id, "toolCall": {...}, "options": [...]}
        self.usage = None
        self.modes, self.mode = [], "default"
        self.acp_sid = None
        self.lock = threading.RLock()
        self.next_id = 0
        self.waiters = {}  # rpc id -> callback(result, error)
        self.proc = subprocess.Popen([AGENT], cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.DEVNULL, text=True, bufsize=1, start_new_session=True)
        threading.Thread(target=self.read, daemon=True).start()
        self.request("initialize", {
            "protocolVersion": PROTOCOL_VERSION,
            # No fs or terminal: the agent reads, writes and runs commands itself.
            "clientCapabilities": {"fs": {"readTextFile": False, "writeTextFile": False}, "terminal": False},
            "clientInfo": {"name": "session-progress", "version": "0.4.0"},
        }, self.on_init)

    # --- JSON-RPC plumbing
    def write(self, msg):
        try:
            self.proc.stdin.write(json.dumps({"jsonrpc": "2.0", **msg}) + "\n")
            self.proc.stdin.flush()
        except (BrokenPipeError, OSError, ValueError):
            self.fail("the agent process ended")

    def request(self, method, params, done=None):
        with self.lock:
            self.next_id += 1
            rid = self.next_id
            if done:
                self.waiters[rid] = done
        self.write({"id": rid, "method": method, "params": params})

    def read(self):
        for line in self.proc.stdout:
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            try:
                self.dispatch(msg)
            except Exception as exc:  # one bad message must not end the session
                self.add({"type": "notice", "text": f"client error: {exc}"})
        with self.lock:
            if self.status != "closed":
                self.fail("the agent process ended")

    def dispatch(self, msg):
        method = msg.get("method")
        if method is None:  # a response to one of our requests
            done = self.waiters.pop(msg.get("id"), None)
            if done:
                done(msg.get("result"), msg.get("error"))
        elif method == "session/update":
            self.on_update((msg.get("params") or {}).get("update") or {})
        elif "id" in msg:  # a request from the agent
            if method == "session/request_permission":
                self.on_permission(msg["id"], msg.get("params") or {})
            else:
                self.write({"id": msg["id"], "error": {"code": -32601, "message": f"{method} is not supported"}})

    # --- state
    def touch(self):
        self.version += 1
        self.updated = time.time()

    def add(self, item, key=None):
        with self.lock:
            self.items.append(item)
            if key:
                self.by_key[key] = item
            if len(self.items) > MAX_ITEMS:
                gone = self.items.pop(0)
                self.by_key = {k: v for k, v in self.by_key.items() if v is not gone}
            self.touch()
        return item

    def fail(self, why):
        with self.lock:
            self.status, self.error = "error", why
            self.answer_pending(None)
            self.touch()

    # --- responses and updates
    def on_init(self, result, error):
        if error:
            return self.fail(f"initialize: {error.get('message')}")
        self.request("session/new", {"cwd": self.cwd, "mcpServers": []}, self.on_new)

    def on_new(self, result, error):
        if error:
            return self.fail(f"session/new: {error.get('message')}")
        with self.lock:
            self.acp_sid = result["sessionId"]
            modes = result.get("modes") or {}
            self.modes = [m for m in modes.get("availableModes") or [] if m.get("id") in MODES]
            self.mode = modes.get("currentModeId") or "default"
            self.status = "idle"
            self.touch()

    def on_update(self, u):
        kind = u.get("sessionUpdate")
        with self.lock:
            if kind in ("agent_message_chunk", "user_message_chunk", "agent_thought_chunk"):
                text = (u.get("content") or {}).get("text") or ""
                role = {"agent_message_chunk": "agent", "user_message_chunk": "user", "agent_thought_chunk": "thought"}[kind]
                key = f"{role}:{u.get('messageId') or 'm'}"
                item = self.by_key.get(key)
                # Chunks of one message (and consecutive id-less chunks) join into one item.
                if item is None and not u.get("messageId") and self.items and self.items[-1].get("role") == role:
                    item = self.items[-1]
                if item is None:
                    self.add({"type": "message", "role": role, "text": text}, key)
                else:
                    item["text"] = clip(item["text"] + text)
                    self.touch()
            elif kind in ("tool_call", "tool_call_update"):
                key = f"tool:{u.get('toolCallId')}"
                item = self.by_key.get(key) or self.add({"type": "tool", "id": u.get("toolCallId"), "title": "", "status": "pending"}, key)
                for f in ("title", "status", "kind"):
                    if u.get(f):
                        item[f] = u[f]
                if u.get("rawInput"):
                    inp = u["rawInput"]
                    item["input"] = clip(next((inp[k] for k in ("command", "file_path", "pattern", "url", "query", "description") if isinstance(inp.get(k), str)), inp), 600)
                if u.get("content"):
                    item["output"] = tool_text(u["content"])
                item["tool"] = ((u.get("_meta") or {}).get("claudeCode") or {}).get("toolName") or item.get("tool")
                self.touch()
            elif kind == "plan":
                self.add({"type": "plan", "entries": [{"content": e.get("content"), "status": e.get("status")} for e in u.get("entries") or []]})
            elif kind == "usage_update":
                self.usage = {"used": u.get("used"), "size": u.get("size"), "cost": (u.get("cost") or {}).get("amount")}
                self.touch()
            elif kind == "current_mode_update":
                self.mode = u.get("currentModeId") or self.mode
                self.touch()
            elif kind == "session_info_update" and u.get("title"):
                self.title = clip(u["title"], 120)
                self.touch()
            elif kind == "notice":
                self.add({"type": "notice", "text": clip(u.get("message") or u.get("text") or "", 1000)})

    def on_permission(self, rid, params):
        call = params.get("toolCall") or {}
        with self.lock:
            # A second request while one waits: refuse the old one rather than lose it.
            self.answer_pending(None)
            inp = call.get("rawInput") or {}
            self.pending = {
                "rpc": rid,
                "title": call.get("title") or "",
                "detail": clip(next((inp[k] for k in ("command", "file_path", "url", "pattern", "plan") if isinstance(inp.get(k), str)), ""), 2000),
                "options": [{"id": o.get("optionId"), "name": o.get("name"), "kind": o.get("kind")} for o in params.get("options") or []],
            }
            self.status = "waiting"
            self.touch()

    # --- actions from the page
    def answer_pending(self, option_id):
        """Answers the waiting permission request with an option, or cancels it (None)."""
        with self.lock:
            p, self.pending = self.pending, None
            if not p:
                return False
            if option_id is not None and option_id not in {o["id"] for o in p["options"]}:
                self.pending = p
                return False
            outcome = {"outcome": "selected", "optionId": option_id} if option_id is not None else {"outcome": "cancelled"}
            self.write({"id": p["rpc"], "result": {"outcome": outcome}})
            name = next((o["name"] for o in p["options"] if o["id"] == option_id), "cancelled")
            self.add({"type": "notice", "text": f"{p['title'] or 'permission'} → {name}"})
            if self.status == "waiting":
                self.status = "running"
            self.touch()
            return True

    def prompt(self, text):
        with self.lock:
            if not self.acp_sid or self.status in ("closed", "error", "starting"):
                return False
            self.add({"type": "message", "role": "user", "text": clip(text)})
            self.status = "running"
            self.touch()

        def done(result, error):
            with self.lock:
                if self.status in ("closed", "error"):
                    return
                if error:
                    self.add({"type": "notice", "text": f"error: {error.get('message')}"})
                elif (result or {}).get("stopReason") not in (None, "end_turn"):
                    self.add({"type": "notice", "text": f"stopped: {result['stopReason']}"})
                self.answer_pending(None)
                self.status = "idle"
                self.touch()
        self.request("session/prompt", {"sessionId": self.acp_sid, "prompt": [{"type": "text", "text": text}]}, done)
        return True

    def cancel(self):
        if self.acp_sid:
            self.answer_pending(None)
            self.write({"method": "session/cancel", "params": {"sessionId": self.acp_sid}})

    def set_mode(self, mode):
        if not self.acp_sid or mode not in MODES:
            return False

        def done(_result, error):
            with self.lock:
                if not error:
                    self.mode = mode
                self.touch()
        self.request("session/set_mode", {"sessionId": self.acp_sid, "modeId": mode}, done)
        return True

    def close(self):
        with self.lock:
            self.answer_pending(None)
            self.status = "closed"
            self.touch()
        try:
            self.proc.terminate()
        except OSError:
            pass

    # --- what the page reads
    def summary(self):
        return {"id": self.id, "title": self.title, "cwd": self.cwd.replace(HOME, "~", 1), "status": self.status,
                "error": self.error, "created": int(self.created * 1000), "updated": int(self.updated * 1000),
                "waiting": bool(self.pending), "usage": self.usage}

    def state(self):
        with self.lock:
            pending = {k: v for k, v in self.pending.items() if k != "rpc"} if self.pending else None
            return {**self.summary(), "version": self.version, "items": list(self.items), "pending": pending,
                    "modes": self.modes, "mode": self.mode}


class Manager:
    def __init__(self):
        self.sessions = {}
        self.lock = threading.Lock()

    def available(self):
        return os.access(AGENT, os.X_OK)

    def create(self, cwd):
        path = os.path.realpath(os.path.expanduser(cwd or "~"))
        if not os.path.isdir(path):
            raise ValueError(f"no such folder: {cwd}")
        if not (path == HOME or path.startswith(HOME + os.sep)):
            raise ValueError("the folder must be inside your home folder")
        s = Session(path)
        with self.lock:
            self.sessions[s.id] = s
        return s

    def get(self, sid):
        return self.sessions.get(sid)

    def list(self):
        with self.lock:
            live = [s for s in self.sessions.values() if s.status != "closed"]
        return [s.summary() for s in sorted(live, key=lambda s: -s.created)]

    def close(self, sid):
        with self.lock:
            s = self.sessions.pop(sid, None)
        if s:
            s.close()
        return bool(s)

    def shutdown(self):
        for s in list(self.sessions.values()):
            s.close()
