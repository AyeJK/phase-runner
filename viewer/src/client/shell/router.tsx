/**
 * A small client-side router: the History API, one context, and a `Link`
 * that navigates without a page load. The viewer has two views and no nested
 * layouts, so a library would be more than it needs.
 *
 * | Path          | Route |
 * |---------------|-------|
 * | `/`           | `board`: the phase kanban. `?phase=N` opens phase N's slide-in panel |
 * | `/list`       | `list`: the list view. `?phase=N` selects phase N (none: the running phase, else the default one) |
 * | `/live`       | `live`: redirected by App once the first snapshot arrives, to `/?phase={N, else running, else default}` |
 * | anything else | `unknown` |
 *
 * The list view takes `?show=progress | complete | future` (the filter row;
 * no `show` is All). The kanban has no filter: its lanes are the groups.
 *
 * Old routes redirect as the location is read, replacing the history entry:
 * `/overview` → `/`, `/phase/:n` → `/?phase=n`, `/sprint/:id` →
 * `/?phase={n}#s{id}` (a hash on `/phase/:n` is kept).
 *
 * On the first load only, a bare `/` (no query, no hash) goes to `/list`
 * unless the kanban was the last layout used (`viewPref.ts`); with nothing
 * remembered the list view is the default. Any later navigation to `/`, such
 * as the Kanban toggle, stays on the kanban.
 *
 * Hash-only links (`#s2.3` on the rail) are left to the browser, which jumps
 * to the element without a navigation; `hashchange` keeps `hash` here in
 * sync.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { phaseOfSprintId } from '../data/status.js';
import type { PhaseFilter } from '../rail/derive.js';
import { DEFAULT_VIEW, rememberedView } from './viewPref.js';

/** A matched route. */
export type Route =
  | { name: 'board'; phase: number | null }
  | { name: 'list'; phase: number | null; show: PhaseFilter }
  | { name: 'live'; phase: number | null }
  | { name: 'unknown' };

/** Where the browser is. */
export interface Location {
  pathname: string;
  search: string;
  hash: string;
}

/** Options for {@link RouterValue.navigate}. */
export interface NavigateOptions {
  /** Replace the current history entry instead of adding one. */
  replace?: boolean;
  /** `history.state` for the new entry (the slide-in panel marks the entries it opens). */
  state?: Record<string, unknown> | null;
  /** Scroll the window to the top after a push with no hash. Default `true`. */
  scroll?: boolean;
}

interface RouterValue {
  location: Location;
  route: Route;
  /** Go to `to` (a path with optional `?search` and `#hash`) without a page load. */
  navigate: (to: string, options?: NavigateOptions) => void;
}

const RouterContext = createContext<RouterValue | null>(null);

function readLocation(): Location {
  const { pathname, search, hash } = window.location;
  return { pathname, search, hash };
}

/** The path without trailing slashes (`/` stays `/`). */
function cleanPath(pathname: string): string {
  return pathname.replace(/\/+$/, '') || '/';
}

/** A `?phase=` value, or `null` when missing or not a whole number. */
function readPhase(search: string): number | null {
  const raw = new URLSearchParams(search).get('phase');
  return raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;
}

const FILTERS: ReadonlySet<string> = new Set(['progress', 'complete', 'future']);

/** A `?show=` value; anything unknown (or none) is All. */
export function readShow(search: string): PhaseFilter {
  const raw = new URLSearchParams(search).get('show');
  return raw !== null && FILTERS.has(raw) ? (raw as PhaseFilter) : 'all';
}

/**
 * Where an old route now lives, or `null` when `location` isn't an old route
 * App can redirect without data (`/live` waits for the snapshot).
 */
export function redirectPath(location: Location): string | null {
  const path = cleanPath(location.pathname);
  if (path === '/overview') return paths.board();
  const phase = /^\/phase\/(\d+)$/.exec(path);
  if (phase) return `${paths.board({ phase: Number(phase[1]) })}${location.hash}`;
  const sprint = /^\/sprint\/([^/]+)$/.exec(path);
  if (sprint) {
    let id: string;
    try {
      id = decodeURIComponent(sprint[1]!);
    } catch {
      return null;
    }
    return phaseOfSprintId(id) === null ? null : paths.sprint(id);
  }
  return null;
}

/** Match a location to a {@link Route}. */
export function matchRoute(location: Pick<Location, 'pathname' | 'search'>): Route {
  const path = cleanPath(location.pathname);
  if (path === '/') return { name: 'board', phase: readPhase(location.search) };
  if (path === '/list') return { name: 'list', phase: readPhase(location.search), show: readShow(location.search) };
  if (path === '/live') return { name: 'live', phase: readPhase(location.search) };
  return { name: 'unknown' };
}

/** Read the location, first replacing an old route with its new one. */
function settledLocation(): Location {
  const to = redirectPath(readLocation());
  if (to !== null) window.history.replaceState(null, '', to);
  return readLocation();
}

/** The location on first load: old routes redirected, and a bare `/` sent to the remembered view (else the default one). */
function initialLocation(): Location {
  const location = settledLocation();
  const view = rememberedView() ?? DEFAULT_VIEW;
  if (cleanPath(location.pathname) === '/' && location.search === '' && location.hash === '' && view === 'list') {
    window.history.replaceState(null, '', paths.list());
    return readLocation();
  }
  return location;
}

export function RouterProvider({ children }: { children: ReactNode }) {
  const [location, setLocation] = useState<Location>(initialLocation);

  useEffect(() => {
    const sync = (): void => setLocation(settledLocation());
    window.addEventListener('popstate', sync);
    window.addEventListener('hashchange', sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener('hashchange', sync);
    };
  }, []);

  const navigate = useCallback((to: string, options?: NavigateOptions) => {
    const url = new URL(to, window.location.href);
    const target = { pathname: url.pathname, search: url.search, hash: url.hash };
    const next = redirectPath(target) ?? `${url.pathname}${url.search}${url.hash}`;
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    const state = options?.state ?? null;
    if (next !== current) {
      if (options?.replace) window.history.replaceState(state, '', next);
      else window.history.pushState(state, '', next);
    }
    setLocation(readLocation());
    // A new page starts at the top; a hash target is scrolled to by the view that owns it.
    if (!options?.replace && options?.scroll !== false && url.hash === '') window.scrollTo(0, 0);
  }, []);

  const route = useMemo(() => matchRoute(location), [location]);
  const value = useMemo<RouterValue>(() => ({ location, route, navigate }), [location, route, navigate]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouterValue {
  const value = useContext(RouterContext);
  if (!value) throw new Error('useRouter() needs a <RouterProvider>');
  return value;
}

/** A view's query: the selected (or open) phase and, in the list view, the filter. */
export interface ViewQuery {
  phase?: number | null;
  show?: PhaseFilter;
}

/** `?phase=2&show=progress`, leaving out what's unset (and `show=all`). */
function viewSearch({ phase, show }: ViewQuery): string {
  const params: string[] = [];
  if (phase !== undefined && phase !== null) params.push(`phase=${phase}`);
  if (show !== undefined && show !== 'all') params.push(`show=${show}`);
  return params.length > 0 ? `?${params.join('&')}` : '';
}

/** Paths for each route, so links are written one way. */
export const paths = {
  /** The kanban, with phase N's panel open when `phase` is set. */
  board: (query: Pick<ViewQuery, 'phase'> = {}): string => `/${viewSearch(query)}`,
  /** The list view, with phase N selected when `phase` is set. */
  list: (query: ViewQuery = {}): string => `/list${viewSearch(query)}`,
  /** A phase: its slide-in panel over the kanban. */
  phase: (n: number): string => `/?phase=${n}`,
  /** A sprint: its phase's panel, landing on the sprint's card. */
  sprint: (id: string): string => {
    const n = phaseOfSprintId(id);
    return n === null ? '/' : `/?phase=${n}#${paths.sprintSection(encodeURIComponent(id))}`;
  },
  /** The id of a sprint's card on the rail (`s2.3`). */
  sprintSection: (id: string): string => `s${id}`,
};

type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
  to: string;
  /** Passed to `navigate` on an in-app click. */
  options?: NavigateOptions;
};

/** An `<a>` that navigates in-app on a plain left click and behaves like a normal link otherwise. */
export function Link({ to, options, onClick, target, children, ...rest }: LinkProps) {
  const { navigate } = useRouter();
  const handleClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    onClick?.(event);
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      (target !== undefined && target !== '_self')
    ) {
      return;
    }
    event.preventDefault();
    navigate(to, options);
  };
  return (
    <a href={to} target={target} onClick={handleClick} {...rest}>
      {children}
    </a>
  );
}
