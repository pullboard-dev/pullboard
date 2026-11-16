/** @pullboard-test-input source-cell apps/cli */
/**
 * Source changes carried by topic parents and merges: the merge-commit mode, split into its own file so the two modes run in parallel [V4,C7,V16].
 */
import { carriedSourceCase } from '../../../../tests/fixtures/submit/carried-source.js';

carriedSourceCase('merge commit', (url) => import(url));
