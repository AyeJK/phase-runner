/**
 * The phase kanban, home at `/` (design-system.md "Phase kanban", "Slide-in
 * panel"): three lanes, left to right (Not started, In progress, Complete),
 * each with a card per phase in that group, and the slide-in panel for
 * `?phase=N`.
 *
 * - The lanes are equal width and always all there; a lane with no phases
 *   says "No phases". Each lane's heading carries its phase count. Lanes are
 *   at least 240px wide; when the three don't fit, the board scrolls
 *   sideways inside itself, never the page.
 * - Clicking a card pushes `/?phase=N` (marked in `history.state`) and the
 *   panel slides in. Closing (back arrow, scrim, Escape) goes Back when the
 *   board opened the panel, so the browser's Back and Forward stay in step;
 *   a panel reached by a link (`/?phase=N` typed or shared) is closed by
 *   replacing the entry with `/`. The browser's Back closes it too.
 * - When the panel closes, focus returns to the card that opened it.
 * - Warnings on files that belong to no phase show as banners above the
 *   board; a phase's own warnings show as a tag on its card and as banners
 *   in its panel.
 *
 * Test hooks: `kanban`, `kan-board`, `section[data-lane]` (`future`,
 * `progress`, `complete`), `lane-count`, `lane-empty`, plus the card's and
 * the panel's.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Project } from '../../core/model.js';
import { paths, useRouter } from '../shell/router.js';
import { ParseWarnings } from '../states/ParseWarnings.js';
import { phaseFiles, samePath } from '../states/warnings.js';
import { kanbanLanes } from './derive.js';
import { KanbanColumn, PANEL_ENTRY } from './KanbanColumn.js';
import { SlidePanel } from './SlidePanel.js';
import './board.css';

interface BoardProps {
  project: Project;
  /** The phase whose panel is open, or `null`. */
  phase: number | null;
  /** App-wide banners (connection lost), repeated inside the panel. */
  banner?: ReactNode;
}

/** How long the panel takes to slide (`--slide` in tokens.css). */
const SLIDE_MS = 280;

function reducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * The panel's phase while it's open, and for the length of the slide after
 * it closes (`closing`), so it can slide out. Reduced motion drops it at once.
 */
function useSlide(open: number | null): { phase: number | null; closing: boolean } {
  const [shown, setShown] = useState<number | null>(open);
  if (open !== null && shown !== open) setShown(open);

  useEffect(() => {
    if (open !== null) return;
    if (reducedMotion()) {
      setShown(null);
      return;
    }
    const timer = window.setTimeout(() => setShown(null), SLIDE_MS);
    return () => window.clearTimeout(timer);
  }, [open]);

  return { phase: open ?? shown, closing: open === null && shown !== null };
}

export function Board({ project, phase, banner }: BoardProps) {
  const { navigate } = useRouter();
  const lanes = useMemo(() => kanbanLanes(project), [project]);
  const slide = useSlide(phase);

  // Files with warnings that no phase owns (a phase's own show on its card and in its panel).
  const orphanFiles = useMemo(() => {
    const owned = new Set(project.phases.flatMap((p) => phaseFiles(project, p)).map(samePath));
    return [...new Set(project.warnings.map((w) => w.file))].filter((f) => !owned.has(samePath(f)));
  }, [project]);

  const close = useCallback(() => {
    const state = window.history.state as typeof PANEL_ENTRY | null;
    if (state?.panel) window.history.back();
    else navigate(paths.board(), { replace: true, scroll: false });
  }, [navigate]);

  // Focus goes back to the card that opened the panel.
  const opened = useRef<number | null>(phase);
  useEffect(() => {
    if (phase !== null) {
      opened.current = phase;
      return;
    }
    const n = opened.current;
    opened.current = null;
    if (n !== null) document.querySelector<HTMLElement>(`[data-kan-col="${n}"]`)?.focus();
  }, [phase]);

  return (
    <>
      <main className="kanban" id="main" inert={phase !== null} data-testid="kanban">
        <h1 className="visually-hidden">Phases</h1>
        {orphanFiles.length > 0 && (
          <div className="kan-banners">
            <ParseWarnings project={project} files={orphanFiles} />
          </div>
        )}
        <div className="kan-board" data-testid="kan-board">
          {lanes.map((lane) => (
            <section className="kan-lane" key={lane.group} aria-labelledby={`lane-${lane.group}`} data-lane={lane.group}>
              <h2 className="kan-lane-head" id={`lane-${lane.group}`}>
                {lane.label}
                <span className="kan-lane-count" data-testid="lane-count">
                  {lane.columns.length}
                </span>
              </h2>
              {lane.columns.length === 0 ? (
                <p className="kan-lane-empty" data-testid="lane-empty">
                  No phases
                </p>
              ) : (
                lane.columns.map((column) => (
                  <KanbanColumn key={column.number} column={column} open={slide.phase === column.number} />
                ))
              )}
            </section>
          ))}
        </div>
      </main>
      {slide.phase !== null && (
        <SlidePanel project={project} number={slide.phase} closing={slide.closing} onClose={close} banner={banner} />
      )}
    </>
  );
}
