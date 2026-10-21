/**
 * The values phase-runner-hud keeps in `$.state`. They last for the session and
 * survive a hot reload of the mod, which module variables don't.
 */

/** When the mod first started in this session, in milliseconds since the epoch. */
export type HudSince = number;

/**
 * Keys of the toasts already raised in this session, oldest first, so each
 * occurrence raises one toast:
 *
 * - `fail:{phase}:{line}`: a gate failed at its retry limit (an escalation).
 * - `blocked:{phase}:{line}`: an implementer reported a blocked task.
 * - `complete:{phase}`: the phase completed. Dropped again when the phase is
 *   seen incomplete, so a later run of it can raise a new one.
 *
 * `{line}` is the 1-based line of the first event of that occurrence in the
 * phase's run log.
 */
export type HudToasted = string[];

declare module 'claude-code' {
  interface PluginState {
    'phase-runner-hud': {
      /** Run-log events older than this never raise a toast. */
      since: HudSince;
      /** See {@link HudToasted}. */
      toasted: HudToasted;
    };
  }
}
