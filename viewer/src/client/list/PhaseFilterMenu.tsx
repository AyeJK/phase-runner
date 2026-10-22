/**
 * The phase list's filter (design-system.md "Calmer layout", Sidebar): a
 * quiet button at the right of the heading line naming the current filter and
 * its count ("All 9"), opening a small dropdown styled like the settings
 * menu: All, In progress, Complete and Not started, each with its count.
 *
 * - The filter lives in the URL (`?show=progress`); choosing one replaces the
 *   history entry and keeps the phase and any card hash.
 * - Escape, a click outside or a choice closes the dropdown and puts focus
 *   back on the button (a click on a link or button keeps focus there);
 *   focus leaving it closes it too. Escape here doesn't reach the phone
 *   switcher's sheet, which stays open.
 *
 * Test hooks: `phase-filter` (the button), `phase-filter-menu`,
 * `button[data-filter]` (with `aria-pressed`).
 */
import { useEffect, useId, useRef, useState, type FocusEvent } from 'react';
import { PHASE_FILTERS, type PhaseFilter } from '../rail/derive.js';
import { paths, useRouter } from '../shell/router.js';

interface PhaseFilterMenuProps {
  show: PhaseFilter;
  counts: Record<PhaseFilter, number>;
}

export function PhaseFilterMenu({ show, counts }: PhaseFilterMenuProps) {
  const { location, route, navigate } = useRouter();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const current = PHASE_FILTERS.find((f) => f.key === show)!;

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

  const choose = (next: PhaseFilter): void => {
    setOpen(false);
    button.current?.focus();
    const to = route.name === 'phase' && route.phase !== null ? paths.phase(route.phase, next) : paths.home(next);
    navigate(`${to}${location.hash}`, { replace: true, scroll: false });
  };

  return (
    <div className="ph-filter" ref={root} onBlur={onBlur}>
      <button
        ref={button}
        type="button"
        className="ph-filter-btn"
        aria-label={`Filter phases: ${current.label}, ${counts[show]}`}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={menuId}
        data-testid="phase-filter"
        onClick={() => setOpen((o) => !o)}
      >
        {current.label} {counts[show]}
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="ph-filter-menu" id={menuId} ref={menu} role="group" aria-label="Show phases" data-testid="phase-filter-menu">
          {PHASE_FILTERS.map((f) => (
            <button key={f.key} type="button" aria-pressed={show === f.key} data-filter={f.key} onClick={() => choose(f.key)}>
              <span>{f.label}</span>
              <span className="ph-filter-count">{counts[f.key]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
