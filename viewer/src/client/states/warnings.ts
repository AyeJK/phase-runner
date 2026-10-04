/**
 * Parse warnings grouped for the warnings banner (design-system.md "Parse
 * warnings"): one group per file, in the model's order (phase files by
 * number, then run logs). Pure, no DOM.
 *
 * The banner title counts distinct lines, not warnings: a line with two
 * problems is still one line that couldn't be read. A whole-file warning
 * (line 0, e.g. the file couldn't be opened) counts as one.
 */
import type { Phase, Project, Warning } from '../../core/model.js';
import { phaseRuns } from '../data/status.js';
import { plural, projectPath } from '../format.js';

/** Paths compared the same whatever the separator or Windows drive-letter case. */
export function samePath(file: string): string {
  const slashed = file.replace(/\\/g, '/');
  return /^[a-z]:\//i.test(slashed) ? slashed[0]!.toLowerCase() + slashed.slice(1) : slashed;
}

/** How many warnings are about the phase file or its run log (the kanban card's "N warnings" tag). */
export function phaseWarnings(warnings: readonly Warning[], phaseFile: string, runFile: string | null): number {
  const files = new Set([samePath(phaseFile), ...(runFile ? [samePath(runFile)] : [])]);
  return warnings.reduce((n, w) => (files.has(samePath(w.file)) ? n + 1 : n), 0);
}

/** Every warning about one file. */
export interface WarningGroup {
  /** Absolute path, as the model has it. */
  file: string;
  /** Path relative to the project folder ("docs/phases/Phase-1-Broken.md"). */
  path: string;
  /** The file's name ("Phase-1-Broken.md"). */
  name: string;
  /** Distinct lines with a warning. */
  lines: number;
  /** The file's warnings, by line. */
  warnings: Warning[];
}

/**
 * The project's warnings grouped by file. With `files`, only groups for those
 * files (compared whatever the separator or drive-letter case).
 */
export function warningGroups(project: Project, files?: readonly string[]): WarningGroup[] {
  const only = files ? new Set(files.map(samePath)) : null;
  const groups = new Map<string, WarningGroup>();
  for (const warning of project.warnings) {
    const key = samePath(warning.file);
    if (only && !only.has(key)) continue;
    let group = groups.get(key);
    if (!group) {
      const path = projectPath(project.root, warning.file);
      group = { file: warning.file, path, name: path.split('/').pop() || path, lines: 0, warnings: [] };
      groups.set(key, group);
    }
    group.warnings.push(warning);
  }
  for (const group of groups.values()) {
    group.warnings.sort((a, b) => a.line - b.line);
    group.lines = new Set(group.warnings.map((w) => w.line)).size;
  }
  return [...groups.values()];
}

/** A phase's own files: its phase plan, plus its run log when it has one. */
export function phaseFiles(project: Project, phase: Pick<Phase, 'number' | 'file'>): string[] {
  const runs = phaseRuns(project, phase.number);
  return runs ? [phase.file, runs.file] : [phase.file];
}

/** "3 lines in Phase-1-Broken.md couldn't be read". */
export function warningsTitle(group: Pick<WarningGroup, 'lines' | 'name'>): string {
  return `${plural(group.lines, 'line')} in ${group.name} couldn't be read`;
}

/** The banner's second line. */
export const WARNINGS_TEXT = 'Everything else is shown.';

/**
 * A raw line made visible: control characters (NUL, ESC, DEL and the rest,
 * but not tab) become their Unicode control pictures (␀, ␛, ␡), so stray
 * bytes show where they are instead of vanishing.
 */
export function visibleRaw(raw: string): string {
  return raw.replace(/[\u0000-\u0008\u000a-\u001f\u007f]/g, (c) => {
    const code = c.charCodeAt(0);
    return String.fromCharCode(code === 0x7f ? 0x2421 : 0x2400 + code);
  });
}
