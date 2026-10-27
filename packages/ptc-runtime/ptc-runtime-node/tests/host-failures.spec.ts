import { AsyncLocalStorage } from 'node:async_hooks'
import { Duplex, PassThrough } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { PtcBindingFunction, PtcRunRequest } from '@deepseek-ai/dsh-ptc-runtime'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { Config } from '../src/index.ts'
import { JsonChannel } from '../src/channel.ts'
import { encodePtcJsonWire } from '../src/json-wire.ts'
import { mountRuntime } from './setup.ts'

const request: PtcRunRequest = { program: 'return 1', bindings: [] }
const NO_INITIAL_FRAME = Symbol('no initial frame')

async function setup(config: Config = {}) {
  const ctx = new Context()
  const { runtime } = await mountRuntime(ctx, config)
  const control = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      if (childControl.destroyed) { callback(new Error('peer closed')); return }
      childControl.push(chunk)
      callback()
    },
  })
  const childControl = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      if (control.destroyed) { callback(new Error('peer closed')); return }
      control.push(chunk)
      callback()
    },
  })
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const direct = Promise.withResolvers<SubprocessOutcome>()
  const messages: unknown[] = []
  const terminate = vi.fn(() => {
    stdout.end()
    stderr.end()
    direct.resolve({ exitCode: 0, signal: null })
  })
  const waitForExit = vi.fn(async () => true)
  const handle: SubprocessHandle = {
    stdin: undefined,
    stdout,
    stderr,
    control,
    collected: {},
    done: direct.promise,
    terminate,
    waitForExit,
  }
  const writes = new Set<Promise<void>>()
  let receive: (message: unknown) => void = () => {}
  const peer = new JsonChannel(childControl, 1024 * 1024, (message) => {
    messages.push(message)
    receive(message)
  }, () => {})
  const emit = (message: unknown): void => {
    const write = peer.send(message).catch(() => {}).finally(() => { writes.delete(write) })
    writes.add(write)
  }
  const resolveExecutable = vi.spyOn(ctx.subprocess, 'resolveExecutable').mockResolvedValue(process.execPath)
  const spawn = vi.spyOn(ctx.subprocess, 'spawn').mockReturnValue(handle)
  onTestFinished(async () => {
    peer.close()
    control.destroy()
    stdout.destroy()
    stderr.destroy()
    direct.resolve({ exitCode: 0, signal: null })
    await Promise.all(writes)
  })
  const start = (input: PtcRunRequest = request, first: unknown = { type: 'ready' }) => {
    const result = runtime.run(runtime.resolve(input))
    if (first !== NO_INITIAL_FRAME) queueMicrotask(() => { emit(first) })
    return result
  }
  const onBoot = (callback: () => void): void => {
    receive = (message) => {
      if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'boot') callback()
    }
  }
  return {
    ctx, runtime, handle, terminate, waitForExit, direct, stdout, stderr, control, peer, messages,
    spawn, resolveExecutable, emit, start, onBoot,
    receive: (callback: typeof receive) => { receive = callback },
  }
}

function call(id: number, value: string = '') {
  return { type: 'call', id, global: 'tools', name: 'test', args: encodePtcJsonWire(value) }
}

function withBinding(fn: PtcBindingFunction): PtcRunRequest {
  return { ...request, bindings: [{ global: 'tools', functions: { test: fn } }] }
}

describe('Node runtime host failures', () => {
  it.each<[Config, string]>([
    [{ timeoutMs: 0 }, 'timeoutMs'],
    [{ maxPendingCalls: -1 }, 'maxPendingCalls'],
    [{ maxOldGenerationSizeMb: Infinity }, 'maxOldGenerationSizeMb'],
    [{ timeoutMs: MAX_TIMER_DELAY_MS + 1 }, 'timeoutMs'],
    [{ maxTimeoutMs: MAX_TIMER_DELAY_MS + 1 }, 'maxTimeoutMs'],
    [{ graceMs: MAX_TIMER_DELAY_MS + 1 }, 'graceMs'],
    [{ maxOutputBytes: 3 }, 'maxOutputBytes'],
    [{ maxOutputBytes: 4.5 }, 'maxOutputBytes'],
    [{ maxMessageBytes: 1.5 }, 'maxMessageBytes'],
    [{ maxMessageBytes: 0x1_0000_0000 }, 'maxMessageBytes'],
    [{ maxPendingCalls: 1.5 }, 'maxPendingCalls'],
    [{ maxOldGenerationSizeMb: 1.5 }, 'maxOldGenerationSizeMb'],
    [{ launch: { kind: 'node-script', executable: '' } }, 'launch.executable'],
    [{ launch: { kind: 'node-script', executable: process.execPath, bootstrapPath: 'relative-bootstrap.js' } }, 'bootstrapPath'],
  ])('rejects deployment configuration %j', async (config, field) => {
    await expect(mountRuntime(new Context(), config)).rejects.toThrow(field)
  })

  it('rejects unsupported resolved inputs before spawning', async () => {
    const h = await setup()
    expect(() => h.runtime.resolve({ ...request, cwd: 'relative' })).toThrow('cwd must be absolute')
    const spec = h.runtime.resolve(request)
    await expect(h.runtime.run({ ...spec, timeoutMs: Infinity })).rejects.toThrow('resolved cwd and timeout')
    expect(h.spawn).not.toHaveBeenCalled()
    await h.ctx.fiber.dispose()
    expect(() => h.runtime.resolve(request)).toThrow('resolve after disposal')
    await expect(h.runtime.run(spec)).rejects.toThrow('run after disposal')
  })

  it('reports bootstrap assets that cannot map into the execution world', async () => {
    const h = await setup()
    vi.spyOn(h.ctx.fs, 'processPathFromHostPath').mockReturnValue(undefined)
    expect((await h.start()).error?.message).toContain('bootstrap is unavailable')
    expect(h.spawn).not.toHaveBeenCalled()
  })

  it('cleans up a provider that fails to supply its requested control pipe', async () => {
    const h = await setup()
    h.spawn.mockReturnValue({ ...h.handle, control: undefined })
    expect((await h.start()).error?.message).toContain('did not supply the requested control')
    expect(h.terminate).toHaveBeenCalledOnce()
    expect(h.waitForExit).toHaveBeenCalledOnce()
  })

  it('reports an executable lookup failure without allocating a process', async () => {
    const h = await setup()
    h.resolveExecutable.mockRejectedValue(new Error('Node executable missing'))
    expect((await h.start()).error).toEqual({ kind: 'worker-exit', message: 'Node executable missing' })
    expect(h.spawn).not.toHaveBeenCalled()
  })

  it('honors an already-aborted run without beginning executable lookup', async () => {
    const h = await setup()
    const result = await h.start({ ...request, signal: AbortSignal.abort('already stopped') }, NO_INITIAL_FRAME)
    expect(result.error).toEqual({ kind: 'abort', message: 'already stopped' })
    expect(h.resolveExecutable).not.toHaveBeenCalled()
  })

  it('keeps a null-deadline run active past the numeric ceiling until cancellation', async () => {
    const h = await setup({ timeoutMs: 20, maxTimeoutMs: 40 })
    const booted = Promise.withResolvers<undefined>()
    h.onBoot(() => { booted.resolve(undefined) })
    const controller = new AbortController()
    let active: ReturnType<typeof h.start> | undefined
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      active = h.start({ ...request, timeoutMs: null, signal: controller.signal })
      const settled = vi.fn()
      void active.then(settled)
      await booted.promise
      await vi.advanceTimersByTimeAsync(1000)
      expect(settled).not.toHaveBeenCalled()
      expect(h.terminate).not.toHaveBeenCalled()
      controller.abort('stop unlimited run')
      expect((await active).error).toEqual({ kind: 'abort', message: 'stop unlimited run' })
      expect(h.terminate).toHaveBeenCalledOnce()
      expect(h.waitForExit).toHaveBeenCalledOnce()
    } finally {
      controller.abort('test cleanup')
      vi.useRealTimers()
      await active
    }
  })

  it('does not launch after cancellation races executable lookup completion', async () => {
    const h = await setup()
    const controller = new AbortController()
    h.resolveExecutable.mockImplementation(async () => {
      controller.abort('lookup canceled')
      return process.execPath
    })
    expect((await h.start({ ...request, signal: controller.signal }, NO_INITIAL_FRAME)).error?.kind).toBe('abort')
    expect(h.spawn).not.toHaveBeenCalled()
  })

  it('reports an early control EOF using the direct process result', async () => {
    const h = await setup()
    h.spawn.mockImplementation(() => {
      queueMicrotask(() => {
        h.control.push(null)
        h.direct.resolve({ exitCode: 7, signal: null })
      })
      return h.handle
    })
    expect((await h.start(request, NO_INITIAL_FRAME)).error).toEqual({
      kind: 'worker-exit', message: 'Node process exited before completing (7)',
    })
  })

  it('reports startup transport loss when the direct process outcome rejects', async () => {
    const h = await setup()
    h.spawn.mockImplementation(() => {
      queueMicrotask(() => {
        h.control.emit('error', new Error('control transport closed'))
        h.direct.reject(new Error('runner connection broken'))
      })
      return h.handle
    })
    expect((await h.start(request, NO_INITIAL_FRAME)).error).toEqual({ kind: 'worker-exit', message: 'runner connection broken' })
  })

  it('reports control loss after readiness as a substrate failure', async () => {
    const h = await setup()
    h.onBoot(() => { h.control.emit('error', new Error('control transport closed')) })
    expect((await h.start()).error).toEqual({ kind: 'worker-exit', message: 'control transport closed' })
  })

  it('classifies invalid UTF-8 on the live control stream as a protocol failure', async () => {
    const h = await setup()
    h.onBoot(() => { h.control.push(Buffer.from([0, 0, 0, 1, 0xff])) })
    expect((await h.start()).error?.kind).toBe('protocol')
  })

  it('rejects traffic before readiness without invoking host bindings', async () => {
    const h = await setup()
    const binding = vi.fn(async () => null)
    const result = await h.start(withBinding(binding), call(1))
    expect(result.error?.message).toContain('before bootstrap readiness')
    expect(binding).not.toHaveBeenCalled()
  })

  it.each<[unknown, string]>([
    [null, 'invalid control frame'],
    [{ type: 'log', text: 1 }, 'invalid log frame'],
    [{ type: 'done', error: null }, 'invalid terminal error'],
    [{ type: 'done', error: { kind: 'exception', message: 1 } }, 'invalid terminal error'],
    [{ type: 'done', error: { kind: 'timeout', message: 'forged' } }, 'invalid terminal error'],
    [{ type: 'call', id: 0, global: 'tools', name: 'test' }, 'invalid binding call identity'],
    [{ ...call(1), name: 'constructor' }, 'undeclared binding'],
    [{ type: 'call', id: 1, global: 'tools', name: 'test' }, 'arguments must be lossless JSON'],
    [{ type: 'unknown' }, 'unknown control message'],
  ])('rejects malformed program frame %j', async (frame, message) => {
    const h = await setup()
    const binding = vi.fn(async () => null)
    h.onBoot(() => { h.emit(frame) })
    const result = await h.start(withBinding(binding))
    expect(result.error).toEqual({ kind: 'protocol', message: expect.stringContaining(message) as unknown })
    expect(binding).not.toHaveBeenCalled()
  })

  it('refuses a repeated call id instead of dispatching it twice', async () => {
    const h = await setup()
    const binding = vi.fn(async () => null)
    h.onBoot(() => { h.emit(call(1)); h.emit(call(1)) })
    expect((await h.start(withBinding(binding))).error?.kind).toBe('protocol')
    expect(binding).toHaveBeenCalledOnce()
  })

  it.each<Config>([{ maxPendingCalls: 1 }, { maxMessageBytes: 512 }])('bounds unresolved host calls with %j', async (config) => {
    const h = await setup(config)
    const release = Promise.withResolvers<null>()
    onTestFinished(() => { release.resolve(null) })
    const binding = vi.fn(async () => await release.promise)
    h.onBoot(() => { h.emit(call(1, 'a'.repeat(300))); h.emit(call(2, 'b'.repeat(300))) })
    expect((await h.start(withBinding(binding))).error?.message).toContain('pending binding calls exceed')
    expect(binding).toHaveBeenCalledOnce()
    release.resolve(null)
    await setImmediate()
  })

  it('rejects an untransferable completion instead of returning a substituted value', async () => {
    const h = await setup()
    h.onBoot(() => { h.emit({ type: 'done', value: { invalid: true } }) })
    expect((await h.start()).error?.kind).toBe('invalid-output')
  })

  it('returns non-lossless binding resolutions as program-visible binding failures', async () => {
    const h = await setup()
    h.receive((message) => {
      if (typeof message !== 'object' || message === null || !('type' in message)) return
      if (message.type === 'boot') h.emit(call(1))
      if (message.type === 'reply') h.emit({ type: 'done' })
    })
    expect((await h.start(withBinding(async () => Number.NaN))).error).toBeUndefined()
    expect(h.messages).toContainEqual({ type: 'reply', id: 1, ok: false, message: expect.stringContaining('lossless JSON') as unknown })
  })

  it('does not publish a late binding reply after the program has settled', async () => {
    const h = await setup()
    const release = Promise.withResolvers<null>()
    onTestFinished(() => { release.resolve(null) })
    h.onBoot(() => { h.emit(call(1)); h.emit({ type: 'done' }) })
    expect((await h.start(withBinding(async () => await release.promise))).error).toBeUndefined()
    release.resolve(null)
    await setImmediate()
    expect(h.messages).not.toContainEqual(expect.objectContaining({ type: 'reply' }))
    expect(h.control.destroyed).toBe(true)
  })

  it('reports failed managed cleanup even when the program returns successfully', async () => {
    const h = await setup()
    vi.mocked(h.waitForExit).mockRejectedValue(new Error('range cannot be observed'))
    h.onBoot(() => { h.emit({ type: 'done', value: encodePtcJsonWire(42) }) })
    expect((await h.start()).error).toEqual({ kind: 'worker-exit', message: 'managed process cleanup failed: range cannot be observed' })
  })

  it('fails when the configured frame budget cannot carry bootstrap data', async () => {
    const h = await setup({ maxMessageBytes: 32 })
    expect((await h.start()).error?.message).toContain('control output exceeds 32 queued bytes')
  })

  it('turns an oversized binding reply into a protocol failure', async () => {
    const h = await setup({ maxMessageBytes: 256 })
    h.onBoot(() => { h.emit(call(1)) })
    const result = await h.start(withBinding(async () => 'x'.repeat(512)))
    expect(result.error).toEqual({ kind: 'protocol', message: 'control output exceeds 256 queued bytes' })
  })

  it('retains admitted logs when the program reports its own output limit', async () => {
    const h = await setup()
    h.onBoot(() => {
      h.emit({ type: 'log', text: 'retained' })
      h.emit({ type: 'done', error: { kind: 'output-limit', message: 'child ledger exhausted' } })
    })
    const result = await h.start()
    expect(result.error?.kind).toBe('output-limit')
    expect(result.logs).toEqual(['retained'])
  })

  it.each([undefined, { kind: 'exception', message: 'program failed' }] as const)('bounds incomplete raw output after completion with %j', async (failure) => {
    const h = await setup({ graceMs: 5 })
    const cleaning = Promise.withResolvers<undefined>()
    vi.mocked(h.terminate).mockImplementation(() => { h.direct.resolve({ exitCode: 0, signal: null }) })
    vi.mocked(h.waitForExit).mockImplementation(async () => { cleaning.resolve(undefined); return true })
    h.onBoot(() => { h.emit(failure === undefined ? { type: 'done' } : { type: 'done', error: failure }) })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const pending = h.start()
      await cleaning.promise
      await vi.advanceTimersByTimeAsync(5)
      expect((await pending).error).toEqual(failure ?? { kind: 'worker-exit', message: 'Node process output did not close cleanly' })
      expect(h.stdout.destroyed).toBe(true)
      expect(h.stderr.destroyed).toBe(true)
    } finally { vi.useRealTimers() }
  })

  it('decodes fragmented native output and preserves incomplete final UTF-8 bytes', async () => {
    const h = await setup()
    h.onBoot(() => {
      for (const stream of [h.stdout, h.stderr]) {
        stream.write(Buffer.from([0xef, 0xbb, 0xbf]))
        stream.write(Buffer.from([0xe2]))
        stream.write(Buffer.from([0x82, 0xac]))
        stream.end(Buffer.from([0xe2]))
      }
      h.emit({ type: 'done' })
    })
    const result = await h.start()
    expect(result.error).toBeUndefined()
    expect(result.logs.filter(text => text === '\uFEFF')).toHaveLength(2)
    expect(result.logs.filter(text => text === '€')).toHaveLength(2)
    expect(result.logs.filter(text => text === '�')).toHaveLength(2)
  })

  it('keeps the fitting native-output prefix and ignores later overflow chunks', async () => {
    const h = await setup({ maxOutputBytes: 256 })
    vi.mocked(h.terminate).mockImplementation(() => {
      h.stderr.end('later output')
      h.stdout.end()
      h.direct.resolve({ exitCode: 0, signal: null })
    })
    h.onBoot(() => { h.stdout.write('x'.repeat(1024)) })
    const result = await h.start()
    expect(result.error?.kind).toBe('output-limit')
    expect(result.logs.join('')).toMatch(/^x+$/)
    expect(Buffer.byteLength(JSON.stringify(result.logs))).toBeLessThanOrEqual(256)
  })

  it.each(['stdout', 'stderr'] as const)('reports a broken raw %s pipe', async (name) => {
    const h = await setup()
    h.onBoot(() => { h[name].emit('error', new Error(`${name} closed`)) })
    expect((await h.start()).error).toEqual({ kind: 'worker-exit', message: `${name} closed` })
  })

  it('retains stderr when a ready process exits without a completion frame', async () => {
    const h = await setup()
    h.onBoot(() => {
      h.stderr.write('native fatal detail')
      h.direct.resolve({ exitCode: 9, signal: null })
    })
    expect((await h.start()).error).toEqual({ kind: 'worker-exit', message: 'Node process exited before completing (9): native fatal detail' })
  })

  it('clears inherited ambient values while keeping native startup paths in the spawned environment', async () => {
    const h = await setup()
    onTestFinished(() => { vi.unstubAllEnvs() })
    vi.stubEnv('TEMP', 'fixture-temp-first')
    vi.stubEnv('TMP', 'fixture-tmp-second')
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '1')
    vi.stubEnv('DSH_TEST_RUNTIME_SECRET', 'must-not-inherit')
    h.onBoot(() => { h.emit({ type: 'done' }) })
    expect((await h.start()).error).toBeUndefined()
    const env = h.spawn.mock.calls[0]?.[0].env ?? {}
    expect(Object.hasOwn(env, 'TEMP')).toBe(false)
    expect(Object.hasOwn(env, 'TMP')).toBe(false)
    expect(Object.hasOwn(env, 'ELECTRON_RUN_AS_NODE')).toBe(false)
    expect(Object.hasOwn(env, 'DSH_TEST_RUNTIME_SECRET')).toBe(true)
    expect(env.DSH_TEST_RUNTIME_SECRET).toBeUndefined()
  })

  it('selects the remote embedded bootstrap without leaking ambient environment', async () => {
    const h = await setup({ launch: { kind: 'embedded', executable: process.execPath } })
    h.onBoot(() => { h.emit({ type: 'done' }) })
    expect((await h.start()).error).toBeUndefined()
    const spec = h.spawn.mock.calls[0]?.[0]
    expect(spec?.env?.DSH_PTC_RUNTIME_NODE).toBe('1')
    expect(Object.hasOwn(spec?.env ?? {}, 'PATH')).toBe(false)
    expect(spec?.argv).toEqual([process.execPath, '134217728'])
    expect(Object.fromEntries(Object.entries(spec?.env ?? {}).filter(([, value]) => value !== undefined)))
      .toEqual({ DSH_PTC_RUNTIME_NODE: '1', NODE_OPTIONS: '--max-old-space-size=512' })
  })
})

it('reports a throwing spawn as a substrate failure', async () => {
  const h = await setup()
  h.spawn.mockImplementation(() => { throw new Error('spawn failed') })
  const result = await h.start(request, NO_INITIAL_FRAME)
  expect(result.error).toEqual({ kind: 'worker-exit', message: 'spawn failed' })
})

it('preserves execution context for bindings delivered by an external control stream', async () => {
  const h = await setup()
  const booted = Promise.withResolvers<undefined>()
  h.receive((raw) => {
    const message = raw as { type: string; ok?: boolean; value?: unknown }
    if (message.type === 'boot') booted.resolve(undefined)
    if (message.type === 'reply') h.emit({ type: 'done', value: message.value })
  })
  const context = new AsyncLocalStorage<string>()
  const pending = context.run('binding context', () => h.start({
    ...request,
    bindings: [{ global: 'tools', functions: { test: async () => context.getStore() ?? null } }],
  }))
  await booted.promise
  h.emit(call(1))
  const result = await pending
  expect(result.value).toBe('binding context')
})
