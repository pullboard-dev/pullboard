/** Structured native test outcomes retain identity without inferring passes from a green command [C7,H16]. */
import { relative } from 'node:path';
import { resolve } from 'node:path';
import { sep } from 'node:path';

const PREFIX = '# pullboard test outcomes ';
const ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;

import { testOutcomeFields } from '../../../verify/core.js';
export { testOutcomeFields } from '../../../verify/core.js';

/** A repository-relative, slash-separated path. */
function portable(root, file) {
  return relative(root, file).split(sep).join('/');
}

/** Observe the controller's actual Node events before public reporters can interpret their output. */
export function testOutcomeCollector(root) {
  const rows = [];
  const owners = [];
  let invalid = false;
  return {
    /**
     * Preserve actual test identities; suites and cancelled work never become positive verdicts. `testFile` is the
     * test file the dispatcher ran this event's worker for, when it knows one.
     */
    observe(event, testFile = null) {
      if (!['test:pass', 'test:fail'].includes(event.type) || event.data?.details?.type === 'suite') return;
      const { file, name, skip, todo, details } = event.data;
      if (!file || ['cancelledByParent', 'testAborted', 'subtestsFailed'].includes(details?.error?.failureType)) {
        invalid = true; return;
      }
      rows.push({ file: portable(root, file), name,
        passed: event.type === 'test:pass', skipped: skip !== undefined || todo !== undefined });
      owners.push(testFile ? portable(root, resolve(root, testFile)) : null);
    },
    /**
     * Publish only after all selected native file workers and their reporters have drained. A case defined once in a
     * shared fixture module and run by two test files reaches Node under the fixture's path both times; those rows
     * take the test file that ran each, so the run keeps every case instead of failing closed on the duplicate. Why:
     * #3253's two check files load one fixture, and its receipts kept no case outcome at all [C7,V4].
     */
    finish(complete, tests) {
      if (!complete || invalid || tests !== rows.length) return null;
      const key = row => JSON.stringify([row.file, row.name]);
      const seen = new Map();
      for (const row of rows) seen.set(key(row), (seen.get(key(row)) ?? 0) + 1);
      return testOutcomeFields(rows.map((row, index) => (seen.get(key(row)) > 1 && owners[index] ? { ...row, file: owners[index] } : row)));
    },
  };
}

/** Bind one complete native result frame to the owning controller's existing run timing identity. */
export function formatTestOutcomes(id, value) {
  const tests = testOutcomeFields(value);
  if (!ID.test(id ?? '') || !tests) return '';
  return tests.map(row => PREFIX + JSON.stringify({ version: 1, id, tests: [row] }) + '\n').join('');
}

/** Read only matching controller frames; duplicate test identities or malformed frames fail closed. */
export function readTestOutcomes(output, id) {
  if (!ID.test(id ?? '')) return null;
  const rows = [];
  let found = false;
  for (const line of typeof output === 'string' ? output.split('\n') : output) {
    if (!line.startsWith(PREFIX)) continue;
    let frame;
    try { frame = JSON.parse(line.slice(PREFIX.length)); } catch { return null; }
    if (frame?.id !== id) continue;
    if (frame.version !== 1 || Object.keys(frame).sort().join(',') !== 'id,tests,version') return null;
    const tests = testOutcomeFields(frame.tests);
    if (!tests) return null;
    found = true;
    rows.push(...tests);
  }
  return found ? testOutcomeFields(rows) : null;
}

/** Bind every observed source path to one immutable regular-file inventory, without one Git child per test. */
export function committedTestOutcomes(root, head, value, readTree) {
  const rows = testOutcomeFields(value);
  if (!head || !rows) return null;
  const files = [...new Set(rows.map(row => row.file))];
  const listed = readTree(root, ['ls-tree', '-rz', head, '--', ...files]);
  if (listed.status !== 0) return null;
  const regular = new Set(listed.stdout.split('\0').flatMap(line => {
    const match = /^100(?:644|755) blob [a-f0-9]+\t(.+\.[cm]?js)$/u.exec(line);
    return match ? [match[1]] : [];
  }));
  return files.every(file => regular.has(file)) ? rows : null;
}

/** Counter trailers are identified by their structured root-plan boundary, never by parsing test stdout/TAP. */
export function trailer(event, afterPlan) {
  return afterPlan && event.type === 'test:diagnostic' && event.data.nesting === 0
    && /^(?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) [0-9]/u.test(event.data.message);
}

/** Feed one event to named live listeners, while ordered reporter data is published separately. */
export function notify(stream, event) {
  stream.emit(event.type, event.data);
}

