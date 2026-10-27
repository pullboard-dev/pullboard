/** @pullboard-test-input source-tree */
/** @pullboard-test-input README.md */
/**
 * Keep docs/architecture.md in step with the relay code it describes [H5,H7]: every table the
 * relay creates, every credential prefix the relay and its client use, and every file and
 * function the page cites. The page is the trust story the site points to, so drift fails here.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createRelayAuth } from '../relay/auth.js';
import { createDeviceStore } from '../relay/device-store.js';
import { createRelayJournal } from '../relay/journal.js';
import { createRelayPages } from '../relay/page-store.js';
import { createStorageQuota } from '../relay/storage-quota.js';

const ROOT = join(import.meta.dirname, '..');
const PAGE = readFileSync(join(ROOT, 'docs', 'architecture.md'), 'utf8');

/**
 * Read every JavaScript module in one repository folder, optionally narrowed by file name.
 * @param {string} folder
 * @param {RegExp} [name]
 * @returns {{ path: string, text: string }[]}
 */
function modules(folder, name = /\.m?js$/u) {
  return readdirSync(join(ROOT, folder)).filter(file => /\.m?js$/u.test(file) && name.test(file)).sort()
    .map(file => ({ path: folder + '/' + file, text: readFileSync(join(ROOT, folder, file), 'utf8') }));
}

/**
 * Name every table a CREATE TABLE statement under relay/ makes; this is what the relay stores.
 * @returns {Set<string>}
 */
function codeTables() {
  const tables = new Set();
  for (const { text } of modules('relay')) {
    for (const match of text.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+([A-Za-z_][A-Za-z0-9_]*)/gu)) tables.add(match[1]);
  }
  return tables;
}

/**
 * Name every Pullboard credential prefix: those the relay mints, and those the relay or its client
 * matches in a credential pattern or a prefix test. GitHub's own ghu_ and ghs_ are not Pullboard's.
 * @returns {Set<string>}
 */
function codePrefixes() {
  const prefixes = new Set();
  for (const { text } of [...modules('relay'), ...modules('src', /^relay.*\.js$/u)]) {
    for (const match of text.matchAll(/\brandom\('([a-z]{2}_)'\)/gu)) prefixes.add(match[1]);
    for (const match of text.matchAll(/(?<![A-Za-z0-9_])(p[a-z]_)(?=[|)]|\[A-Za-z0-9_-\])/gu)) prefixes.add(match[1]);
    for (const match of text.matchAll(/startsWith\('(p[a-z]_)'\)/gu)) prefixes.add(match[1]);
  }
  return prefixes;
}

/**
 * Return the lines of one level-two section of the page, up to the next level-two heading.
 * @param {string} heading
 * @returns {string[]}
 */
function section(heading) {
  const lines = PAGE.split('\n');
  const start = lines.indexOf('## ' + heading);
  assert.ok(start >= 0, `the architecture page has a "${heading}" section`);
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines.slice(start + 1, end < 0 ? lines.length : end);
}

/**
 * Name the backticked identifier that opens each table row of a section.
 * @param {string} heading
 * @param {RegExp} cell
 * @returns {Set<string>}
 */
function rowNames(heading, cell) {
  return new Set(section(heading).flatMap(line => { const match = cell.exec(line); return match ? [match[1]] : []; }));
}

/**
 * List the tables the relay's own stores really create, by opening them in a private folder.
 * @returns {Set<string>}
 */
function liveTables() {
  const folder = mkdtempSync(join(tmpdir(), 'pullboard-architecture-'));
  try {
    const auth = createRelayAuth({ database: join(folder, 'auth.sqlite'), github: {} });
    auth.close();
    const boards = join(folder, 'boards');
    createRelayJournal({ directory: boards, boardId: '0'.repeat(32) }).close();
    createRelayPages({ directory: boards, boardId: '0'.repeat(32) }).close();
    createStorageQuota({ directory: boards, auth: { withBoard: (board, work) => work() } }).close();
    const devices = createDeviceStore({ directory: boards });
    devices.begin('1', 'a'.repeat(22));
    devices.close();
    const tables = new Set();
    for (const file of [join(folder, 'auth.sqlite'), join(boards, 'devices.sqlite'), join(boards, '0'.repeat(32) + '.journal.sqlite'), join(boards, 'storage-quota.sqlite')]) {
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) tables.add(row.name);
      } finally { db.close(); }
    }
    return tables;
  } finally { rmSync(folder, { recursive: true, force: true }); }
}

test('the architecture page names every relay table and credential prefix the code has [H5,H7]', () => {
  const tables = codeTables();
  assert.ok(tables.size >= 13, 'the relay source declares its tables');
  assert.deepEqual([...liveTables()].sort(), [...tables].sort(), 'the parsed CREATE TABLE names are the tables the relay stores open');
  const listed = rowNames('What the relay stores', /^\| `([A-Za-z_][A-Za-z0-9_]*)` \|/u);
  for (const table of tables) assert.ok(listed.has(table), `the page lists the relay table ${table}`);
  for (const table of listed) assert.ok(tables.has(table), `the page lists ${table}, and the relay code has no such table`);

  const prefixes = codePrefixes();
  assert.ok(prefixes.size >= 4, 'the relay source declares its credential prefixes');
  const rows = rowNames('Who is who', /^\| `([a-z]{2}_)` /u);
  for (const prefix of prefixes) assert.ok(rows.has(prefix), `the credential table names ${prefix}`);
  for (const prefix of rows) assert.ok(prefixes.has(prefix), `the credential table names ${prefix}, and the code has no such prefix`);
  const mentioned = new Set([...PAGE.matchAll(/`(p[a-z]_)`/gu)].map(match => match[1]));
  for (const prefix of mentioned) assert.ok(prefixes.has(prefix), `the page mentions ${prefix}, and the code has no such prefix`);
});

test('every file and function the architecture page cites exists in the code [H7]', () => {
  const paths = [...PAGE.matchAll(/`((?:src|relay|test|docs)\/[A-Za-z0-9_./-]+\.(?:js|mjs|md))`/gu)].map(match => match[1]);
  assert.ok(paths.length > 10, 'the page cites the code it describes');
  for (const path of new Set(paths)) assert.ok(existsSync(join(ROOT, path)), `the page cites ${path}, which exists`);
  const citations = [...PAGE.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`(?: and `([A-Za-z_][A-Za-z0-9_]*)`)? in `((?:src|relay)\/[A-Za-z0-9_./-]+\.m?js)`/gu)];
  assert.ok(citations.length > 10, 'the page names the functions behind its claims');
  for (const [, first, second, path] of citations) {
    const source = readFileSync(join(ROOT, path), 'utf8');
    for (const name of [first, second].filter(Boolean)) {
      assert.match(source, new RegExp(`(?<![A-Za-z0-9_$])${name}(?![A-Za-z0-9_$])`, 'u'), `${path} has the ${name} the page cites`);
    }
  }
});

test('the README links the architecture page from its docs list [I12]', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /^- \[[^\]]+\]\(docs\/architecture\.md\): .+$/mu);
});
