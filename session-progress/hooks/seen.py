"""seen.py <sessionId> <statusSince>: mark a session's finish as seen, so its DONE
badge goes away (in the pane and on the web page) until it finishes again.

Kept in ../web/seen.json as {sessionId: statusSince}; entries older than a day
are dropped. Prints {"ok": true}.
"""
import json, os, re, sys, time

SEEN = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web", "seen.json")
DAY_MS = 86_400_000


def load():
    try:
        with open(SEEN) as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


if __name__ == "__main__":
    sid, since = sys.argv[1], int(sys.argv[2])
    if not re.fullmatch(r"[A-Za-z0-9-]{1,64}", sid):
        print(json.dumps({"ok": False, "reason": "bad-session"}))
        sys.exit(0)
    now = time.time() * 1000
    data = {k: v for k, v in load().items() if isinstance(v, (int, float)) and now - v < DAY_MS}
    data[sid] = since
    os.makedirs(os.path.dirname(SEEN), exist_ok=True)
    tmp = f"{SEEN}.{os.getpid()}.tmp"
    with open(tmp, "w") as fh:
        json.dump(data, fh)
    os.replace(tmp, SEEN)
    print(json.dumps({"ok": True}))
