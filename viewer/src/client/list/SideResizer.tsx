/**
 * The sidebar's resize handle: a thin strip on the sidebar's right edge that
 * shows a line on hover and drags the sidebar wider or narrower (from 720px
 * up; the phone switcher has none). The width sets `--side` on the list
 * layout, stays between {@link SIDE_MIN} and {@link SIDE_MAX} (and never past
 * half the window, in `list.css`), and is remembered in `localStorage`.
 * Double-click puts the default width back. It's a focusable separator:
 * the arrow keys nudge it, Home and End jump to the ends.
 *
 * Storage can be missing or throw, so a failed read means the default width
 * and a failed write just isn't remembered.
 *
 * Test hook: `side-resize`.
 */
import { useCallback, useState, type KeyboardEvent, type PointerEvent } from 'react';

const KEY = 'phase-viewer:side-width';
export const SIDE_MIN = 200;
export const SIDE_MAX = 480;
/** How far one arrow key press moves the edge. */
const STEP = 16;

function clampSide(px: number): number {
  return Math.round(Math.min(SIDE_MAX, Math.max(SIDE_MIN, px)));
}

function storedSide(): number | null {
  try {
    const value = Number(window.localStorage.getItem(KEY));
    return value > 0 ? clampSide(value) : null;
  } catch {
    return null;
  }
}

/** The chosen sidebar width (`null` for the default) and a setter that remembers it. */
export function useSideWidth(): [number | null, (px: number | null) => void] {
  const [width, setWidth] = useState(storedSide);
  const set = useCallback((px: number | null) => {
    const next = px === null ? null : clampSide(px);
    setWidth(next);
    try {
      if (next === null) window.localStorage.removeItem(KEY);
      else window.localStorage.setItem(KEY, String(next));
    } catch {
      // Not remembered; the next visit uses the default.
    }
  }, []);
  return [width, set];
}

interface SideResizerProps {
  width: number | null;
  onChange: (px: number | null) => void;
}

export function SideResizer({ width, onChange }: SideResizerProps) {
  const [dragging, setDragging] = useState(false);

  /** The sidebar's width as drawn: the chosen width, or the default for this window size. */
  const current = (el: HTMLElement) => width ?? parseFloat(getComputedStyle(el).getPropertyValue('--side'));

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const left = handle.parentElement!.getBoundingClientRect().left;
    handle.setPointerCapture(e.pointerId);
    document.documentElement.classList.add('side-resizing');
    setDragging(true);
    const move = (ev: globalThis.PointerEvent) => onChange(ev.clientX - left);
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      document.documentElement.classList.remove('side-resizing');
      setDragging(false);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const now = current(e.currentTarget);
    const next =
      e.key === 'ArrowLeft' ? now - STEP
      : e.key === 'ArrowRight' ? now + STEP
      : e.key === 'Home' ? SIDE_MIN
      : e.key === 'End' ? SIDE_MAX
      : null;
    if (next === null) return;
    e.preventDefault();
    onChange(next);
  };

  return (
    <div
      className="side-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize phase list"
      aria-valuemin={SIDE_MIN}
      aria-valuemax={SIDE_MAX}
      aria-valuenow={width ?? undefined}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      data-dragging={dragging || undefined}
      data-testid="side-resize"
      onPointerDown={onPointerDown}
      onDoubleClick={() => onChange(null)}
      onKeyDown={onKeyDown}
    />
  );
}
