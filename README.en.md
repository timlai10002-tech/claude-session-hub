# Claude Session Hub

English | [繁體中文](README.md)

See, and act on, **every** Claude Code session on your Mac at once: which ones are running, which are waiting for you, how much context each has used, and how much CPU/GPU its VS Code window is burning. Works in the terminal, the browser, a Chrome side panel, and on your phone.

This repo is a Claude Code plugin marketplace (`claude-session-hub`) holding one plugin: **session-progress**.

![Claude Session Hub web page: the Active section on top holds a session waiting on a permission prompt, with its Allow/Deny buttons, and the running sessions](docs/hub.jpg)

<img src="docs/side-panel.png" width="300" align="right" alt="Chrome side panel: the same view as a narrow column">

**Chrome side panel** (right): every session stays in view beside whatever page you are on, and the toolbar badge shows how many are waiting for you.

The screenshots use demo data.

<br clear="right">

## Features

| | |
|---|---|
| **Overview** | Sessions waiting for you, running, and just finished are pinned in an Active section on top (in that order, each tagged with its window); the rest grouped by VS Code window. Status badges: `⚠ NEEDS YOU`, `▶ RUNNING`, `✓ DONE 2m`, `○ idle 3h12m` |
| **Just finished** | A session that finished within 10 minutes shows `✓ DONE 2m ✕` and stays in Active instead of dropping straight to the idle list; click the badge to move it there now, in every view |
| **Context** | Usage bar (`245k/1M`), a sparkline of growth per prompt (`▂▇▅▃█ ▲ +10.1k`), time left on the prompt cache |
| **Rate limits** | Your account's 5-hour and 7-day usage and when they reset |
| **Resources** | CPU and memory per VS Code window, VS Code's GPU process, and system GPU utilisation |
| **Jump / close** | Click a session's name to bring up its VS Code window and terminal; press "✕ close" twice to close the window |
| **Stop** | Running sessions get a `■ Stop` button; two presses send Esc to its terminal to interrupt it (only while it is still in the same run) |
| **Answer prompts** | When a session is stuck on a permission prompt or a question, answer it from the web page |
| **LAN / phone** | Optional; only a URL carrying the secret key gets in |
| **Chrome side panel** | A panel on the right of the browser; the toolbar badge counts sessions waiting and running |
| **Notifications** | A macOS notification when a session needs you or finishes; click it to jump to that VS Code terminal. Right-click the toolbar icon to turn either kind off |
| **Dark / light** | Follows macOS by default; the button by the title cycles auto, light and dark, remembered per browser |

## Requirements

- macOS (uses `ps`, `ioreg`, `launchctl`, `open`)
- Claude Code
- Python 3 (standard library only)
- VS Code with the bundled extension, for jump, close and answering prompts

## Install

### 1. The plugin

In Claude Code:

```
/plugin marketplace add timlai10002-tech/claude-session-hub
/plugin install session-progress@claude-session-hub
```

Or, from a local clone you are working on:

```
claude plugin marketplace add ~/claude-session-hub
claude plugin install session-progress@claude-session-hub --scope user
```

After editing the code, run `/reload-plugins` in each session.

### 2. The VS Code extension (recommended)

Jumping to a terminal, closing windows and answering prompts from the web all go through it, as does the exact per-window CPU figure.

```
cd session-progress/vscode-extension
python3 make_vsix.py
code --install-extension claude-terminal-focus-*.vsix
```

Then run **Developer: Reload Window** once in every VS Code window that is already open.

## Usage

| Command or URL | What it does |
|---|---|
| `/sessions` | Opens the sessions pane inside Claude Code |
| `/sessions-web` | Starts the local server and opens `http://127.0.0.1:8787/` in the browser |

### Chrome side panel

1. Open `chrome://extensions` and turn on Developer mode
2. Click "Load unpacked" and choose `session-progress/chrome-extension`
3. Pin the toolbar icon; clicking it opens the side panel

The panel shows the local web page, so run `/sessions-web` first.

### LAN and phone

```
touch session-progress/web/lan.enabled
```

Then restart the server (stop the `server.py` process and run `/sessions-web` again). `/sessions-web` prints the LAN URL, shaped `http://<IP>:8787/k/<key>/`.

- A request without the key, or with a wrong one, gets a 404.
- Anyone with the URL can do everything you can: allow commands, close windows. Give it only to devices you trust.
- The connection is plain HTTP. Don't turn this on over public Wi‑Fi.
- New key: delete `web/lan.key` and restart the server.
- LAN off: delete `web/lan.enabled`.
- To reach it from your phone away from home, use [Tailscale](https://tailscale.com) rather than exposing the server to the internet.

## Sharing with people who don't use the plugin

```
python3 session-progress/chrome-extension/make_bundle.py
```

This builds `session-progress/dist/claude-sessions-chrome.zip`. The recipient unzips it and runs `bash install.sh`, which installs the local server in `~/Library/Application Support/claude-sessions` and starts it at every login; then they load the extension in Chrome. See the `README.md` inside the zip.

This version has no 5h/7d rate-limit line, since only the Claude Code engine can read it.

## How it works

```
~/.claude/sessions/*.json  ─┐
~/.claude/projects/*.jsonl ─┼─► hooks/scan.py ─► /sessions pane (register.tsx)
ps / ioreg                 ─┘          │
                                       └─► web/server.py ─► browser / Chrome side panel / phone
                                               │
          VS Code extension ◄── request.json ──┘  hooks/vscode.py: jump, close, send a key
```

- **scan.py** reads Claude Code's session registry and transcripts to work out status, context, growth and cache time, then uses `ps` to find which VS Code window each session lives in.
- **register.tsx** is the plugin itself: it scans every 5 seconds and draws the pane, writes the rate limits for the web page, and records each tool call before it runs, so the web page can show what a waiting session is asking.
- **The VS Code extension** writes a heartbeat every 5 seconds (the window's folder and its terminals' shell pids) and watches `~/.claude/terminal-focus/request.json` to jump to a terminal, close the window, or type one digit or Esc into a terminal.

## Security

- The server listens on `127.0.0.1` only by default.
- POST requests need an `X-Sessions: 1` header. A page on another site cannot send that without a CORS preflight, and the server never approves one.
- The Host header must be localhost or an IP address, which stops DNS rebinding.
- In LAN mode, requests from other machines must carry the key path, compared with `secrets.compare_digest`.
- Answering a terminal prompt from the web sends only one digit or Esc, and only after checking the session is still in the same wait, so a late press never lands in the prompt box.

## Development

```
cd session-progress
claude plugin validate .
claude plugin test .
```

| Path | Contents |
|---|---|
| `session-progress/hooks/register.tsx` | The plugin: pane, commands, tool-call recording |
| `session-progress/hooks/progress.test.ts` | Plugin tests |
| `session-progress/hooks/scan.py` | Scans every session |
| `session-progress/hooks/vscode.py` | Sends jump, close and key requests to the VS Code extension |
| `session-progress/types/index.d.ts` | Types for the plugin's state |
| `session-progress/web/` | Local server and the web page |
| `session-progress/vscode-extension/` | The claude-terminal-focus extension |
| `session-progress/chrome-extension/` | Chrome side panel and the share-bundle script |
