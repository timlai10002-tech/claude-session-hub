"""vscode.py focus|close <pid>: ask the VS Code window hosting Claude process
<pid> to raise itself and show its terminal, or to close.

vscode.py key <pid> <1-9|esc> <statusUpdatedAt>: type one key into that
terminal to answer the prompt the session is waiting on, only if the session
is still waiting in the same spell (so a late press never lands in the prompt box).

Needs the claude-terminal-focus extension (../vscode-extension) in VS Code.
Prints {"ok": true, "action": ..., "terminal": name}, or {"ok": false} with
"reason": "old-extension" when the window's extension predates actions.
"""
import json, os, subprocess, sys, time, uuid

DIR = os.path.join(os.path.expanduser("~"), ".claude", "terminal-focus")
WAIT_S = 3


def ancestors(pid):
    """pid and its parents up to (not including) launchd: one is the terminal's shell."""
    chain = []
    while pid > 1 and len(chain) < 20:
        chain.append(pid)
        try:
            out = subprocess.run(["ps", "-o", "ppid=", "-p", str(pid)], capture_output=True, text=True, timeout=2).stdout
            pid = int(out.strip())
        except Exception:
            break
    return chain


KEYS = {**{str(n): str(n) for n in range(1, 10)}, "esc": "\x1b"}


def still_waiting(pid, since):
    try:
        with open(os.path.join(os.path.expanduser("~"), ".claude", "sessions", f"{pid}.json")) as fh:
            s = json.load(fh)
    except Exception:
        return False
    return s.get("status") == "waiting" and str(s.get("statusUpdatedAt")) == since


action, pid = sys.argv[1], int(sys.argv[2])
req = {"action": action}
if action == "key":
    key, since = sys.argv[3], sys.argv[4]
    if key not in KEYS:
        print(json.dumps({"ok": False, "reason": "bad-key"}))
        sys.exit(0)
    if not still_waiting(pid, since):
        print(json.dumps({"ok": False, "reason": "not-waiting"}))
        sys.exit(0)
    req["text"] = KEYS[key]
os.makedirs(DIR, exist_ok=True)
rid = uuid.uuid4().hex
tmp = os.path.join(DIR, f".request-{rid}.json")
with open(tmp, "w") as fh:
    json.dump({"id": rid, **req, "ts": int(time.time() * 1000), "pids": ancestors(pid)}, fh)
os.replace(tmp, os.path.join(DIR, "request.json"))

ack = os.path.join(DIR, f"ack-{rid}.json")
deadline = time.time() + WAIT_S
while time.time() < deadline:
    if os.path.exists(ack):
        time.sleep(0.05)
        try:
            with open(ack) as fh:
                out = json.load(fh)
        finally:
            os.remove(ack)
        # The 0.1.0 extension ignores the action and always focuses; its ack has no "action".
        if out.get("action", "focus") != action:
            out = {"ok": False, "reason": "old-extension"}
        print(json.dumps(out))
        sys.exit(0)
    time.sleep(0.1)
print(json.dumps({"ok": False}))
