import { Context } from '@deepseek-ai/cordis'
import { onTestFinished } from 'vitest'

/** Create an empty runtime context with owned teardown. */
export async function createRuntimeContext(): Promise<Context> {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  return ctx
}
