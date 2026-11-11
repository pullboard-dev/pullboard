import { readdirSync } from 'node:fs';
import { readGateReceipt } from '../../../../../packages/gate/index.js';
import { receiptStore } from '../../../../../packages/gate/index.js';
import { testClosures } from '../../../../../packages/gate/index.js';
import { context } from '../entry.js';
import { gitExecFileSync } from '../../../../../packages/git/light.js';

/** Run a read-only Git query, returning null when history is unavailable. */
function git(root, ...args) {
  try { return gitExecFileSync(args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).trimEnd(); }
  catch { return null; }
}

/** Explain recorded observations on first-parent history without inventing unobserved outcomes [C7]. */
export function explainObservations(root, file, observations, closureReader = testClosures) {
  if (typeof file !== 'string' || !file || file.startsWith('/') || /[\0\r\n\\]/u.test(file) || file.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('supply a repository-relative test file');
  const history = git(root, 'rev-list', '--first-parent', 'main');
  if (history === null) return { file, unavailable: 'main history unavailable' };
  const commits = history.split('\n');
  const byCommit = new Map();
  for (const row of observations) {
    if (!commits.includes(row.commit) || !['red', 'green'].includes(row.result)) continue;
    const previous = byCommit.get(row.commit);
    if (previous && previous.result !== row.result) byCommit.set(row.commit, { result: 'ambiguous' });
    else if (!previous || (!previous.stable && row.stable)) byCommit.set(row.commit, row);
  }
  const redIndex = commits.findIndex(commit => byCommit.get(commit)?.result === 'red');
  if (redIndex < 0) return { file, unavailable: 'no recorded red on main history' };
  const greenIndex = commits.findIndex((commit, index) => index > redIndex && byCommit.get(commit)?.result === 'green');
  const green = greenIndex < 0 ? null : commits[greenIndex];
  const firstRedIndex = greenIndex < 0 ? redIndex : commits.slice(redIndex, greenIndex).findLastIndex(commit => byCommit.get(commit)?.result === 'red') + redIndex;
  const red = commits[firstRedIndex];
  const redEvidence = byCommit.get(red);
  const stable = redEvidence.stable ?? null;
  const frame = stable && / @ (.+)#([^#]+)$/u.exec(stable);
  let closure = null, closureReason = null;
  try { const found = closureReader(root, red).closures.get(file); closure = found?.files ?? null; closureReason = found?.reason || (!found ? 'test is absent from the import graph' : null); }
  catch (error) { closureReason = `import graph unavailable: ${error.message}`; }
  const suspects = [];
  if (green && closure) for (const commit of commits.slice(firstRedIndex, greenIndex).reverse()) {
    const names = git(root, 'diff-tree', '--no-commit-id', '--name-only', '-r', '--first-parent', commit);
    if (names === null) return { file, red, green, stable, frame: frame?.[1] ?? null, unavailable: 'commit diff unavailable' };
    if (!names.split('\n').some(path => closure.includes(path))) continue;
    const subject = git(root, 'show', '-s', '--format=%s', commit) ?? '';
    const item = /(?:^|\s)#(\d+)\b/u.exec(subject)?.[1] ?? null;
    const diff = frame && closure.includes(frame[1]) ? git(root, 'show', '--format=', '--no-ext-diff', commit, '--', frame[1]) : null;
    suspects.push({ commit, item, diff: diff || null });
  }
  return { file, green, red, stable, frame: frame?.[1] ?? null, function: frame?.[2] ?? null,
    closureKnown: Boolean(closure), closureReason, suspects: green && closure ? suspects : null };
}

/** Read only validated gate receipts that prove this file's outcome at a committed source [C7]. */
function observations(root, file) {
  const store = receiptStore(root);
  if (!store) return [];
  let names;
  try { names = readdirSync(store); } catch { return []; }
  return names.filter(name => /^[a-f0-9-]{36}\.json$/u.test(name)).flatMap(name => {
    const receipt = readGateReceipt(store, name.slice(0, -5));
    if (!receipt || receipt.proof && receipt.proof.sourceClean !== true) return [];
    const cases = receipt.testOutcomes?.filter(row => row.file === file) ?? [];
    const failures = receipt.failures.filter(row => row.file === file);
    if (failures.length) {
      const stable = receipt.failureSignatures?.failures.find(row => row.file === file && row.stable)?.stable ?? null;
      return [{ commit: receipt.head, result: 'red', stable }];
    }
    if (cases.length && cases.every(row => row.passed && !row.skipped)) return [{ commit: receipt.head, result: 'green' }];
    return [];
  });
}

/** Report recorded red history and the source commits that touch the test closure. */
export async function run(io, { first, second }) {
  if (first !== 'explain' || !second) { io.err('usage: pullboard red explain <repository-relative-test-file>'); return 1; }
  const root = context(io).info.root;
  let result;
  try { result = explainObservations(root, second, observations(root, second)); }
  catch (error) { io.err(error.message); return 1; }
  io.result?.(result);
  io.say(`File: ${result.file}`);
  io.say(`Last green: ${result.green ?? 'unknown'}`);
  io.say(`First observed red: ${result.red ?? 'unknown'}`);
  io.say(`Deepest repository frame: ${result.frame ? `${result.frame}#${result.function}` : 'unknown'}`);
  io.say(`Signature: ${result.stable ?? 'unknown'}`);
  io.say(`Cluster: ${result.stable ?? 'unknown'}`);
  if (result.unavailable) io.say(`History: ${result.unavailable}`);
  if (result.suspects === null || result.suspects === undefined) io.say(`Suspects: unknown (${result.closureReason ?? 'missing green or test closure'})`);
  else if (!result.suspects.length) io.say('Suspects: none in the observed interval touch the known test closure');
  else for (const suspect of result.suspects) {
    io.say(`Suspect: ${suspect.commit}${suspect.item ? ` #${suspect.item}` : ''}`);
    if (suspect.diff) io.say(suspect.diff);
  }
  return 0;
}
