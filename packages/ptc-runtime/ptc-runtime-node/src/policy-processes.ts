/** Provider-owned bookkeeping of retained Node PTC process cleanup. */
import type { Context } from '@deepseek-ai/cordis'

interface Process {
  release: () => Promise<void>
}

/** Owns asynchronous process cleanup without delaying provider teardown. */
export class PolicyProcesses {
  private readonly processes = new Set<Process>()

  /**
   * Observe provider lifecycle for retained process cleanup.
   * @param ctx - Node provider lifecycle.
   */
  constructor(ctx: Context) {
    ctx.effect(() => async () => {
      await this.settle([...this.processes])
    }, 'Node PTC process cleanup')
  }

  /**
   * Track a retained process until its owner confirms cleanup.
   * @param release - Idempotent cancellation and awaited cleanup.
   * @returns Removal after successful process cleanup.
   */
  register(release: () => Promise<void>): () => void {
    const process: Process = { release }
    this.processes.add(process)
    return () => { this.processes.delete(process) }
  }

  private async settle(processes: Process[]): Promise<void> {
    const results = await Promise.allSettled(processes.map(process => process.release()))
    for (const process of processes) this.processes.delete(process)
    const failed = results.find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  }
}
