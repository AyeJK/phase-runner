/**
 * Parse-warnings banners (design-system.md "Parse warnings"): one `.banner.warn`
 * per file with lines the viewer couldn't read, "N lines in {file} couldn't be
 * read" / "Everything else is shown.", and a **Show details** button (one of
 * the two sanctioned in-page toggles) that reveals the file's path and each
 * warning's line number and raw text, with the reason under it.
 *
 * Views pass the files they show: a phase page shows its phase's plan and
 * run log, then every file no phase owns (`pageWarningFiles`). The rest of
 * the view renders as usual underneath.
 *
 * Test hooks: `[data-testid=parse-warnings]` (with `data-file`, the project
 * path), `parse-warnings-toggle`, `parse-warnings-details`, `parse-warning`
 * rows (with `data-line`), `parse-warning-raw`.
 */
import { useId, useMemo, useState } from 'react';
import type { Project } from '../../core/model.js';
import { StatusIcon } from '../components/StatusIcon.js';
import { visibleRaw, warningGroups, warningsTitle, WARNINGS_TEXT, type WarningGroup } from './warnings.js';
import './states.css';

export function ParseWarnings({ project, files }: { project: Project; files?: readonly string[] }) {
  const groups = useMemo(() => warningGroups(project, files), [project, files]);
  if (groups.length === 0) return null;
  return (
    <div className="parse-warnings">
      {groups.map((group) => (
        <WarningBanner key={group.file} group={group} />
      ))}
    </div>
  );
}

function WarningBanner({ group }: { group: WarningGroup }) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();

  return (
    <div className="banner warn warn-banner" data-testid="parse-warnings" data-file={group.path}>
      <StatusIcon kind="warn" />
      <div className="warn-text">
        <strong>{warningsTitle(group)}</strong>
        <p>{WARNINGS_TEXT}</p>
      </div>
      <button
        className="btn"
        type="button"
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={() => setOpen((o) => !o)}
        data-testid="parse-warnings-toggle"
      >
        {open ? 'Hide details' : 'Show details'}
      </button>
      <div className="warn-details" id={detailsId} hidden={!open} data-testid="parse-warnings-details">
        <div className="warn-file">{group.path}</div>
        <ol className="warn-lines">
          {group.warnings.map((warning, i) => (
            <li key={`${warning.line}:${i}`} data-testid="parse-warning" data-line={warning.line}>
              <span className="ln">{warning.line > 0 ? `line ${warning.line}` : 'file'}</span>
              <span className="raw" data-testid="parse-warning-raw">
                {warning.raw !== '' ? (
                  visibleRaw(warning.raw)
                ) : warning.line > 0 ? (
                  <span className="blank">(blank line)</span>
                ) : null}
              </span>
              <span className="why">{warning.message}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
