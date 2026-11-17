/**
 * Run-log reader: turns the text of one `docs/phases/.runs/phase-{N}.jsonl`
 * file into typed {@link RunEvent}s plus {@link Warning}s. Pure (text in, data
 * out) and never throws.
 *
 * Rules (spec: `plugin/skills/phase-builder/run-log.md`, "Reading the log"):
 *
 * - One JSON object per LF-terminated line. A trailing CR is dropped, and a
 *   leading UTF-8 BOM is ignored.
 * - The text after the last `\n` is an append still being written, so it is
 *   skipped silently, even when it happens to be complete JSON. An empty file
 *   yields nothing.
 * - Blank (whitespace-only) lines are skipped silently.
 * - A terminated line that isn't a JSON object, or lacks a required field
 *   (`v`, `ts`, `phase`, `wave`, `sprint`, `gate`, `result`, `attempt`), or has
 *   one of the wrong type, is skipped with a warning carrying its line number.
 *   Strings must be non-blank; `phase`, `wave` and `attempt` must be whole
 *   numbers `>= 0` (the writer logs `0` for an empty placeholder).
 * - `v > 1`: the file gets one warning (at the first such line) and every line
 *   is still read best-effort. `v` that isn't a number `>= 1` skips the line.
 * - Unknown `gate` / `result` values are kept as `unknown`, with the raw value
 *   in `rawGate` / `rawResult`, and one warning per value per file (at its
 *   first line), so a log from a newer writer doesn't bury the page in
 *   warnings. `result: "start"` is read without a warning on `implement`,
 *   `task` and `suite` lines only; on any other gate it is `unknown`.
 * - A `task` line carries its task number alone in `summary`. It is read into
 *   {@link RunEvent.task}; a `task` line whose `summary` isn't a whole number
 *   is skipped with a warning.
 * - Optional fields: `summary` (missing → `""`), `files` (kept only when it is
 *   an array; non-string entries dropped), `max` (missing or invalid → the spec
 *   default, see {@link DEFAULT_MAX}). Extra fields are ignored.
 * - Events keep file order. `ts` is kept as written and never used for sorting.
 */
import {
  RUN_GATES,
  RUN_RESULTS,
  type RunEvent,
  type RunGate,
  type RunResult,
  type Warning,
} from '../model.js';

/** The run-log format version this reader was written for. */
export const RUN_LOG_VERSION = 1;

/**
 * `max` used when a line has none (or an invalid one): the spec's defaults,
 * `max_verify_retries` / `max_wave_test_retries` = 3 and doc-sync's fixed 1.
 * An unknown gate gets 3 like the retrying gates, and so does a `task` line,
 * which carries its implementation run's `max`.
 */
export const DEFAULT_MAX: Readonly<Record<RunGate, number>> = {
  implement: 3,
  verify: 3,
  wave_test: 3,
  doc_sync: 1,
  task: 3,
  suite: 3,
  unknown: 3,
};

/** Gates whose lines may carry `result: "start"`. */
const START_GATES: ReadonlySet<RunGate> = new Set<RunGate>(['implement', 'task', 'suite']);

/** A `task` line's `summary`: the task number and nothing else. */
const TASK_NUMBER = /^\d+$/;

/** What {@link readRunLog} returns. */
export interface RunLogRead {
  /** Every readable event, in file order. */
  events: RunEvent[];
  /** Problems found, in file order. */
  warnings: Warning[];
}

const KNOWN_GATES: ReadonlySet<string> = new Set<string>(RUN_GATES.filter((g) => g !== 'unknown'));
const KNOWN_RESULTS: ReadonlySet<string> = new Set<string>(RUN_RESULTS.filter((r) => r !== 'unknown'));

/**
 * Read one run-log file.
 *
 * @param text The file's contents. A `Uint8Array` (e.g. a `Buffer`) is decoded
 *   as UTF-8 with invalid bytes replaced, so binary garbage is safe to pass.
 * @param file The file's path, copied into every {@link Warning.file}.
 */
export function readRunLog(text: string | Uint8Array, file: string): RunLogRead {
  const events: RunEvent[] = [];
  const warnings: Warning[] = [];
  const warn = (line: number, raw: string, message: string): void => {
    warnings.push({ file, line, raw, message });
  };

  try {
    const content = decode(text);
    const segments = content.split('\n');
    // The last segment is either '' (the file ends with a newline) or an append
    // still in progress. Both are skipped silently.
    const terminated = segments.length - 1;
    const claimed = new Set<string>();

    for (let i = 0; i < terminated; i++) {
      const lineNo = i + 1;
      let raw = segments[i] ?? '';
      if (raw.endsWith('\r')) raw = raw.slice(0, -1);
      if (raw.trim() === '') continue;

      try {
        const lineWarn = (message: string): void => warn(lineNo, raw, message);
        const event = readLine(raw, lineNo, lineWarn, (key) => {
          if (claimed.has(key)) return false;
          claimed.add(key);
          return true;
        });
        if (event) events.push(event);
      } catch (err) {
        warn(lineNo, raw, `Could not read line: ${errorMessage(err)}; skipped`);
      }
    }
  } catch (err) {
    warn(0, '', `Could not read run log: ${errorMessage(err)}`);
  }

  return { events, warnings };
}

/**
 * Parse one terminated, non-blank line. Returns `null` (after warning) when the
 * line can't become an event.
 *
 * @param once Returns `true` the first time it is called with a key per file,
 *   so the `v > 1` warning, and the warning for each unknown gate or result
 *   value, is raised once per file: a log from a newer writer reads as one
 *   warning per new value, not one per line.
 */
function readLine(
  raw: string,
  line: number,
  warn: (message: string) => void,
  once: (key: string) => boolean,
): RunEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warn('Line is not valid JSON; skipped');
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    warn('Line is not a JSON object; skipped');
    return null;
  }
  const obj = parsed as Record<string, unknown>;

  // Version first: it decides whether the rest is read at all.
  const v = obj['v'];
  if (v === undefined) {
    warn('Missing required field "v"; skipped');
    return null;
  }
  if (typeof v !== 'number' || !Number.isFinite(v) || v < RUN_LOG_VERSION) {
    warn(`Unsupported run-log version "v": ${show(v)}; skipped`);
    return null;
  }
  if (v > RUN_LOG_VERSION && once('version')) {
    warn(
      `Run log uses format v${v}, newer than this reader (v${RUN_LOG_VERSION}); reading it best-effort`,
    );
  }

  // Required fields.
  const problems: string[] = [];
  const ts = requireString(obj, 'ts', problems);
  const phase = requireCount(obj, 'phase', problems);
  const wave = requireCount(obj, 'wave', problems);
  const sprint = requireString(obj, 'sprint', problems);
  const rawGate = requireString(obj, 'gate', problems);
  const rawResult = requireString(obj, 'result', problems);
  const attempt = requireCount(obj, 'attempt', problems);
  if (
    problems.length > 0 ||
    ts === null ||
    phase === null ||
    wave === null ||
    sprint === null ||
    rawGate === null ||
    rawResult === null ||
    attempt === null
  ) {
    warn(`${problems.join('; ')}; skipped`);
    return null;
  }

  // Enumerations: unknown values are kept as `unknown`.
  let gate: RunGate = 'unknown';
  if (KNOWN_GATES.has(rawGate)) gate = rawGate as RunGate;
  else if (once(`gate:${rawGate}`)) warn(`Unknown gate ${show(rawGate)}; kept as "unknown" (warned once per file)`);

  let result: RunResult = 'unknown';
  if (KNOWN_RESULTS.has(rawResult)) result = rawResult as RunResult;
  else if (once(`result:${rawResult}`)) warn(`Unknown result ${show(rawResult)}; kept as "unknown" (warned once per file)`);
  if (result === 'start' && !START_GATES.has(gate)) {
    result = 'unknown';
    warn(`Result "start" is only used on implement, task and suite lines, not ${show(rawGate)}; kept as "unknown"`);
  }

  // A task line names its task in `summary`; without a number it says nothing.
  let task: number | null = null;
  if (gate === 'task') {
    const rawTask = obj['summary'];
    const text = typeof rawTask === 'string' ? rawTask.trim() : '';
    task = TASK_NUMBER.test(text) ? Number(text) : null;
    if (task === null || !Number.isSafeInteger(task)) {
      warn(`A task line's "summary" should be the task number alone, got ${show(rawTask)}; skipped`);
      return null;
    }
  }

  // Optional fields.
  let max = DEFAULT_MAX[gate];
  const rawMax = obj['max'];
  if (rawMax !== undefined && rawMax !== null) {
    if (isCount(rawMax)) max = rawMax;
    else warn(`Field "max" should be a whole number >= 0, got ${show(rawMax)}; using ${max}`);
  }

  let summary = '';
  const rawSummary = obj['summary'];
  if (typeof rawSummary === 'string') summary = rawSummary;
  else if (rawSummary !== undefined && rawSummary !== null) {
    warn(`Field "summary" should be a string, got ${show(rawSummary)}; treated as empty`);
  }

  const event: RunEvent = {
    v,
    ts,
    phase,
    wave,
    sprint,
    gate,
    rawGate,
    result,
    rawResult,
    attempt,
    max,
    summary,
    line,
  };

  const rawFiles = obj['files'];
  if (Array.isArray(rawFiles)) {
    const files = rawFiles.filter((f): f is string => typeof f === 'string');
    if (files.length !== rawFiles.length) {
      warn(`Field "files" has ${rawFiles.length - files.length} non-string entries; dropped them`);
    }
    event.files = files;
  } else if (rawFiles !== undefined && rawFiles !== null) {
    warn(`Field "files" should be an array of strings, got ${show(rawFiles)}; ignored`);
  }

  if (task !== null) event.task = task;

  return event;
}

/** A required string field; `null` (with a problem noted) when missing or not a string. */
function requireString(obj: Record<string, unknown>, key: string, problems: string[]): string | null {
  const value = obj[key];
  if (value === undefined) {
    problems.push(`Missing required field "${key}"`);
    return null;
  }
  if (typeof value !== 'string') {
    problems.push(`Field "${key}" should be a string, got ${show(value)}`);
    return null;
  }
  if (value.trim() === '') {
    problems.push(`Field "${key}" is empty`);
    return null;
  }
  return value;
}

/** A required whole-number field (>= 0); `null` (with a problem noted) otherwise. */
function requireCount(obj: Record<string, unknown>, key: string, problems: string[]): number | null {
  const value = obj[key];
  if (value === undefined) {
    problems.push(`Missing required field "${key}"`);
    return null;
  }
  if (!isCount(value)) {
    problems.push(`Field "${key}" should be a whole number >= 0, got ${show(value)}`);
    return null;
  }
  return value;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Decode input to a string, dropping a leading BOM. */
function decode(text: string | Uint8Array): string {
  let s: string;
  if (typeof text === 'string') s = text;
  // Not fatal (the default): invalid bytes become U+FFFD.
  else if (text instanceof Uint8Array) s = new TextDecoder('utf-8').decode(text);
  else s = '';
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** Short JSON rendering of a value for warning messages. */
function show(value: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(value) ?? String(value);
  } catch {
    s = String(value);
  }
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
