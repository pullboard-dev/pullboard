/** @pullboard-test-input source-tree */
/**
 * The parity check for the in-process journey pilot (#8058): the same blueprint commands run once as real processes and
 * once through the in-process dispatch, and any difference in exit code, stdout or stderr fails the test [S1,I1,C7].
 */
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { PUBLISHED } from '../../tests/fixtures/blueprint.js';
import { emptyRepo } from '../../tests/fixtures/blueprint.js';
import { JOURNEY_MODES } from '../../tests/fixtures/blueprint.js';

/** The commands of the sample, each with the directory it runs in (relative to the repo). */
const SAMPLE = [
  { name: 'a refusal names the bundled blueprints', argv: ['init', '--blueprint', 'no-such-blueprint', '--json'] },
  { name: 'a URL is refused', argv: ['init', '--blueprint', 'https://example.invalid/web-app.json', '--json'] },
  { name: 'init with a blueprint, verbose', argv: ['init', '--blueprint', 'web-app', '--verbose'] },
  { name: 'starters, text', argv: ['blueprint', 'starters', 'web-app'] },
  { name: 'starters, json', argv: ['blueprint', 'starters', 'web-app', '--json'] },
  { name: 'a repeat add says it is already there', argv: ['blueprint', 'add', 'web-app'] },
  { name: 'a repeat add, json', argv: ['blueprint', 'add', 'web-app', '--json'] },
  { name: 'an unknown blueprint on a board', argv: ['blueprint', 'add', 'no-such-blueprint', '--json'] },
  { name: 'a local file blueprint', argv: ['blueprint', 'add', 'local.json', '--json'], prepare: (repo) => writeFileSync(join(repo, 'local.json'), JSON.stringify({ ...PUBLISHED, name: 'local', title: 'Local plan', kind: undefined })) },
  { name: 'a lane is added', argv: ['lane', 'add', 'app', '--owns', 'app/'] },
  { name: 'list, json', argv: ['list', '--json'] },
  { name: 'spec, json', argv: ['spec', '--json'] },
  { name: 'plain init in a nested repo is unchanged', argv: ['init'], fresh: true },
  { name: 'init from a subdirectory reads the file beside the caller', argv: ['init', '--blueprint', 'local.json', '--verbose'], fresh: true, cwd: 'plans',
    prepare: (repo) => { mkdirSync(join(repo, 'plans')); writeFileSync(join(repo, 'plans', 'local.json'), JSON.stringify({ ...PUBLISHED, name: 'local', title: 'Local plan' })); } },
];

/** Output with the machine-dependent parts named: the private directory, timestamps, and generated identifiers. */
function normalized(text, box) {
  const roots = [box.dir, realpathSync(box.dir)];
  let out = String(text);
  for (const root of roots) out = out.split(root).join('<dir>');
  return out.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/gu, '<time>').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu, '<uuid>');
}

/** Run the whole sample against fresh boards in one mode; one record per command. */
function runSample(mode) {
  const primary = emptyRepo({ mode });
  const records = [];
  for (const entry of SAMPLE) {
    const box = entry.fresh ? emptyRepo({ mode }) : primary;
    entry.prepare?.(box.repo);
    const result = box.runIn(entry.cwd ? join(box.repo, entry.cwd) : box.repo, ...entry.argv);
    records.push({ name: entry.name, code: result.status, stdout: normalized(result.stdout, box), stderr: normalized(result.stderr, box) });
  }
  return records;
}

test('parity: a sample of blueprint commands gives the same exit code, stdout and stderr in a real process and in-process [S1,I1,C7]', () => {
  const [real, inprocess] = JOURNEY_MODES.map(runSample);
  assert.equal(real.length, SAMPLE.length);
  const differences = [];
  for (const [index, entry] of real.entries()) {
    for (const field of ['code', 'stdout', 'stderr']) {
      if (entry[field] !== inprocess[index][field]) differences.push(`${entry.name}: ${field} differs\n  process:   ${JSON.stringify(entry[field]).slice(0, 300)}\n  inprocess: ${JSON.stringify(inprocess[index][field]).slice(0, 300)}`);
    }
  }
  assert.deepEqual(differences, [], `the two runtimes disagree:\n${differences.join('\n')}`);
});

test('parity: the check itself fails on any difference [S1,I1,C7]', () => {
  const box = emptyRepo({ mode: 'process' });
  assert.notEqual(normalized(`${box.dir}/x 2026-11-15T10:00:00Z`, box), normalized(`${box.dir}/y 2026-11-15T10:00:00Z`, box), 'a changed byte still shows');
  assert.equal(normalized(`${box.dir}/x 2026-11-15T10:00:00Z`, box), normalized(`${box.dir}/x 2026-11-16T11:00:01.5Z`, box), 'only the named machine parts are masked');
});
