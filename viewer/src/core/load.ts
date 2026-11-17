/**
 * Project loader: one project folder in, one {@link Project} out.
 *
 * - Phase files: every regular file in `{root}/docs/phases/` named
 *   `Phase-{N}….md` (e.g. `Phase-2-Core-Model.md`; case-insensitive), sorted by
 *   N numerically (`Phase-10` after `Phase-9`), ties by name. Other files and
 *   folders, `.runs/` included, are ignored.
 * - Run logs: `{root}/docs/phases/.runs/phase-{N}.jsonl`, via `findRunLogs`,
 *   each derived with `deriveRun`.
 * - Design system: whether `{root}/docs/design/design-system.md` is a file.
 *
 * Read-only by design: plain `fs` reads (`readdir`, `stat`, `readFile`), no
 * writes, no git, no child processes.
 *
 * Never throws (the promise never rejects). Every problem becomes a
 * {@link Warning} with an absolute file path, grouped by file in load order:
 * the folder itself, then each phase file (parser warnings plus loader
 * warnings, sorted by line), then each run log.
 *
 * Loader warnings on top of the parser's and reader's:
 *
 * - no `docs/phases/` folder (or it can't be read): one warning, empty project
 * - a phase file that can't be read (line 0)
 * - a phase file whose `# Phase N` header disagrees with its file name, or two
 *   files with the same phase number
 * - a dependency on `Sprint X.Y` that no loaded phase defines, or on
 *   `Phase N` when no phase N is loaded (on the dependency's line)
 * - a run log whose events name another phase (once per file, first such line)
 *
 * The per-file steps (`loadPhaseFile`, `loadRunLog`) and the cross-file checks
 * (`checkPhaseNumbers`, `checkDependencies`) are exported so the server's
 * incremental state (`src/server/state.ts`) can re-read one changed file and
 * rebuild the same {@link Project} this loader would.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Phase, PhaseRuns, Project, Warning } from './model.js';
import { deriveProgress } from './derive/progress.js';
import { deriveRun } from './derive/run.js';
import { parsePhaseFile } from './parser/phase.js';
import { findRunLogs } from './runlog/find.js';
import { readRunLog } from './runlog/read.js';

/** Phase file names: `Phase-{N}` then a non-word character, ending in `.md`. */
const PHASE_FILE = /^Phase-(\d+)\b.*\.md$/i;

/**
 * The phase number a phase file name maps to, or `null` when the name isn't
 * a phase file (`Phase-{N}….md`).
 */
export function phaseFileNumber(name: string): number | null {
  const m = PHASE_FILE.exec(name);
  if (!m?.[1]) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : null;
}

/** A phase file as parsed, with its own warnings. */
export interface LoadedPhase {
  phase: Phase;
  /** File-name phase number. */
  fileNumber: number;
  /** The file's lines (index 0 is line 1), for quoting in loader warnings. */
  lines: string[];
  warnings: Warning[];
}

/**
 * Load a project folder.
 *
 * @param root The project folder (the one holding `docs/phases/`); resolved
 *   to an absolute path.
 */
export async function loadProject(root: string): Promise<Project> {
  const absRoot = path.resolve(typeof root === 'string' ? root : '.');
  const phasesDir = path.join(absRoot, 'docs', 'phases');
  const project: Project = {
    root: absRoot,
    phasesDir,
    phases: [],
    runs: [],
    hasDesignSystem: false,
    progress: deriveProgress([]),
    warnings: [],
  };

  try {
    project.hasDesignSystem = await isFile(path.join(absRoot, 'docs', 'design', 'design-system.md'));

    let names: string[];
    try {
      names = await readdir(phasesDir);
    } catch (err) {
      project.warnings.push({
        file: phasesDir,
        line: 0,
        raw: '',
        message: `No docs/phases/ folder to read (${errorCode(err)}); the project has no phase plans`,
      });
      return project;
    }

    // Phase files.
    const candidates = names
      .map((name) => ({ name, n: phaseFileNumber(name) }))
      .filter((c): c is { name: string; n: number } => c.n !== null)
      .sort((a, b) => a.n - b.n || a.name.localeCompare(b.name));

    const loaded: LoadedPhase[] = [];
    for (const { name, n } of candidates) {
      const file = path.join(phasesDir, name);
      if (!(await isFile(file))) continue;
      loaded.push(await loadPhaseFile(file, n));
    }
    // Header numbers win for ordering; the sort is stable, so ties keep file order.
    loaded.sort((a, b) => a.phase.number - b.phase.number);

    checkPhaseNumbers(loaded);
    checkDependencies(loaded);

    project.phases = loaded.map((l) => l.phase);
    for (const l of loaded) {
      l.warnings.sort((a, b) => a.line - b.line);
      project.warnings.push(...l.warnings);
    }
    project.progress = deriveProgress(project.phases);

    // Run logs.
    const uiSprints = uiSprintIds(project.phases);
    const sprintTasks = sprintTaskNumbers(project.phases);
    for (const log of await findRunLogs(phasesDir)) {
      const { runs, warnings } = await loadRunLog(log.file, log.phase, uiSprints, sprintTasks);
      project.runs.push(runs);
      project.warnings.push(...warnings);
    }
  } catch (err) {
    project.warnings.push({
      file: phasesDir,
      line: 0,
      raw: '',
      message: `Could not finish loading the project: ${errorMessage(err)}; returning what loaded so far`,
    });
  }
  return project;
}

/**
 * Ids of the sprints that run a browser wave test (a `ui:` route and no
 * `skip-ui: true`), for {@link deriveRun}'s `uiSprints` option.
 */
export function uiSprintIds(phases: readonly Phase[]): string[] {
  return phases
    .flatMap((p) => p.sprints)
    .filter((s) => s.verification.ui.length > 0 && s.verification.skipUi !== true)
    .map((s) => s.id);
}

/**
 * Each sprint's task numbers (rows without a number left out), for
 * {@link deriveRun}'s `sprintTasks` option: a `task` line in the run log that
 * names a number its sprint doesn't have is ignored.
 */
export function sprintTaskNumbers(phases: readonly Phase[]): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const sprint of phases.flatMap((p) => p.sprints)) {
    out[sprint.id] = sprint.tasks.map((t) => t.number).filter((n): n is number => n !== null);
  }
  return out;
}

/** Read and parse one phase file; a read failure becomes an empty phase plus a warning. */
export async function loadPhaseFile(file: string, fileNumber: number): Promise<LoadedPhase> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    const { phase } = parsePhaseFile('', file);
    phase.number = fileNumber;
    return {
      phase,
      fileNumber,
      lines: [],
      warnings: [{ file, line: 0, raw: '', message: `Could not read phase file (${errorCode(err)})` }],
    };
  }
  const { phase, warnings } = parsePhaseFile(text, file);
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return { phase, fileNumber, lines: body.split(/\r?\n/), warnings };
}

/**
 * Warn about a header number that disagrees with the file name, and duplicate
 * phase numbers. Pushes onto each entry's `warnings`; expects `loaded` sorted
 * by phase number.
 */
export function checkPhaseNumbers(loaded: LoadedPhase[]): void {
  const seen = new Map<number, string>();
  for (const l of loaded) {
    const { phase } = l;
    if (phase.line > 0 && phase.number !== l.fileNumber) {
      l.warnings.push(
        lineWarning(
          l,
          phase.line,
          `Phase header says phase ${phase.number} but the file name says ${l.fileNumber}; using ${phase.number}`,
        ),
      );
    }
    const other = seen.get(phase.number);
    if (other !== undefined) {
      l.warnings.push(
        lineWarning(l, phase.line, `Phase ${phase.number} is also defined in ${path.basename(other)}`),
      );
    } else {
      seen.set(phase.number, phase.file);
    }
  }
}

/** Warn about dependency ids that name no loaded sprint or phase. Pushes onto each entry's `warnings`. */
export function checkDependencies(loaded: LoadedPhase[]): void {
  const sprintIds = new Set<string>();
  const phaseNumbers = new Set<number>();
  for (const { phase } of loaded) {
    phaseNumbers.add(phase.number);
    for (const s of phase.sprints) sprintIds.add(s.id);
  }
  for (const l of loaded) {
    for (const sprint of l.phase.sprints) {
      for (const dep of sprint.dependencies) {
        for (const id of dep.sprints) {
          if (!sprintIds.has(id)) {
            l.warnings.push(
              lineWarning(l, dep.line, `Sprint ${sprint.id} depends on Sprint ${id}, which is not in any loaded phase`),
            );
          }
        }
        for (const n of dep.phases) {
          if (!phaseNumbers.has(n)) {
            l.warnings.push(
              lineWarning(l, dep.line, `Sprint ${sprint.id} depends on Phase ${n}, which is not loaded`),
            );
          }
        }
      }
    }
  }
}

/**
 * Read, parse and derive one run log; a read failure becomes an empty log plus a warning.
 *
 * @param uiSprints See {@link uiSprintIds}.
 * @param sprintTasks See {@link sprintTaskNumbers}. Left out, every `task` line's number is kept.
 */
export async function loadRunLog(
  file: string,
  phase: number,
  uiSprints: readonly string[],
  sprintTasks?: Readonly<Record<string, readonly number[]>>,
): Promise<{ runs: PhaseRuns; warnings: Warning[] }> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(file);
  } catch (err) {
    return {
      runs: { phase, file, events: [], waves: [], escalations: [], sprintHistory: {}, suites: [] },
      warnings: [{ file, line: 0, raw: '', message: `Could not read run log (${errorCode(err)})` }],
    };
  }
  const { events, warnings } = readRunLog(bytes, file);
  const stray = events.find((e) => e.phase !== phase);
  if (stray) {
    const count = events.filter((e) => e.phase !== phase).length;
    warnings.push({
      file,
      line: stray.line,
      raw: rawLine(bytes, stray.line),
      message: `${count} event(s) name phase ${stray.phase} in the log for phase ${phase}; kept as they are`,
    });
    warnings.sort((a, b) => a.line - b.line);
  }
  const derived = deriveRun(events, { uiSprints, sprintTasks });
  return { runs: { phase, file, events, ...derived }, warnings };
}

/** A warning on a 1-based line of a loaded phase file, quoting that line. */
function lineWarning(l: LoadedPhase, line: number, message: string): Warning {
  return { file: l.phase.file, line, raw: line > 0 ? (l.lines[line - 1] ?? '') : '', message };
}

/** One line of a run log's bytes, without its line ending. */
function rawLine(bytes: Uint8Array, line: number): string {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const raw = body.split('\n')[line - 1] ?? '';
  return raw.endsWith('\r') ? raw.slice(0, -1) : raw;
}

/** `true` when the path is a regular file; `false` on any error. */
async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/** A short code for an fs error (`ENOENT`, `ENOTDIR`, …), else its message. */
function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err && typeof err.code === 'string') return err.code;
  return errorMessage(err);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
