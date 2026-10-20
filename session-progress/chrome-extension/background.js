// Toolbar icon opens the side panel; its badge counts sessions needing you (yellow) or running (green).
const API = 'http://127.0.0.1:8787/api/sessions'
const ACP_API = 'http://127.0.0.1:8787/api/acp'

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  chrome.alarms.create('poll', { periodInMinutes: 0.5 })
  poll()
})
chrome.runtime.onStartup.addListener(poll)
chrome.alarms.onAlarm.addListener(a => a.name === 'poll' && poll())

async function poll() {
  try {
    const rows = await (await fetch(API, { cache: 'no-store' })).json()
    // ACP sessions started from the web page count the same way.
    const acp = await fetch(ACP_API, { cache: 'no-store' }).then(r => r.json()).then(o => o.sessions || []).catch(() => [])
    const waiting = rows.filter(r => r.status === 'waiting').length + acp.filter(a => a.status === 'waiting').length
    const busy = rows.filter(r => r.status === 'busy').length + acp.filter(a => a.status === 'running' || a.status === 'starting').length
    const [text, color, title] = waiting
      ? [String(waiting), '#e0a100', `${waiting} need you · ${busy} running`]
      : busy
        ? [String(busy), '#1f9d55', `${busy} running`]
        : ['', '#777', `${rows.length + acp.length} sessions, all idle`]
    await chrome.action.setBadgeText({ text })
    await chrome.action.setBadgeBackgroundColor({ color })
    await chrome.action.setTitle({ title: `Claude Session Hub · ${title}` })
  } catch {
    await chrome.action.setBadgeText({ text: '·' })
    await chrome.action.setBadgeBackgroundColor({ color: '#999' })
    await chrome.action.setTitle({ title: 'Claude Session Hub · local server not running (run /sessions-web)' })
  }
}
