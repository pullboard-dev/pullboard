/**
 * Import CI results into the flake ledger (#918). A CI job that fails and passes on its rerun at the same commit is
 * the same evidence #887 records for local gates: one red original and one green pair. The importer reads local
 * per-attempt manifests (ci-result.json beside its TAP file), so it needs no network and no CI credentials.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { statSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { posix } from 'node:path';
import { tryGit } from '../../../git/index.js';
import { Refused } from '../../../kernel/index.js';

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const MANIFEST = 'ci-result.json';

/** The SHA-256 of a text, as hex. */
function digest(text) {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Read and check one attempt's manifest: which run, attempt and job it was, where it ran, at which commit, and the
 * TAP file beside it. Anything malformed is refused by its file, never guessed.
 */
function readAttempt(file) {
  let value;
  try { value = JSON.parse(readFileSync(file, 'utf8')); } catch { value = null; }
  const text = (entry, limit) => typeof entry === 'string' && entry.length > 0 && entry.length <= limit && !/[\r\n\0]/u.test(entry);
  if (!value || value.provider !== 'github' || !/^\d{1,20}$/u.test(String(value.run ?? '')) || !Number.isSafeInteger(value.attempt)
      || value.attempt < 1 || !text(value.job, 200) || !text(value.runner, 200) || !/^v\d+\.\d+\.\d+$/u.test(value.node ?? '')
      || !SHA.test(value.commit ?? '') || !text(value.root, 4096) || !posix.isAbsolute(value.root)
      || !['success', 'failure'].includes(value.conclusion) || !Number.isFinite(Date.parse(value.at))
      || !text(value.tap, 200) || basename(value.tap) !== value.tap) {
    throw new Refused('CI_RESULT', `${file} is not a CI result: it needs provider github, run, attempt, job, runner, node, commit, root, conclusion, at and the tap file beside it`);
  }
  const tap = join(dirname(file), value.tap);
  return { ...value, run: String(value.run), tapFile: tap, output: readFileSync(tap, 'utf8') };
}

/**
 * The top-level test results a CI TAP report names, with each test's file relative to the CI checkout. A result
 * without a location inside that checkout keeps file null. Skipped rows stay visible for ambiguity checks.
 */
function ciTests(output, root) {
  const rows = [];
  let active = null;
  for (const raw of output.split('\n')) {
    const match = /^(not ok|ok)\s+\d+\s+-\s+(.*)$/u.exec(raw);
    if (match) {
      const directive = /\s+#\s*(?:SKIP|TODO)\b/iu.exec(match[2]);
      active = { name: directive ? match[2].slice(0, directive.index).trimEnd() : match[2], passed: match[1] === 'ok', file: null, skip: directive !== null };
      rows.push(active);
      continue;
    }
    if (/^\S/u.test(raw)) active = null;
    const location = active && /^ {2}location:\s*['"]?(.*?)['"]?\s*$/u.exec(raw);
    if (!location) continue;
    const file = posix.relative(root, location[1].replace(/:\d+(?::\d+)?$/u, ''));
    if (file && !file.startsWith('../') && !posix.isAbsolute(file)) active.file = file;
  }
  return rows;
}

/**
 * Match a rerun to one actual failed test. Its original file and title must identify one occurrence. A located row
 * identifies its own file first. A locationless row can stand for a test only when its title occurs once in each
 * report; a skip or another same-title file proves no pass.
 */
function rerunTest(target, before, after) {
  if (target.file === null || before.filter(row => row.name === target.name && row.file === target.file).length !== 1) return undefined;
  const exact = after.filter(row => row.name === target.name && row.file === target.file);
  if (exact.length) return exact.length === 1 && !exact[0].skip ? exact[0] : undefined;
  const sameTitle = after.filter(row => row.name === target.name);
  if (sameTitle.length !== 1 || sameTitle[0].file !== null || sameTitle[0].skip
      || before.filter(row => row.name === target.name).length !== 1) return undefined;
  return sameTitle[0];
}

/**
 * Keep one attempt's TAP under the board's flake evidence, by digest, and describe it as a receipt. Kept evidence is
 * never replaced: a re-import whose report differs is refused before anything is written (#918 review).
 */
function keepReceipt(evidence, id, label, attempt) {
  const folder = join(evidence, id);
  const file = join(folder, label + '.log');
  if (existsSync(file)) {
    if (digest(readFileSync(file, 'utf8')) !== digest(attempt.output)) {
      throw new Refused('FLAKE_OBSERVATION_CHANGED', `the kept ${label} report for ${id} differs from this CI result; the original evidence stays as recorded`);
    }
  } else {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    writeFileSync(file, attempt.output, { flag: 'wx', mode: 0o600 });
  }
  return { green: attempt.conclusion === 'success', sha256: digest(attempt.output), bytes: statSync(file).size,
    artifact: `flake-evidence/${id}/${label}.log`, profileSha256: null };
}

/**
 * The flake observations a folder of CI results holds. Each failed attempt is paired with the next attempt of the
 * same run and job at the same commit. A failing test that passes there is a flake, one that fails again is
 * stable-red, and a failure the TAP does not name by file stays unclassified. The original red is always kept.
 *
 * @param {string} root this checkout, which must hold each commit so its tree can be pinned
 * @param {string} folder the downloaded CI results
 * @returns {object[]} observations for recordFlakeObservation
 */
export function ciObservations(root, folder) {
  const files = readdirSync(folder, { recursive: true }).map(String).filter(path => basename(path) === MANIFEST).sort();
  if (!files.length) throw new Refused('CI_RESULT', `${folder} holds no ${MANIFEST}; save each CI attempt's manifest beside its TAP file`);
  const jobs = new Map();
  for (const attempt of files.map(path => readAttempt(join(folder, path)))) {
    const key = `${attempt.run}\0${attempt.job}`;
    if (!jobs.has(key)) jobs.set(key, []);
    jobs.get(key).push(attempt);
  }
  const common = tryGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (common.status !== 0) throw new Refused('NOT_A_REPO', 'run pullboard flakes import inside the board repository');
  const evidence = join(common.stdout.trim(), 'pullboard', 'flake-evidence');
  const observations = [];
  for (const attempts of jobs.values()) {
    attempts.sort((left, right) => left.attempt - right.attempt);
    for (const [index, red] of attempts.entries()) {
      if (red.conclusion !== 'failure') continue;
      const rerun = attempts.slice(index + 1).find(next => next.commit === red.commit);
      if (!rerun) continue;
      const tree = tryGit(root, ['rev-parse', '--verify', '--quiet', `${red.commit}^{tree}`]);
      if (tree.status !== 0) throw new Refused('CI_COMMIT_UNKNOWN', `this checkout lacks CI commit ${red.commit}, so its tree cannot be pinned`, `git fetch origin ${red.commit}, then run pullboard flakes import again`);
      const after = ciTests(rerun.output, rerun.root);
      const before = ciTests(red.output, red.root);
      const failed = before.filter(row => !row.passed && !row.skip);
      const named = failed.filter(row => row.file !== null);
      const targets = named.length ? named : [{ file: null, name: null }];
      for (const target of targets) {
        const id = `ci-${red.run}-${red.attempt}-${digest(JSON.stringify([red.job, target.file, target.name])).slice(0, 16)}`;
        const again = rerunTest(target, before, after);
        // A flake needs a green pair: a rerun that passed this test but failed elsewhere proves nothing either way.
        const classification = again === undefined ? 'unclassified' : !again.passed ? 'stable-red' : rerun.conclusion === 'success' ? 'flake' : 'unclassified';
        const reason = classification === 'flake' ? `GitHub run ${red.run} failed this test in attempt ${red.attempt} and passed it in attempt ${rerun.attempt} at the same commit; original red retained.`
          : classification === 'stable-red' ? `GitHub run ${red.run} failed this test again in attempt ${rerun.attempt} at the same commit; original red retained.`
            : target.file === null ? `GitHub run ${red.run} attempt ${red.attempt} failed with no test named by file in its TAP; it remains unclassified.`
              : again === undefined ? `GitHub run ${red.run} attempt ${rerun.attempt} did not unambiguously identify this test; it remains unclassified.`
                : `GitHub run ${red.run} attempt ${rerun.attempt} passed this test but failed elsewhere; it remains unclassified.`;
        observations.push({
          id, file: target.file, name: target.name, head: red.commit, tree: tree.stdout.trim(), main: red.commit, kind: 'ci', classification,
          commandSha256: digest(`ci:github:${red.job}`), reason, at: new Date(red.at).toISOString(), diagnosticMs: 0, load: null,
          ci: { provider: 'github', run: red.run, attempt: red.attempt, rerunAttempt: rerun.attempt, job: red.job, runner: red.runner, node: red.node },
          original: keepReceipt(evidence, id, 'original', red), paired: keepReceipt(evidence, id, 'paired', rerun), mainReceipt: null,
        });
      }
    }
  }
  return observations;
}
