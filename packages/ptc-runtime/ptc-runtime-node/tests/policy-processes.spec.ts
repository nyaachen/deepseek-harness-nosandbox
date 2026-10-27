import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import { PolicyProcesses } from '../src/policy-processes.ts'

async function setup() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const processes = new PolicyProcesses(ctx)
  return { ctx, processes }
}

it('settles every registered release on owner unload', async () => {
  const { ctx, processes } = await setup()
  const cleanup = Promise.withResolvers<undefined>()
  const entered = Promise.withResolvers<undefined>()
  const release = vi.fn(async () => { entered.resolve(undefined); await cleanup.promise })
  processes.register(release)
  const disposed = ctx.fiber.dispose()
  try {
    await entered.promise
    cleanup.resolve(undefined)
    await disposed
    expect(release).toHaveBeenCalledOnce()
  } finally { cleanup.resolve(undefined); await disposed }
})

it('stops settling a detached release without affecting the others', async () => {
  const { ctx, processes } = await setup()
  const detached = vi.fn(async () => {})
  const retained = vi.fn(async () => {})
  processes.register(detached)()
  processes.register(retained)
  await ctx.fiber.dispose()
  expect(detached).not.toHaveBeenCalled()
  expect(retained).toHaveBeenCalledOnce()
})

it('settles every release and reports a failed cleanup from the owner unload', async () => {
  const { ctx, processes } = await setup()
  const failure = new Error('process observation failed')
  const reported = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
  const failed = vi.fn(async () => { throw failure })
  const settled = vi.fn(async () => {})
  processes.register(failed)
  processes.register(settled)
  try {
    await ctx.fiber.dispose()
    expect(failed).toHaveBeenCalledOnce()
    expect(settled).toHaveBeenCalledOnce()
    expect(reported).toHaveBeenCalledWith(failure)
  } finally { reported.mockRestore() }
})
