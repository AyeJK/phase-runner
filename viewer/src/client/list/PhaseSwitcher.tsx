/**
 * The phone phase switcher (design-system.md "Calmer layout", Phase
 * switcher): below 720px it replaces the sidebar with a sticky bar under the
 * top bar. Its button names the selected phase ("Phase 8", the title, the
 * sidebar's end item, a chevron) and opens a sheet over the scrim holding the
 * same heading and rows as the sidebar ({@link PhaseList}).
 *
 * - Choosing a phase navigates and closes the sheet. A click on the scrim,
 *   Escape, or the switcher closes it too.
 * - Opening moves focus to the selected row; closing returns it to the
 *   switcher. The page behind doesn't scroll while the sheet is open.
 * - The sheet's rows are only rendered while it's open, so the sidebar's rows
 *   are the only `a[data-phase-item]` on the page otherwise. From 720px up
 *   the bar is hidden (CSS) and an open sheet closes.
 *
 * Test hooks: `phase-switcher` (the button), `phase-sheet`, plus
 * {@link PhaseList}'s.
 */
import { useCallback, useEffect, useId, useRef, useState, type MouseEvent } from 'react';
import type { PhaseRow } from './derive.js';
import { PhaseEndItem, PhaseList, phaseRowName, phaseTitle } from './PhaseList.js';

/** The width from which the sidebar shows instead (design-system.md "Tokens and breakpoints"). */
const WIDE = '(min-width: 720px)';

interface PhaseSwitcherProps {
  rows: readonly PhaseRow[];
  /** The selected phase's number, or `null`. */
  selected: number | null;
}

export function PhaseSwitcher({ rows, selected }: PhaseSwitcherProps) {
  const [open, setOpen] = useState(false);
  /** Where the sheet starts: the bottom of the switcher bar when it opened. */
  const [top, setTop] = useState<number | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const sheetId = useId();
  const row = rows.find((r) => r.number === selected);

  const close = useCallback(() => {
    setOpen(false);
    buttonRef.current?.focus();
  }, []);

  const toggle = (): void => {
    if (open) {
      close();
      return;
    }
    setTop(barRef.current?.getBoundingClientRect().bottom ?? null);
    setOpen(true);
  };

  const onScrim = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) close();
  };

  useEffect(() => {
    if (!open) return;
    // Focus the selected row (or the first).
    const panel = panelRef.current;
    const target = panel?.querySelector<HTMLElement>('[aria-current="page"]') ?? panel?.querySelector<HTMLElement>('a');
    target?.focus();

    // The page behind stays put.
    const root = document.documentElement;
    const overflow = root.style.overflow;
    root.style.overflow = 'hidden';

    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close();
    };
    document.addEventListener('keydown', onKey);

    // Widening past the breakpoint hides the switcher: close with it.
    const wide = window.matchMedia(WIDE);
    const onWide = (): void => {
      if (wide.matches) setOpen(false);
    };
    wide.addEventListener('change', onWide);

    return () => {
      root.style.overflow = overflow;
      document.removeEventListener('keydown', onKey);
      wide.removeEventListener('change', onWide);
    };
  }, [open, close]);

  return (
    <>
      <div className="switch-bar" ref={barRef}>
        <button
          ref={buttonRef}
          type="button"
          className="switch"
          aria-expanded={open}
          aria-controls={sheetId}
          aria-label={row ? phaseRowName(row) : `Phase ${selected ?? ''}`.trim()}
          data-testid="phase-switcher"
          onClick={toggle}
        >
          <span className="n">{selected === null ? 'Phases' : `Phase ${selected}`}</span>
          <span className="t">{row ? phaseTitle(row) : ''}</span>
          {row ? <PhaseEndItem row={row} /> : <span />}
          <svg className="chev" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      <div
        className="sheet"
        id={sheetId}
        hidden={!open}
        style={top === null ? undefined : { top }}
        onClick={onScrim}
        data-testid="phase-sheet"
      >
        {open && (
          <nav className="sheet-panel" aria-label="Phases" ref={panelRef}>
            <PhaseList rows={rows} selected={selected} onChoose={close} />
          </nav>
        )}
      </div>
    </>
  );
}
