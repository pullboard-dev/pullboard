/** A copied template root's board file and home folders are rewritten to the new root, and status answers there [C7,#8997]. */
import assert from 'node:assert/strict';
import { cpSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { privateFixtureFiles } from '../child.js';
import { runCliInProcess } from '../process.js';
import { relocateBoard } from './relocate-board.js';
import { relocateHomes } from './relocate-board.js';
import { releaseFixture } from './release.js';

/** Every file under a folder, as absolute paths. */
function filesIn(folder) {
  return readdirSync(folder, { withFileTypes: true }).flatMap(entry => (entry.isDirectory() ? filesIn(join(folder, entry.name)) : entry.isFile() ? [join(folder, entry.name)] : []));
}

test('clause 1: a copied template root names only the new root in its board file and home folders, and status answers there [C7,#8997]', async t => {
  const template = releaseFixture(t);
  const copy = privateFixtureFiles('pullboard-resume-copy-').root;
  t.after(() => rmSync(copy, { recursive: true, force: true }));
  cpSync(template.root, copy, { recursive: true, verbatimSymlinks: true });
  relocateBoard(template.root, copy);
  relocateHomes(template.root, copy);

  const db = new DatabaseSync(join(copy, 'repo', '.git', 'pullboard', 'board.sqlite'), { readOnly: true });
  try {
    const seats = db.prepare('SELECT agent_path FROM agent').all().map(row => row.agent_path);
    assert.ok(seats.length > 0 && seats.every(path => path.startsWith(copy)), `every seat is in the new root: ${seats}`);
    const dump = db.prepare("SELECT meta_value FROM board_meta WHERE meta_key LIKE 'local:family:%'").all().map(row => row.meta_value).join('\n');
    assert.ok(dump.includes(copy) && !dump.includes(template.root), 'the board metadata names only the new root');
  } finally { db.close(); }

  for (const folder of ['home', 'machine-home']) {
    const files = filesIn(join(copy, folder));
    assert.ok(files.length > 0, `${folder} holds files`);
    for (const file of files) assert.ok(!readFileSync(file, 'utf8').includes(template.root), `${file} no longer names the template root`);
  }
  assert.ok(readFileSync(join(copy, 'home', 'projects.json'), 'utf8').includes(join(copy, 'repo')), 'the project list names the new repo');

  const env = Object.fromEntries(Object.entries(template.env).map(([key, value]) => [key, typeof value === 'string' ? value.split(template.root).join(copy) : value]));
  const status = await runCliInProcess(['status'], { cwd: join(copy, 'repo'), env });
  assert.equal(status.status, 0, status.stderr || status.stdout);
  assert.ok(!(status.stdout + status.stderr).includes(template.root), 'status never names the template root');
});
