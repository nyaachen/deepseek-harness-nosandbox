import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { expect, it } from 'vitest'
import NodeRuntime from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { mountRuntime } from './setup.ts'

it.each<Config>([{}, { executionMode: 'per-call' }])('starts fresh state for each call with configuration %j', async (config) => {
  const { runtime } = await mountRuntime(new Context(), config)
  const stateOwner = {}
  const run = (program: string) => runtime.run(runtime.resolve({ program, bindings: [], stateOwner }))
  expect(runtime.programFormat).toBe('function-body')
  expect((await run('globalThis.retained = 17; return retained;')).value).toBe(17)
  expect((await run('return typeof retained;')).value).toBe('undefined')
  await runtime.release(stateOwner)
})

it.each(['in-memory', 'durable', 'fresh-process', 'persistent-repl'])('rejects unsupported execution mode %s at configuration parsing', (executionMode) => {
  expect(() => z.resolve({ executionMode }, NodeRuntime.Config, {})).toThrow()
})

it('clears retained state when a provider is reloaded with another execution mode', async () => {
  const ctx = new Context()
  const owner = {}
  const { runtime: memory, fiber: memoryFiber } = await mountRuntime(ctx, { executionMode: 'persistent-in-memory' })
  const first = await memory.run(memory.resolve({ program: 'let retained = 17;', bindings: [], stateOwner: owner }))
  expect(first.error).toBeUndefined()
  expect(memory.programFormat).toBe('repl')
  await memoryFiber.dispose()
  const { runtime: perCall, fiber: perCallFiber } = await mountRuntime(ctx, { executionMode: 'per-call' })
  expect(perCall.programFormat).toBe('function-body')
  expect((await perCall.run(perCall.resolve({ program: 'return typeof retained;', bindings: [], stateOwner: owner }))).value).toBe('undefined')
  await perCallFiber.dispose()
  const { runtime: resumed } = await mountRuntime(ctx, { executionMode: 'persistent-in-memory' })
  expect((await resumed.run(resumed.resolve({ program: 'typeof retained', bindings: [], stateOwner: owner }))).value).toBe('undefined')
})

it.each<NonNullable<Config['executionMode']>>(['per-call', 'persistent-in-memory'])('resolves an omitted cwd to the provider process directory in %s mode', async (executionMode) => {
  const { runtime } = await mountRuntime(new Context(), { executionMode })
  const explicit = join(process.cwd(), 'explicit-workspace')
  expect(runtime.resolve({ program: '', bindings: [] }).cwd).toBe(process.cwd())
  expect(runtime.resolve({ program: '', bindings: [], cwd: explicit }).cwd).toBe(explicit)
})
