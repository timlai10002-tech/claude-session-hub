// Toolbar icon opens the side panel; its badge counts sessions needing you (yellow) or running (green).
// Every poll also compares each session with the last one and raises a notification when a session
// starts waiting for you or finishes a run; clicking it goes to that session's terminal.
const BASE = 'http://127.0.0.1:8787'
const API = `${BASE}/api/sessions`
// Notification kinds the person can switch off from the toolbar icon's right-click menu.
const KINDS = { need: 'Notify when a session needs you', done: 'Notify when a session finishes' }

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  chrome.alarms.create('poll', { periodInMinutes: 0.5 })
  chrome.contextMenus.removeAll(async () => {
    const on = await settings()
    for (const [id, title] of Object.entries(KINDS))
      chrome.contextMenus.create({ id, title, type: 'checkbox', checked: on[id], contexts: ['action'] })
  })
  poll()
})
chrome.runtime.onStartup.addListener(poll)
chrome.alarms.onAlarm.addListener(a => a.name === 'poll' && poll())
chrome.contextMenus.onClicked.addListener(info => {
  if (info.menuItemId in KINDS) chrome.storage.local.set({ [`notify.${info.menuItemId}`]: info.checked })
})

async function settings() {
  const got = await chrome.storage.local.get(['notify.need', 'notify.done'])
  return { need: got['notify.need'] !== false, done: got['notify.done'] !== false }
}

async function poll() {
  let rows
  try {
    rows = await (await fetch(API, { cache: 'no-store' })).json()
  } catch {
    await chrome.action.setBadgeText({ text: '·' })
    await chrome.action.setBadgeBackgroundColor({ color: '#999' })
    await chrome.action.setTitle({ title: 'Claude Session Hub · local server not running (run /sessions-web)' })
    return
  }
  const waiting = rows.filter(r => r.status === 'waiting').length
  const busy = rows.filter(r => r.status === 'busy').length
  const [text, color, title] = waiting
    ? [String(waiting), '#e0a100', `${waiting} need you · ${busy} running`]
    : busy
      ? [String(busy), '#1f9d55', `${busy} running`]
      : ['', '#777', `${rows.length} sessions, all idle`]
  await chrome.action.setBadgeText({ text })
  await chrome.action.setBadgeBackgroundColor({ color })
  await chrome.action.setTitle({ title: `Claude Session Hub · ${title}` })
  await notifyChanges(rows)
}

// The last poll's status per session lives in session storage, since the service worker
// is stopped between polls. The first poll after a start only records, so nothing old pops up.
async function notifyChanges(rows) {
  const { last } = await chrome.storage.session.get('last')
  const next = Object.fromEntries(rows.map(r => [r.sessionId, { status: r.status, since: r.statusSince }]))
  await chrome.storage.session.set({ last: next })
  if (!last) return
  const on = await settings()
  for (const r of rows) {
    const before = last[r.sessionId]
    if (!before) continue
    const newWait = r.status === 'waiting' && (before.status !== 'waiting' || before.since !== r.statusSince)
    if (newWait && on.need) {
      const p = r.pending
      const ask = p ? (p.kind === 'question' ? p.detail : p.kind === 'plan' ? 'Approve the plan?' : `Allow ${p.tool}? ${p.detail || ''}`) : (r.waitingFor || 'Waiting for you')
      show(`need|${r.pid}|${r.app}`, `⚠ ${r.name} needs you`, ask, true)
    } else if (before.status === 'busy' && r.status === 'idle' && on.done) {
      show(`done|${r.pid}|${r.app}`, `✓ ${r.name} finished`, r.lastReply || r.title || r.cwd, false)
    }
  }
}

function show(id, title, message, sticky) {
  chrome.notifications.create(`${id}|${Date.now()}`, {
    type: 'basic',
    iconUrl: 'icon128.png',
    title,
    message: String(message).slice(0, 200),
    requireInteraction: sticky, // a "needs you" stays until dismissed
    priority: sticky ? 2 : 0,
  })
}

// Clicking a notification goes to that session: its VS Code terminal, or the web page otherwise.
chrome.notifications.onClicked.addListener(async id => {
  chrome.notifications.clear(id)
  const [, pid, app] = id.split('|')
  if (app === 'vscode') {
    const res = await fetch(`${BASE}/api/focus`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sessions': '1' },
      body: JSON.stringify({ pid: Number(pid) }),
    }).then(r => r.json()).catch(() => ({}))
    if (res.ok) return
  }
  chrome.tabs.create({ url: `${BASE}/` })
})
