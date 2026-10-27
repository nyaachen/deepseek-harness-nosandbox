import { mountWorkingDirectoryFixture } from './working-directory-fixture.ts'
/**
 * Continuable-child delegation policy: a fresh continuable start pins
 * `approval/policy: never` onto the child's own log, and a cold resume replays
 * that persisted snapshot instead of re-capturing the parent (the one-shot
 * `subagent-inprocess/tests/inheritance.spec.ts` counterpart).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { queueHostSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import ApprovalService, { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import SubagentRuntime from '../src/index.ts'
import { TestSessionQuery } from './test-session-query.ts'
import { loadStoredSession } from './persistence-helpers.ts'

type Script = ConstructorParameters<typeof MockAdapter>[0]

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Boot the continuable stack plus the approval service the manager consumes opportunistically. */
async function setup(script: Script) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const root = mkdtempSync(join(tmpdir(), 'dsh-continuation-inherit-'))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(ApprovalService)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TestSessionQuery)
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
  ctx.llm.registerAdapter(['mock'], new MockAdapter(script))
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  return { ctx, parent }
}

function startSpec(parent: Agent, provider = 'spawn') {
  return {
    provider,
    label: 'child task',
    request: { prompt: [{ type: 'text' as const, text: 'child task' }], parent },
    signal: new AbortController().signal,
  }
}

/** Wait until a child's Activation is gone, i.e. its handle finished disposal. */
async function waitNoActivation(ctx: Context, childId: SessionId): Promise<void> {
  await vi.waitFor(() => {
    expect(ctx.agents.get(childId)).toBeUndefined()
  }, { timeout: 15_000 })
}

function policyEvents(events: readonly SessionEvent[]) {
  return events.filter(event => event.type === 'approval/policy')
}

function foldedApprovalPolicy(ctx: Context, id: SessionId, events: readonly SessionEvent[]): unknown {
  return ctx.approval.overrideOf(Session.create(id, events))
}

describe('continuable policy inheritance', () => {
  it('pins approval to never at the creation window and keeps it durable', { timeout: 20_000 }, async () => {
    const { ctx, parent } = await setup([textResponse('child done')])
    // No parent approval override: the child pin must not depend on one.
    expect(ctx.approval.overrideOf(parent.session)).toBeUndefined()
    let child: Agent | undefined
    ctx.on('agent/created', ({ agent }) => {
      if (agent !== parent) child = agent
    })

    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    // The delegation event is appended in the creation window, so it is
    // already the child's effective policy at inbox acceptance.
    if (child === undefined) throw new Error('expected the continuable child to be created')
    expect(ctx.approval.overrideOf(child.session)).toBe('never')

    await waitNoActivation(ctx, started.childId)
    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(policyEvents(loaded.events)).toMatchObject([
      { type: 'approval/policy', data: { policy: 'never', source: 'delegation' } },
    ])
    // Durable: a reload folds the same effective policy.
    expect(foldedApprovalPolicy(ctx, started.childId, loaded.events)).toBe('never')
    expect(ctx.approval.overrideOf(parent.session)).toBeUndefined()
    const runtimeContext = loaded.events.find(
      (event): event is SessionEvent<'user/message'> => event.type === 'user/message'
        && event.data.source.kind === 'runtime-context',
    )
    const contextText = runtimeContext?.data.content
      .flatMap(block => block.type === 'text' ? [block.text] : [])
      .join('\n')
    expect(contextText).toContain('You are a delegated subagent')
  })

  it('pins approval after the fork prefix of an unswitched fork child', { timeout: 20_000 }, async () => {
    const { ctx, parent } = await setup([textResponse('parent turn'), textResponse('forked child')])
    parent.followup(createUserMessage({
      content: [{ type: 'text', text: 'parent work' }],
      source: { kind: 'user' },
    }))
    await parent.whenIdle()

    const started = await ctx.subagents.startActivation({ ...startSpec(parent, 'fork'), delivery: 'parent' })
    await waitNoActivation(ctx, started.childId)

    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(loaded.inheritedEventCount).toBeGreaterThan(0)
    expect(policyEvents(loaded.events)).toMatchObject([
      { type: 'approval/policy', data: { policy: 'never', source: 'delegation' } },
    ])
    expect(foldedApprovalPolicy(ctx, started.childId, loaded.events)).toBe('never')
  })

  it('lets a later child-side switch win over the delegation snapshot', { timeout: 20_000 }, async () => {
    const { ctx, parent } = await setup([textResponse('child done')])
    setApprovalPolicy(parent.session, 'never')
    let child: Agent | undefined
    ctx.on('agent/created', ({ agent }) => {
      if (agent !== parent) child = agent
    })

    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    if (child === undefined) throw new Error('expected the continuable child to be created')
    expect(ctx.approval.overrideOf(child.session)).toBe('never')
    // Last event wins: the child's own runtime switch beats the seeded snapshot.
    setApprovalPolicy(child.session, 'ask')
    expect(ctx.approval.overrideOf(child.session)).toBe('ask')

    await waitNoActivation(ctx, started.childId)
    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(foldedApprovalPolicy(ctx, started.childId, loaded.events)).toBe('ask')
  })

  it('cold-resumes on the persisted snapshot without re-capturing the parent', { timeout: 20_000 }, async () => {
    const { ctx, parent } = await setup([textResponse('first'), textResponse('after resume')])
    const started = await ctx.subagents.startActivation({ ...startSpec(parent), delivery: 'parent' })
    await waitNoActivation(ctx, started.childId)

    // The parent switches AFTER the child was created; the resumed child keeps
    // the delegation-time snapshot from its own log.
    setApprovalPolicy(parent.session, 'ask')
    await queueHostSubagentPrompt(
      ctx.subagents,
      parent,
      started.childId,
      [{ type: 'text', text: 'continue please' }],
      { kind: 'user' },
      new AbortController().signal,
    )
    await waitNoActivation(ctx, started.childId)

    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    // The approval pin is seeded once at creation, never re-appended on resume.
    expect(loaded.events.filter(event => event.type === 'approval/policy')).toMatchObject([
      { data: { policy: 'never', source: 'delegation' } },
    ])
    expect(foldedApprovalPolicy(ctx, started.childId, loaded.events)).toBe('never')
    expect(ctx.approval.overrideOf(parent.session)).toBe('ask')
  })

  it('places inherited events after a fork prefix so fresh policy wins stale seed state', { timeout: 20_000 }, async () => {
    const { ctx, parent } = await setup([textResponse('parent turn'), textResponse('forked child')])
    // The stale policy lands inside the completed turn the fork seed replays.
    setApprovalPolicy(parent.session, 'ask')
    parent.followup(createUserMessage({
      content: [{ type: 'text', text: 'parent work' }],
      source: { kind: 'user' },
    }))
    await parent.whenIdle()
    setApprovalPolicy(parent.session, 'never')

    const started = await ctx.subagents.startActivation({ ...startSpec(parent, 'fork'), delivery: 'parent' })
    await waitNoActivation(ctx, started.childId)

    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(loaded.inheritedEventCount).toBeGreaterThan(0)
    const events = policyEvents(loaded.events)
    expect(events.map(event => event.data.policy)).toEqual(['ask', 'never'])
    expect(events.at(-1)?.data).toEqual({ policy: 'never', source: 'delegation' })
    expect(foldedApprovalPolicy(ctx, started.childId, loaded.events)).toBe('never')
  })
})
