/**
 * Consumer-surface tests for the `pwsh` tool over a FAKE bash executor,
 * exercised through `ctx.tools.execute()` so nothing bypasses the tool
 * registry. The fake executor makes every seam outcome scriptable — output
 * text, truncation, timeout, abort, nonzero exits, background handles — so
 * these tests verify the schema, argument validation, workdir derivation,
 * managed `DSH_*` collection, abort translation, canonical result projection,
 * rendering, background job wiring, and the UI presenters. Real-pwsh behavior
 * is pinned separately in integration.spec.ts.
 */

import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { TOOL_ABORTED, TOOL_ABORTED_BEFORE_DISPATCH } from '@deepseek-ai/dsh-tools'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { ShellExecRequest, ShellExecSpec, ShellExecution, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'
import * as ToolPwsh from '@deepseek-ai/dsh-tool-pwsh'
import * as BashEnvPlugin from '@deepseek-ai/dsh-shell-env'
import { processOutcome } from '../src/background.ts'
import { renderPwshJobRead, renderPwshResult } from '../src/render.ts'

/** Empty offset readers for fakes that never produce output. */
const silentReader = { readFrom: (fromByte: number) => ({ text: '', nextOffset: fromByte, lossy: false }) }

/** Use the newest id returned by the real registry, including settled jobs. */
function currentId(ctx: Context, owner?: Agent): string {
  const id = ctx.jobs.list(owner?.id).at(-1)?.id
  if (id === undefined) throw new Error('background job was not registered')
  return id
}

const testToolSignal = new AbortController().signal

/** Per-test temp dirs (session cwd/home fixtures), removed after each test. */
const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * A scriptable fake executor: `resolve()` mirrors the real defaulting, `run()`
 * returns the armed foreground script, `start()` returns the armed background
 * handle.
 */
class FakeBash extends ShellExecutor {
  requests: ShellExecRequest[] = []
  specs: ShellExecSpec[] = []
  startCalls = 0
  handler: (spec: ShellExecSpec) => ShellRunResult = () => runResult('')
  backgroundHandler: (spec: ShellExecSpec) => ShellProcess = () => fakeProcess('bg-ok\n')

  override resolve(request: ShellExecRequest): ShellExecSpec {
    this.requests.push(request)
    return {
      command: request.command,
      workdir: request.workdir ?? process.cwd(),
      timeoutMs: request.timeoutMs ?? 60_000,
      onExpiry: request.onExpiry ?? 'kill',
      stdoutMaxBytes: request.stdoutMaxBytes ?? 64_000,
      ...request.signal ? { signal: request.signal } : {},
      ...request.stdin !== undefined ? { stdin: request.stdin } : {},
      ...request.env !== undefined ? { env: request.env } : {},
      ...request.dshEnv !== undefined ? { dshEnv: request.dshEnv } : {},
    }
  }

  override async execute(spec: ShellExecSpec): Promise<ShellExecution> {
    this.specs.push(spec)
    // A job's starter (background, or a foreground call with a registry) runs
    // under `none`; the deadline-killed foreground path keeps `kill`. Both
    // project the scripted result, since a foreground job reads it too.
    if (spec.onExpiry === 'none') this.startCalls++
    const proc = spec.onExpiry === 'none' ? this.backgroundHandler(spec) : fakeProcess()
    return Object.assign(proc, { result: () => Promise.resolve(this.handler(spec)) })
  }
}

/** A successful run result over the given stdout; overrides script the failure shapes. */
function runResult(stdout: string, overrides?: Partial<ShellRunResult>): ShellRunResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: 60_000,
    stdout: { text: stdout, truncated: false },
    stderr: { text: '', truncated: false },
    ...overrides,
  }
}

/** A settled successful background handle; overrides script failure shapes. */
function fakeProcess(delta = 'bg-ok\n'): ShellProcess {
  return {
    status: 'completed',
    exitCode: 0,
    signal: null,
    done: Promise.resolve(),
    readOutput: () => ({ delta: '', lossy: false }),
    kill: () => false,
    // ASCII only: the observed offsets are string indexes.
    observed: {
      stdout: { readFrom: (fromByte: number) => ({ text: delta.slice(fromByte), nextOffset: delta.length, lossy: false }) },
      stderr: { readFrom: (fromByte: number) => ({ text: '', nextOffset: fromByte, lossy: false }) },
    },
  }
}

/** A running background handle whose kill() settles it as killed (like a real job_kill). */
function killableProcess(): ShellProcess {
  let resolveDone: () => void = () => {}
  const done = new Promise<void>((resolve) => { resolveDone = resolve })
  const proc: ShellProcess = {
    status: 'running',
    exitCode: null,
    signal: null,
    done,
    readOutput: () => ({ delta: '', lossy: false }),
    observed: { stdout: silentReader, stderr: silentReader },
    kill: () => {
      if (proc.status !== 'running') return false
      proc.status = 'killed'
      proc.signal = 'SIGTERM'
      resolveDone()
      return true
    },
  }
  return proc
}

async function setup(toolConfig: Partial<ToolPwsh.Config> = {}, dshHome?: string) {
  const ctx = new Context()
  provideWorkingDirectoryFixture(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(BashEnvPlugin, dshHome === undefined ? {} : { dshHome })
  await ctx.plugin(FakeBash)
  await ctx.plugin(ToolPwsh, toolConfig)
  const bash = ctx.shell as FakeBash
  return { ctx, bash }
}

/** Full harness: the generic job runtime + its controller, then the pwsh tool. */
async function setupWithJobs(toolConfig: Partial<ToolPwsh.Config> = {}, dshHome?: string) {
  const ctx = new Context()
  provideWorkingDirectoryFixture(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalJobRegistry)
  await ctx.plugin(ToolJobs)
  await ctx.plugin(BashEnvPlugin, dshHome === undefined ? {} : { dshHome })
  await ctx.plugin(FakeBash)
  await ctx.plugin(ToolPwsh, toolConfig)
  const bash = ctx.shell as FakeBash
  return { ctx, bash }
}


/**
 * Build a fake {@link Agent} with the shared agent/session identity, give it a
 * dedicated lifecycle fiber for `Agent.ctx`, and register it in `ctx.agents`.
 * The fake session carries an empty event log, mirroring a real session.
 */
async function registerFakeAgent(ctx: Context, sessionId: string): Promise<Agent> {
  const scopeFiber = ctx.plugin(() => {})
  const id = SessionId(sessionId)
  const agent = {
    id,
    ctx: scopeFiber.ctx,
    session: {
      id,
      header: { version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false },
      inheritedEventCount: SessionLogOffset(0),
      firstLiveSeq: SessionLogOffset(0),
      seq: SessionLogOffset(0),
      eventAt: () => undefined,
      snapshotEvents: () => [],
    },
  } as unknown as Agent
  await ctx.agents.register(agent)
  return agent
}

let callCounter = 0
function call(ctx: Context, name: string, args: unknown, agent?: Agent) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId(`call-${++callCounter}`),
    name,
    arguments: args,
    ...agent ? { agent } : {},
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

async function callUntilText(
  ctx: Context,
  name: string,
  args: unknown,
  expected: string,
  timeoutMs = 5_000,
): Promise<Awaited<ReturnType<typeof call>>> {
  const deadline = Date.now() + timeoutMs
  let last: Awaited<ReturnType<typeof call>> | undefined
  while (Date.now() < deadline) {
    last = await call(ctx, name, args)
    if (text(last).includes(expected)) return last
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`tool output did not include ${JSON.stringify(expected)}; last text ${JSON.stringify(last === undefined ? '' : text(last))}`)
}

describe('registration', () => {
  it.each([
    ['foreground-only', setup],
    ['job-backed', setupWithJobs],
  ] as const)('requests description before command in the %s schema', async (_mode, setupContext) => {
    const { ctx } = await setupContext()
    try {
      const schema = ctx.tools.schemas().find(tool => tool.name === 'pwsh')!
      expect(Object.keys(schema.parameters.properties as Record<string, unknown>).slice(0, 2))
        .toEqual(['description', 'command'])
      expect(schema.parameters).toHaveProperty('required', ['description', 'command'])
      expect(schema.description).toContain('Provide `description` before `command` in the arguments.')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('registers the pwsh tool with its prompt section and schema', async () => {
    const { ctx } = await setupWithJobs()
    const schema = ctx.tools.schemas().find(s => s.name === 'pwsh')
    expect(schema).toBeDefined()
    expect(schema?.description).toContain('PowerShell command')
    expect(schema?.parameters.properties).toMatchObject({
      command: { type: 'string' },
      description: { type: 'string' },
      timeoutMs: { type: 'number' },
      workdir: { type: 'string' },
      run_in_background: { type: 'boolean' },
    })
    expect(schema?.parameters.required).toEqual(['description', 'command'])
    const prompt = renderPrompt(await ctx.systemPrompt.assemble())
    expect(prompt).toContain('Non-zero exits are reported as `[exit code: N]` markers')
    expect(prompt).toContain('without a signal marker')
  })

  it('registers a foreground-only schema without a job registry', async () => {
    const { ctx } = await setup()
    const schema = ctx.tools.schemas().find(s => s.name === 'pwsh')!
    expect(Object.keys(schema.parameters.properties as Record<string, unknown>))
      .toEqual(['description', 'command', 'timeoutMs', 'workdir'])
    expect(JSON.stringify(schema.parameters)).not.toContain('job_output')
  })

  it('stays pending until ctx.shell exists (inject)', async () => {
    const ctx = new Context()
    provideWorkingDirectoryFixture(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(ToolPwsh)
    expect(ctx.tools.schemas()).toHaveLength(0)
  })

  it('unregisters everything on fiber disposal (HMR safety)', async () => {
    const ctx = new Context()
    provideWorkingDirectoryFixture(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(BashEnvPlugin)
    await ctx.plugin(FakeBash)
    const fiber = await ctx.plugin(ToolPwsh)
    expect(ctx.tools.schemas()).toHaveLength(1)
    await fiber.dispose()
    expect(ctx.tools.schemas()).toHaveLength(0)
  })
})

describe('argument validation', () => {
  it('rejects a blank command or description and a non-positive timeoutMs', async () => {
    const { ctx } = await setup()
    expect(text(await call(ctx, 'pwsh', { command: '  ', description: 'd' }))).toContain('expected a non-empty string')
    expect(text(await call(ctx, 'pwsh', { command: 'Write-Output hi', description: ' ' }))).toContain('expected a non-empty string')
    expect(text(await call(ctx, 'pwsh', { command: 'Write-Output hi', description: 'd', timeoutMs: -1 })))
      .toContain('invalid timeoutMs: expected a positive number')
  })
})

describe('execution through the bash seam', () => {
  it('forwards command, session cwd, timeout, and managed DSH_* environment', async () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'dsh-tool-pwsh-home-'))
    tempDirs.push(dshHome)
    const { ctx, bash } = await setup({}, dshHome)
    bash.handler = () => runResult('hi\n')
    const agent = await registerFakeAgent(ctx, 'session-1')
    Object.assign(agent.session.header, { cwd: '/sessions/s1' })
    const result = await call(ctx, 'pwsh', {
      command: 'Write-Output hi',
      description: 'say hi',
      timeoutMs: 1234,
    }, agent)
    expect(result.isError).toBe(false)
    const request = bash.requests[0]
    expect(request?.command).toBe('Write-Output hi')
    expect(request?.workdir).toBe('/sessions/s1')
    expect(request?.timeoutMs).toBe(1234)
    expect(request?.dshEnv).toEqual({
      DSH_HOME: dshHome,
      DSH_SHELL: '1',
      DSH_SESSION_ID: 'session-1',
    })
    expect(bash.specs[0]?.workdir).toBe('/sessions/s1')
  })

  it('resolves a relative workdir against the session cwd, absolute ones verbatim', async () => {
    const { ctx, bash } = await setup()
    bash.handler = () => runResult('ok\n')
    const agent = await registerFakeAgent(ctx, 'session-cwd')
    Object.assign(agent.session.header, { cwd: '/sessions/s1' })
    await call(ctx, 'pwsh', { command: 'pwd', description: 'cwd', workdir: 'sub/dir' }, agent)
    expect(bash.requests[0]?.workdir).toBe(resolvePath('/sessions/s1', 'sub/dir'))
    await call(ctx, 'pwsh', { command: 'pwd', description: 'cwd', workdir: resolvePath('/abs/path') }, agent)
    expect(bash.requests[1]?.workdir).toBe(resolvePath('/abs/path'))
  })

  it('omits workdir and the session id without an agent, so executor defaulting applies', async () => {
    const { ctx, bash } = await setup()
    bash.handler = () => runResult('ok\n')
    await call(ctx, 'pwsh', { command: 'Write-Output ok', description: 'ok' })
    expect(bash.requests[0]).not.toHaveProperty('workdir')
    const dshEnv = bash.requests[0]?.dshEnv
    expect(dshEnv).toBeDefined()
    expect(dshEnv?.['DSH_SHELL']).toBe('1')
    expect(dshEnv?.['DSH_HOME']).toEqual(expect.any(String))
    expect(dshEnv).not.toHaveProperty('DSH_SESSION_ID')
  })

  it('forwards exec.signal into the resolved request', async () => {
    const { ctx, bash } = await setup()
    const controller = new AbortController()
    bash.handler = () => runResult('ok\n')
    await ctx.tools.execute({
      signal: controller.signal,
      callId: ToolCallId('call-signal'),
      name: 'pwsh',
      arguments: { command: 'Write-Output ok', description: 'ok' },
    })
    expect(bash.requests[0]?.signal).toBe(controller.signal)
  })

  it('projects the canonical foreground result with stdout, stderr, and exit facts', async () => {
    const { ctx, bash } = await setup()
    bash.handler = () => runResult('out\n', {
      exitCode: 2,
      stderr: { text: 'err\n', truncated: false },
      timeoutMs: 5000,
    })
    const result = await call(ctx, 'pwsh', { command: 'failing', description: 'fail' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected pwsh success')
    expect(result.value).toEqual({
      kind: 'foreground',
      cwd: process.cwd(),
      exitCode: 2,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: 5000,
      stdout: { text: 'out\n', truncated: false },
      stderr: { text: 'err\n', truncated: false },
    })
    expect(text(result)).toBe('out\n[stderr]\nerr\n[exit code: 2]')
  })

  it('renders a clean exit without a marker and an empty body as (no output)', async () => {
    const { ctx, bash } = await setup()
    bash.handler = () => runResult('hi\n')
    const clean = await call(ctx, 'pwsh', { command: 'Write-Output hi', description: 'say hi' })
    expect(text(clean)).toBe('hi\n')

    bash.handler = () => runResult('')
    const empty = await call(ctx, 'pwsh', { command: 'Write-Output -NoNewline ""', description: 'nothing' })
    expect(text(empty)).toBe('(no output)')
  })

  it('renders stderr-only output without a stdout prefix', async () => {
    const { ctx, bash } = await setup()
    bash.handler = () => runResult('', {
      stderr: { text: 'err\n', truncated: false },
      exitCode: 1,
    })
    const result = await call(ctx, 'pwsh', { command: 'fail', description: 'fail' })
    expect(text(result)).toBe('[stderr]\nerr\n[exit code: 1]')
  })

  it('inserts the separating newline before the stderr section when stdout lacks one', async () => {
    const { ctx, bash } = await setup()
    bash.handler = () => runResult('out', {
      stderr: { text: 'err\n', truncated: false },
      exitCode: 1,
    })
    const result = await call(ctx, 'pwsh', { command: 'fail', description: 'fail' })
    expect(text(result)).toBe('out\n[stderr]\nerr\n[exit code: 1]')
  })

  it('renders the truncation notice with the spill path, then markers', async () => {
    const { ctx, bash } = await setup()
    bash.handler = () => runResult('tail', {
      stdout: { text: 'tail', truncated: true, spillPath: '/spill/out.log' },
      stderr: { text: '', truncated: false },
    })
    const result = await call(ctx, 'pwsh', { command: 'noisy', description: 'noise' })
    expect(text(result)).toBe('tail\n[output truncated; full output: /spill/out.log]')

    bash.handler = () => runResult('', { timedOut: true, exitCode: null, signal: 'SIGTERM', timeoutMs: 500 })
    const timedOut = await call(ctx, 'pwsh', { command: 'slow', description: 'slow' })
    // A timeout kill carries both facts, mirroring the bash tool's markers.
    expect(text(timedOut)).toBe('(no output)\n[timed out after 500ms]\n[killed by signal: SIGTERM]')
  })

  it('renders the truncation notice with (unavailable) when no spill path exists', async () => {
    const { ctx, bash } = await setup()
    bash.handler = () => runResult('tail', {
      stdout: { text: 'tail', truncated: true },
      stderr: { text: '', truncated: false },
    })
    const result = await call(ctx, 'pwsh', { command: 'noisy', description: 'noise' })
    expect(text(result)).toBe('tail\n[output truncated; full output: (unavailable)]')
  })

  it('translates an aborted run into the TOOL_ABORTED HarnessError', async () => {
    const { ctx, bash } = await setup()
    bash.handler = () => runResult('', { aborted: true, exitCode: null, signal: 'SIGTERM' })
    const result = await call(ctx, 'pwsh', { command: 'Start-Sleep -Seconds 60', description: 'sleep' })
    expect(result.isError).toBe(true)
    expect(result.error).toMatchObject({ info: { name: 'AbortError', code: TOOL_ABORTED } })
  })
})

describe('background execution through the job runtime', () => {
  it('run_in_background acks with the job id, readable through the REAL job_output tool', async () => {
    const { ctx } = await setupWithJobs()
    const started = await call(ctx, 'pwsh', { command: 'Write-Output bg-ok', description: 'test command', run_in_background: true })
    expect(started.isError).toBe(false)
    if (started.isError) throw new Error('expected background pwsh success')
    expect(started.value).toEqual({ kind: 'background', jobId: currentId(ctx), cwd: process.cwd() })
    expect(text(started)).toBe(`started background job ${currentId(ctx)}`)

    const read = await callUntilText(ctx, 'job_output', { job_id: currentId(ctx) }, 'bg-ok')
    expect(text(read)).toContain('bg-ok')
    // A later read reports the terminal outcome in the generic status line.
    const final = await callUntilText(ctx, 'job_output', { job_id: currentId(ctx) }, '[status: completed, exit code: 0]')
    expect(final.isError).toBe(false)
  })

  it('a running background job is killable through the REAL job_kill tool', async () => {
    const { ctx, bash } = await setupWithJobs()
    bash.backgroundHandler = () => killableProcess()
    await call(ctx, 'pwsh', { command: 'Start-Sleep -Seconds 60', description: 'test command', run_in_background: true })

    const killed = await call(ctx, 'job_kill', { job_id: currentId(ctx) })
    expect(text(killed)).toBe(`requested cancellation of job ${currentId(ctx)}`)
    // The cancel reached the process handle; the task settles as killed with
    // the signal detail mapped by processOutcome.
    const final = await call(ctx, 'job_output', { job_id: currentId(ctx), wait: true })
    expect(text(final)).toContain('[status: killed, signal: SIGTERM]')
  })

  it('a background job started by an agent is registered with that agent as owner', async () => {
    const { ctx } = await setupWithJobs()
    const agent = await registerFakeAgent(ctx, 'sess-owner')
    const started = await call(ctx, 'pwsh', { command: 'Start-Sleep -Seconds 60', description: 'test command', run_in_background: true }, agent)
    expect(text(started)).toBe(`started background job ${currentId(ctx, agent)}`)

    const anon = await call(ctx, 'job_output', { job_id: currentId(ctx, agent) })
    expect(anon.isError).toBe(true)
    expect(text(anon)).toMatch(/belongs to another session/)

    const killed = await call(ctx, 'job_kill', { job_id: currentId(ctx, agent) }, agent)
    expect(killed.isError).toBe(false)
    await call(ctx, 'job_output', { job_id: currentId(ctx, agent), wait: true }, agent) // await settlement — no orphan
  })

  it('fails loud when the job runtime is not loaded', async () => {
    const { ctx } = await setup() // no LocalJobRegistry / ToolJobs
    const result = await call(ctx, 'pwsh', { command: 'Start-Sleep -Seconds 60', description: 'test command', run_in_background: true })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
  })

  it('a pre-aborted call is skipped before the process starts', async () => {
    const { ctx, bash } = await setupWithJobs()
    const controller = new AbortController()
    controller.abort()
    const result = await ctx.tools.execute({
      callId: ToolCallId('call-pre-aborted'),
      name: 'pwsh',
      arguments: { command: 'Start-Sleep -Seconds 60', description: 'test command', run_in_background: true },
      signal: controller.signal,
    })
    expect(result.isError).toBe(true)
    expect(result.error).toEqual({
      message: 'tool call aborted before dispatch',
      info: { name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH },
    })
    expect(bash.startCalls).toBe(0)
  })

  it('never spawns the process when tasks.start preflight throws (no orphan, by construction)', async () => {
    // With no job controller, preflight fails before the executor can spawn.
    const ctx = new Context()
    provideWorkingDirectoryFixture(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalJobRegistry)
    await ctx.plugin(BashEnvPlugin)
    await ctx.plugin(FakeBash)
    await ctx.plugin(ToolPwsh)
    const bash = ctx.shell as FakeBash

    const result = await call(ctx, 'pwsh', { command: 'Start-Sleep -Seconds 60', description: 'test command', run_in_background: true })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('no job controller serves this agent')
    // Declare-then-execute: the failed preflight means no process ever ran.
    expect(bash.startCalls).toBe(0)
  })

  it('enableRunInBackground: false removes the parameter and rejects the call', async () => {
    const { ctx } = await setup({ enableRunInBackground: false })
    const schema = ctx.tools.schemas().find(s => s.name === 'pwsh')!
    expect(Object.keys(schema.parameters.properties as Record<string, unknown>))
      .toEqual(['description', 'command', 'timeoutMs', 'workdir'])
    expect(schema.description).not.toContain('run_in_background')

    // Schema omission is advertising; execution must also enforce the opt-out.
    const forced = await call(ctx, 'pwsh', { command: 'Write-Output hi', description: 'test command', run_in_background: true })
    expect(forced.isError).toBe(true)
    expect(text(forced)).toContain('run_in_background is disabled for this deployment')
    const foreground = await call(ctx, 'pwsh', { command: 'Write-Output hi', description: 'test command' })
    expect(foreground.isError).toBe(false)
  })

  it('applies the built-in background default when apply() receives a bare config', async () => {
    // Bypasses the schemastery defaults on purpose: apply() must stand on its
    // own `?? true` fallback when embedded programmatically without the schema.
    const ctx = new Context()
    provideWorkingDirectoryFixture(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalJobRegistry)
    await ctx.plugin(BashEnvPlugin)
    await ctx.plugin(FakeBash)
    ToolPwsh.apply(ctx, {})
    // The job-backed variant registers from the registry fork, one turn later.
    await new Promise(resolve => setTimeout(resolve, 0))
    const schema = ctx.tools.schemas()[0]!
    expect(schema.parameters.properties).toHaveProperty('run_in_background')
    expect(JSON.stringify(schema.parameters)).toContain('job_output')
  })

  it('reports the deadline preparation timeout when the wait expires before a process exists', async () => {
    const { ctx, bash } = await setupWithJobs()
    // Preparation that only ends with the job's own cancellation: the wait
    // expires with no process, so the call reports the deadline's preparation
    // timeout and leaves no job record behind.
    const launch = vi.spyOn(bash, 'execute').mockImplementation(spec => new Promise<ShellExecution>((_resolve, reject) => {
      spec.signal?.addEventListener('abort', () => { reject(new Error('fixture preparation aborted')) }, { once: true })
    }))
    try {
      const result = await call(ctx, 'pwsh', { command: 'Write-Output ok', description: 'slow preparation', timeoutMs: 100 })
      if (result.isError) throw new Error('expected a foreground result')
      expect(result.value).toMatchObject({ kind: 'foreground', timedOut: true, exitCode: null })
      expect(text(result)).toBe('(no output)\n[timed out after 100ms]\n[exit code: null]')
      expect(ctx.jobs.list()).toEqual([])
    } finally {
      launch.mockRestore()
      await ctx.fiber.dispose()
    }
  })
})

describe('the background surface follows the job registry', () => {
  async function bare() {
    const ctx = new Context()
    provideWorkingDirectoryFixture(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(BashEnvPlugin)
    await ctx.plugin(FakeBash)
    return { ctx, bash: ctx.shell as FakeBash }
  }
  const backgroundAdvertised = (ctx: Context): boolean =>
    'run_in_background' in (ctx.tools.get('pwsh')!.parameters as { properties: Record<string, unknown> }).properties

  it('switches to the job-backed variant when a registry loads later, and back when it unloads', async () => {
    const { ctx, bash } = await bare()
    await ctx.plugin(ToolPwsh)
    expect(backgroundAdvertised(ctx)).toBe(false)

    const registry = await ctx.plugin(LocalJobRegistry)
    await ctx.plugin(ToolJobs)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(backgroundAdvertised(ctx)).toBe(true)
    const started = await call(ctx, 'pwsh', { command: 'Write-Output swapped', description: 'test command', run_in_background: true })
    expect(text(started)).toBe(`started background job ${currentId(ctx)}`)

    // The registry leaves; the foreground-only variant returns in its place,
    // and the tool never disappears in between.
    await registry.dispose()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(ctx.tools.get('pwsh')).toBeDefined()
    expect(backgroundAdvertised(ctx)).toBe(false)
    bash.handler = () => runResult('plain\n')
    const foreground = await call(ctx, 'pwsh', { command: 'Write-Output plain', description: 'test command' })
    expect(text(foreground)).toBe('plain\n')
    expect(bash.specs.at(-1)?.onExpiry).toBe('kill')
  })

  it('disposing the tool plugin while a registry is present removes the tool without restoring anything', async () => {
    const { ctx } = await bare()
    await ctx.plugin(LocalJobRegistry)
    await ctx.plugin(ToolJobs)
    const errors = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    const fiber = await ctx.plugin(ToolPwsh)
    expect(backgroundAdvertised(ctx)).toBe(true)
    await fiber.dispose()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(ctx.tools.get('pwsh')).toBeUndefined()
    expect(errors).not.toHaveBeenCalled()
  })
})

describe('UI presentation', () => {
  it('a real execute presents a completed foreground run as a terminal card with the parsed exit pill', async () => {
    const { ctx, bash } = await setup()
    bash.handler = () => runResult('hi\n')
    const args = { command: 'Write-Output hi', description: 'say hi' }
    const result = await call(ctx, 'pwsh', args)
    const view = ctx.tools.get('pwsh')?.presentResult?.(args, result)
    // A terminal result keeps the RAW bytes (newlines intact) a terminal
    // renderer needs; a clean run renders no exit marker, so the body is the
    // raw output with a clean exit-0 pill, mirroring the bash tool.
    expect(view).toEqual({ card: 'terminal', output: 'hi\n', exitCode: 0 })
  })

  it('the pending call view is a terminal card carrying command, description, and optional cwd', async () => {
    const { ctx } = await setup()
    const definition = ctx.tools.get('pwsh')
    expect(definition?.presentCall?.({ command: 'Get-Process', description: 'List processes' }))
      .toEqual({ card: 'terminal', title: 'Get-Process', description: 'List processes' })
    expect(definition?.presentCall?.({ command: 'Get-Process', description: 'List processes', workdir: 'C:\\work' }))
      .toMatchObject({ cwd: 'C:\\work' })
  })

  it('a background pending call renders the generic card like the bash tool', async () => {
    const { ctx } = await setup()
    const definition = ctx.tools.get('pwsh')
    expect(definition?.presentCall?.({
      command: 'Start-Sleep -Seconds 60',
      description: 'long wait',
      run_in_background: true,
    })).toEqual({
      card: 'generic',
      title: 'Start-Sleep -Seconds 60',
      kind: 'execute',
      rawInput: 'Start-Sleep -Seconds 60',
      content: [{ type: 'text', text: 'long wait' }],
    })
  })

  it('presentResult: a non-zero exit and a signal kill parse into exitCode / signal', async () => {
    const { ctx } = await setup()
    const present = ctx.tools.get('pwsh')
    const args = { command: 'x', description: 'x' }
    expect(present?.presentResult?.(args, { content: [{ type: 'text', text: 'oops\n[exit code: 3]' }], isError: false }))
      .toEqual({ card: 'terminal', output: 'oops', exitCode: 3 })
    expect(present?.presentResult?.(args, { content: [{ type: 'text', text: 'gone\n[killed by signal: SIGKILL]' }], isError: false }))
      .toEqual({ card: 'terminal', output: 'gone', signal: 'SIGKILL' })
  })

  it('presentResult: markers a pill CANNOT show (timeout) stay in the terminal output', async () => {
    const { ctx } = await setup()
    const args = { command: 'x', description: 'x' }
    expect(ctx.tools.get('pwsh')?.presentResult?.(
      args,
      { content: [{ type: 'text', text: 'slow\n[timed out after 100ms]\n[exit code: 143]' }], isError: false },
    )).toEqual({ card: 'terminal', output: 'slow\n[timed out after 100ms]', exitCode: 143 })
  })

  it('presentResult exit parse is the inverse of renderPwshResult markers (round-trip)', async () => {
    const { ctx } = await setup()
    const present = ctx.tools.get('pwsh')!
    const base = {
      aborted: false,
      timeoutMs: 1000,
      stdout: { text: 'out', truncated: false },
      stderr: { text: '', truncated: false },
    }
    const cases = [
      { result: { ...base, exitCode: 0, signal: null, timedOut: false }, expect: { exitCode: 0 } },
      { result: { ...base, exitCode: 7, signal: null, timedOut: false }, expect: { exitCode: 7 } },
      { result: { ...base, exitCode: null, signal: 'SIGTERM' as const, timedOut: false }, expect: { signal: 'SIGTERM' } },
      // A trapped-timeout run that exits 0 has no signal/exit marker → reads as exit 0 (it did exit 0).
      { result: { ...base, exitCode: 0, signal: null, timedOut: true }, expect: { exitCode: 0 } },
    ]
    for (const c of cases) {
      const rendered = renderPwshResult(c.result)
      const out = present.presentResult!({ command: 'x', description: 'x' }, { content: [{ type: 'text', text: rendered }], isError: false })
      // Drop card + output; the remaining fields are the parsed exit.
      const { card: _c, output, ...exit } = out as { card: string; output?: string; exitCode?: number; signal?: string }
      expect(exit).toEqual(c.expect)
      // Whatever the parse consumed is gone from the body, so a card with an
      // exit pill never shows the same status twice.
      expect(output).not.toMatch(/\[exit code: \d+\]|\[killed by signal: /)
    }
  })

  it('presentResult: a clean exit-0 whose output ENDS in marker-like text is NOT read as a failure', async () => {
    const { ctx } = await setup()
    const args = { command: 'Write-Output "[exit code: 5]"', description: 'print' }
    // A successful command may print marker-like text. A clean result appends no marker or
    // newline; parsing requires the leading newline emitted for real markers, so this stays exit 0.
    const out = ctx.tools.get('pwsh')!.presentResult!(args, { content: [{ type: 'text', text: '[exit code: 5]' }], isError: false })
    expect(out).toEqual({ card: 'terminal', output: '[exit code: 5]', exitCode: 0 })
    // Same for a fake signal marker with no leading newline.
    const sig = ctx.tools.get('pwsh')!.presentResult!(args, { content: [{ type: 'text', text: '[killed by signal: SIGKILL]' }], isError: false })
    expect(sig).toEqual({ card: 'terminal', output: '[killed by signal: SIGKILL]', exitCode: 0 })
  })

  it('presentResult: a run_in_background ack is a generic card and carries no exit pill', async () => {
    const { ctx } = await setup()
    const result = ctx.tools.get('pwsh')!.presentResult!(
      { command: 'Start-Sleep -Seconds 60', description: 'long wait', run_in_background: true },
      { content: [{ type: 'text', text: 'started background job pwsh-1' }], isError: false },
    )
    expect(result).toEqual({ card: 'generic', content: [{ type: 'text', text: '```console\nstarted background job pwsh-1\n```' }] })
  })

  it('presentResult: an isError result is a generic card (no real process exit to report)', async () => {
    const { ctx } = await setup()
    const out = ctx.tools.get('pwsh')!.presentResult!(
      { command: 'x', description: 'x' },
      { content: [{ type: 'text', text: 'tool call aborted' }], isError: true },
    )
    expect(out).toEqual({ card: 'generic', content: [{ type: 'text', text: '```console\ntool call aborted\n```' }] })
  })

  it('presentResult falls back to undefined for multi-block or non-text content', async () => {
    const { ctx } = await setup()
    const definition = ctx.tools.get('pwsh')
    const args = { command: 'Write-Output hi', description: 'say hi' }
    const multi = { content: [{ type: 'text' as const, text: 'a' }, { type: 'text' as const, text: 'b' }], isError: false }
    expect(definition?.presentResult?.(args, multi as never)).toBeUndefined()
    const image = { content: [{ type: 'image' as const, text: 'a' }], isError: false }
    expect(definition?.presentResult?.(args, image as never)).toBeUndefined()
  })
})


describe('renderPwshJobRead', () => {
  it('returns the delta verbatim for a lossless read', () => {
    expect(renderPwshJobRead('out\n', false, [])).toBe('out\n')
    expect(renderPwshJobRead('', false, [])).toBe('')
  })

  it('appends the loss notice with the available spill paths', () => {
    expect(renderPwshJobRead('out\n', true, ['C:\\spill\\out.log']))
      .toBe('out\n[some output was dropped from memory; full output: C:\\spill\\out.log]')
    expect(renderPwshJobRead('out\n', true, ['C:\\spill\\out.log', 'C:\\spill\\err.log']))
      .toBe('out\n[some output was dropped from memory; full output: C:\\spill\\out.log, C:\\spill\\err.log]')
  })

  it('reports (unavailable) when a lossy read has no safe spill path', () => {
    expect(renderPwshJobRead('out\n', true, []))
      .toBe('out\n[some output was dropped from memory; full output: (unavailable)]')
  })

  it('an empty lossy delta is the notice alone', () => {
    expect(renderPwshJobRead('', true, ['C:\\spill\\err.log']))
      .toBe('[some output was dropped from memory; full output: C:\\spill\\err.log]')
  })

  it('inserts the separating newline only when the delta lacks one', () => {
    expect(renderPwshJobRead('tail', true, []))
      .toBe('tail\n[some output was dropped from memory; full output: (unavailable)]')
    expect(renderPwshJobRead('tail\n', true, []))
      .toBe('tail\n[some output was dropped from memory; full output: (unavailable)]')
  })
})

describe('processOutcome', () => {
  function settled(over: Partial<ShellProcess>): ShellProcess {
    return {
      status: 'completed',
      exitCode: 0,
      signal: null,
      done: Promise.resolve(),
      readOutput: () => ({ delta: '', lossy: false }),
      observed: { stdout: silentReader, stderr: silentReader },
      kill: () => false,
      ...over,
    }
  }

  it('maps a signal-killed process to killed with the signal detail', () => {
    expect(processOutcome(settled({ status: 'killed', signal: 'SIGTERM' })))
      .toEqual({ status: 'killed', detail: 'signal: SIGTERM' })
  })

  it('maps a killed process without a recorded signal (kill raced exit / spawn failure)', () => {
    expect(processOutcome(settled({ status: 'killed', exitCode: null })))
      .toEqual({ status: 'killed', detail: 'killed before exit' })
  })

  it('maps a completed process to its exit code', () => {
    expect(processOutcome(settled({ exitCode: 3 })))
      .toEqual({ status: 'completed', detail: 'exit code: 3' })
  })

  it('defensively reads a null exit code as 0 (handle shapes from other executors)', () => {
    expect(processOutcome(settled({ exitCode: null })))
      .toEqual({ status: 'completed', detail: 'exit code: 0' })
  })
})

describe('resolved launch directory metadata', () => {
  it.each([
    { background: false, workdir: undefined },
    { background: false, workdir: 'relative' },
    { background: true, workdir: undefined },
    { background: true, workdir: 'relative' },
  ])('records the executor directory for background=$background and workdir=$workdir', async ({ background, workdir }) => {
    const { ctx, bash } = await setupWithJobs()
    const directory = mkdtempSync(join(tmpdir(), 'dsh-pwsh-cwd-meta-'))
    bash.handler = () => runResult('metadata-ok')
    bash.backgroundHandler = () => fakeProcess('metadata-ok')
    const current = join(directory, 'current')
    const ensure = vi.spyOn(ctx.workingDirectory, 'ensure').mockResolvedValue(current)
    const resolve = ctx.shell.resolve.bind(ctx.shell)
    const resolving = vi.spyOn(ctx.shell, 'resolve').mockImplementation(request => ({ ...resolve(request), workdir: directory }))
    const launch = vi.spyOn(ctx.shell, 'execute')
    try {
      const owner = await registerFakeAgent(ctx, 'directory-metadata')
      const result = await call(ctx, 'pwsh', {
        command: "[Console]::Out.Write('metadata-ok')", description: 'Read launch metadata', run_in_background: background,
        ...workdir === undefined ? {} : { workdir },
      }, owner)
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected shell success')
      expect(result.value).toMatchObject({ cwd: directory })
      expect(result.meta).toEqual({ cwd: directory })
      expect(resolving).toHaveBeenCalledOnce()
      expect(resolving).toHaveBeenCalledWith(expect.objectContaining({ workdir: workdir === undefined ? current : join(current, workdir) }))
      expect(launch).toHaveBeenCalledWith(expect.objectContaining({ workdir: directory }))
      expect(text(result)).toBe(background ? `started background job ${currentId(ctx, owner)}` : 'metadata-ok')
      if (background) await call(ctx, 'job_output', { job_id: currentId(ctx, owner), wait: true }, owner)
    } finally {
      ensure.mockRestore()
      resolving.mockRestore()
      launch.mockRestore()
      await ctx.fiber.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
