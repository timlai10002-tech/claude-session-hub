import { expect, test } from 'claude-code/testing'

const FAKE = [
  {
    pid: 1, sessionId: 'a', name: 'web-shop-c0', cwd: '~/web-shop', status: 'waiting',
    waitingFor: 'permission prompt', statusSince: 0, title: 'Nav tests',
    lastPrompt: 'run the suite', todosDone: 2, todosTotal: 5, todoActive: 'Running tests',
    app: 'vscode', window: 'w1', windowLabel: '~/web-shop', tty: 'ttys015',
    ctxTokens: 420000, ctxMax: 1000000, winCpu: 12.5, winMemMB: 830, winSource: 'extension', appCpu: 31, gpuProcCpu: 4.2, gpuUtil: 10,
  },
  { pid: 2, sessionId: 'b', name: 'data-pipeline-c9', cwd: '~/data-pipeline', status: 'idle', statusSince: 0, app: 'vscode', window: 'w2', windowLabel: '~/data-pipeline', tty: 'ttys007', winCpu: 0.6, winMemMB: 111, winSource: 'terminals', appCpu: 10.5, gpuProcCpu: 0, gpuUtil: 18 },
  { pid: 3, sessionId: 'c', name: 'tim-cb', cwd: '~', status: 'busy', statusSince: 0, lastTool: 'Bash: Run the test suite', app: 'Apple_Terminal', window: '', tty: 'ttys000' },
]

for (const surface of ['terminal', 'desktop'] as const) {
  test(`pane groups sessions by VS Code window on ${surface}`, async ($, on) => {
    on('process.run', async () => ({ value: { exitCode: 0, stdout: JSON.stringify(FAKE), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never)
    on('ui.open', async () => ({ value: { isPlaced: true } }) as never)

    const ran = await $.command.run({ command: 'sessions', args: '' } as never)
    expect(ran).toEqual(expect.objectContaining({ text: 'Sessions pane opened.' }))

    const ui = await $.ui.mount({
      plugin: 'session-progress', surface, component: 'Pane',
      requestId: 'session-progress', props: {} as never,
    })
    expect(await ui.find({ text: /web-shop-c0/ })).toBeDefined()
    expect(await ui.find({ text: /permission prompt/ })).toBeDefined()
    expect(await ui.find({ text: /2\/5/ })).toBeDefined()
    expect(await ui.find({ text: /data-pipeline-c9/ })).toBeDefined()
    expect(await ui.find({ text: /VS Code · ~\/web-shop \(1\)/ })).toBeDefined()
    expect(await ui.find({ text: /Other terminals \(1\)/ })).toBeDefined()
    expect(await ui.find({ text: /2 VS Code terminals/ })).toBeDefined()
    await ui.unmount()
  })
}

test('pressing a VS Code session asks vscode.py to raise its terminal', async ($, on) => {
  const calls: string[][] = []
  on('process.run', async (_$, e) => {
    const argv = (e as { argv: string[] }).argv
    calls.push(argv)
    const stdout = argv.some(a => a.endsWith('vscode.py')) ? JSON.stringify({ ok: true, terminal: 'zsh' }) : JSON.stringify(FAKE)
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)

  await $.command.run({ command: 'sessions', args: '' } as never)
  const ui = await $.ui.mount({
    plugin: 'session-progress', surface: 'terminal', component: 'Pane',
    requestId: 'session-progress', props: {} as never,
  })
  await ui.press({ key: 'open-a' })
  const focusCall = calls.find(argv => argv.some(a => a.endsWith('vscode.py')))
  expect(focusCall?.slice(-2)).toEqual(['focus', '1'])
  expect(await ui.find({ text: /↗ web-shop-c0/ })).toBeDefined()
  await ui.unmount()
})

test('pane shows context use and window CPU/GPU', async ($, on) => {
  on('process.run', async () => ({ value: { exitCode: 0, stdout: JSON.stringify(FAKE), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  await $.command.run({ command: 'sessions', args: '' } as never)
  const ui = await $.ui.mount({ plugin: 'session-progress', surface: 'terminal', component: 'Pane', requestId: 'session-progress', props: {} as never })
  expect(await ui.find({ text: /420k\/1M \(42%\)/ })).toBeDefined()
  expect(await ui.find({ text: /window CPU 12.5% · 830MB/ })).toBeDefined()
  expect(await ui.find({ text: /GPU proc 4.2% · GPU 10% \(system\)/ })).toBeDefined()
  expect(await ui.find({ text: /claude terminals CPU 0.6% · 111MB │ VS Code CPU 10.5%/ })).toBeDefined()
  await ui.unmount()
})

test('close needs two presses and then asks vscode.py to close the window', async ($, on) => {
  const calls: string[][] = []
  on('process.run', async (_$, e) => {
    const argv = (e as { argv: string[] }).argv
    calls.push([...argv])
    const stdout = argv.some(a => a.endsWith('vscode.py')) ? JSON.stringify({ ok: true }) : JSON.stringify(FAKE)
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  await $.command.run({ command: 'sessions', args: '' } as never)
  const ui = await $.ui.mount({ plugin: 'session-progress', surface: 'terminal', component: 'Pane', requestId: 'session-progress', props: {} as never })
  const closes = () => calls.filter(argv => argv.includes('close'))

  await ui.press({ key: 'close-vscode:w1' })
  expect(closes()).toHaveLength(0)
  expect(await ui.find({ text: /press again to close window/ })).toBeDefined()

  await ui.press({ key: 'close-vscode:w1' })
  expect(closes().map(argv => argv.slice(-2))).toEqual([['close', '1']])
  await ui.unmount()
})

test('running and waiting sessions are badged and counted', async ($, on) => {
  on('process.run', async () => ({ value: { exitCode: 0, stdout: JSON.stringify(FAKE), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  await $.command.run({ command: 'sessions', args: '' } as never)
  const ui = await $.ui.mount({ plugin: 'session-progress', surface: 'terminal', component: 'Pane', requestId: 'session-progress', props: {} as never })
  expect(await ui.find({ text: /● 1 running/ })).toBeDefined()
  expect(await ui.find({ text: /◐ 1 need you/ })).toBeDefined()
  expect(await ui.find({ text: /▶ RUNNING/ })).toBeDefined()
  expect(await ui.find({ text: /⚠ NEEDS YOU/ })).toBeDefined()
  expect(await ui.find({ text: /now Bash: Run the test suite/ })).toBeDefined()
  await ui.unmount()
})

test('/sessions-web runs launch.py and reports the URL', async ($, on) => {
  const calls: string[][] = []
  on('process.run', async (_$, e) => {
    const argv = (e as { argv: string[] }).argv
    calls.push([...argv])
    const stdout = argv.some(a => a.endsWith('launch.py')) ? JSON.stringify({ ok: true, url: 'http://127.0.0.1:8787/', started: true }) : '[]'
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  const ran = await $.command.run({ command: 'sessions-web', args: '' } as never)
  expect(ran).toEqual(expect.objectContaining({ text: 'Sessions web view started: http://127.0.0.1:8787/' }))
  expect(calls.some(argv => argv.some(a => a.endsWith('web/launch.py')))).toBe(true)
})

test('close is refused with a reload hint when the window has no heartbeat', async ($, on) => {
  const calls: string[][] = []
  const toasts: string[] = []
  on('process.run', async (_$, e) => {
    calls.push([...(e as { argv: string[] }).argv])
    return { value: { exitCode: 0, stdout: JSON.stringify(FAKE), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', async (_$, e) => { toasts.push(String((e as { text: string }).text)); return { value: undefined } as never })
  await $.command.run({ command: 'sessions', args: '' } as never)
  const ui = await $.ui.mount({ plugin: 'session-progress', surface: 'terminal', component: 'Pane', requestId: 'session-progress', props: {} as never })
  expect(await ui.find({ text: /reload window first/ })).toBeDefined()
  await ui.press({ key: 'close-vscode:w2' })
  await ui.press({ key: 'close-vscode:w2' })
  expect(calls.filter(argv => argv.includes('close'))).toHaveLength(0)
  expect(toasts.some(t => /Reload Window/.test(t))).toBe(true)
  await ui.unmount()
})

test('idle sessions show how long they have been idle', async ($, on) => {
  const now = Date.now()
  const list = [
    { ...FAKE[1], sessionId: 'i1', name: 'idle-mins', statusSince: now - 12 * 60_000 },
    { ...FAKE[1], sessionId: 'i2', name: 'idle-hours', statusSince: now - (3 * 60 + 12) * 60_000 },
    { ...FAKE[1], sessionId: 'i3', name: 'idle-days', statusSince: now - (2 * 24 + 5) * 3_600_000 },
  ]
  on('process.run', async () => ({ value: { exitCode: 0, stdout: JSON.stringify(list), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  await $.command.run({ command: 'sessions', args: '' } as never)
  const ui = await $.ui.mount({ plugin: 'session-progress', surface: 'terminal', component: 'Pane', requestId: 'session-progress', props: {} as never })
  expect(await ui.find({ text: /idle 12m/ })).toBeDefined()
  expect(await ui.find({ text: /idle 3h12m/ })).toBeDefined()
  expect(await ui.find({ text: /idle 2d5h/ })).toBeDefined()
  await ui.unmount()
})

test('rows show the per-prompt sparkline, last growth and cache time left', async ($, on) => {
  const now = Date.now()
  const list = [{ ...FAKE[0], ctxTokens: 165_000, ctxGrowth: [1000, 9000, 6000, 3000, 10_100], cacheExpiresAt: now + 54 * 60_000 + 20_000 }]
  on('process.run', async () => ({ value: { exitCode: 0, stdout: JSON.stringify(list), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  await $.command.run({ command: 'sessions', args: '' } as never)
  const ui = await $.ui.mount({ plugin: 'session-progress', surface: 'terminal', component: 'Pane', requestId: 'session-progress', props: {} as never })
  expect(await ui.find({ text: /▂▇▅▃█/ })).toBeDefined()
  expect(await ui.find({ text: /▲ \+10.1k/ })).toBeDefined()
  expect(await ui.find({ text: /cache 54 min/ })).toBeDefined()
  await ui.unmount()
})

test('a tool call is recorded for the web view before it runs', async ($, on) => {
  const writes: { path: string; text: string }[] = []
  on('fs.write', async (_$, e) => {
    writes.push(e as never)
    return { value: undefined } as never
  })
  on('session.id', async () => ({ value: 'sid-1' }) as never)
  on('tool.call', async () => ({ result: { text: 'ok' } }) as never)

  await $.tool.call({ tool: 'Bash', command: 'rm -rf build', description: 'Clean' } as never)
  // The recorder runs beside the call (not awaited): let its session.id and fs.write settle.
  for (let i = 0; i < 20; i++) await Promise.resolve()
  const rec = writes.find(w => w.path.endsWith('/web/pending/sid-1.json'))
  expect(rec).toBeDefined()
  const body = JSON.parse(rec!.text)
  expect(body.tool).toBe('Bash')
  expect(body.input).toEqual({ command: 'rm -rf build', description: 'Clean' })
})

test('each prompt is summarised in a few words for the voice; slash commands are not', async ($, on) => {
  const writes: { path: string; text: string }[] = []
  const asked: string[] = []
  on('fs.write', async (_$, e) => {
    writes.push(e as never)
    return { value: undefined } as never
  })
  on('session.id', async () => ({ value: 'sid-1' }) as never)
  on('model.complete', async (_$, e) => {
    asked.push(String((e as { prompt: unknown }).prompt))
    return { value: { isAnswered: true, text: '"Review fixed reply sentences."\n', usage: {} } } as never
  })
  on('prompt.submit', async (_$, e) => ({ text: (e as { text: string }).text }) as never)

  await $.prompt.submit({ text: '/sessions-web' } as never)
  for (let i = 0; i < 20; i++) await Promise.resolve()
  expect(asked).toHaveLength(0)

  await $.prompt.submit({ text: '幫我修好結帳按鈕' } as never)
  for (let i = 0; i < 20; i++) await Promise.resolve()
  expect(asked).toHaveLength(1)
  expect(asked[0]).toContain('幫我修好結帳按鈕')
  for (let i = 0; i < 50 && !writes.length; i++) await Promise.resolve()
  const rec = writes.find(w => w.path.endsWith('/web/topics/sid-1.json'))
  expect(JSON.parse(rec!.text).topic).toBe('Review fixed reply sentences')
})

test('running and waiting sessions are pinned in an Active section, tagged with their window', async ($, on) => {
  on('process.run', async () => ({ value: { exitCode: 0, stdout: JSON.stringify(FAKE), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  await $.command.run({ command: 'sessions', args: '' } as never)
  const ui = await $.ui.mount({ plugin: 'session-progress', surface: 'terminal', component: 'Pane', requestId: 'session-progress', props: {} as never })
  expect(await ui.find({ text: /Active \(2\)/ })).toBeDefined()
  expect(await ui.find({ text: /\[VS Code · ~\/web-shop\]/ })).toBeDefined()
  expect(await ui.find({ text: /\[Terminal\]/ })).toBeDefined()
  expect(await ui.find({ text: /↑ 1 in Active above/ })).toBeDefined()
  await ui.unmount()
})

// A running VS Code session whose window can take keys, and one that finished a minute ago.
const LIVE = [
  { pid: 7, sessionId: 'r', name: 'web-shop-build', cwd: '~/web-shop', status: 'busy', statusSince: 1234, app: 'vscode', window: 'w1', windowLabel: '~/web-shop', tty: 'ttys009', winCpu: 3, winMemMB: 90, winSource: 'extension', extVersion: '0.3.1', appCpu: 5, gpuProcCpu: 0 },
  { pid: 8, sessionId: 'd', name: 'web-shop-docs', cwd: '~/web-shop', status: 'idle', statusSince: Date.now() - 60_000, lastReply: 'All done.', app: 'vscode', window: 'w1', windowLabel: '~/web-shop', tty: 'ttys010' },
]

test('a session that just finished is pinned as DONE', async ($, on) => {
  on('process.run', async () => ({ value: { exitCode: 0, stdout: JSON.stringify(LIVE), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  await $.command.run({ command: 'sessions', args: '' } as never)
  const ui = await $.ui.mount({ plugin: 'session-progress', surface: 'terminal', component: 'Pane', requestId: 'session-progress', props: {} as never })
  expect(await ui.find({ text: /✓ DONE 1m ✕/ })).toBeDefined()
  expect(await ui.find({ text: /Active \(2\)/ })).toBeDefined()
  await ui.unmount()
})

test('a finish past its DONE setting (doneUntil) drops to the idle list', async ($, on) => {
  const expired = LIVE.map(r => (r.sessionId === 'd' ? { ...r, doneUntil: Date.now() - 1 } : r))
  on('process.run', async () => ({ value: { exitCode: 0, stdout: JSON.stringify(expired), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  await $.command.run({ command: 'sessions', args: '' } as never)
  const ui = await $.ui.mount({ plugin: 'session-progress', surface: 'terminal', component: 'Pane', requestId: 'session-progress', props: {} as never })
  expect(await ui.find({ text: /✓ DONE/ })).toBeUndefined()
  expect(await ui.find({ text: /Active \(1\)/ })).toBeDefined()
  await ui.unmount()
})

test('stop needs two presses and then asks vscode.py to press Esc in that run', async ($, on) => {
  const calls: string[][] = []
  on('process.run', async (_$, e) => {
    const argv = (e as { argv: string[] }).argv
    calls.push([...argv])
    const stdout = argv.some(a => a.endsWith('vscode.py')) ? JSON.stringify({ ok: true }) : JSON.stringify(LIVE)
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  await $.command.run({ command: 'sessions', args: '' } as never)
  const ui = await $.ui.mount({ plugin: 'session-progress', surface: 'terminal', component: 'Pane', requestId: 'session-progress', props: {} as never })
  const stops = () => calls.filter(argv => argv.includes('stop'))

  await ui.press({ key: 'stop-r' })
  expect(stops()).toHaveLength(0)
  expect(await ui.find({ text: /press again to stop/ })).toBeDefined()

  await ui.press({ key: 'stop-r' })
  expect(stops().map(argv => argv.slice(-3))).toEqual([['stop', '7', '1234']])
  await ui.unmount()
})

test('dismissing a DONE session records it with seen.py and unpins it', async ($, on) => {
  const calls: string[][] = []
  let dismissed = false
  on('process.run', async (_$, e) => {
    const argv = (e as { argv: string[] }).argv
    calls.push([...argv])
    if (argv.some(a => a.endsWith('seen.py'))) dismissed = true
    const list = LIVE.map(r => (r.sessionId === 'd' && dismissed ? { ...r, seen: true } : r))
    const stdout = argv.some(a => a.endsWith('seen.py')) ? '{"ok":true}' : JSON.stringify(list)
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  await $.command.run({ command: 'sessions', args: '' } as never)
  const ui = await $.ui.mount({ plugin: 'session-progress', surface: 'terminal', component: 'Pane', requestId: 'session-progress', props: {} as never })
  expect(await ui.find({ text: /Active \(2\)/ })).toBeDefined()

  await ui.press({ key: 'seen-d' })
  const seen = calls.filter(argv => argv.some(a => a.endsWith('seen.py')))
  expect(seen.map(argv => argv.slice(-2))).toEqual([['d', String(LIVE[1]!.statusSince)]])
  expect(await ui.find({ text: /Active \(1\)/ })).toBeDefined()
  await ui.unmount()
})
