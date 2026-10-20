import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Limits, SessionRow } from '../types'

const PANE = 'session-progress'
const REFRESH_MS = 5000

const rows = atom({ plugin: 'session-progress', key: 'rows' } as const, [])
const scannedAt = atom({ plugin: 'session-progress', key: 'scannedAt' } as const, 0)
// The group whose close button was pressed once; a second press within CONFIRM_MS closes it.
const closeArmed = atom({ plugin: 'session-progress', key: 'closeArmed' } as const, '')
const CONFIRM_MS = 5000
const limits = atom({ plugin: 'session-progress', key: 'limits' } as const, { at: 0, list: [] } as Limits)
const LIMIT_LABEL: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: '$' }
const SPARK = '▁▂▃▄▅▆▇█'

// One bar per recent prompt, scaled to the largest growth; a compaction (negative) is the lowest bar.
const spark = (growth: number[]) => {
  const top = Math.max(1, ...growth)
  return growth.map(g => SPARK[Math.max(0, Math.min(7, Math.round((Math.max(0, g) / top) * 7)))]).join('')
}
const signed = (n: number) => `${n < 0 ? '▼ -' : '▲ +'}${n <= -1000 || n >= 1000 ? `${+(Math.abs(n) / 1000).toFixed(1)}k` : Math.abs(n)}`
const untilText = (ms: number) => {
  const m = Math.round(ms / 60_000)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h${String(m % 60).padStart(2, '0')}` : `${Math.floor(h / 24)}d${h % 24}h`
}

// The account's limits are the same in every session: keep them, and leave them for the web page.
async function shareLimits($: EngineInterface, list: Limits['list']) {
  if (list.length === 0) return
  const value: Limits = { at: Date.now(), list: list.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })) }
  await update($, limits, () => value)
  await $.fs.write(`${$.plugin.root}/web/limits.json`, JSON.stringify(value)).catch(() => undefined)
}

const STATUS_COLOR: Record<string, string> = { busy: 'green', waiting: 'yellow', idle: 'gray' }
const STATUS_ICON: Record<string, string> = { busy: '●', waiting: '◐', idle: '○' }
// Busy and waiting rows get a solid badge and a colored gutter down every line; idle rows stay dim.
// "done" is an idle session that replied within DONE_MS: it stays pinned so a finish isn't missed.
const BADGE: Record<string, string> = { busy: '▶ RUNNING', waiting: '⚠ NEEDS YOU', done: '✓ DONE' }
const GUTTER: Record<string, string> = { busy: 'green', waiting: 'yellow', done: 'cyan' }
const DONE_MS = 10 * 60_000

const count = (list: SessionRow[], status: string) => list.filter(r => r.status === status).length

const ago = (now: number, then: number) => {
  const s = Math.max(0, Math.round((now - then) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

// Two units for how long a session has sat in its state: 45s, 12m, 3h12m, 2d5h.
const span = (now: number, then: number) => {
  const s = Math.max(0, Math.round((now - then) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h}h${m % 60}m` : `${h}h`
  const d = Math.floor(h / 24)
  return h % 24 ? `${d}d${h % 24}h` : `${d}d`
}

const tokens = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`)

const ctxColor = (ratio: number) => (ratio >= 0.8 ? 'red' : ratio >= 0.5 ? 'yellow' : 'green')

const bar = (done: number, total: number, width = 10) => {
  const filled = total === 0 ? 0 : Math.round((done / total) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

async function scan($: EngineInterface) {
  const script = `${$.plugin.root}/hooks/scan.py`
  const run = await $.process.run(['python3', '-I', script], { timeoutMs: 15000 }).catch(() => undefined)
  if (!run || run.exitCode !== 0) return
  let list: SessionRow[]
  try {
    list = JSON.parse(run.stdout)
  } catch {
    return
  }
  await update($, rows, () => list)
  await update($, scannedAt, () => Date.now())
  const vscode = list.filter(r => r.app === 'vscode')
  const busy = vscode.filter(r => r.status === 'busy').length
  const waiting = vscode.filter(r => r.status === 'waiting').length
  $.ui.status(`VS Code claude ${vscode.length} · ${busy} busy · ${waiting} waiting`)
}

// Ask the VS Code window hosting `r` to focus its terminal or close, via the claude-terminal-focus extension.
async function vscodeAction($: EngineInterface, action: 'focus' | 'close', r: SessionRow) {
  const script = `${$.plugin.root}/hooks/vscode.py`
  const run = await $.process.run(['python3', '-I', script, action, String(r.pid)], { timeoutMs: 8000 }).catch(() => undefined)
  let out: { ok?: boolean; reason?: string } = {}
  try {
    out = run && run.exitCode === 0 ? JSON.parse(run.stdout) : {}
  } catch {}
  const ok = out.ok === true
  if (out.reason === 'old-extension') $.ui.toast(`That window runs an old extension that can only focus: ${RELOAD_HINT}.`)
  else if (!ok) $.ui.toast(`No VS Code window answered for ${r.name}: is the claude-terminal-focus extension installed and the window reloaded?`)
  if (ok && action === 'close') void scan($)
}

// Esc into a running session's terminal, on a second press within CONFIRM_MS (the arm
// shares closeArmed, keyed stop:<session>), and only while it is still in that run.
async function pressStop($: EngineInterface, r: SessionRow) {
  const key = `stop:${r.sessionId}`
  if ((await read($, closeArmed)) !== key) {
    await update($, closeArmed, () => key)
    $.clock.after(CONFIRM_MS, () => void update($, closeArmed, k => (k === key ? '' : k)))
    return
  }
  await update($, closeArmed, () => '')
  const script = `${$.plugin.root}/hooks/vscode.py`
  const run = await $.process.run(['python3', '-I', script, 'stop', String(r.pid), String(r.statusSince)], { timeoutMs: 8000 }).catch(() => undefined)
  let out: { ok?: boolean; reason?: string } = {}
  try {
    out = run && run.exitCode === 0 ? JSON.parse(run.stdout) : {}
  } catch {}
  if (out.ok) $.ui.toast(`Stopped ${r.name}.`)
  else if (out.reason === 'not-running') $.ui.toast(`${r.name} is no longer running.`)
  else if (out.reason === 'old-extension') $.ui.toast(`Not stopped, that window runs an old extension: ${RELOAD_HINT}.`)
  else $.ui.toast(`No VS Code window answered for ${r.name}.`)
  void scan($)
}

// Dismiss a DONE badge: seen.py records the finish, so every view drops it until the next run.
async function dismissDone($: EngineInterface, r: SessionRow) {
  const script = `${$.plugin.root}/hooks/seen.py`
  await $.process.run(['python3', '-I', script, r.sessionId, String(r.statusSince)], { timeoutMs: 5000 }).catch(() => undefined)
  await update($, rows, list => list.map(x => (x.sessionId === r.sessionId ? { ...x, seen: true } : x)))
  void scan($)
}

const RELOAD_HINT = 'in that VS Code window run "Developer: Reload Window" so the claude-terminal-focus extension (0.2+) loads'

async function pressClose($: EngineInterface, g: Group) {
  if (g.stats?.winSource !== 'extension') {
    $.ui.toast(`Can't close this window yet: ${RELOAD_HINT}.`)
    return
  }
  const armed = await read($, closeArmed)
  if (armed !== g.key) {
    await update($, closeArmed, () => g.key)
    $.clock.after(CONFIRM_MS, () => void update($, closeArmed, k => (k === g.key ? '' : k)))
    return
  }
  await update($, closeArmed, () => '')
  const first = g.rows[0]
  if (first) await vscodeAction($, 'close', first)
}

type Group = { key: string; label: string; rows: SessionRow[]; stats?: SessionRow }

// One group per VS Code window (most urgent first), then every other terminal.
function groupRows(list: SessionRow[]): Group[] {
  const groups = new Map<string, Group>()
  for (const r of list) {
    const key = r.app === 'vscode' ? `vscode:${r.window}` : 'other'
    const label = r.app === 'vscode' ? `VS Code · ${r.windowLabel ?? r.window}` : 'Other terminals'
    const group = groups.get(key) ?? { key, label, rows: [] }
    group.rows.push(r)
    groups.set(key, group)
  }
  const rank = (g: Group) =>
    g.key === 'other' ? 9 : Math.min(...g.rows.map(r => STATUS_RANK[r.status] ?? 3))

  for (const g of groups.values()) g.stats = g.rows.find(r => r.winCpu !== undefined)
  return [...groups.values()].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label))
}

const STATUS_RANK: Record<string, number> = { waiting: 0, busy: 1, idle: 2 }
const isActive = (r: SessionRow) => r.status === 'busy' || r.status === 'waiting'
const isDone = (r: SessionRow, now: number) => r.status === 'idle' && !r.seen && !!r.lastReply && now < (r.doneUntil ?? r.statusSince + DONE_MS)
// The status a row is drawn with: its own, or "done" for a fresh finish.
const shown = (r: SessionRow, now: number) => (isDone(r, now) ? 'done' : r.status)
const PIN_RANK: Record<string, number> = { waiting: 0, busy: 1, done: 2 }
// Where a session lives, for its row in the Active section.
const whereOf = (r: SessionRow) =>
  r.app === 'vscode' ? `VS Code · ${r.windowLabel ?? r.window}` : r.app === 'Apple_Terminal' ? 'Terminal' : r.app === 'other' ? 'terminal' : r.app

// The arguments the web view shows for a call that waits on the person; never file contents.
const PENDING_KEYS = ['command', 'file_path', 'url', 'pattern', 'query', 'prompt', 'skill', 'description', 'questions', 'plan']

// Records the session's latest tool call for scan.py before the permission
// prompt opens, so the web view can say what a waiting session asks.
async function recordCall($: EngineInterface, e: { tool: string; agentId?: string } & Record<string, unknown>) {
  if (e.agentId) return
  const input: Record<string, unknown> = {}
  for (const k of PENDING_KEYS) if (e[k] !== undefined) input[k] = e[k]
  const sid = await $.session.id()
  await $.fs.write(`${$.plugin.root}/web/pending/${sid}.json`, JSON.stringify({ ts: Date.now(), tool: e.tool, input }))
}

// A few English words for what the person just asked, so the hub's voice can say it:
// summarised by the small model and kept in web/topics/<session>.json for scan.py.
const TOPIC_ASK = 'Summarise this request to a coding assistant in 3 to 6 plain English words, ' +
  'like a task title. Reply with the words only: no quotes, no punctuation at the end.\n\nRequest:\n'

async function recordTopic($: EngineInterface, text: string) {
  const ask = text.trim()
  if (!ask || ask.startsWith('/')) return // a slash command is not a task
  const r = await $.model.complete({ model: 'haiku', prompt: TOPIC_ASK + ask.slice(0, 2000), maxTokens: 30 })
  const topic = r.isAnswered ? r.text.split('\n')[0]!.trim().replace(/^["'“\s]+|["'”.。\s]+$/g, '').slice(0, 60) : ''
  if (!topic) return
  const sid = await $.session.id()
  await $.fs.write(`${$.plugin.root}/web/topics/${sid}.json`, JSON.stringify({ ts: Date.now(), topic }))
}

export const register: Register = on => {
  let timer: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'sessions',
      description: 'Show what Claude is doing in each VS Code terminal, grouped by window',
    })
    await $.command.register({
      name: 'sessions-web',
      description: 'Open the sessions view in the browser (local server on 127.0.0.1:8787)',
    })
    void scan($)
    void $.session.usage().then(u => shareLimits($, u.rateLimits)).catch(() => undefined)
    timer?.cancel()
    timer = $.clock.every(REFRESH_MS, () => void scan($))

    return next(e)
  })

  on('tool.call', ($, e, next) => {
    void recordCall($, e as unknown as Parameters<typeof recordCall>[1]).catch(() => undefined)
    return next(e)
  })

  on('prompt.submit', ($, e, next) => {
    void recordTopic($, e.text).catch(() => undefined)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.rateLimits.length > 0) await shareLimits($, e.rateLimits)
    return next(e)
  })

  on('command.run', { command: 'sessions' }, async $ => {
    await scan($)
    await $.ui.open({ id: PANE, title: 'Sessions' })

    return { text: 'Sessions pane opened.' }
  })

  on('command.run', { command: 'sessions-web' }, async $ => {
    const script = `${$.plugin.root}/web/launch.py`
    const run = await $.process.run(['python3', '-I', script], { timeoutMs: 15000 }).catch(() => undefined)
    let out: { ok?: boolean; url?: string; started?: boolean; lan?: string } = {}
    try {
      out = run && run.exitCode === 0 ? JSON.parse(run.stdout) : {}
    } catch {}
    if (!out.ok) return { text: `Could not start the sessions web server: ${run?.stderr.trim() || 'no response'}` }

    return { text: `Sessions web view ${out.started ? 'started' : 'already running'}: ${out.url}${out.lan ? ` · LAN: ${out.lan}` : ''}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, rows)
    const at = await read($, scannedAt)
    const armed = await read($, closeArmed)
    const lim = await read($, limits)
    const now = Date.now()
    const groups = groupRows(list)
    // A count above zero is a solid badge; zero is drawn dim so the two never look alike.
    const summaryBadge = (status: string, label: string, n: number) =>
      n > 0 ? (
        <Text backgroundColor={GUTTER[status]} color="black" bold>
          {' '}{label}{' '}
        </Text>
      ) : (
        <Text dimColor>{label}</Text>
      )
    const vscodeCount = list.filter(r => r.app === 'vscode').length
    // Running and waiting sessions are pinned in one Active section on top (waiting
    // first, longest first); the window groups below keep only the idle ones.
    const pinned = (r: SessionRow) => isActive(r) || isDone(r, now)
    const active = list.filter(pinned).sort((a, b) => (PIN_RANK[shown(a, now)] ?? 3) - (PIN_RANK[shown(b, now)] ?? 3) || a.statusSince - b.statusSince)
    const sessionRow = (r: SessionRow, where?: string) => {
    const st = shown(r, now)
    const gutter = GUTTER[st]
    const pad = gutter ? <Text color={gutter}>{'  ┃ '}</Text> : '    '
    const active = st !== 'idle'
    return (
    <Box key={r.sessionId} flexDirection="column">
      <Box key={`head-${r.sessionId}`} flexDirection="row">
        {st === 'done' ? (
          // The DONE badge is itself the dismiss control: its ✕ and hover say so.
          <Text color={gutter}>{'  ┃ '}</Text>
        ) : (
          ''
        )}
        {st === 'done' ? (
          <Button key={`seen-${r.sessionId}`} plain label={` ${BADGE.done} ${span(now, r.statusSince)} ✕ `} hover={{ backgroundColor: 'cyan', color: 'black' }} onPress={() => void dismissDone($, r)} />
        ) : (
        <Text>
          {gutter ? <Text color={gutter}>{'  ┃ '}</Text> : '  '}
          {BADGE[st] ? (
            <Text backgroundColor={gutter} color="black" bold>
              {' '}{BADGE[st]} {span(now, r.statusSince)}{' '}
            </Text>
          ) : (
            <Text color={STATUS_COLOR[r.status] ?? 'white'} dimColor>
              {STATUS_ICON[r.status] ?? '?'} {r.status} {span(now, r.statusSince)}
            </Text>
          )}
          {r.waitingFor ? <Text color="yellow" bold> {r.waitingFor}</Text> : ''}{' '}
        </Text>
        )}
        {r.app === 'vscode' ? (
          <Button key={`open-${r.sessionId}`} plain label={`↗ ${r.name}`} dimColor={!active} hover={{ underline: true }} onPress={() => void vscodeAction($, 'focus', r)} />
        ) : (
          <Text bold={active} dimColor={!active}>{r.name}</Text>
        )}
        {where ? <Text color="blue"> [{where}]</Text> : ''}
        {r.status === 'busy' && r.app === 'vscode' && r.extVersion ? (
          <Button
            key={`stop-${r.sessionId}`}
            plain
            dimColor={armed !== `stop:${r.sessionId}`}
            label={armed === `stop:${r.sessionId}` ? ' ■ press again to stop' : ' ■ stop'}
            hover={{ color: 'red' }}
            onPress={() => void pressStop($, r)}
          />
        ) : (
          ''
        )}
        <Text wrap="truncate" dimColor> {r.tty} · {r.cwd}</Text>
      </Box>
      {r.title && <Text wrap="truncate" dimColor={!active}>{pad}{r.title}</Text>}
      {r.status === 'busy' && (r.todoActive || r.lastTool) && (
        <Text wrap="truncate">
          {pad}
          <Text color="green" bold>now </Text>
          {r.todoActive ?? r.lastTool}
        </Text>
      )}
      {r.ctxTokens !== undefined && r.ctxMax !== undefined && (
        <Text wrap="truncate">
          {pad}
          <Text color={ctxColor(r.ctxTokens / r.ctxMax)}>ctx {bar(Math.min(r.ctxTokens, r.ctxMax), r.ctxMax)}</Text>
          <Text dimColor>
            {' '}
            {tokens(r.ctxTokens)}/{tokens(r.ctxMax)} ({Math.round((r.ctxTokens / r.ctxMax) * 100)}%)
          </Text>
          {r.ctxGrowth && r.ctxGrowth.length > 0 ? (
            <Text>
              {' '}
              <Text color="cyan">{spark(r.ctxGrowth)}</Text>
              <Text dimColor> {signed(r.ctxGrowth[r.ctxGrowth.length - 1] ?? 0)}</Text>
            </Text>
          ) : (
            ''
          )}
          {r.cacheExpiresAt !== undefined ? (
            r.cacheExpiresAt > now ? (
              <Text>
                <Text dimColor> │ </Text>
                <Text color={r.cacheExpiresAt - now < 5 * 60_000 ? 'yellow' : 'green'}>cache {untilText(r.cacheExpiresAt - now)}</Text>
              </Text>
            ) : (
              <Text dimColor> │ cache expired</Text>
            )
          ) : (
            ''
          )}
        </Text>
      )}
      {r.todosTotal !== undefined && r.todosTotal > 0 && (
        <Text wrap="truncate">
          {pad}
          <Text color="cyan">
            {bar(r.todosDone ?? 0, r.todosTotal)} {r.todosDone}/{r.todosTotal}
          </Text>
          {r.todoActive ? <Text dimColor> {r.todoActive}</Text> : ''}
        </Text>
      )}
      {r.lastPrompt && (
        <Text wrap="truncate" dimColor>
          {pad}› {r.lastPrompt}
        </Text>
      )}
      {r.lastReply && (
        <Text wrap="truncate" dimColor>
          {pad}‹ {r.lastReply}
        </Text>
      )}
    </Box>
    )
    }

    return (
      <Box flexDirection="column">
        <Text wrap="truncate">
          {summaryBadge('busy', `● ${count(list, 'busy')} running`, count(list, 'busy'))}
          <Text> </Text>
          {summaryBadge('waiting', `◐ ${count(list, 'waiting')} need you`, count(list, 'waiting'))}
          <Text dimColor> · ○ {count(list, 'idle')} idle</Text>
        </Text>
        {lim.list.length > 0 && (
          <Text wrap="truncate">
            {lim.list.map((l, i) => {
              const left = l.resetsAt ? Date.parse(l.resetsAt) - now : NaN
              return (
                <Text key={l.kind}>
                  {i > 0 ? <Text dimColor> │ </Text> : ''}
                  <Text bold color={l.percentUsed >= 80 ? 'red' : l.percentUsed >= 50 ? 'yellow' : 'green'}>
                    {LIMIT_LABEL[l.kind] ?? l.kind} {Math.round(l.percentUsed)}%
                  </Text>
                  {Number.isFinite(left) && left > 0 ? <Text dimColor> · resets {untilText(left)}</Text> : ''}
                </Text>
              )
            })}
          </Text>
        )}
        <Text dimColor>
          {vscodeCount} VS Code terminals running claude · updated {at ? ago(now, at) : '—'} ago
        </Text>
        {list.length === 0 && <Text dimColor>No running sessions found.</Text>}
        {active.length > 0 && (
          <Box key="active" flexDirection="column" marginTop={1}>
            <Text bold color="green">▌Active ({active.length})</Text>
            {active.map(r => sessionRow(r, whereOf(r)))}
          </Box>
        )}
        {groups.map(g => (
          <Box key={g.key} flexDirection="column" marginTop={1}>
            <Box key={`group-${g.key}`} flexDirection="row">
              <Text bold color={g.key === 'other' ? 'gray' : 'blue'} wrap="truncate">
                ▌{g.label} ({g.rows.length}){' '}
              </Text>
              {count(g.rows, 'busy') > 0 && <Text color="green" bold>● {count(g.rows, 'busy')} running </Text>}
              {count(g.rows, 'waiting') > 0 && <Text color="yellow" bold>◐ {count(g.rows, 'waiting')} need you </Text>}
              {g.key !== 'other' && (
                <Button
                  key={`close-${g.key}`}
                  plain
                  dimColor={armed !== g.key}
                  label={g.stats?.winSource !== 'extension' ? '✕ close (reload window first)' : armed === g.key ? '✕ press again to close window' : '✕ close'}
                  hover={{ color: 'red' }}
                  onPress={() => void pressClose($, g)}
                />
              )}
            </Box>
            {g.stats && (
              <Text dimColor wrap="truncate">
                {'  '}{g.stats.winSource === 'terminals' ? 'claude terminals' : 'window'} CPU {g.stats.winCpu}% · {g.stats.winMemMB}MB │ VS Code CPU {g.stats.appCpu}% · GPU proc{' '}
                {g.stats.gpuProcCpu}%{g.stats.gpuUtil !== undefined ? ` · GPU ${g.stats.gpuUtil}% (system)` : ''}
              </Text>
            )}
            {g.rows.filter(r => !pinned(r)).map(r => sessionRow(r))}
            {g.rows.some(pinned) && (
              <Text dimColor>{'  '}↑ {g.rows.filter(pinned).length} in Active above</Text>
            )}
          </Box>
        ))}
      </Box>
    )
  })
}
