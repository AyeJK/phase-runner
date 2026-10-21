/**
 * The parse-warnings banner's grouping (`src/client/states/warnings.ts`)
 * against the `broken` fixture: one group per file, distinct lines counted,
 * the title copy, and control characters made visible.
 */
import { describe, expect, it } from 'vitest';
import {
  orphanFiles,
  pageWarningFiles,
  phaseFiles,
  visibleRaw,
  warningGroups,
  warningsTitle,
} from '../../src/client/states/warnings.js';
import { loadProject } from '../../src/core/load.js';
import { BROKEN, BROKEN_LINES } from '../fixtures/index.js';

describe('warningGroups', () => {
  it('groups the broken fixture into one file with every warning, by line', async () => {
    const project = await loadProject(BROKEN.root);
    const groups = warningGroups(project);
    expect(groups).toHaveLength(1);
    const [group] = groups;
    expect(group!.path).toBe('docs/phases/Phase-1-Broken.md');
    expect(group!.name).toBe('Phase-1-Broken.md');
    expect(group!.warnings).toHaveLength(project.warnings.length);
    expect(group!.lines).toBe(new Set(project.warnings.map((w) => w.line)).size);
    const lines = group!.warnings.map((w) => w.line);
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
    expect(lines).toContain(BROKEN_LINES.unclosedRow);
    expect(lines).toContain(BROKEN_LINES.binaryBytes);
  });

  it('filters to the files a page shows', async () => {
    const project = await loadProject(BROKEN.root);
    const phase = project.phases[0]!;
    expect(warningGroups(project, phaseFiles(project, phase))).toHaveLength(1);
    expect(warningGroups(project, [phase.file.replace(/\\/g, '/')])).toHaveLength(1);
    expect(warningGroups(project, ['/elsewhere/Phase-9-Nope.md'])).toHaveLength(0);
  });

  it('adds files no phase owns to every phase page', async () => {
    const project = await loadProject(BROKEN.root);
    const phase = project.phases[0]!;
    expect(orphanFiles(project)).toEqual([]);
    expect(pageWarningFiles(project, phase)).toEqual(phaseFiles(project, phase));

    const orphan = `${project.phasesDir}/.runs/phase-9.jsonl`;
    const withOrphan = {
      ...project,
      warnings: [
        ...project.warnings,
        { file: orphan, line: 1, raw: 'not json', message: 'Not JSON' },
        { file: orphan.replace(/\//g, '\\'), line: 2, raw: '{', message: 'Not JSON' },
      ],
    };
    // One entry per file, whatever the separator; the phase's own file is never an orphan.
    expect(orphanFiles(withOrphan)).toEqual([orphan]);
    expect(pageWarningFiles(withOrphan, phase)).toEqual([...phaseFiles(withOrphan, phase), orphan]);
    const groups = warningGroups(withOrphan, pageWarningFiles(withOrphan, phase));
    expect(groups.map((g) => [g.name, g.lines])).toEqual([
      ['Phase-1-Broken.md', new Set(project.warnings.map((w) => w.line)).size],
      ['phase-9.jsonl', 2],
    ]);
  });
});

describe('copy', () => {
  it('counts lines with the right plural', () => {
    expect(warningsTitle({ lines: 1, name: 'Phase-1-Broken.md' })).toBe("1 line in Phase-1-Broken.md couldn't be read");
    expect(warningsTitle({ lines: 3, name: 'phase-2.jsonl' })).toBe("3 lines in phase-2.jsonl couldn't be read");
  });

  it('shows control characters as control pictures and keeps tabs and text', () => {
    expect(visibleRaw('a\u0000b\u001bc\u007fd')).toBe('a␀b␛c␡d');
    expect(visibleRaw('| x | 1 |\tok')).toBe('| x | 1 |\tok');
  });
});
