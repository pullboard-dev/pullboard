/** Replay pull claims against a copy of a board's database to measure what one claim costs at that board's size [C7,#12097]. */
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { fileSystemAdapter } from '../../../fs/index.js';
import { boardJobQueueCall } from './gate.js';

const fs = fileSystemAdapter();

/** Free bytes of the volume holding `dir`. */
function defaultFreeBytes(dir) {
  const info = fs.statfs(dir);
  return info.bavail * info.bsize;
}

/** The value at a fraction of the sorted samples, the nearest rank. */
function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

/**
 * Run `count` pull claims through boardJobQueueCall on a copy of the board database, each inside a transaction that is
 * rolled back, and report how long they took. Why a copy: the claim path writes, and the live board must never be written by a measurement.
 *
 * The copy goes to a uniquely named file in os.tmpdir(), never beside the source, and only when the free space there is at
 * least twice the source's size; otherwise this throws before anything is written.
 *
 * @param {{ db: string, root: string, count?: number, freeBytes?: (dir: string) => number }} options - db: the board database file; root: the board's repository root; freeBytes: reads the free bytes of a directory (injected so a test needs no full disk).
 * @returns {{ p50: number, p95: number, max: number }} Milliseconds per claim.
 */
export function replayClaims({ db, root, count = 50, freeBytes = defaultFreeBytes }) {
  const scratch = tmpdir();
  const sourceSize = fs.stat(db).size;
  const free = freeBytes(scratch);
  if (free < sourceSize * 2) throw new Error(`claim replay needs ${sourceSize * 2} free bytes in ${scratch} and ${free} are free`);
  const copyFile = join(scratch, `pullboard-claim-replay-${process.pid}-${Date.now()}.db`);
  const source = new DatabaseSync(db, { readOnly: true });
  try { source.prepare('VACUUM INTO ?').run(copyFile); } finally { source.close(); }
  const copy = new DatabaseSync(copyFile);
  const board = { db: copy, gitRoot: root, root };
  const took = [];
  try {
    for (let index = 0; index < count; index++) {
      copy.exec('BEGIN IMMEDIATE');
      const started = performance.now();
      try {
        boardJobQueueCall(board, { action: 'claim', runner: `claim-replay-${index}`, capabilities: [] }, { mode: 'pull' });
      } finally {
        took.push(performance.now() - started);
        copy.exec('ROLLBACK');
      }
    }
  } finally {
    copy.close();
    fs.rm(copyFile, { force: true });
  }
  const sorted = took.toSorted((a, b) => a - b);
  return { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), max: sorted.at(-1) };
}

/** The one line the command prints: the three figures for a replay. */
export function replayLine({ p50, p95, max }, count) {
  return `claim replay: ${count} claims p50 ${p50.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms, max ${max.toFixed(2)} ms`;
}

/** Export the tree of a git ref into a new temp folder with git archive; returns the folder. */
function exportTree(root, ref) {
  const folder = execFileSync('mktemp', ['-d', join(tmpdir(), 'pullboard-claim-compare-XXXXXX')], { encoding: 'utf8' }).trim();
  const archive = execFileSync('git', ['-C', root, 'archive', '--format=tar', ref], { maxBuffer: 1024 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', folder], { input: archive });
  return folder;
}

/** Run replayClaims from the code tree at `codeRoot` in a child process, on the board at `db`/`root`. */
function replayAtTree({ codeRoot, db, root, count }) {
  const module = pathToFileURL(join(codeRoot, 'packages/api/src/io/claim-replay.js')).href;
  const script = `const m = await import(${JSON.stringify(module)}); process.stdout.write(JSON.stringify(m.replayClaims({ db: ${JSON.stringify(db)}, root: ${JSON.stringify(root)}, count: ${count} })));`;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: codeRoot, encoding: 'utf8', maxBuffer: 1024 * 1024 }));
}

/** worse when the candidate p95 is over max(1.25 x main p95, main p95 + 50 ms) or over 1 s; otherwise same. */
export function claimVerdict(candidate, main) {
  const limit = Math.max(main.p95 * 1.25, main.p95 + 50);
  return candidate.p95 > limit || candidate.p95 > 1000 ? 'worse' : 'same';
}

/**
 * Replay claims at the candidate's code (the tree at `root`) and at main's code (an exported tree of `main`) on copies of
 * the same board database, and judge the candidate against main [C7,#12385].
 *
 * @param {{ db: string, root: string, main?: string, count?: number, exportMain?: (root: string, ref: string) => string, replay?: Function }} options - root: the board's repository root; code: the candidate's code tree (default root); main: the git ref of main (default "main"); exportMain and replay are seams for tests.
 * @returns {{ candidate: object, main: object, verdict: 'worse' | 'same' }} Each side is { p50, p95, max } in milliseconds.
 */
export function compareClaimsWithMain({ db, root, code = root, main = 'main', count = 50, exportMain = exportTree, replay = replayAtTree }) {
  const mainRoot = exportMain(code, main);
  const owned = mainRoot !== code;
  try {
    const mainFigures = replay({ codeRoot: mainRoot, db, root, count });
    const candidate = replay({ codeRoot: code, db, root, count });
    return { candidate, main: mainFigures, verdict: claimVerdict(candidate, mainFigures) };
  } finally {
    if (owned) fs.rm(mainRoot, { recursive: true, force: true });
  }
}
