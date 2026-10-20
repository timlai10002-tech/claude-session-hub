"""Local web view of the session-progress pane: http://127.0.0.1:8787

GET  /              the page (index.html)
GET  /api/sessions  ../hooks/scan.py's JSON, cached for a second
GET  /api/limits    limits.json, the account's rate-limit windows the mod writes
POST /api/focus     {"pid": n}  -> ../hooks/vscode.py focus n
POST /api/close     {"pid": n}  -> ../hooks/vscode.py close n
POST /api/answer    {"pid": n, "key": "1".."9"|"esc", "since": statusSince}
                    -> ../hooks/vscode.py key n key since: answers a waiting prompt
POST /api/stop      {"pid": n, "since": statusSince}
                    -> ../hooks/vscode.py stop n since: Esc into a running session
POST /api/seen      {"sessionId": id, "since": statusSince}
                    -> ../hooks/seen.py: dismiss a session's DONE badge

Binds to 127.0.0.1 only, unless LAN mode is on (SESSIONS_LAN=1 or a file named
lan.enabled beside this one): then it listens on every interface, and a
request from another machine must come under /k/<key>/ (the key in lan.key,
made on first start); without it the server answers 404 as if nothing were
here. With the key, a phone can do all this Mac can: view, answer, focus, close.
POSTs need the X-Sessions header, which a page on another origin
cannot send without a CORS preflight this server never grants, and the Host
header must be localhost or an IP literal, which stops DNS rebinding.
"""
import ipaddress, json, os, secrets, subprocess, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
# In the plugin the scripts sit in ../hooks; in the standalone bundle, beside this file.
HOOKS = next(d for d in (os.path.join(os.path.dirname(HERE), "hooks"), HERE) if os.path.exists(os.path.join(d, "scan.py")))
PORT = int(os.environ.get("SESSIONS_PORT", "8787"))
LOCAL_HOSTS = {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}
LAN = os.environ.get("SESSIONS_LAN") == "1" or os.path.exists(os.path.join(HERE, "lan.enabled"))
KEY_FILE = os.path.join(HERE, "lan.key")


def lan_key():
    """The secret LAN path segment, made once and kept in lan.key (delete it to get a new one)."""
    try:
        with open(KEY_FILE) as fh:
            key = fh.read().strip()
        if key:
            return key
    except OSError:
        pass
    key = secrets.token_urlsafe(18)
    fd = os.open(KEY_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(key)
    return key


KEY = lan_key() if LAN else ""


def ip_host(host):
    name, _, port = (host or "").rpartition(":")
    try:
        ipaddress.ip_address(name.strip("[]"))
    except ValueError:
        return False
    return port == str(PORT)

_cache = {"at": 0.0, "body": b"[]"}
_lock = threading.Lock()


def scan():
    with _lock:
        if time.time() - _cache["at"] > 1:
            run = subprocess.run([sys.executable, "-I", os.path.join(HOOKS, "scan.py")], capture_output=True, timeout=20)
            if run.returncode == 0:
                _cache.update(at=time.time(), body=run.stdout)
        return _cache["body"]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def send(self, code, body, ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def from_this_mac(self):
        return ipaddress.ip_address(self.client_address[0]).is_loopback

    def local(self):
        """Checks Host, then strips /k/<key> into self.route; another machine must carry the key."""
        host = self.headers.get("Host")
        if not (host in LOCAL_HOSTS or (LAN and ip_host(host))):
            self.send(403, b'{"error":"bad host"}')
            return False
        path = self.path.split("?", 1)[0]
        parts = path.split("/", 3)  # ['', 'k', key, rest]
        if len(parts) >= 3 and parts[1] == "k" and KEY and secrets.compare_digest(parts[2], KEY):
            if len(parts) == 3:  # /k/<key> -> /k/<key>/ so the page's relative api/ paths resolve
                self.send_response(301)
                self.send_header("Location", path + "/")
                self.end_headers()
                return False
            self.route = "/" + parts[3]
            return True
        if self.from_this_mac():
            self.route = path
            return True
        self.send(404, b'{"error":"not found"}')
        return False

    def do_GET(self):
        if not self.local():
            return
        path = self.route
        if path in ("/", "/index.html"):
            with open(os.path.join(HERE, "index.html"), "rb") as fh:
                self.send(200, fh.read(), "text/html; charset=utf-8")
        elif path == "/api/sessions":
            self.send(200, scan())
        elif path == "/api/limits":
            # Written by the mod in any running session from $.session.usage(): the account's 5h/7d windows.
            try:
                with open(os.path.join(HERE, "limits.json"), "rb") as fh:
                    self.send(200, fh.read())
            except OSError:
                self.send(200, b'{"at":0,"list":[]}')
        elif path == "/api/ping":
            self.send(200, b'{"app":"session-progress"}')
        else:
            self.send(404, b'{"error":"not found"}')

    def do_POST(self):
        if not self.local():
            return
        if self.headers.get("X-Sessions") != "1":
            return self.send(403, b'{"error":"forbidden"}')
        if self.route == "/api/seen":
            return self.seen()
        action = {"/api/focus": "focus", "/api/close": "close", "/api/answer": "key", "/api/stop": "stop"}.get(self.route)
        if not action:
            return self.send(403, b'{"error":"forbidden"}')
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)))
            args = [action, str(int(body["pid"]))]
            if action == "key":
                args += [str(body["key"]), str(int(body["since"]))]
            elif action == "stop":
                args += [str(int(body["since"]))]
        except Exception:
            return self.send(400, b'{"error":"bad body"}')
        run = subprocess.run([sys.executable, "-I", os.path.join(HOOKS, "vscode.py"), *args], capture_output=True, timeout=10)
        _cache["at"] = 0
        self.send(200, run.stdout.strip() or b'{"ok":false}')


    def seen(self):
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)))
            args = [str(body["sessionId"]), str(int(body["since"]))]
        except Exception:
            return self.send(400, b'{"error":"bad body"}')
        run = subprocess.run([sys.executable, "-I", os.path.join(HOOKS, "seen.py"), *args], capture_output=True, timeout=10)
        _cache["at"] = 0
        self.send(200, run.stdout.strip() or b'{"ok":false}')


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0" if LAN else "127.0.0.1", PORT), Handler).serve_forever()
