/** @pullboard-test-input source-tree packages/codemap/data/plan/cells.json packages/codemap/data/plan/** */
/** Import-cut filing and checking run on real private boards, split from cells.test.js to stay inside its file budget [D3,CD64,C7]. */
import { fileURLToPath } from 'node:url';
import { readPlan } from '../../../../../packages/codemap/index.js';
import { installCutCases } from '../../../tests/fixtures/cells/cases.js';
import { fixture } from '../../../../../packages/landing/tests/fixtures/plan.js';
import { git } from '../../../../../packages/landing/tests/fixtures/plan.js';

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const BIN = fileURLToPath(new URL('../../../../../packages/codemap/src/io/cells/scripts/plan.js', import.meta.url));
const PLAN = readPlan(ROOT);

installCutCases({ PLAN, BIN, fixture, git });
