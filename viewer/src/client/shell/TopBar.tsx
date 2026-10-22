/**
 * The top bar (design-system.md "Calmer layout", Top bar): the project name
 * at the left as the headline; at the right the gold "Phase Runner" link,
 * then the settings gear (theme), and nothing else.
 *
 * The project name is the project folder's name (`baseName(root)`, the same
 * name the tab title ends with), so two viewers open side by side can be
 * told apart. It's plain text on one line, ending in an ellipsis when it
 * doesn't fit; the full path is its tooltip only. Nothing shows there until
 * a project loads (the loading, empty and candidates states).
 *
 * The link reads "Phase Runner 0.4.0" (the viewer's version from
 * package.json, set at build time) and opens the GitHub repo in a new tab.
 * Below 480px only "v0.4.0" shows; its accessible name stays whole.
 *
 * Test hooks: `project-name`, `brand-link`.
 */
import { baseName } from '../data/applyUpdate.js';
import { SettingsMenu } from './SettingsMenu.js';
import './shell.css';

const REPO_URL = 'https://github.com/AyeJK/phase-runner';

export function TopBar({ root }: { root: string | null }) {
  return (
    <header className="app-head">
      {root !== null && (
        <span className="project-name" title={root} data-testid="project-name">
          {baseName(root)}
        </span>
      )}
      <div className="head-end">
        <a
          className="brand-link"
          href={REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Phase Runner ${__VIEWER_VERSION__} on GitHub`}
          data-testid="brand-link"
        >
          <span className="brand-words">Phase Runner </span>
          <span className="brand-v">v</span>
          {__VIEWER_VERSION__}
        </a>
        <SettingsMenu />
      </div>
    </header>
  );
}
