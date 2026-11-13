/** A coordinator that takes over mid-batch and adopts it lands without NOT_YOUR_CHECKOUT or LAND_DIRTY [B3,B7,R3]. */
import { test } from 'node:test';

// CONTROLLER_ONLY: adopting a killed in-process batch after takeover is the batch engine's recovery; a pulled land job has no batch or landing worktree to rebind [B3,B7,R3,GH24].
test('land --adopt after takeover rebinds the landing worktree to the new session [B3,B7,R3,GH24]', { skip: 'CONTROLLER_ONLY: deleted with #6807' }, () => {});
