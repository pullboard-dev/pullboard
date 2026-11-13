/**
 * The detached claim beater's entry: `node run.js <json>` beats its seat until the claim ends, the agent session
 * exits or the worktree is gone [B3,C7]. startClaimBeater (../beater.js) launches it at claim.
 */
import { runBeater } from '../beater.js';

await runBeater(JSON.parse(process.argv[2]));
