/** The account's rate-limit windows (shared by every session), as `$.session.usage()` reports them */
export type Limits = { at: number; list: { kind: string; percentUsed: number; resetsAt?: string }[] }

export type SessionRow = {
  pid: number
  sessionId: string
  name: string
  cwd: string
  status: string
  waitingFor?: string
  statusSince: number
  title?: string
  lastPrompt?: string
  lastReply?: string
  todosDone?: number
  todosTotal?: number
  todoActive?: string
  /** Context growth per answered prompt, last few, oldest first (negative after a compaction) */
  ctxGrowth?: number[]
  /** When the prompt cache written by the last main-thread request expires (ms) */
  cacheExpiresAt?: number
  /** The last tool call in the transcript, `Name: main argument` */
  lastTool?: string
  /** A waiting session's question: the tool call asking, and a single question's choices. */
  pending?: { kind: 'permission' | 'question' | 'plan'; tool: string; detail: string; options?: string[] }
  /** Terminal app hosting the session: `vscode`, `Apple_Terminal`, ... */
  app: string
  /** Which VS Code window (its git IPC socket id); empty outside VS Code */
  window: string
  windowLabel?: string
  tty: string
  /** Tokens in context at the last main-thread reply */
  ctxTokens?: number
  /** Assumed window: 1M once past 200k (or a [1m] model), else 200k */
  ctxMax?: number
  /** This VS Code window (ext host + its terminals), from the extension's heartbeat */
  winCpu?: number
  winMemMB?: number
  /** `extension`: ext host + all its terminals; `terminals`: only the terminals running claude (no heartbeat) */
  winSource?: 'extension' | 'terminals'
  /** The window's claude-terminal-focus version; absent before 0.3.1, which cannot type answers. */
  extVersion?: string
  /** The whole VS Code app instance the window belongs to */
  appCpu?: number
  /** CPU of that instance's GPU process (per-process GPU time needs sudo) */
  gpuProcCpu?: number
  /** System-wide GPU utilization % (ioreg) */
  gpuUtil?: number
}

declare module 'claude-code' {
  interface PluginState {
    'session-progress': { rows: SessionRow[]; scannedAt: number; closeArmed: string; limits: Limits }
  }
}
