/** Read durable observations or opt this board into one diagnostic pair, never into retry acceptance [C7,H16]. */
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { ciObservations } from "../../../github/index.js";
import { CONFIG_FILE } from "../../../config/index.js";
import { COORDINATOR } from "../../../config/index.js";
import { laneOf } from "../../../seats/index.js";
import { flakeLedger } from "./main.js";
import { flakeQuarantines } from "./quarantine.js";
import { Refused } from "../../../kernel/index.js";

/**
 * Import CI results into the ledger (#918): each observation is an ordinary ordered board move, filed in the lane
 * that owns its test, and the original red always stays red.
 */
async function importCi(ctx, folder, withBoard, { ordered, resourceAgent }) {
  const observations = ciObservations(ctx.info.root, folder);
  const agentId = resourceAgent(ctx);
  const lanes = Object.keys(ctx.config.lanes ?? {});
  const recorded = [];
  for (const observation of observations) {
    const owner = observation.file ? laneOf(ctx.config, observation.file) : COORDINATOR;
    const lane = owner === COORDINATOR ? lanes[0] : owner;
    const result = await withBoard(ctx, board => ordered(ctx, board, 'recordFlakeObservation', [{ agentId, observation, lane }]));
    recorded.push({ id: observation.id, classification: observation.classification, file: observation.file, name: observation.name,
      run: observation.ci.run, job: observation.ci.job, duplicate: Boolean(result?.duplicate), item: result?.item ?? null });
    ctx.io.say(`${observation.classification}: ${observation.file ?? '(unnamed CI failure)'}${observation.name ? ' :: ' + observation.name : ''}; run ${observation.ci.run} attempts ${observation.ci.attempt}→${observation.ci.rerunAttempt}; ${observation.ci.job}${result?.duplicate ? ' (already recorded)' : ''}`);
  }
  if (!observations.length) ctx.io.say('no failed CI attempt with a rerun at the same commit; nothing to record');
  ctx.io.result?.({ imported: recorded });
  return 0;
}

/** List actual flake sightings separately from unknown failures and candidate regressions. */
export function flakesCommand(ctx, { first, second, rest }, withBoard, services = {}) {
  if (first === 'import' && second && !rest.length) return importCi(ctx, second, withBoard, services);
  if (['rerun', 'quarantine'].includes(first) && ['on', 'off'].includes(second) && !rest.length) {
    if (!ctx.info.isMain) throw new Refused('NOT_MAIN', 'only the coordinator sets this board’s diagnostic policy; ask it to run pullboard flakes rerun on or off');
    const file = join(ctx.info.root, CONFIG_FILE);
    const config = JSON.parse(readFileSync(file, 'utf8'));
    config.flakes = { ...(config.flakes ?? {}), [first]: second === 'on' };
    writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
    ctx.io.result?.({ flakes: config.flakes, file: CONFIG_FILE });
    ctx.io.say(first === 'rerun' ? `paired flake diagnostics ${second}; commit ${CONFIG_FILE} to apply this board policy. The original red remains red.`
      : `flake quarantine ${second}; commit ${CONFIG_FILE} to apply this board policy. Runs and repair items are recorded either way; only quarantine stops a proven flake from blocking a landing.`);
    return 0;
  }
  if (first || second || rest.length) throw new Refused('USAGE', 'pullboard flakes lists observations; pullboard flakes rerun|quarantine on|off sets the coordinator’s opt-in policy; pullboard flakes import <folder> records downloaded CI results');
  return withBoard(ctx, board => {
    const rows = flakeLedger(board, { root: ctx.info.root });
    const flakes = rows.filter(row => row.count > 0);
    const unclassified = rows.filter(row => row.count === 0 && row.classification === 'unclassified');
    const regressions = rows.filter(row => row.count === 0 && row.classification === 'possible-regression');
    const stable = rows.filter(row => row.count === 0 && row.classification === 'stable-red');
    const quarantined = flakeQuarantines(board).filter(entry => entry.status === 'quarantined');
    ctx.io.result?.({ flakes, unclassified, regressions, stable, quarantined });
    for (const row of rows) {
      const repairs = row.repairs ?? (row.item ? [row.item] : []);
      ctx.io.say(`${row.status}: ${row.file ?? '(unclassified gate)'}${row.name ? ' :: ' + row.name : ''}; count ${row.count}; first ${row.firstSeen}; last ${row.lastSeen}${repairs.length ? '; repair ' + repairs.map(id => '#' + id).join(', ') : ''}`);
    }
    for (const entry of quarantined) ctx.io.say(`quarantined: ${entry.file} :: ${entry.name}; still runs and reports, ${entry.autoSubmit ? `repair #${entry.item} must land before release` : entry.nativeCore ? `blocking verdict unchanged; repair #${entry.item}, ${entry.cleanRuns}/20 clean runs` : `does not block a landing until repair #${entry.item} is verified`}`);
    if (!rows.length && !quarantined.length) ctx.io.say('no recorded test failures; paired diagnostics are off unless this board opts in with pullboard flakes rerun on');
    return 0;
  });
}
