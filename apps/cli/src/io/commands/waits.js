/** The pullboard waits command: the wait audit's table, and its minute sentinel run as `waits record` [C7]. */
import { Refused } from '../../../../../packages/kernel/index.js';
import { COORDINATOR } from '../../../../../packages/config/index.js';
import { loadMachineSettings } from '../../../../../packages/config/index.js';
import { endLostTestRuns } from '../../../../../packages/drive/index.js';
import { handoffQueueDirectory } from '../../../../../packages/resources/index.js';
import { listResources } from '../../../../../packages/resources/index.js';
import { machineHome } from '../../../../../packages/resources/index.js';
import { openWaitKey } from '../../../../../packages/sentinels/index.js';
import { recordWaits } from '../../../../../packages/sentinels/index.js';
import { waitBudgets } from '../../../../../packages/sentinels/index.js';
import { waitItemFields } from '../../../../../packages/sentinels/index.js';
import { waitKey } from '../../../../../packages/sentinels/index.js';
import { waitLines } from '../../../../../packages/sentinels/index.js';
import { waitsSnapshot } from '../../../../../packages/sentinels/index.js';
import { context } from '../entry.js';
import { ordered } from '../entry.js';
import { whoAmI } from '../entry.js';
import { withBoard } from '../entry.js';

/** Snapshot every wait surface of this checkout's repository and machine. */
async function snapshotHere(ctx, budgets, runnerTimeoutMs) {
  const settings = loadMachineSettings();
  return waitsSnapshot({ budgets, runnerTimeoutMs, hosts: (settings.runners ?? []).map(runner => runner.host).filter(host => typeof host === 'string'),
    paths: { commonDir: ctx.info.commonDir, boardFile: ctx.file, machineHome: machineHome(), handoffQueue: handoffQueueDirectory() } });
}

/**
 * `pullboard waits` prints surface, holder, age, waiters and budget read-only and exits 1 when anything is over
 * budget; `pullboard waits record` also reclaims dead holders, files one item per new cause and records the run.
 */
export async function run(io, { first, second, rest = [] } = {}) {
  const usage = first === 'check' ? second === undefined || rest.length : second !== undefined || (first !== undefined && first !== 'record');
  if (usage) throw new Refused('USAGE', 'use pullboard waits [--json] to read the table, pullboard waits check <wait key> to test one cause, or pullboard waits record to run the audit');
  const ctx = context(io);
  const budgets = waitBudgets(ctx.config, loadMachineSettings());
  if (first === 'check') {
    // A filed item's check: red while the wait with this key is still over budget, green once its cause is gone.
    const snapshot = await snapshotHere(ctx, budgets, 2_000);
    const over = snapshot.rows.filter(row => row.breach && waitKey(row) === second);
    io.result?.({ key: second, over });
    io.say(over.length ? `${second}: over budget\n${waitLines({ ...snapshot, rows: over }).slice(0, -1).join('\n')}` : `${second}: within budget`);
    return over.length ? 1 : 0;
  }
  if (first !== 'record') {
    const snapshot = await snapshotHere(ctx, budgets, 500);
    io.result?.({ waits: snapshot });
    for (const line of waitLines(snapshot)) io.say(line);
    return snapshot.rows.some(row => row.breach) ? 1 : 0;
  }
  if (!budgets.sentinel) {
    io.say('the wait audit is off (waits.sentinel is false)');
    io.result?.({ waits: null });
    return 0;
  }
  const snapshot = await snapshotHere(ctx, budgets, 10_000);
  return withBoard(ctx, async board => {
    const me = whoAmI(ctx, board);
    // Only the coordinator files and releases; another seat's run reports what it saw.
    const filing = me.id === COORDINATOR;
    const outcome = await recordWaits({ ...snapshot, budgets: { ...budgets, file: budgets.file && filing, reclaim: budgets.reclaim } }, {
      openKey: key => openWaitKey(board.db, key),
      fileItem: draft => ordered(ctx, board, 'addItem', [waitItemFields(draft, me.id)]),
      shout: text => ordered(ctx, board, 'shout', [{ from: 'sentinel', to: COORDINATOR, lanes: [], text, detail: { model: me.model ?? 'unknown' } }]),
      prunePools: scope => listResources({ scope, root: ctx.info.root }),
      release: async claim => {
        if (!filing || !claim.lastSeen) return false;
        await ordered(ctx, board, 'release', [claim.item, me.id, '', { seat: claim.seat, lastSeen: claim.lastSeen }, 'BLOCKED']);
        return true;
      },
    });
    // A test run whose lease lapsed and whose worker is gone is marked lost here, so it stops holding a slot.
    if (budgets.reclaim) for (const run of endLostTestRuns(board.db, { now: ctx.clock.now().getTime() })) outcome.reclaimed.push(`test run ${run.id.slice(0, 8)}: marked lost, its worker${run.pid ? ` pid ${run.pid}` : ''} is gone and its lease lapsed ${Math.round(run.lapsedMs / 60_000)} min ago`);
    io.result?.({ waits: snapshot, recorded: outcome });
    io.say(`waits: ${snapshot.rows.filter(row => row.breach).length} over budget; filed ${outcome.filed.length}, already open ${outcome.deduplicated.length}, reclaimed ${outcome.reclaimed.length}`);
    for (const line of [...outcome.filed.map(row => `#${row.id} ${row.title}`), ...outcome.reclaimed, ...outcome.notes]) io.say(`  ${line}`);
    return 0;
  });
}

