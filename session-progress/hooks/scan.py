"""Print a JSON list summarising every live Claude Code session on this machine."""
import json, os, re, subprocess, sys, time

HOME = os.path.expanduser("~")
REG = os.path.join(HOME, ".claude", "sessions")
SPARK_N = 5
PROJ = os.path.join(HOME, ".claude", "projects")
# The plugin's tool.call hook records each session's latest tool call here
# before the permission prompt opens (the transcript gets it only afterwards).
PENDING = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web", "pending")
PENDING_WINDOW_MS = 120_000
# The records hold each session's next command: keep the folder to this user.
try:
    if os.path.isdir(PENDING) and os.stat(PENDING).st_mode & 0o077:
        os.chmod(PENDING, 0o700)
except OSError:
    pass


def recorded_pending(sid, since):
    try:
        with open(os.path.join(PENDING, f"{sid}.json")) as fh:
            rec = json.load(fh)
    except Exception:
        return None
    # The call that asks is the one made just before the session started waiting.
    if not isinstance(rec.get("ts"), (int, float)) or not since - PENDING_WINDOW_MS <= rec["ts"] <= since + 5000:
        return None
    return pending_of({"name": rec.get("tool"), "input": rec.get("input") or {}})


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except OSError:
        return False


def proc_info(pids):
    """Map pid -> {app, window, tty} from each process's environment (ps eww)."""
    if not pids:
        return {}
    try:
        out = subprocess.run(["ps", "eww", "-o", "pid=,tty=,command=", "-p", ",".join(map(str, pids))],
                             capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return {}
    info = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) < 2 or not parts[0].isdigit():
            continue
        env = dict(t.split("=", 1) for t in parts[2:] if "=" in t and t.split("=", 1)[0].isupper())
        prog = env.get("TERM_PROGRAM", "")
        app = "vscode" if prog == "vscode" else (prog or "other")
        window = env.get("VSCODE_GIT_IPC_HANDLE", "").rsplit("vscode-git-", 1)[-1].removesuffix(".sock") if app == "vscode" else ""
        info[int(parts[0])] = {"app": app, "window": window, "tty": parts[1]}
    return info


def tail(path, n=2000):
    try:
        out = subprocess.run(["tail", "-n", str(n), path], capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return []
    rows = []
    for line in out.splitlines():
        try:
            rows.append(json.loads(line))
        except ValueError:
            pass
    return rows


def transcript(cwd, sid):
    slug = "".join(c if c.isalnum() else "-" for c in cwd)
    p = os.path.join(PROJ, slug, sid + ".jsonl")
    return p if os.path.exists(p) else None


def iso_ms(ts):
    try:
        from datetime import datetime
        return int(datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() * 1000)
    except Exception:
        return None


def is_prompt(d):
    """A user message the person typed, not a tool result coming back."""
    if d.get("type") != "user" or d.get("isSidechain") or d.get("isMeta"):
        return False
    content = (d.get("message") or {}).get("content")
    if isinstance(content, str):
        return bool(content.strip())
    return isinstance(content, list) and any(isinstance(c, dict) and c.get("type") == "text" for c in content)


def pending_of(c):
    """What a tool call waiting for the person asks: the tool, its argument, and the choices."""
    inp = c.get("input") or {}
    name = c.get("name") or "?"
    if name == "AskUserQuestion":
        qs = inp.get("questions") or []
        q = qs[0] if qs else {}
        out = {"kind": "question", "tool": name, "detail": " ".join(str(q.get("question") or "").split())[:300]}
        # One single-select question is answered by its option's number; anything else needs the terminal.
        if len(qs) == 1 and not q.get("multiSelect"):
            out["options"] = [str(o.get("label") or "")[:80] for o in (q.get("options") or [])][:9]
        return out
    if name == "ExitPlanMode":
        return {"kind": "plan", "tool": name, "detail": " ".join(str(inp.get("plan") or "").split())[:300]}
    arg = next((inp[k] for k in ("command", "file_path", "url", "pattern", "query", "prompt", "skill", "description") if isinstance(inp.get(k), str)), "")
    return {"kind": "permission", "tool": name, "detail": " ".join(arg.split())[:300]}


def summarise(path):
    info = {}
    open_calls = {}  # main-thread tool_use id -> pending_of(), until its tool_result arrives
    # Context after each prompt's last reply, oldest first, and the prompt cache.
    per_prompt, ctx, ttl_1h, last_req, replied = [], None, False, None, False
    for d in tail(path, 2000):
        t = d.get("type")
        # Close the previous prompt only if the model answered it (a slash command is not answered).
        if is_prompt(d) and replied:
            per_prompt.append(ctx)
            replied = False
        if t == "assistant" and not d.get("isSidechain"):
            u = (d.get("message") or {}).get("usage") or {}
            if u:
                ctx = sum(u.get(k) or 0 for k in ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")) or ctx
                replied = True
                if ((u.get("cache_creation") or {}).get("ephemeral_1h_input_tokens") or 0) > 0:
                    ttl_1h = True
                last_req = iso_ms(d.get("timestamp") or "") or last_req
        if t == "user" and not d.get("isSidechain"):
            for c in (d.get("message") or {}).get("content") or []:
                if isinstance(c, dict) and c.get("type") == "tool_result":
                    open_calls.pop(c.get("tool_use_id"), None)
        if t == "ai-title" and d.get("aiTitle"):
            info["title"] = d["aiTitle"]
        elif t == "custom-title" and d.get("customTitle"):
            info["title"] = d["customTitle"]
        elif t == "last-prompt" and d.get("lastPrompt"):
            info["lastPrompt"] = d["lastPrompt"]
        elif t == "assistant":
            msg = d.get("message") or {}
            u = msg.get("usage")
            if u and not d.get("isSidechain"):
                used = sum(u.get(k) or 0 for k in ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"))
                if used:
                    info["ctxTokens"] = used
                    # The window size is not recorded: past 200k (or a [1m] model) it must be 1M.
                    big = used > 200_000 or "[1m]" in (msg.get("model") or "")
                    info["ctxMax"] = 1_000_000 if big else 200_000
            for c in msg.get("content") or []:
                if not isinstance(c, dict):
                    continue
                if c.get("type") == "text" and c.get("text", "").strip():
                    info["lastReply"] = c["text"].strip()
                if c.get("type") == "tool_use" and not d.get("isSidechain") and c.get("id"):
                    open_calls[c["id"]] = pending_of(c)
                if c.get("type") == "tool_use":
                    inp = c.get("input") or {}
                    arg = next((inp[k] for k in ("description", "command", "file_path", "pattern", "url", "query", "prompt", "skill") if isinstance(inp.get(k), str)), "")
                    info["lastTool"] = f"{c.get('name')}: {arg}" if arg else c.get("name")
                if c.get("type") == "tool_use" and c.get("name") == "TodoWrite":
                    todos = (c.get("input") or {}).get("todos") or []
                    info["todosTotal"] = len(todos)
                    info["todosDone"] = sum(1 for x in todos if x.get("status") == "completed")
                    act = [x for x in todos if x.get("status") == "in_progress"]
                    info["todoActive"] = (act[0].get("activeForm") or act[0].get("content")) if act else None
    if open_calls:
        info["pending"] = list(open_calls.values())[-1]
    if replied:
        per_prompt.append(ctx)
    # Growth per prompt for the last few prompts (negative after a compaction).
    growth = [b - a for a, b in zip(per_prompt, per_prompt[1:])][-SPARK_N:]
    if growth:
        info["ctxGrowth"] = growth
    if last_req:
        info["cacheExpiresAt"] = last_req + (3600_000 if ttl_1h else 300_000)
    for k in ("lastPrompt", "lastReply", "lastTool"):
        if k in info:
            info[k] = " ".join(info[k].split())[:200]
    return info


# Finishes the person dismissed (seen.py): {sessionId: statusSince}.
try:
    with open(os.path.join(os.path.dirname(PENDING), "seen.json")) as fh:
        SEEN = json.load(fh)
except Exception:
    SEEN = {}

rows = []
for f in os.listdir(REG) if os.path.isdir(REG) else []:
    if not f.endswith(".json"):
        continue
    try:
        with open(os.path.join(REG, f)) as fh:
            s = json.load(fh)
    except Exception:
        continue
    pid = s.get("pid")
    if not isinstance(pid, int) or not alive(pid):
        continue
    row = {
        "pid": pid,
        "sessionId": s.get("sessionId", ""),
        "name": s.get("name") or str(pid),
        "cwd": (s.get("cwd") or "").replace(HOME, "~", 1),
        "status": s.get("status") or "unknown",
        "statusSince": s.get("statusUpdatedAt") or s.get("updatedAt") or 0,
    }
    if s.get("waitingFor"):
        row["waitingFor"] = s["waitingFor"]
    tp = transcript(s.get("cwd") or "", row["sessionId"])
    if tp:
        row.update({k: v for k, v in summarise(tp).items() if v is not None})
    # Only a waiting session's open tool call is a question for the person.
    if row["status"] == "waiting":
        rec = recorded_pending(row["sessionId"], row["statusSince"])
        if rec:
            row["pending"] = rec
    else:
        row.pop("pending", None)
    # A finish the person dismissed: no DONE badge until the session runs again.
    if row["status"] == "idle" and SEEN.get(row["sessionId"]) == row["statusSince"]:
        row["seen"] = True
    rows.append(row)

procs = proc_info([r["pid"] for r in rows])
for r in rows:
    r.update(procs.get(r["pid"], {"app": "other", "window": "", "tty": "?"}))

# Per-window usage. The claude-terminal-focus extension in each VS Code window
# writes windows/<ext host pid>.json: its folder and its terminals' shell pids.
HEARTBEATS = os.path.join(HOME, ".claude", "terminal-focus", "windows")


def proc_table():
    """pid -> (ppid, %cpu, rss KB, command) for every process."""
    try:
        out = subprocess.run(["ps", "-axo", "pid=,ppid=,%cpu=,rss=,command="], capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return {}
    table = {}
    for line in out.splitlines():
        parts = line.split(None, 4)
        if len(parts) == 5 and parts[0].isdigit():
            table[int(parts[0])] = (int(parts[1]), float(parts[2]), int(parts[3]), parts[4])
    return table


def subtree(table, kids, root):
    seen, stack = set(), [root]
    while stack:
        p = stack.pop()
        if p in seen or p not in table:
            continue
        seen.add(p)
        stack.extend(kids.get(p, ()))
    return seen


def heartbeats():
    now = time.time() * 1000
    beats = []
    for f in os.listdir(HEARTBEATS) if os.path.isdir(HEARTBEATS) else []:
        try:
            with open(os.path.join(HEARTBEATS, f)) as fh:
                b = json.load(fh)
        except Exception:
            continue
        if now - (b.get("ts") or 0) < 20000 and isinstance(b.get("extHost"), int):
            beats.append(b)
    return beats


def gpu_util():
    try:
        out = subprocess.run(["ioreg", "-r", "-d", "1", "-w", "0", "-c", "IOAccelerator"], capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return None
    m = re.search(r'"Device Utilization %"=(\d+)', out)
    return int(m.group(1)) if m else None


table = proc_table()
kids = {}
for pid, (ppid, *_rest) in table.items():
    kids.setdefault(ppid, []).append(pid)


def ancestors(pid):
    chain = []
    while pid in table and pid > 1 and len(chain) < 30:
        chain.append(pid)
        pid = table[pid][0]
    return chain


def is_code_main(pid):
    """The VS Code (or fork) app's main process: .../Contents/MacOS/<name>, not a Helper."""
    cmd = table[pid][3]
    return "/Contents/MacOS/" in cmd and "Helper" not in cmd.split("/Contents/MacOS/", 1)[1].split(" --", 1)[0]


def usage(procs):
    return round(sum(table[p][1] for p in procs), 1), round(sum(table[p][2] for p in procs) / 1024)


def set_stats(r, procs, main, source):
    app = subtree(table, kids, main) if main > 1 else set()
    gpu_proc = [p for p in kids.get(main, ()) if "--type=gpu-process" in table[p][3]]
    r["winCpu"], r["winMemMB"] = usage(procs)
    r["winSource"] = source
    r["appCpu"] = usage(app)[0]
    r["gpuProcCpu"] = usage(gpu_proc)[0]
    if gpu is not None:
        r["gpuUtil"] = gpu


gpu = gpu_util()
beats = heartbeats()
fallback = {}  # window -> (main pid, set of procs) for windows without a heartbeat
for r in rows:
    if r["app"] != "vscode":
        continue
    chain = ancestors(r["pid"])
    b = next((b for b in beats if set(chain) & set(b.get("terminals") or [])), None)
    if b:
        # This window: its extension host (and language servers under it) plus its terminals.
        procs = subtree(table, kids, b["extHost"])
        for shell in b.get("terminals") or []:
            procs |= subtree(table, kids, shell)
        r["window"] = str(b["extHost"])
        if b.get("folder"):
            r["windowLabel"] = b["folder"].replace(HOME, "~", 1)
        set_stats(r, procs, table.get(b["extHost"], (0,))[0], "extension")
        # Extensions before 0.3.1 send no version and cannot type an answer.
        if b.get("version"):
            r["extVersion"] = b["version"]
        continue
    # No heartbeat (extension missing or not reloaded): claude -> ... -> shell -> pty host -> main.
    i = next((i for i, p in enumerate(chain) if is_code_main(p)), None)
    if i is None or i < 2:
        continue
    main, shell = chain[i], chain[i - 2]
    m, procs = fallback.setdefault(r["window"], (main, set()))
    procs |= subtree(table, kids, shell)

# A heartbeat-less window counts every claude terminal of it seen this scan.
for r in rows:
    if r["app"] == "vscode" and "winSource" not in r and r["window"] in fallback:
        main, procs = fallback[r["window"]]
        set_stats(r, procs, main, "terminals")

# Label each VS Code window by the common folder of its terminals' working dirs.
by_window = {}
for r in rows:
    if r["app"] == "vscode":
        by_window.setdefault(r["window"], []).append(r["cwd"])
for w, cwds in by_window.items():
    if any(r.get("winSource") == "extension" for r in rows if r["app"] == "vscode" and r["window"] == w):
        continue  # labelled by its heartbeat's folder
    label = os.path.commonpath(cwds) if all(c.startswith("~") for c in cwds) or all(c.startswith("/") for c in cwds) else cwds[0]
    for r in rows:
        if r["app"] == "vscode" and r["window"] == w:
            r["windowLabel"] = label

order = {"waiting": 0, "busy": 1, "idle": 2}
rows.sort(key=lambda r: (order.get(r["status"], 3), -r["statusSince"]))
json.dump(rows, sys.stdout, ensure_ascii=False)
