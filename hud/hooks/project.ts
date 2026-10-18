/**
 * The whole project as phase-viewer sees it, built from file text: every
 * `Phase-{N}-*.md` in `docs/phases/` and every `.runs/phase-{N}.jsonl`. Pure
 * (names and text in, a {@link Project} out) and never throws; `register.ts`
 * reads the files through `$.fs`.
 *
 * It follows the viewer's loader (`viewer/src/core/load.ts`), which can't be
 * copied in because it reads files with Node: phase files sorted by number,
 * each parsed, task progress derived, then each run log read and derived with
 * the sprints that run a browser wave test and each sprint's task numbers. The
 * cross-file checks the viewer adds (a phase header that disagrees with its
 * file name, a dependency on a sprint no phase defines) are left out: the pane
 * counts only the parser's and the run-log reader's warnings.
 */
import { deriveProgress } from './core/derive/progress.js';
import { deriveRun } from './core/derive/run.js';
import type { Phase, Project, Warning } from './core/model.js';
import { parsePhaseFile } from './core/parser/phase.js';
import { readRunLog } from './core/runlog/read.js';

/** One file's name (no directory) and text. */
export interface FileText {
  name: string;
  text: string;
}

const PHASE_FILE = /^Phase-(\d+)\b.*\.md$/i;
const RUN_LOG = /^phase-(0|[1-9]\d*)\.jsonl$/;

/** The phase number of a phase file name (`Phase-{N}….md`), or `null` for any other name. */
export function phaseFileNumber(name: string): number | null {
  const m = PHASE_FILE.exec(name);
  if (!m?.[1]) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : null;
}

/** The phase number of a run-log name (`phase-{N}.jsonl`), or `null` for any other name. */
export function runLogNumber(name: string): number | null {
  const m = RUN_LOG.exec(name);
  return m?.[1] ? Number(m[1]) : null;
}

/**
 * Build the project.
 *
 * @param root The folder that holds `docs/phases/`, with `/` separators.
 * @param phaseFiles The phase files' names and text, in any order. Other names are ignored.
 * @param runLogs The run logs' names and text, in any order. Other names are ignored.
 */
export function assembleProject(root: string, phaseFiles: readonly FileText[], runLogs: readonly FileText[]): Project {
  const phasesDir = `${root.replace(/[\\/]+$/, '')}/docs/phases`;
  const warnings: Warning[] = [];

  const phases: Phase[] = [];
  const candidates = phaseFiles
    .map((f) => ({ ...f, n: phaseFileNumber(f.name) }))
    .filter((f): f is FileText & { n: number } => f.n !== null)
    .sort((a, b) => a.n - b.n || a.name.localeCompare(b.name));
  for (const file of candidates) {
    const parsed = parsePhaseFile(file.text, `${phasesDir}/${file.name}`);
    phases.push(parsed.phase);
    warnings.push(...[...parsed.warnings].sort((a, b) => a.line - b.line));
  }
  // Header numbers win for ordering; the sort is stable, so ties keep file order.
  phases.sort((a, b) => a.number - b.number);

  const sprints = phases.flatMap((p) => p.sprints);
  const uiSprints = sprints
    .filter((s) => s.verification.ui.length > 0 && s.verification.skipUi !== true)
    .map((s) => s.id);
  const sprintTasks: Record<string, number[]> = {};
  for (const s of sprints) sprintTasks[s.id] = s.tasks.map((t) => t.number).filter((n): n is number => n !== null);

  const runs = runLogs
    .map((f) => ({ ...f, n: runLogNumber(f.name) }))
    .filter((f): f is FileText & { n: number } => f.n !== null)
    .sort((a, b) => a.n - b.n)
    .map((f) => {
      const file = `${phasesDir}/.runs/${f.name}`;
      const read = readRunLog(f.text, file);
      warnings.push(...read.warnings);
      return { phase: f.n, file, events: read.events, ...deriveRun(read.events, { uiSprints, sprintTasks }) };
    });

  return {
    root,
    phasesDir,
    phases,
    runs,
    hasDesignSystem: false,
    progress: deriveProgress(phases),
    warnings,
  };
}
