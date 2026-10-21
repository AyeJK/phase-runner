/**
 * Not found (design-system.md "Not found", "Unified states"): an unknown
 * phase (in the list view's rail side) or any other address (under the top
 * bar) shows a message in the `.empty` block with a link back to the phases
 * (`/`). The shell stays around it.
 *
 * An unknown sprint never gets here on its own: `/sprint/:id` redirects to
 * its phase (`/phase/:n#s{id}`), so an unknown sprint of an unknown phase
 * shows that phase as not found.
 *
 * Test hooks: `[data-testid=not-found]` with `data-kind` (`phase` or
 * `page`), `not-found-overview` (the link).
 */
import { Link, paths } from '../shell/router.js';
import './states.css';

function NotFound({ kind, title, text }: { kind: 'phase' | 'page'; title: string; text: string }) {
  return (
    <div className="empty state-empty" data-testid="not-found" data-kind={kind}>
      <h3>{title}</h3>
      <p>{text}</p>
      <p className="state-next">
        <Link className="link" to={paths.home()} data-testid="not-found-overview">
          Back to phases
        </Link>
      </p>
    </div>
  );
}

/** `/phase/N` for a number no phase plan has. */
export function PhaseNotFound({ number }: { number: number }) {
  return <NotFound kind="phase" title={`Phase ${number} not found`} text={`There's no Phase ${number} in the phase plans.`} />;
}

/** Any other address. */
export function PageNotFound() {
  return <NotFound kind="page" title="Page not found" text="The viewer has nothing at this address." />;
}
