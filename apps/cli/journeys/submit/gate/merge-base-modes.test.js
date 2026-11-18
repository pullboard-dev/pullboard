/** @pullboard-test-input source-tree */
/** The topic-parent and merge-commit affected-submit cases, split from merge-base.test.js to stay under the runner time budget [V4,C7,V16]. */
import { test } from 'node:test';
import { affectedSubmitModeCases } from '../../../tests/fixtures/submit/merge-base-modes.js';

affectedSubmitModeCases(test, ['topic parent', 'merge commit']);
