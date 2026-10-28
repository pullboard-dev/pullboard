/** Structured native test outcomes retain identity without inferring passes from a green command [C7,H16]. */
import { relative } from 'node:path';
import { sep } from 'node:path';

const PREFIX = '# pullboard test outcomes ';
const ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;

/** Normalize bounded per-test facts; malformed or duplicate identities grant no quarantine evidence. */
export function testOutcomeFields(value) {
  if (!Array.isArray(value) || !value.length || value.length > 100000) return null;
  const keys = new Set(), rows = [];
  for (const row of value) {
    if (!row || Object.keys(row).sort().join(',') !== 'file,name,passed,skipped'
      || typeof row.file !== 'string' || !row.file || row.file.length > 4096
      || row.file.startsWith('/') || /^[A-Za-z]:/u.test(row.file) || /[\\\r\n\0]/u.test(row.file)
      || row.file.split('/').some(part => !part || part === '.' || part === '..')
      || typeof row.name !== 'string' || !row.name || row.name.length > 8192 || /[\r\n\0]/u.test(row.name)
      || typeof row.passed !== 'boolean' || typeof row.skipped !== 'boolean') return null;
    const key = JSON.stringify([row.file, row.name]);
    if (keys.has(key)) return null;
    keys.add(key);
    rows.push({ file: row.file, name: row.name, passed: row.passed, skipped: row.skipped });
  }
  return rows;
}

/** Observe the controller's actual Node events before public reporters can interpret their output. */
export function testOutcomeCollector(root) {
  const rows = [];
  let invalid = false;
  return {
    /** Preserve actual test identities; suites and cancelled work never become positive verdicts. */
    observe(event) {
      if (!['test:pass', 'test:fail'].includes(event.type) || event.data?.details?.type === 'suite') return;
      const { file, name, skip, todo, details } = event.data;
      if (!file || ['cancelledByParent', 'testAborted', 'subtestsFailed'].includes(details?.error?.failureType)) {
        invalid = true; return;
      }
      rows.push({ file: relative(root, file).split(sep).join('/'), name,
        passed: event.type === 'test:pass', skipped: skip !== undefined || todo !== undefined });
    },
    /** Publish only after all selected native file workers and their reporters have drained. */
    finish(complete, tests) {
      return complete && !invalid && tests === rows.length ? testOutcomeFields(rows) : null;
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

