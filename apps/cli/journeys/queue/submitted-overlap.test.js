/** pullboard queue shows two submitted items that share a file with no mutual wait: only the later submission waits, on the earlier [C7,#11771]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { submittedWithoutGate } from '../../tests/fixtures/submitted-seam.js';
import { clean } from '../../tests/fixtures/verdict-check.js';
import { project } from '../../tests/fixtures/verdict-check.js';
import { sandbox } from '../../tests/fixtures/verdict-check.js';
import { succeeds } from '../../tests/fixtures/verdict-check.js';

/** One item that names the shared file, claimed in the web seat, committed there and submitted through the seam. */
async function sharedFileItem(box, repo, web, title, criterion) {
  const added = await succeeds(box, repo, 'add', 'web', title, '--specs', 'G1', '--criterion', criterion, '--level', 'strong', '--brief', 'Files: web/fixture.txt\nTest: the fixture item is accepted with its recorded check');
  const id = Number(/#(\d+)/.exec(added)?.[1]);
  await succeeds(box, web, 'claim', String(id));
  mkdirSync(join(web, 'web'), { recursive: true });
  writeFileSync(join(web, 'web', `item-${id}.js`), 'export const complete = true;\n');
  box.git(web, 'add', '-A');
  box.git(web, 'commit', '-q', '-m', `feat(web): complete fixture ${id} [G1]`);
  submittedWithoutGate({ repo, git: box.git }, web, id);
  return id;
}

test('cli.journeys-queue-submitted-overlap.two-submitted-items-sharing-a-file: clause 3: pullboard queue on two submitted items that share a file shows the later one waiting on the earlier and the earlier waiting on nothing [C7,#11771]', async () => {
  const box = sandbox();
  try {
    const { repo, web } = await project(box);
    const first = await sharedFileItem(box, repo, web, 'Reorder the shelf labels', 'Shelf labels print in alphabetical order.');
    const second = await sharedFileItem(box, repo, web, 'Purge stale cache entries', 'Cache rows older than a day are deleted at startup.');
    console.log(await succeeds(box, repo, 'queue'));
    const listed = JSON.parse(await succeeds(box, repo, 'queue', '--json'));
    const rows = [...listed.releases.flatMap(release => release.items), ...listed.unreleased];
    const early = rows.find(row => row.id === first);
    const late = rows.find(row => row.id === second);
    assert.equal(early.status, 'submitted');
    assert.equal(late.status, 'submitted');
    assert.deepEqual(early.waits, []);
    assert.deepEqual(late.waits, [`#${second} waits for #${first} (submitted) on web/fixture.txt`]);
  } finally { clean(box); }
});
