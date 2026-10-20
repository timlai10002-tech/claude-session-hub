"""Start web/server.py in the background unless it already answers, then open it in the browser.

Prints {"ok": bool, "url": ..., "started": bool}.
"""
import json, os, subprocess, sys, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("SESSIONS_PORT", "8787"))
URL = f"http://127.0.0.1:{PORT}/"


def up():
    try:
        with urllib.request.urlopen(URL + "api/ping", timeout=1) as res:
            return json.load(res).get("app") == "session-progress"
    except Exception:
        return False


started = False
if not up():
    log = open(os.path.join(HERE, "server.log"), "ab")
    subprocess.Popen([sys.executable, "-I", os.path.join(HERE, "server.py")], stdin=subprocess.DEVNULL,
                     stdout=log, stderr=log, start_new_session=True)
    started = True
    for _ in range(30):
        if up():
            break
        time.sleep(0.2)

ok = up()
if ok and "--no-open" not in sys.argv:
    subprocess.run(["open", URL])
out = {"ok": ok, "url": URL, "started": started}
if os.environ.get("SESSIONS_LAN") == "1" or os.path.exists(os.path.join(HERE, "lan.enabled")):
    ip = subprocess.run(["ipconfig", "getifaddr", "en0"], capture_output=True, text=True).stdout.strip()
    try:
        with open(os.path.join(HERE, "lan.key")) as fh:
            key = fh.read().strip()
    except OSError:
        key = ""
    if ip and key:
        out["lan"] = f"http://{ip}:{PORT}/k/{key}/"
print(json.dumps(out))
