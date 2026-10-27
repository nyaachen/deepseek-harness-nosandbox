/**
 * Event types this harness no longer writes or interprets, declared so sessions
 * logged by earlier harnesses stay readable.
 *
 * The persistence read path refuses a required event type it does not know
 * (`known-event-types.ts`), so an undeclared historical record would make its
 * whole session unreadable. Declaring the types here admits those records as
 * history only: nothing appends either type, no session projection folds them,
 * and neither can confine a process or switch a permission policy back on.
 *
 * @module @deepseek-ai/dsh-session/retired-events
 */

/** The file-effect mode space a recorded sandbox mode came from. */
export type RetiredSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Retired: the session switched its file-effect sandbox mode. This harness
     * does not confine processes or file effects, so the record is history: no
     * consumer resolves, folds, or acts on it, and no code path appends it.
     */
    'sandbox/mode': {
      /** The mode the writing harness ran under. */
      mode: RetiredSandboxMode
      /** Marks an override seeded into a child at delegation. */
      source?: 'delegation'
    }
    /**
     * Retired: the user selected a permission preset, which bundled a sandbox
     * mode with an approval policy. Only the name survives; the mode it named
     * no longer exists, so the record carries no current meaning.
     */
    'permission/preset': {
      /** The preset name the writing harness recorded. */
      preset: string
    }
  }
}
