/** @pullboard-test-input source-tree */
/** @pullboard-test-input packages/gate/tests/io/board/baseline/guard.test.js */
/** A real submit names a new board-open file before large selection defers; one real submit per file keeps it inside the per-file cap (#4939) [C7]. */
import { installSubmitTestTreeCases } from '../../../tests/fixtures/submit/cases.js';

installSubmitTestTreeCases(['large selection']);
