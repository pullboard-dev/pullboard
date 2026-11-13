/** A gate named by an unnormalized path receives a drafted infra note, as Git reports the same file [C7,V4]. Drives the real CLI in process. */
import { test } from 'node:test';
import { draftedNoteCase } from '../../tests/fixtures/submit/infra.js';

test('a gate named by a dotted path receives a drafted note [C7,V4]', async (t) => {
  await draftedNoteCase(t, 'node src/../src/check.js', 'src/check.js');
  await draftedNoteCase(t, 'node ./src/./check.js', 'src/check.js');
});
