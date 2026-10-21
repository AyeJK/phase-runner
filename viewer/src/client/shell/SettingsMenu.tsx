/**
 * The settings menu at the right of the top bar: a gear button that opens a
 * small dropdown holding the Theme toggle (Light | Dark | System). The
 * choice applies at once and is remembered (`../theme.ts`); the dropdown
 * stays open so the change can be seen, and closes on Escape (focus back on
 * the gear), a click outside, or focus leaving it.
 */
import { useEffect, useRef, useState, type FocusEvent } from 'react';
import { setThemePref, themePref, type ThemePref } from '../theme.js';

const OPTIONS: { pref: ThemePref; label: string }[] = [
  { pref: 'light', label: 'Light' },
  { pref: 'dark', label: 'Dark' },
  { pref: 'system', label: 'System' },
];

export function SettingsMenu() {
  const [open, setOpen] = useState(false);
  const [pref, setPref] = useState<ThemePref>(themePref);
  const root = useRef<HTMLDivElement>(null);
  const gear = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    // Focus the current choice, so the toggle is one keypress away.
    menu.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.focus();
    const onPointerDown = (e: PointerEvent): void => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      gear.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const onBlur = (e: FocusEvent<HTMLDivElement>): void => {
    if (e.relatedTarget && !root.current?.contains(e.relatedTarget as Node)) setOpen(false);
  };

  const choose = (next: ThemePref): void => {
    setThemePref(next);
    setPref(next);
  };

  return (
    <div className="settings" ref={root} onBlur={onBlur}>
      <button
        ref={gear}
        type="button"
        className="settings-btn"
        aria-label="Settings"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls="settings-menu"
        onClick={() => setOpen((o) => !o)}
      >
        <GearIcon />
      </button>
      {open && (
        <div className="settings-menu" id="settings-menu" ref={menu} data-testid="settings-menu">
          <span className="settings-label" id="settings-theme">
            Theme
          </span>
          <div className="theme-toggle" role="group" aria-labelledby="settings-theme">
            {OPTIONS.map((o) => (
              <button key={o.pref} type="button" aria-pressed={pref === o.pref} onClick={() => choose(o.pref)}>
                {o.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}
