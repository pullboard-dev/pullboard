/** @pullboard-test-input source-tree */
/**
 * Source changes carried by topic parents and merges: the topic-parent mode, split into its own file so the two modes run in parallel [V4,C7,V16].
 */
import { carriedSourceCase } from '../../../../tests/fixtures/submit/carried-source.js';

carriedSourceCase('topic parent', (url) => import(url));
