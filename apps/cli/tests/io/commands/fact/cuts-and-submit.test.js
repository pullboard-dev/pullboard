/** @pullboard-test-input source-tree packages/codemap/data/plan/cells.json packages/codemap/data/plan/** */
/** @pullboard-test-input packages/gate/tests/io/board/baseline/guard.test.js */
/** Import-cut filing and checking, and the real submits that name a new board-open file before full fallback or large selection defers, each on its own real board [D3,CD64,C7]. */
import { fileURLToPath } from 'node:url';
import { readPlan } from '../../../../../../packages/codemap/index.js';
import { installCutCases } from '../../../fixtures/cells/cases.js';
import { fixture } from '../../../../../../packages/landing/tests/fixtures/plan.js';
import { git } from '../../../../../../packages/landing/tests/fixtures/plan.js';
import { installSubmitTestTreeCases } from '../../../fixtures/submit/cases.js';

const ROOT = fileURLToPath(new URL('../../../../../../', import.meta.url));
const BIN = fileURLToPath(new URL('../../../../../../packages/codemap/src/io/cells/scripts/plan.js', import.meta.url));
const PLAN = readPlan(ROOT);

installCutCases({ PLAN, BIN, fixture, git });

installSubmitTestTreeCases(['full fallback']);

installSubmitTestTreeCases(['large selection']);
