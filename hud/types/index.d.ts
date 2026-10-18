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

/**
 * What the pane shows. `auto` follows the run: the live phase while one is
 * live, else the phase list.
 */
export type HudNav = { screen: 'auto' } | { screen: 'phases' } | { screen: 'phase'; phase: number };

/**
 * Sprint cards and card rows the person opened or closed, by key
 * (`card:{sprint}`, `{sprint}:criteria`, ...). A key not here takes its
 * default: a card is open while its sprint is running, a row is closed.
 */
export type HudToggled = Record<string, boolean>;

/** Goes up each time the files the pane draws from change, so the pane draws again. */
export type HudRevision = number;

declare module 'claude-code' {
  interface PluginState {
    'phase-runner-hud': {
      /** Run-log events older than this never raise a toast. */
      since: HudSince;
      /** See {@link HudToasted}. */
      toasted: HudToasted;
      /** See {@link HudNav}. */
      nav: HudNav;
      /** See {@link HudToggled}. */
      toggled: HudToggled;
      /** See {@link HudRevision}. */
      revision: HudRevision;
    };
  }
}
