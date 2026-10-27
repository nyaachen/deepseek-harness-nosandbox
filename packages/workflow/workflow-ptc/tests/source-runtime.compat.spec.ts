import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
/** The Node compatibility matrix runs this complete source-entry smoke. */
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import PtcWorkflowEngine from '../src/index.ts'
import { fakeParent, mountPtcRuntime } from './setup.ts'

async function setup(executionMode: 'per-call' | 'persistent-in-memory' = 'per-call') {
  const ctx = new Context()
  const files = await mountPtcRuntime(ctx, executionMode)
  provideWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  ctx.subagents.registerProvider({
    name: 'spawn',
    capabilities: { agentOptions: true, agentPreset: false, outputSchema: true, depthLimit: true },
    inheritsParentContext: false,
    start: () => Promise.reject(new Error('source runtime smoke must not start a child')),
  })
  await ctx.plugin(PtcWorkflowEngine, {})
  return { ctx, parent: await fakeParent(ctx), ...files }
}

it('runs the default workflow config through the source PTC runtime', async () => {
  const { ctx, parent } = await setup()
  const run = ctx.workflowEngine.start({
    script: 'return args.left * args.right',
    args: { left: 6, right: 7 },
    meta: { name: 'source-runtime-compat', description: 'source workflow and PTC entry' },
    parent,
  })
  try {
    const result = await run.result
    expect(result, result.error).toMatchObject({ value: 42, stopReason: 'completed', agentsStarted: 0 })
  } finally { await run.dispose() }
})
