// Toolbar icon opens the side panel; its badge counts sessions needing you (yellow) or running (green).
const API = 'http://127.0.0.1:8787/api/sessions'

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
    const waiting = rows.filter(r => r.status === 'waiting').length
    const busy = rows.filter(r => r.status === 'busy').length
    const [text, color, title] = waiting
      ? [String(waiting), '#e0a100', `${waiting} need you · ${busy} running`]
      : busy
        ? [String(busy), '#1f9d55', `${busy} running`]
        : ['', '#777', `${rows.length} sessions, all idle`]
    await chrome.action.setBadgeText({ text })
    await chrome.action.setBadgeBackgroundColor({ color })
    await chrome.action.setTitle({ title: `Claude Sessions · ${title}` })
  } catch {
    await chrome.action.setBadgeText({ text: '·' })
    await chrome.action.setBadgeBackgroundColor({ color: '#999' })
    await chrome.action.setTitle({ title: 'Claude Sessions · local server not running (run /sessions-web)' })
  }
}
