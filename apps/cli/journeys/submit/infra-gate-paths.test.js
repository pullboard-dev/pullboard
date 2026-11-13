/** A gate named by a shell separator or an unnormalized path receives a drafted infra note, as Git reports the same file [C7,V4]. Drives the real CLI in process. */
import { test } from 'node:test';
import { draftedNoteCase } from '../../tests/fixtures/submit/infra.js';

test('a gate named by a shell separator or a dotted path receives a drafted note [C7,V4]', async (t) => {
  await draftedNoteCase(t, 'node src/check.js; true', 'src/check.js');
  // An unnormalized path names the same file Git reports, so it needs the note too (#814 review).
  await draftedNoteCase(t, 'node src/../src/check.js', 'src/check.js');
  await draftedNoteCase(t, 'node ./src/./check.js', 'src/check.js');
});
