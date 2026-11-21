/** @pullboard-test-input source-tree */
/** Source changes carried by topic parents and merges in both modes, and the topic-parent and merge-commit affected-submit cases [V4,C7,V16]. */
import { carriedSourceCase } from '../../../fixtures/submit/carried-source.js';
import { test } from 'node:test';
import { affectedSubmitModeCases } from '../../../fixtures/submit/merge-base-modes.js';

carriedSourceCase('merge commit', (url) => import(url));

carriedSourceCase('topic parent', (url) => import(url));

affectedSubmitModeCases(test, ['topic parent', 'merge commit']);
