/**
 * The top bar (design-system.md "Calmer layout", Top bar): the wordmark at
 * the left; at the right the project name, then the settings gear (theme),
 * and nothing else.
 *
 * The project name is the project folder's name (`baseName(root)`, the same
 * name the tab title ends with), so two viewers open side by side can be
 * told apart. It's plain text on one line, ending in an ellipsis when it
 * doesn't fit; the full path is its tooltip only. Nothing shows until a
 * project loads (the loading, empty and candidates states).
 *
 * Test hooks: `project-name`.
 */
import { baseName } from '../data/applyUpdate.js';
import { SettingsMenu } from './SettingsMenu.js';
import { Wordmark } from './Wordmark.js';
import './shell.css';

export function TopBar({ root }: { root: string | null }) {
  return (
    <header className="app-head">
      <div className="brand">
        <Wordmark />
      </div>
      <div className="head-end">
        {root !== null && (
          <span className="project-name" title={root} data-testid="project-name">
            {baseName(root)}
          </span>
        )}
        <SettingsMenu />
      </div>
    </header>
  );
}
