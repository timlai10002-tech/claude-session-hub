// Every VS Code window runs this, for the session-progress Claude Code mod.
//
// - Heartbeat: every 5s it writes ~/.claude/terminal-focus/windows/<ext host
//   pid>.json (its folder and its terminals' shell pids) so the mod can tell
//   which window holds which session and add up the window's CPU.
// - Requests: the mod's vscode.py writes request.json with an action and a
//   Claude process's pid plus its ancestors; the window owning a terminal whose
//   shell is among them acts (focus: raise the window and show the terminal;
//   close: close the window; key: type one key, a digit or Esc, into the
//   terminal to answer the prompt the session waits on) and writes ack-<id>.json back.
const vscode = require('vscode')
const cp = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const DIR = path.join(os.homedir(), '.claude', 'terminal-focus')
const REQ = path.join(DIR, 'request.json')
const WINDOWS = path.join(DIR, 'windows')
const BEAT = path.join(WINDOWS, `${process.pid}.json`)
// Sent with every heartbeat and ack, so the mod knows what this window can do
// (typing an answer needs 0.3.1 or later).
const VERSION = require('./package.json').version
const STALE_MS = 10000
const BEAT_MS = 5000

function folder() {
  const ws = vscode.workspace.workspaceFile
  return ws && ws.scheme === 'file' ? ws.fsPath : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
}

function raiseWindow() {
  const target = folder()
  // `code <folder>` focuses the window that already has the folder open.
  if (target) cp.execFile(path.join(vscode.env.appRoot, 'bin', 'code'), [target], () => {})
}

async function shellPids() {
  const pids = await Promise.all(vscode.window.terminals.map(t => t.processId))
  return pids.filter(Boolean)
}

async function beat() {
  const body = { extHost: process.pid, version: VERSION, folder: folder() ?? null, terminals: await shellPids(), ts: Date.now() }
  const tmp = `${BEAT}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify(body))
    fs.renameSync(tmp, BEAT)
  } catch {}
}

function activate(context) {
  fs.mkdirSync(WINDOWS, { recursive: true })
  let lastId = ''

  const handle = async () => {
    let req
    try {
      req = JSON.parse(fs.readFileSync(REQ, 'utf8'))
    } catch {
      return
    }
    if (!req.id || req.id === lastId || Date.now() - req.ts > STALE_MS) return
    lastId = req.id
    const wanted = new Set(req.pids)
    for (const t of vscode.window.terminals) {
      const pid = await t.processId
      if (!pid || !wanted.has(pid)) continue
      fs.writeFileSync(path.join(DIR, `ack-${req.id}.json`), JSON.stringify({ ok: true, action: req.action ?? 'focus', version: VERSION, terminal: t.name }))
      if (req.action === 'key') {
        // Only a menu choice: one digit or Esc, never free text.
        if (/^([1-9]|\x1b)$/.test(req.text ?? '')) t.sendText(req.text, false)
      } else if (req.action === 'close') {
        await vscode.commands.executeCommand('workbench.action.closeWindow')
      } else {
        raiseWindow()
        t.show(false)
      }
      return
    }
  }

  const watcher = fs.watch(DIR, (_event, file) => {
    if (file === 'request.json') void handle()
  })
  void beat()
  const timer = setInterval(() => void beat(), BEAT_MS)
  context.subscriptions.push(
    { dispose: () => watcher.close() },
    { dispose: () => clearInterval(timer) },
    vscode.window.onDidOpenTerminal(() => void beat()),
    vscode.window.onDidCloseTerminal(() => void beat()),
  )
}

function deactivate() {
  try {
    fs.unlinkSync(BEAT)
  } catch {}
}

module.exports = { activate, deactivate }
