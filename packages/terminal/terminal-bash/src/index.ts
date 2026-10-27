/**
 * Persistent shell PTY backend over the subprocess terminal primitive, bounded
 * output, and provider-owned session cleanup.
 * @module @deepseek-ai/dsh-terminal-bash
 */

import type {} from '@deepseek-ai/dsh-working-directory'
import { Context } from '@deepseek-ai/cordis'
import { TerminalBackendCleanupError } from '@deepseek-ai/dsh-terminal'
import type { TerminalBackend, TerminalBackendSpawnSpec, TerminalSendOperation } from '@deepseek-ai/dsh-terminal'
import type { SubprocessTerminalHandle, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { ENCODING_PREAMBLE } from '@deepseek-ai/dsh-pwsh-local'
import { type Config, type ResolvedConfig, resolveConfig, type ShellDialect, validateConfig } from './config.ts'
import { LocalPtySession } from './session.ts'
import { CONTROLLED_PROMPT } from './sanitize.ts'

export { Config } from './config.ts'
export type { Config as TerminalLocalConfig } from './config.ts'

/** Cordis plugin name. */
export const name = 'terminal-bash'
/** Required services: terminal registry, process substrate, and working directory. */
export const inject = ['terminals', 'subprocess', 'workingDirectory']

function childEnvironment(spec: TerminalBackendSpawnSpec, dialect: ShellDialect): Record<string, string> {
  // The subprocess provider supplies its own scrubbed ambient base; these are
  // deliberate terminal-specific overrides layered after it.
  const common = {
    TERM: 'dumb',
    PAGER: 'cat',
    GIT_PAGER: 'cat',
    DSH_SHELL: '1',
    DSH_SESSION_ID: spec.owner.id,
    DSH_PTY_SESSION_ID: spec.sessionId,
  }
  if (dialect === 'pwsh') {
    // pwsh ignores PS1/PROMPT_COMMAND; its prompt is installed by the startup
    // bootstrap instead, and NO_COLOR keeps the renderer quiet.
    return { ...common, NO_COLOR: '1' }
  }
  return {
    ...common,
    PS1: CONTROLLED_PROMPT,
    // Re-asserting PS1 after the marker keeps prompt readiness working when a
    // command overwrote the shell variable: bash runs PROMPT_COMMAND before
    // rendering each prompt, so an override never survives to the next prompt.
    PROMPT_COMMAND: `printf "\\033]133;D;%s\\007" "$?"; PS1='${CONTROLLED_PROMPT}'`,
    BASH_SILENCE_DEPRECATION_WARNING: '1',
  }
}

/**
 * The pwsh prompt function that emits the shared OSC `133;D;` + BEL marker
 * before every prompt, mirroring bash's PROMPT_COMMAND. `[char]27`/`[char]7`
 * build the control bytes at runtime because raw ESC characters in submitted
 * input are unreliable under PSReadLine.
 */
export const PWSH_PROMPT_SETUP =
  "function prompt { [Console]::Write([char]27 + ']133;D;' + [int]$LASTEXITCODE + [char]7); '" + CONTROLLED_PROMPT + "' }"

// TODO(pty-initialize-race-home): Fold this outer abort race into
// LocalPtySession.initialize when the send-state consolidation lands; the
// session already owns the send lifecycle the race protects.
async function startupSession(
  session: LocalPtySession,
  dialect: ShellDialect,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  let startupOperation: TerminalSendOperation | undefined
  const start = async (): Promise<void> => {
    if (dialect === 'bash') {
      await session.initialize(signal)
      return
    }
    // pwsh cannot install its prompt from the environment. Write the prompt
    // function through the session, pin UTF-8 output before user input, and
    // accept only backend stdin_read evidence; echoed setup source containing
    // the printable prompt is not readiness. Follow-up sends bridge silence
    // settlements during startup, while one absolute deadline bounds them.
    let viewport = ''
    for (;;) {
      const first = viewport.length === 0
      startupOperation = session.startSend({
        text: first ? ENCODING_PREAMBLE + PWSH_PROMPT_SETUP : '',
        submit: first,
        ...signal !== undefined ? { signal } : {},
      })
      const result = await startupOperation.done
      if (result.waitReason === 'session_exit') throw new Error('PTY shell exited during startup')
      if (result.waitReason === 'timeout') throw new Error('PTY shell did not reach readiness before startup timeout')
      viewport = result.viewport
      if (result.waitReason === 'stdin_read') break
    }
    session.motd = viewport
  }
  const races: Promise<void>[] = []
  let onAbort: (() => void) | undefined
  if (signal !== undefined) {
    const aborted = Promise.withResolvers<never>()
    onAbort = () => { aborted.reject(signal.reason) }
    signal.addEventListener('abort', onAbort, { once: true })
    races.push(aborted.promise)
  }
  let deadlineTimer: NodeJS.Timeout | undefined
  if (dialect === 'pwsh') {
    const deadline = Promise.withResolvers<never>()
    deadlineTimer = setTimeout(() => {
      startupOperation?.cancel()
      deadline.reject(new Error('PTY shell did not reach readiness before startup timeout'))
    }, timeoutMs)
    races.push(deadline.promise)
  }
  try {
    signal?.throwIfAborted()
    await Promise.race([start(), ...races])
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
    if (signal !== undefined && onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}

/** Reject a failed startup only after its unpublished resources reach quiescence. */
async function rejectAfterStartupCleanup(error: unknown, cleanup: () => Promise<void>): Promise<never> {
  try {
    await cleanup()
  } catch (cleanupError: unknown) {
    throw new TerminalBackendCleanupError(error, cleanupError)
  }
  throw error
}

/** Local shell backend registered under the configured type. */
export class BashTerminalBackend implements TerminalBackend {
  readonly type: string

  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
    private readonly spawnTerminal: (
      spec: SubprocessTerminalSpawnSpec,
    ) => Promise<SubprocessTerminalHandle> = spec => ctx.subprocess.spawnTerminal(spec),
    private readonly createSession: (
      terminal: SubprocessTerminalHandle,
      config: ResolvedConfig,
    ) => LocalPtySession = (terminal, config) => new LocalPtySession(terminal, config),
  ) {
    this.type = config.backendType
  }

  async spawn(spec: TerminalBackendSpawnSpec): Promise<LocalPtySession> {
    spec.signal?.throwIfAborted()
    const terminal = await this.spawnTerminal({
      argv: [this.config.shellPath, ...this.config.shellArgs],
      cwd: spec.cwd ?? await this.ctx.workingDirectory.ensure(spec.owner, spec.signal),
      env: childEnvironment(spec, this.config.shellDialect),
      rows: this.config.rows,
      cols: this.config.cols,
      terminalType: 'dumb',
      graceMs: this.config.disposeGraceMs,
      signal: spec.signal,
    })
    let session: LocalPtySession
    try {
      session = this.createSession(terminal, this.config)
    } catch (error) {
      return rejectAfterStartupCleanup(error, () => terminal.terminate())
    }
    try {
      await startupSession(session, this.config.shellDialect, this.config.timeoutMs, spec.signal)
      return session
    } catch (error) {
      return rejectAfterStartupCleanup(error, () => session.close('PTY startup failed'))
    }
  }
}

/** Register the local PTY backend. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  validateConfig(resolved)
  ctx.terminals.registerBackend(new BashTerminalBackend(ctx, resolved))
}
