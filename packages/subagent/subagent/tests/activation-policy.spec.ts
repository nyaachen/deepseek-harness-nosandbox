/**
 * Delegation policy through child session events appended before publication:
 * the pinned `approval/policy: never` and the deterministic rejection it forces
 * on a delegated child's approval asks.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import ApprovalService, { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { mountLocalActivations, startPreparedActivation } from './local-activation.ts'

type Script = ConstructorParameters<typeof MockAdapter>[0]

const contexts: Context[] = []
let workspace: string

beforeEach(async () => {
  workspace = await realpath(await mkdtemp(join(tmpdir(), 'dsh-inherit-')))
})

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  await rm(workspace, { recursive: true, force: true })
})

async function setupWalled(script: Script): Promise<{ ctx: Context; parent: Agent }> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mountLocalActivations(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(LocalFileSystem, { cwd: workspace })
  await ctx.plugin(ToolFs)
  await ctx.plugin(ApprovalService)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], new MockAdapter(script))
  const parent = await ctx.agentLoop.create(
    SessionId('parent'),
    { provider: 'mock', model: 'mock' },
    { cwd: workspace },
  )
  return { ctx, parent }
}

function spawnRequest(parent: Agent) {
  return {
    label: 'child task',
    prompt: [{ type: 'text' as const, text: 'child task' }],
    parent,
    signal: new AbortController().signal,

  }
}

function toolResultTexts(agent: Agent): string[] {
  return agent.session.snapshotEvents()
    .filter((event): event is SessionEvent<'tool/result'> => event.type === 'tool/result')
    .map(event => event.data.message.content
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join(''))
}

describe('in-process policy inheritance', () => {
  it('pins approval to never before publishing a spawn child', async () => {
    const script: Script = []
    const { ctx, parent } = await setupWalled(script)
    const allowed = join(workspace, 'spawn-allowed.txt')
    // No parent approval override: the child pin must not depend on one.
    expect(ctx.approval.overrideOf(parent.session)).toBeUndefined()
    const parentLogLength = parent.session.snapshotEvents().length
    script.push(
      toolCallResponse('write', 'write', { file_path: allowed, content: 'fine' }),
      textResponse('child done'),
    )

    const run = await startPreparedActivation(spawnRequest(parent), {})
    try {
      const result = await run.result
      const child = run.localAgent

      expect(await readFile(allowed, 'utf8')).toBe('fine')
      expect(result.stopReason).toBe('completed')
      expect(child.session.snapshotEvents().filter(event => event.type === 'approval/policy')).toMatchObject([
        { seq: 1, data: { policy: 'never', source: 'delegation' } },
      ])
      expect(child.session.firstLiveSeq).toBe(0)
      expect(child.session.header.isSeeded).toBe(false)
      expect(child.session.inheritedEventCount).toBe(0)
      expect(ctx.approval.overrideOf(child.session)).toBe('never')
      const request = child.session.snapshotEvents().find(
        (event): event is SessionEvent<'request/header'> => event.type === 'request/header',
      )
      const systemNode = child.session.snapshotEvents().find(
        (event): event is SessionEvent<'system/message'> => event.type === 'system/message',
      )
      const runtimeContext = child.session.snapshotEvents().find(
        (event): event is SessionEvent<'user/message'> => event.type === 'user/message'
          && event.data.source.kind === 'runtime-context',
      )
      if (request === undefined || systemNode === undefined || runtimeContext === undefined) {
        throw new Error('child request lacks its system node or runtime policy context')
      }
      expect(systemNode.seq).toBeLessThan(runtimeContext.seq)
      expect(runtimeContext.seq).toBeLessThan(request.seq)
      const contextText = runtimeContext.data.content
        .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
        .map(block => block.text)
        .join('\n')
      expect(contextText).toContain('Approval prompts are disabled')
      // The statement rides runtime context; the system node (surface node 0) stays uniform.
      expect(contextText).toContain('You are a delegated subagent')
      const systemHead = child.session.deriveMessages()[0]
      if (systemHead?.role !== 'system') throw new Error('child surface node 0 is not a system message')
      expect(child.session.surface.nodes[0]).toBe(systemNode.seq)
      const systemText = systemHead.content
        .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
        .map(block => block.text)
        .join('\n')
      expect(systemText).not.toContain('Approval prompts are disabled')
      expect(systemText).not.toContain('You are a delegated subagent')
      expect(parent.session.snapshotEvents().filter(event => event.type !== 'subagent/catalog')).toHaveLength(parentLogLength)
    } finally {
      await run.dispose()
    }
  })

  it('places the delegated event after a fork prefix so fresh policy wins stale seed state', async () => {
    const script: Script = []
    const { ctx, parent } = await setupWalled(script)
    const allowed = join(workspace, 'fork-allowed.txt')
    // The stale policy lands inside the prefix the fork seed replays.
    setApprovalPolicy(parent.session, 'ask')
    const seed = parent.session.snapshotEvents()
    setApprovalPolicy(parent.session, 'never')
    script.push(
      toolCallResponse('write', 'write', { file_path: allowed, content: 'fine' }),
      textResponse('child done'),
    )

    const run = await startPreparedActivation(spawnRequest(parent), { seed })
    try {
      await run.result
      const child = run.localAgent

      expect(child.session.header.isSeeded).toBe(true)
      expect(child.session.inheritedEventCount).toBe(1)
      expect(child.session.firstLiveSeq).toBe(seed.length)
      const policyEvents = child.session.snapshotEvents().filter(event => event.type === 'approval/policy')
      expect(policyEvents.map(event => event.data.policy)).toEqual(['ask', 'never'])
      const delegation = policyEvents.at(-1)!
      expect(delegation.data).toEqual({ policy: 'never', source: 'delegation' })
      expect(delegation.seq).toBeGreaterThanOrEqual(child.session.firstLiveSeq)
      expect(await readFile(allowed, 'utf8')).toBe('fine')
      expect(ctx.approval.overrideOf(child.session)).toBe('never')

      setApprovalPolicy(child.session, 'ask')
      expect(ctx.approval.overrideOf(child.session)).toBe('ask')
    } finally {
      await run.dispose()
    }
  })

  it('rejects a delegated child approval ask deterministically even when an answerer would allow it', async () => {
    const script: Script = []
    const { ctx, parent } = await setupWalled(script)
    // A granting answerer proves the pin resolves before any answerer runs.
    let consulted = false
    ctx.on('approval/request', () => {
      consulted = true
      return Promise.resolve('allowed-once' as const)
    })
    // The tool-level gate asks for one tool, so the ask reaches the approval seam.
    ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.name !== 'write') return next()
      return { kind: 'ask', reason: 'the fixture requires approval for write' }
    })
    const blocked = join(workspace, 'escalation-blocked.txt')
    script.push(
      toolCallResponse('write', 'write', { file_path: blocked, content: 'escaped' }),
      textResponse('child done'),
    )

    const run = await startPreparedActivation(spawnRequest(parent), {})
    try {
      await run.result
      const child = run.localAgent

      await expect(readFile(blocked, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      expect(consulted).toBe(false)
      expect(toolResultTexts(child).join('\n')).toContain('the user rejected tool "write"')
      const asked = child.session.snapshotEvents().find(
        (event): event is SessionEvent<'approval/asked'> => event.type === 'approval/asked',
      )
      const decided = child.session.snapshotEvents().find(
        (event): event is SessionEvent<'approval/decided'> => event.type === 'approval/decided',
      )
      expect(asked?.data.toolName).toBe('write')
      expect(decided?.data).toMatchObject({ id: asked?.data.id, outcome: 'rejected' })
    } finally {
      await run.dispose()
    }
  })
})
