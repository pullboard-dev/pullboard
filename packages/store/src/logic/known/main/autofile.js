import { MAIN_RED_FAILURE_LINES_ENGINE } from '../../../../../state/light.js';
import { blockingFailures } from "../../../../../verify/index.js";
/** Native exact-main evidence derives repair items only inside the submitting holder's atomic move [V4,B3,H16]. */
import { Refused } from "../../../../../kernel/light.js";
import { KNOWN_MAIN_AUTOFILE_ENGINE } from "../../../../../state/light.js";
import { ENGINE_VERSION } from "../../../../../state/index.js";
import { laneOf } from "../../../../../seats/browser.js";
import { unownedMainReds } from "./reworks.js";
import { linkKnownMainReworks } from "./reworks.js";
import { validateItemAddition } from "../../../io/board/add.js";
import { insertItem } from "../../../io/board/add.js";
import { appendFact } from "../../../io/board/fact.js";
import { splitMainReds } from "../../../../../items/index.js";
import { mainRedFact } from "../../../../../items/index.js";
import { mainRedKeyLines } from "../../../../../items/index.js";

/** Quote one derived literal file without interpreting its bytes as shell syntax. */
function word(file) { return "'" + file.replaceAll("'", "'\\''") + "'"; }

/** Reject an incomplete evidence envelope rather than lending it owner-creation authority. */
function refused() { return new Refused('SUBMISSION_PROOF', 'automatic Main red repairs need complete native candidate/main signatures and accepted-main opt-in; rerun submit'); }

/** Validate captured native evidence on origin and replay without consulting receiver Git, clocks or policy. */
export function validateKnownMainAutofile(board, id, options, value = options.autoMainReds) {
  if (!value || value.version !== 1 || (board.executionEngineVersion ?? ENGINE_VERSION) < KNOWN_MAIN_AUTOFILE_ENGINE
    || value.policy?.commit !== options.policyCommit || value.policy?.enabled !== true
    || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value.main ?? '') || typeof value.runner !== 'string' || !value.runner.trim()
    || !Array.isArray(value.phases) || value.phases.length !== value.candidates?.length
    || !Number.isSafeInteger(value.signatureVersion) || value.signatureVersion < 1 || !value.lanes || !Array.isArray(value.candidates) || !value.candidates.length || !Array.isArray(value.comparisons) || !value.comparisons.length) throw refused();
  const item = board.db.prepare('SELECT * FROM item WHERE item_id=?').get(id);
  const parse = receipt => { const result = board.runtimePorts.sourceAdvanceReceipts.receiptFields(receipt); if (!result) throw refused(); return result; };
  const candidates = value.candidates.map(parse), comparisons = value.comparisons.map(parse);
  const failures = [];
  for (const [index, receipt] of candidates.entries()) {
    if (value.phases[index]?.command !== receipt.command || !['criterion', 'proof'].includes(value.phases[index]?.role)) throw refused();
    if (receipt.version !== 2 || receipt.kind !== 'submit' || receipt.head !== (options.companion?.commit ?? options.commit)
      || receipt.tree !== (options.companion?.tree ?? options.tree) || receipt.main !== options.policyCommit
      || receipt.proof.item !== id || receipt.proof.seat !== options.agentId || !receipt.proof.sourceClean
      || receipt.proof.frozenDigest !== item.item_frozen_digest) throw refused();
    if (receipt.green) continue;
    if (receipt.failureSignatures?.version !== value.signatureVersion || !receipt.failureSignatures.failures.length) throw refused();
    const blocking = blockingFailures(receipt, receipt.failureSignatures.failures);
    if (!blocking) throw refused();
    failures.push(...blocking);
  }
  if (!failures.length) throw refused();
  const unique = new Map();
  for (const row of failures) {
    const key = JSON.stringify([row.file, row.name]);
    if (unique.has(key) && unique.get(key).signature !== row.signature) throw refused();
    unique.set(key, row);
  }
  for (const failure of unique.values()) {
    const matches = comparisons.filter(receipt => receipt.kind === 'main-red' && receipt.head === value.main && receipt.main === value.main
      && !receipt.green && receipt.failureSignatures?.version === value.signatureVersion
      && receipt.failureSignatures.failures.some(row => row.file === failure.file && row.name === failure.name && row.signature === failure.signature));
    if (matches.length !== 1) throw refused();
    if ((board.executionEngineVersion ?? ENGINE_VERSION) >= MAIN_RED_FAILURE_LINES_ENGINE) {
      const mainFailure = matches[0].failureSignatures.failures.find(row => row.file === failure.file && row.name === failure.name && row.signature === failure.signature);
      if (mainFailure?.firstError) unique.set(JSON.stringify([failure.file, failure.name]), { ...failure, firstError: mainFailure.firstError });
    }
  }
  return { main: value.main, failures: [...unique.values()] };
}

/** Recheck ownership and create only missing file-derived repairs, atomically with the authentic submit. */
export function fileKnownMainAutofile(board, id, options, items, runningFile = false) {
  const known = validateKnownMainAutofile(board, id, options);
  const missing = unownedMainReds(known, items, id, runningFile);
  if (missing === null) throw refused();
  const repairs = [];
  for (const { file, names } of missing) {
    const lane = laneOf({ lanes: options.autoMainReds.lanes }, file);
    if (!lane || lane === 'coordinator') throw new Refused('SUBMISSION_PROOF', `automatic Main red repair has no declared owner lane for ${file}; ask the coordinator to file or route its repair`);
    // One cause key for every filer: a case an open repair owns gets a fact there, never a second item.
    const { owned, fresh } = splitMainReds(items, names.map(name => ({ file, name })));
    for (const [owner, rows] of owned) appendFact(board, owner, { agentId: options.agentId, kind: 'measurement', text: mainRedFact(rows, `submit #${id}; main ${known.main}`) });
    if (!fresh.length) continue;
    const item = { by: options.agentId, lane, title: `Main red: ${file}`, route: 'strong', specIds: [], parentId: null, after: [],
      criterion: `Repair these exact cases on main ${known.main}: ${fresh.map(row => row.name).join('; ')}. First introducing landing: unknown. Filed by submit #${id} from identical native candidate/main failure signatures.`,
      brief: `Files: ${file}\nTest: Run the stored exact-file check; every case named in the criterion must pass.\nSource: submit #${id}; main ${known.main}\n${mainRedKeyLines(fresh)}` };
    const validated = validateItemAddition(board, item);
    // This engine's approved authority derives this one check; it does not impersonate the coordinator or widen addItem.
    const repair = insertItem(board, item, { ...validated, command: `${options.autoMainReds.runner.trim()} ${word(file)}` });
    const lines = known.failures.filter(row => row.file === file && row.firstError).map(({ name, firstError }) => ({ name, firstError }));
    if (lines.length) board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?)').run(`main_red_failure_lines:${repair}`, JSON.stringify(lines));
    items.push(board.db.prepare('SELECT * FROM item WHERE item_id=?').get(repair));
    repairs.push({ file, name: null, item: repair });
  }
  const linked = linkKnownMainReworks(known, items, id, true, runningFile);
  if (!linked) throw refused();
  return { known: linked, repairs };
}
