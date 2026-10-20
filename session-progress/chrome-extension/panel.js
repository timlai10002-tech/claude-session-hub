// Shows the session-progress web page when its local server answers, a hint (retried) when not.
const BASE = 'http://127.0.0.1:8787/'
const view = document.getElementById('view')
const down = document.getElementById('down')
let shown = false

async function check() {
  let up = false
  try {
    up = (await (await fetch(BASE + 'api/ping', { cache: 'no-store' })).json()).app === 'session-progress'
  } catch {}
  if (up && !shown) {
    view.src = BASE + '?panel=1'
    shown = true
  }
  if (!up) shown = false
  view.style.display = up ? 'block' : 'none'
  down.style.display = up ? 'none' : 'block'
}

check()
setInterval(check, 3000)
