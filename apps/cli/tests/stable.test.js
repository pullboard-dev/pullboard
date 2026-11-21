/** @pullboard-test-input apps/cli/tests/** apps/cli/journeys/** */
/** Every cli-app test, in its tests and journeys folders, carries a stable ID in its own title and one complete record, never derived from its path [C7,U148,#10476,#10541]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../packages/gate/tests/fixtures/child.js';
import { registryStrictEnabled as registryStrict } from '../../../packages/config/index.js';

/** An ID is dotted (cli.area.slug); other `word:` titles in this wide cell are not IDs. */
const TITLE_ID = /^test\('([a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+): /gmu;
const TESTS = /^test\(/gmu;

/** Inlined from the verify cell's registryFindings: a cell test may not import another cell's front door; a later item holds the shared check (rg4). */
function registryFindings(files, records) {
  const ids = [];
  const findings = [];
  const known = new Set(Object.keys(records));
  for (const { file, source } of files) {
    const found = [...source.matchAll(TITLE_ID)].map((match) => match[1]);
    const missing = [...source.matchAll(TESTS)].length - found.length;
    if (missing > 0) findings.push(`${file}: ${missing} test title(s) start without an ID and a colon`);
    for (const id of found) {
      ids.push(id);
      if (!known.has(id)) findings.push(`${file}: test ${id} has no registry record`);
    }
  }
  const written = new Set(ids);
  for (const id of known) if (!written.has(id)) findings.push(`registry.json: record ${id} names no test`);
  return { ids, findings };
}

/** Findings fail only in strict mode (tests.registryStrict on) and only when there is one. */
function registryOutcome(findings, strict) {
  return { fails: strict && findings.length > 0, report: findings.length === 0 ? '' : `${findings.length} unregistered: ${findings.join('; ')}` };
}

const DIR = import.meta.dirname;
const KINDS = ['cell unit', 'contract', 'journey', 'harness'];
const ID = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$/u;

/** Every test file under one of this app's folders (tests, journeys), nested folders included. */
function testFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? testFiles(join(dir, entry.name)) : entry.name.endsWith('.test.js') ? [join(dir, entry.name)] : []));
}

/** Every registry file under `journeys`, nested folders included: a registry-<id>.json a lane keeps beside its own journeys. */
function journeyRegistryFiles(journeys) {
  return readdirSync(journeys, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? journeyRegistryFiles(join(journeys, entry.name)) : /^registry-[0-9a-z]+\.json$/u.test(entry.name) ? [join(journeys, entry.name)] : []));
}

/** The records of the fixtures folder's registry*.json plus every journey-local registry-<id>.json, and each ID written in more than one file. */
function loadRecords(fixtures, journeys) {
  const files = [...readdirSync(fixtures).filter((name) => /^registry(?:-\d+[a-z]?)?\.json$/u.test(name)).sort().map((name) => join(fixtures, name)), ...journeyRegistryFiles(journeys).sort()];
  const records = {};
  const duplicates = [];
  for (const file of files) {
    for (const [id, record] of Object.entries(JSON.parse(readFileSync(file, 'utf8')))) {
      if (id in records) duplicates.push(id);
      records[id] = record;
    }
  }
  return { records, duplicates };
}

test('cli.stable.complete: clause 1: [C7,U148] every registered test has a stable ID and one complete record; an unregistered test is reported and fails only with tests.registryStrict on', (t) => {
  // Each slice keeps its records in its own registry*.json so parallel slices never conflict.
  // A lane that may not edit the fixtures folder keeps its records in a registry-<id>.json beside its journeys; those count the same.
  const { records, duplicates } = loadRecords(join(DIR, 'fixtures'), join(DIR, '..', 'journeys'));
  assert.deepEqual(duplicates, [], 'no ID is recorded in two registry files');
  const files = [...testFiles(DIR), ...testFiles(join(DIR, '..', 'journeys'))].sort().map((file) => ({ file, source: readFileSync(file, 'utf8') }));
  const { ids, findings } = registryFindings(files, records);
  assert.deepEqual([...new Set(ids)].sort(), ids.slice().sort(), 'no ID is used by two tests');
  // A file that already carries an ID title is covered: it may not leave one test without an ID or record, strict mode or not.
  const covered = files.filter(({ source }) => /^test\('[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+: /mu.test(source));
  const uncoveredInCovered = findings.filter((finding) => covered.some(({ file }) => finding.startsWith(`${file}:`)));
  assert.deepEqual(uncoveredInCovered, [], 'a covered file leaves a test without an ID or record');
  const outcome = registryOutcome(findings, registryStrict());
  if (outcome.report) t.diagnostic(outcome.report);
  assert.equal(outcome.fails, false, outcome.report);
  for (const [id, record] of Object.entries(records)) {
    assert.match(id, ID, `${id}: a dotted lowercase ID`);
    assert.ok(Array.isArray(record.proves?.specs) && record.proves.specs.length > 0, `${id}: proves names spec ids`);
    assert.ok(typeof record.proves.claim === 'string' && record.proves.claim.length > 0, `${id}: proves has one sentence`);
    assert.ok(typeof record.why === 'string' && record.why.length > 0, `${id}: has a why`);
    assert.ok(KINDS.includes(record.kind), `${id}: kind is one of ${KINDS.join(', ')}`);
    assert.ok(Array.isArray(record.inputs) && record.inputs.length > 0, `${id}: declares its inputs`);
  }
});

/** A throwaway fixtures folder and journeys folder, each holding the given registry files. */
function withRegistries({ fixtures, journeys }, check) {
  const root = privateFixtureFiles('cli-stable-registries-').root;
  mkdirSync(join(root, 'fixtures'));
  mkdirSync(join(root, 'journeys', 'shout'), { recursive: true });
  for (const [name, records] of Object.entries(fixtures)) writeFileSync(join(root, 'fixtures', name), JSON.stringify(records));
  for (const [name, records] of Object.entries(journeys)) writeFileSync(join(root, 'journeys', name), JSON.stringify(records));
  check(loadRecords(join(root, 'fixtures'), join(root, 'journeys')));
}

test('cli.stable.journey-local-registries: clause 1: [C7,U148] records in a registry-<id>.json beside journeys count toward cli.stable.complete the same as records in the fixtures folder registry*.json', () => {
  withRegistries({ fixtures: { 'registry-1.json': { 'cli.a.one': {} } }, journeys: { 'shout/registry-2.json': { 'cli.a.two': {} } } }, ({ records, duplicates }) => {
    assert.deepEqual(Object.keys(records).sort(), ['cli.a.one', 'cli.a.two']);
    assert.deepEqual(duplicates, []);
  });
});

test('cli.stable.journey-local-duplicate-id: clause 2: [C7,U148] a test id recorded both beside a journey and in the fixtures folder is still refused as a duplicate', () => {
  withRegistries({ fixtures: { 'registry-1.json': { 'cli.a.one': {} } }, journeys: { 'shout/registry-2.json': { 'cli.a.one': {} } } }, ({ duplicates }) => {
    assert.deepEqual(duplicates, ['cli.a.one']);
  });
});

test('cli.stable.journeys-registered: clause 2: [C7,U148] every test under the journeys add, agents, baseline, blueprint, cells, claim, companion and decisions folders has a registered cli.<area>.<slug> title ID', () => {
  // The claim policy chaos case keeps its record in the registry of the item that added it (#5705).
  const records = Object.assign({}, ...['registry-10541.json', 'registry-5705.json'].map(name => JSON.parse(readFileSync(join(DIR, 'fixtures', name), 'utf8'))));
  const journeys = join(DIR, '..', 'journeys');
  // #12243 moved decisions/project and agents/takeover-model under tests/io/commands; #12246 moved companion/review there too.
  const moved = ['agents/takeover-model.test.js', 'companion/review.test.js', 'decisions/project.test.js'].map((name) => join(DIR, 'io', 'commands', name));
  for (const area of ['add', 'agents', 'baseline', 'blueprint', 'cells', 'claim', 'companion', 'decisions']) {
    const files = existsSync(join(journeys, area)) ? testFiles(join(journeys, area)) : [];
    for (const file of [...files, ...moved.filter((path) => path.includes(`/commands/${area}/`))]) {
      const source = readFileSync(file, 'utf8');
      const ids = [...source.matchAll(TITLE_ID)].map((match) => match[1]);
      assert.equal(ids.length, [...source.matchAll(TESTS)].length, `${file}: every test title starts with an ID`);
      for (const id of ids) assert.ok(records[id], `${file}: ${id} has a record in registry-10541.json or registry-5705.json`);
    }
  }
});

test('cli.stable.journeys-registered-10552: clause 2: [C7,U148] every test under the journeys show, view, watch and worktree folders has a registered cli.<area>.<slug> title ID', () => {
  const records = JSON.parse(readFileSync(join(DIR, 'fixtures', 'registry-10552.json'), 'utf8'));
  const journeys = join(DIR, '..', 'journeys');
  for (const area of ['show', 'view', 'watch', 'worktree']) {
    for (const file of testFiles(join(journeys, area))) {
      const source = readFileSync(file, 'utf8');
      const ids = [...source.matchAll(TITLE_ID)].map((match) => match[1]);
      assert.equal(ids.length, [...source.matchAll(TESTS)].length, `${file}: every test title starts with an ID`);
      for (const id of ids) assert.ok(records[id], `${file}: ${id} has a record in registry-10552.json`);
    }
  }
});

test('cli.stable.journeys-registered-10549: clause 1: [C7,U148] every core-owned test under the journeys release, resources, resume, sync and upgrade folders has a registered cli.<area>.<slug> title ID', () => {
  // A test later split out of this slice keeps its record in the registry of the item that moved it or added it (#10694, #10970, #12005).
  const records = Object.assign({}, ...['registry-10549.json', 'registry-10694.json', 'registry-10695.json', 'registry-10970.json', 'registry-10933.json', 'registry-12005.json'].map((name) => JSON.parse(readFileSync(join(DIR, 'fixtures', name), 'utf8'))));
  const journeys = join(DIR, '..', 'journeys');
  // View-lane files are the view lane's own slice; core may not edit them.
  const viewOwned = new Set([]);
  for (const area of ['release', 'resources', 'resume', 'sync', 'upgrade']) {
    for (const file of testFiles(join(journeys, area))) {
      if (viewOwned.has(file.slice(journeys.length + 1))) continue;
      const source = readFileSync(file, 'utf8');
      const ids = [...source.matchAll(TITLE_ID)].map((match) => match[1]);
      assert.equal(ids.length, [...source.matchAll(TESTS)].length, `${file}: every test title starts with an ID`);
      for (const id of ids) assert.ok(records[id], `${file}: ${id} has a record in registry-10549.json, registry-10694.json, registry-10695.json, registry-10933.json, registry-10970.json or registry-12005.json`);
    }
  }
});

test('cli.stable.journeys-registered-10546: clause 1: [C7,U148] every core-owned test under the journeys init, land, lanes, languages, list, log and mcp folders has a registered cli.<area>.<slug> title ID', () => {
  // Records live in every slice's own registry*.json, as cli.stable.complete reads them; never one slice's file alone.
  const records = Object.assign({}, ...readdirSync(join(DIR, 'fixtures')).filter((name) => /^registry(?:-\d+)?\.json$/u.test(name)).sort().map((name) => JSON.parse(readFileSync(join(DIR, 'fixtures', name), 'utf8'))));
  const journeys = join(DIR, '..', 'journeys');
  // View-lane files are the view lane's own slice; core may not edit them. Excluded: init/perf.test.js, init/perf/tab-speed-rows-ceiling.test.js.
  const viewOwned = new Set(['init/perf.test.js', 'init/perf/tab-speed-rows-ceiling.test.js', 'init/perf/tab-speed-spec.test.js']);
  for (const area of ['init', 'land', 'lanes', 'languages', 'list', 'log', 'mcp']) {
    for (const file of testFiles(join(journeys, area))) {
      if (viewOwned.has(file.slice(journeys.length + 1))) continue;
      const source = readFileSync(file, 'utf8');
      const ids = [...source.matchAll(TITLE_ID)].map((match) => match[1]);
      assert.equal(ids.length, [...source.matchAll(TESTS)].length, `${file}: every test title starts with an ID`);
      for (const id of ids) assert.ok(records[id], `${file}: ${id} has a record in a registry*.json`);
    }
  }
});

test('cli.stable.journeys-registered-10547: clause 1: [C7,U148] every core-owned test under the journeys merged, milestone, move, next, publish and queue folders has a registered cli.<area>.<slug> title ID', () => {
  // The next-folder cases added by #10851 #8945's derived-state journey and #11026's herd journey keep their records in those items' registries.
  const records = Object.assign({}, ...['registry-10547.json', 'registry-10851.json', 'registry-8945.json', 'registry-11026.json'].map(name => JSON.parse(readFileSync(join(DIR, 'fixtures', name), 'utf8'))));
  const journeys = join(DIR, '..', 'journeys');
  // View-lane files are the view lane's own slice; core may not edit them. Excluded: milestone/auth.test.js.
  const viewOwned = new Set(['milestone/auth.test.js']);
  for (const area of ['merged', 'milestone', 'move', 'next', 'publish', 'queue']) {
    for (const file of testFiles(join(journeys, area))) {
      if (viewOwned.has(file.slice(journeys.length + 1))) continue;
      const source = readFileSync(file, 'utf8');
      const ids = [...source.matchAll(TITLE_ID)].map((match) => match[1]);
      assert.equal(ids.length, [...source.matchAll(TESTS)].length, `${file}: every test title starts with an ID`);
      for (const id of ids) assert.ok(records[id], `${file}: ${id} has a record in registry-10547.json, registry-10851.json, registry-8945.json or registry-11026.json`);
    }
  }
});

/** The problems the journeys-registered-10550 check finds: a test under the runner, shout, stats or status folders without a title ID or a record. */
function runnerShoutStatsStatusFindings(records, journeys) {
  // View-lane files are the view lane's own slice; core may not edit them. Their records sit here already, so a view-owned file is skipped only while its titles have no IDs yet (items #10595, #10596 rename them).
  const viewOwned = new Set(['shout/fixture.test.js', 'shout/shouts.test.js', ...['api', 'connections', 'foreground', 'presentation', 'setup', 'transport', 'undeclared'].map((name) => `shout/journeys/fixture-${name}.test.js`)]);
  const findings = [];
  for (const area of ['runner', 'shout', 'stats', 'status']) {
    let files = [];
    try { files = testFiles(join(journeys, area)); } catch { /* an area folder absent from a throwaway tree has no tests */ }
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      if (viewOwned.has(file.slice(journeys.length + 1)) && ![...source.matchAll(TITLE_ID)].length) continue;
      const ids = [...source.matchAll(TITLE_ID)].map((match) => match[1]);
      if (ids.length !== [...source.matchAll(TESTS)].length) findings.push(`${file}: every test title starts with an ID`);
      for (const id of ids) if (!records[id]) findings.push(`${file}: ${id} has a record in a registry file`);
    }
  }
  return findings;
}

test('cli.stable.journeys-registered-10550: clause 1: [C7,U148] every core-owned test under the journeys runner, shout, stats and status folders has a registered cli.<area>.<slug> title ID', () => {
  // The same loader cli.stable.complete uses: every slice's fixtures registry*.json plus a registry-<id>.json kept beside a journey.
  const journeys = join(DIR, '..', 'journeys');
  const { records } = loadRecords(join(DIR, 'fixtures'), journeys);
  assert.deepEqual(runnerShoutStatsStatusFindings(records, journeys), []);
});

test('cli.stable.journeys-registered-local-records: clause 2: [C7,U148] a shout journey recorded only in a registry file under the journeys folder passes the journeys-registered-10550 check, and the same journey with no record in either place fails it', () => {
  const root = privateFixtureFiles('cli-stable-local-records-').root;
  mkdirSync(join(root, 'fixtures'));
  mkdirSync(join(root, 'journeys', 'shout'), { recursive: true });
  const id = 'cli.shout-local.records-beside-the-journey';
  writeFileSync(join(root, 'journeys', 'shout', 'local.test.js'), `test('${id}: clause 1: a journey', () => {});\n`);
  const journeys = join(root, 'journeys');
  assert.notDeepEqual(runnerShoutStatsStatusFindings(loadRecords(join(root, 'fixtures'), journeys).records, journeys), [], 'no record anywhere fails');
  writeFileSync(join(journeys, 'shout', 'registry-1.json'), JSON.stringify({ [id]: {} }));
  assert.deepEqual(runnerShoutStatsStatusFindings(loadRecords(join(root, 'fixtures'), journeys).records, journeys), [], 'a record beside the journey passes');
});

test('cli.stable.journeys-registered-10551: clause 1: [C7,U148] every core-owned test under the journeys spec, speed, test and version folders has a registered cli.<area>.<slug> title ID', () => {
  // This slice's records plus any other slice's, so a test another item registered is not claimed twice.
  const records = Object.assign({}, ...readdirSync(join(DIR, 'fixtures')).filter((name) => /^registry(?:-\d+[a-z]?)?\.json$/u.test(name)).sort().map((name) => JSON.parse(readFileSync(join(DIR, 'fixtures', name), 'utf8'))));
  const journeys = join(DIR, '..', 'journeys');
  // View-lane files are the view lane's own slice; core may not edit them. Their records sit here already, so a view-owned file is skipped only while its titles have no IDs yet (items #10595, #10596 rename them).
  const viewOwned = new Set(['spec/revision.test.js', ...['boards', 'decisions', 'list', 'pointer', 'rows', 'script', 'shared', 'tab-speed-stage-timeout', 'tab-speed-trace'].map((name) => `spec/cockpit/${name}.test.js`)]);
  for (const area of ['spec', 'speed', 'test', 'version']) {
    for (const file of testFiles(join(journeys, area))) {
      const source = readFileSync(file, 'utf8');
      if (viewOwned.has(file.slice(journeys.length + 1)) && ![...source.matchAll(TITLE_ID)].length) continue;
      const ids = [...source.matchAll(TITLE_ID)].map((match) => match[1]);
      assert.equal(ids.length, [...source.matchAll(TESTS)].length, `${file}: every test title starts with an ID`);
      for (const id of ids) assert.ok(records[id], `${file}: ${id} has a record in a registry file`);
    }
  }
});

test('cli.stable.journeys-registered-10545: clause 1: [C7,U148] every core-owned test under the journeys fact, hooks, imports, inbox, intake and join folders has a registered cli.<area>.<slug> title ID', () => {
  // Journey cases register in their own slice's file (registry-10545.json, registry-10838.json, registry-8915.json) or in a registry-<id>.json beside the journeys, so every slice's records count.
  const records = loadRecords(join(DIR, 'fixtures'), join(DIR, '..', 'journeys')).records;
  const journeys = join(DIR, '..', 'journeys');
  // View-lane files are the view lane's own slice; core may not edit them. Excluded: inbox/sidebar.test.js.
  const viewOwned = new Set(['inbox/sidebar.test.js']);
  // #12246 moved the intake journeys under tests/io/commands/intake; they keep their records and are still checked here.
  const movedIntake = ['boundary', 'main', 'revision'].map((name) => join(DIR, 'io', 'commands', 'intake', `${name}.test.js`));
  for (const area of ['fact', 'hooks', 'imports', 'inbox', 'intake', 'join']) {
    const files = existsSync(join(journeys, area)) ? testFiles(join(journeys, area)) : [];
    for (const file of area === 'intake' ? [...files, ...movedIntake] : files) {
      if (viewOwned.has(file.slice(journeys.length + 1))) continue;
      const source = readFileSync(file, 'utf8');
      const ids = [...source.matchAll(TITLE_ID)].map((match) => match[1]);
      assert.equal(ids.length, [...source.matchAll(TESTS)].length, `${file}: every test title starts with an ID`);
      for (const id of ids) assert.ok(records[id], `${file}: ${id} has a record in a registry file`);
    }
  }
});

test('cli.stable.journeys-registered-10548: clause 1: [C7,U148] every core-owned test under the journeys relay, reopen, roadmap, sentinels and settings folders has a registered cli.<area>.<slug> title ID', () => {
  // This slice's records plus any other slice's, so a settings test another item registered (settings.seat-runtime-profiles) is not claimed twice.
  const records = Object.assign({}, ...readdirSync(join(DIR, 'fixtures')).filter((name) => /^registry(?:-\d+)?\.json$/u.test(name)).sort().map((name) => JSON.parse(readFileSync(join(DIR, 'fixtures', name), 'utf8'))));
  const journeys = join(DIR, '..', 'journeys');
  // View-lane files are the view lane's own slice; core may not edit them.
  const viewOwned = new Set(['sentinels/needs.test.js']);
  // #12244 moved reopen/evidence under tests/io/commands; its records stay in the registry files.
  const moved = [join(DIR, 'io', 'commands', 'reopen', 'evidence.test.js')];
  for (const area of ['relay', 'reopen', 'roadmap', 'sentinels', 'settings']) {
    const files = existsSync(join(journeys, area)) ? testFiles(join(journeys, area)) : [];
    for (const file of [...files, ...moved.filter((path) => path.includes(`/commands/${area}/`))]) {
      if (viewOwned.has(file.slice(journeys.length + 1))) continue;
      const source = readFileSync(file, 'utf8');
      const ids = [...source.matchAll(TITLE_ID)].map((match) => match[1]);
      assert.equal(ids.length, [...source.matchAll(TESTS)].length, `${file}: every test title starts with an ID`);
      for (const id of ids) assert.ok(records[id], `${file}: ${id} has a record in a registry file`);
    }
  }
});

test('cli.stable.journeys-registered-10918: clause 1: [C7,U148] every core-owned test under the journeys verify folder has a registered cli.<area>.<slug> title ID', () => {
  // Records live in every slice's own registry*.json, as cli.stable.complete reads them.
  const records = Object.assign({}, ...readdirSync(join(DIR, 'fixtures')).filter((name) => /^registry(?:-\d+[a-z]?)?\.json$/u.test(name)).sort().map((name) => JSON.parse(readFileSync(join(DIR, 'fixtures', name), 'utf8'))));
  const journeys = join(DIR, '..', 'journeys');
  // View-lane files are the view lane's own slice; core may not edit them (pullboard.json lanes.view.owns).
  const viewOwned = new Set(['verify/fixes.test.js', 'verify/item/panel.test.js', 'verify/item/timeline.test.js', 'verify/walk.test.js']);
  for (const file of testFiles(join(journeys, 'verify'))) {
    if (viewOwned.has(file.slice(journeys.length + 1))) continue;
    const source = readFileSync(file, 'utf8');
    const ids = [...source.matchAll(TITLE_ID)].map((match) => match[1]);
    assert.equal(ids.length, [...source.matchAll(TESTS)].length, `${file}: every test title starts with an ID`);
    for (const id of ids) assert.ok(records[id], `${file}: ${id} has a record in a registry*.json`);
  }
});

test('cli.stable.journeys-registered-10917: clause 1: [C7,U148] every core-owned test under the journeys submit folder has a registered cli.<area>.<slug> title ID', () => {
  // Records live in every slice's own registry*.json, as cli.stable.complete reads them.
  const records = Object.assign({}, ...readdirSync(join(DIR, 'fixtures')).filter((name) => /^registry(?:-\d+[a-z]?)?\.json$/u.test(name)).sort().map((name) => JSON.parse(readFileSync(join(DIR, 'fixtures', name), 'utf8'))));
  const journeys = join(DIR, '..', 'journeys');
  // View-lane files are the view lane's own slice; core may not edit them (pullboard.json lanes.view.owns).
  const viewOwned = new Set(['submit/notes.test.js']);
  for (const file of testFiles(join(journeys, 'submit'))) {
    if (viewOwned.has(file.slice(journeys.length + 1))) continue;
    const source = readFileSync(file, 'utf8');
    const ids = [...source.matchAll(TITLE_ID)].map((match) => match[1]);
    assert.equal(ids.length, [...source.matchAll(TESTS)].length, `${file}: every test title starts with an ID`);
    for (const id of ids) assert.ok(records[id], `${file}: ${id} has a record in a registry*.json`);
  }
});
