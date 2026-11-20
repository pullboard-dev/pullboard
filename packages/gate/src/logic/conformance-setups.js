/** The language setups the gate is checked against: report command, checked-in fixture report, selection unit and toolchain, with a missing toolchain reported unavailable [C7]. */
import { junitCommand } from './junit.js';

/** One row per setup; command and report come from the junit table (ctest is the cmake row), so they cannot drift from it. */
const ROWS = Object.freeze([
  { language: 'node', row: 'node', unit: 'file', toolchains: ['node'] },
  { language: 'typescript', row: 'node', unit: 'file', toolchains: ['node'], command: 'vitest run --reporter=junit --outputFile=.pullboard/junit/typescript.xml', report: '.pullboard/junit/typescript.xml' },
  { language: 'python', row: 'python', unit: 'file', toolchains: ['python3'] },
  { language: 'go', row: 'go', unit: 'package', toolchains: ['go'] },
  { language: 'rust', row: 'rust', unit: 'crate', toolchains: ['cargo'] },
  { language: 'php', row: 'php', unit: 'file', toolchains: ['php'] },
  { language: 'elixir', row: 'elixir', unit: 'project', toolchains: ['mix'] },
  { language: 'csharp', row: 'csharp', unit: 'project', toolchains: ['dotnet'] },
  { language: 'ctest', row: 'cmake', unit: 'file', toolchains: ['cmake', 'ctest'] },
]);

/**
 * Every conformance setup, in a fixed order, each with its report command, report path, fixture report path (relative to packages/gate) and selection unit.
 * Why: the real-pipeline runs and the compatibility page read one list instead of each re-deriving the languages.
 *
 * @returns {{ language: string, command: string, report: string, fixture: string, unit: string, toolchains: string[] }[]}
 */
export function conformanceSetups() {
  return ROWS.map(({ language, row, unit, toolchains, command, report }) => {
    const base = junitCommand(row);
    return { language, command: command ?? base.command, report: report ?? base.report, fixture: `tests/fixtures/conformance/${language}.xml`, unit, toolchains: [...toolchains] };
  });
}

/**
 * Whether each setup's toolchain is present, using an injected which so nothing runs a process here.
 * Why: a runner without a toolchain is unavailable, never red; the answer names the missing toolchain so the page can say so.
 *
 * @param {(name: string) => boolean} which true when the named tool is on the path
 * @returns {{ language: string, status: 'available' | 'unavailable', toolchain: string | null }[]}
 */
export function setupAvailability(which) {
  return conformanceSetups().map(({ language, toolchains }) => {
    const missing = toolchains.find(name => !which(name)) ?? null;
    return { language, status: missing === null ? 'available' : 'unavailable', toolchain: missing };
  });
}

/** The pipeline stages a conformance run can reach, in order. */
export const CONFORMANCE_STAGES = Object.freeze(['claim', 'submit', 'gate', 'review', 'accept', 'land']);

/**
 * One row per setup and pipeline stage: the outcome and run id of the latest recorded run that reached that stage.
 * Why: the compatibility page shows one cell per language and stage; a missing toolchain is unavailable at every stage, never red, and a setup nothing has run is unknown.
 * A run is { id, language, at, stages: { [stage]: outcome } }; it reached a stage when that stage is a key of stages, and the latest run has the greatest at (the later one in the list on a tie).
 *
 * @param {{ language: string, toolchains: string[] }[]} setups the conformanceSetups() rows
 * @param {{ id: string, language: string, at: string, stages: Record<string, string> }[]} runs the recorded runs
 * @param {(name: string) => boolean} which true when the named tool is on the path
 * @returns {{ language: string, stage: string, outcome: string, run: string | null }[]}
 */
export function conformanceResults(setups, runs, which) {
  const rows = [];
  for (const { language, toolchains } of setups) {
    const present = toolchains.every(name => which(name));
    for (const stage of CONFORMANCE_STAGES) {
      if (!present) { rows.push({ language, stage, outcome: 'unavailable', run: null }); continue; }
      let latest = null;
      for (const run of runs) {
        if (run.language !== language || !Object.hasOwn(run.stages ?? {}, stage)) continue;
        if (latest === null || run.at >= latest.at) latest = run;
      }
      rows.push(latest === null ? { language, stage, outcome: 'unknown', run: null } : { language, stage, outcome: latest.stages[stage], run: latest.id });
    }
  }
  return rows;
}
