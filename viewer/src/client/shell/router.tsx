/**
 * A small client-side router: the History API, one context, and a `Link`
 * that navigates without a page load. The viewer has one view (the list
 * view) and no nested layouts, so a library would be more than it needs
 * (design-system.md "Calmer layout", Routes).
 *
 * | Path          | Route |
 * |---------------|-------|
 * | `/`           | `phase` with no number: the list view on the running phase, else the default one |
 * | `/phase/:n`   | `phase`: the list view on phase n; `#s{id}` opens that sprint's card |
 * | `/live`       | `live`: redirected by App once the first snapshot arrives, to `/phase/{running, else default}` |
 * | anything else | `unknown` |
 *
 * Old routes redirect as the location is read, replacing the history entry
 * (a hash is kept):
 *
 * | Old | New |
 * |-----|-----|
 * | `/?phase=N`, `/list?phase=N`, `/live?phase=N` | `/phase/N` |
 * | `/list`, `/list?…` without a phase, `/overview` | `/` |
 * | `/sprint/:id` | `/phase/{n}#s{id}` |
 *
 * Any other query (the old filter row's `?show=`) is dropped.
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

/** A matched route. */
export type Route =
  /** The list view; `phase` is `null` at `/` (the view picks the running or default phase). */
  | { name: 'phase'; phase: number | null }
  | { name: 'live' }
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

/**
 * Where an old route now lives, or `null` when `location` is already where it
 * belongs (or is a `/live` with no phase, which App redirects once the
 * snapshot is here).
 */
export function redirectPath(location: Location): string | null {
  const path = cleanPath(location.pathname);
  const { search, hash } = location;
  if (path === '/overview') return paths.home();
  if (path === '/' || path === '/list' || path === '/live') {
    const phase = readPhase(search);
    if (phase !== null) return `${paths.phase(phase)}${hash}`;
    if (path === '/live') return null;
    return path === '/list' || search !== '' ? `${paths.home()}${hash}` : null;
  }
  const phase = /^\/phase\/(\d+)$/.exec(path);
  if (phase) {
    const to = paths.phase(Number(phase[1]));
    return search !== '' || path !== location.pathname ? `${to}${hash}` : null;
  }
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
  if (path === '/') return { name: 'phase', phase: null };
  const phase = /^\/phase\/(\d+)$/.exec(path);
  if (phase) return { name: 'phase', phase: Number(phase[1]) };
  if (path === '/live') return { name: 'live' };
  return { name: 'unknown' };
}

/** Read the location, first replacing an old route with its new one. */
function settledLocation(): Location {
  const to = redirectPath(readLocation());
  if (to !== null) window.history.replaceState(null, '', to);
  return readLocation();
}

export function RouterProvider({ children }: { children: ReactNode }) {
  const [location, setLocation] = useState<Location>(settledLocation);

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
    if (next !== current) {
      if (options?.replace) window.history.replaceState(null, '', next);
      else window.history.pushState(null, '', next);
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

/** Paths for each route, so links are written one way. */
export const paths = {
  /** The list view on the running phase, else the default one. */
  home: (): string => '/',
  /** The list view on phase n. */
  phase: (n: number): string => `/phase/${n}`,
  /** A sprint: its phase, landing on the sprint's card. */
  sprint: (id: string): string => {
    const n = phaseOfSprintId(id);
    return n === null ? '/' : `${paths.phase(n)}#${paths.sprintSection(encodeURIComponent(id))}`;
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
