/**
 * The phase list's filter (design-system.md "Calmer layout", Sidebar): a
 * quiet button at the right of the heading line naming the current filter and
 * its count ("All 9", "In progress 2", "2 statuses 5"), opening a small
 * dropdown styled like the settings menu: All, In progress, Complete and Not
 * started, each with its count and a check when chosen.
 *
 * - The groups toggle on and off, so several can be shown at once; All
 *   clears them. All is checked with none or every group chosen.
 * - The filter lives in the URL (`?show=progress,future`); each change
 *   replaces the history entry and keeps the phase and any card hash.
 * - The dropdown stays open while choosing. Escape or a click outside closes
 *   it and puts focus back on the button (a click on a link or button keeps
 *   focus there); focus leaving it closes it too. Escape here doesn't reach
 *   the phone switcher's sheet, which stays open.
 *
 * Test hooks: `phase-filter` (the button), `phase-filter-menu`,
 * `button[data-filter]` (with `aria-pressed`).
 */
import { useEffect, useId, useRef, useState, type FocusEvent } from 'react';
import { PHASE_FILTERS, type PhaseFilter, type PhaseShow } from '../rail/derive.js';
import { paths, useRouter } from '../shell/router.js';
import { phaseShowSummary, showsAll } from './derive.js';

interface PhaseFilterMenuProps {
  show: PhaseShow;
  counts: Record<PhaseFilter, number>;
}

/** The filter after choosing `key`: All clears it, a group toggles, kept in menu order. */
function toggled(show: PhaseShow, key: PhaseFilter): PhaseShow {
  if (key === 'all') return [];
  const next = show.includes(key) ? show.filter((group) => group !== key) : [...show, key];
  return PHASE_FILTERS.flatMap((f) => (f.key !== 'all' && next.includes(f.key) ? [f.key] : []));
}

export function PhaseFilterMenu({ show, counts }: PhaseFilterMenuProps) {
  const { location, route, navigate } = useRouter();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const current = phaseShowSummary(show, counts);
  const chosen = (key: PhaseFilter): boolean => (key === 'all' ? showsAll(show) : show.includes(key));

  useEffect(() => {
    if (!open) return;
    const close = (): void => {
      setOpen(false);
      button.current?.focus();
    };
    // Focus the current choice, so the menu is one keypress from a change.
    menu.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.focus();
    // A click outside closes it. Once the click has moved focus, focus goes back to the button,
    // unless the click put it on something focusable.
    const onPointerDown = (e: PointerEvent): void => {
      if (root.current?.contains(e.target as Node)) return;
      setOpen(false);
      window.setTimeout(() => {
        if (document.activeElement === null || document.activeElement === document.body) button.current?.focus();
      });
    };
    // In the capture phase, so Escape closes this menu and not the switcher's sheet around it.
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  const onBlur = (e: FocusEvent<HTMLDivElement>): void => {
    if (e.relatedTarget && !root.current?.contains(e.relatedTarget as Node)) setOpen(false);
  };

  const choose = (key: PhaseFilter): void => {
    const next = toggled(show, key);
    const to = route.name === 'phase' && route.phase !== null ? paths.phase(route.phase, next) : paths.home(next);
    navigate(`${to}${location.hash}`, { replace: true, scroll: false });
  };

  return (
    <div className="ph-filter" ref={root} onBlur={onBlur}>
      <button
        ref={button}
        type="button"
        className="ph-filter-btn"
        aria-label={`Filter phases: ${current.label}, ${current.count}`}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={menuId}
        data-testid="phase-filter"
        onClick={() => setOpen((o) => !o)}
      >
        {current.label} {current.count}
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="ph-filter-menu" id={menuId} ref={menu} role="group" aria-label="Show phases" data-testid="phase-filter-menu">
          {PHASE_FILTERS.map((f) => (
            <button key={f.key} type="button" aria-pressed={chosen(f.key)} data-filter={f.key} onClick={() => choose(f.key)}>
              <svg className="ph-filter-check" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="ph-filter-label">{f.label}</span>
              <span className="ph-filter-count">{counts[f.key]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
