/**
 * Every landing is one runner land job: accept offers it, and `pullboard land` and `land <ids> --forced` offer the same
 * kind; a runner merges, checks and pushes trunk with compare-and-swap, and its receipt marks the items merged. This
 * host merges nothing and runs no landing batch. With trunk.remote set this holds in any gate.runnerDispatch mode
 * (#5864). With trunk.remote empty the trunk is the board host's own repository, which only a runner on this host
 * reaches, so the job needs the local runner's board-host capability; that path stays behind pull until L6 [P7].
 */
import { offerLandingJob } from '../../../../../packages/api/index.js';
import { openLandingJob } from '../../../../../packages/api/index.js';
import { configTrunkRemote } from '../../../../../packages/config/index.js';
import { runnerDispatchMode } from '../../../../../packages/config/index.js';
import { tryGit } from '../../../../../packages/git/index.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import { checkLandingMessages } from '../../../../../packages/landing/index.js';
import { landingContext } from '../../../../../packages/landing/index.js';
import { withoutStaleVerdicts } from '../../../../../packages/landing/index.js';
import { ordered } from '../../../index.js';
import { withBoard } from '../context.js';
import { BOARD_HOST } from '../runner/local.js';
import { ensureLocalRunner } from '../runner/local.js';
import { pullGit } from '../runner/git.js';

const TRUNK = 'refs/heads/main';

/** The ref an accepted item's commit is published under on the trunk remote, so a runner can fetch it by name. */
export function landingItemRef(id) {
  return `refs/pullboard/land/${id}`;
}

/**
 * The trunk commit a land job lands onto, as this checkout holds it: the trunk remote's tip, fetched under a private ref
 * when this checkout lacks it, else main's commit. Why: verdict freshness is judged against the main the items land on,
 * and with a trunk remote of record this checkout's own main may lag it [B3,C7].
 */
async function landingTrunk(root, remote, main) {
  const listed = tryGit(root, ['ls-remote', '--', remote, TRUNK]);
  const tip = listed.status === 0 && /^[0-9a-f]{40}/u.test(listed.stdout) ? listed.stdout.slice(0, 40) : main;
  const held = () => tryGit(root, ['cat-file', '-e', `${tip}^{commit}`]).status === 0;
  if (tip !== main && !held()) await pullGit.fetchTrunk(root, remote, [`+${TRUNK}:refs/pullboard/landing/trunk`]);
  return held() ? tip : main;
}

/**
 * The deferred files each item's latest submission recorded, by item id; null when no item deferred any.
 * Why: the pulled gate records them in the submission proof, and only the landing job can run them on the merged tree [C7].
 */
function deferredFilesOf(db, items) {
  const found = {};
  for (const entry of items) {
    const row = db.prepare("SELECT event_detail FROM event WHERE item_id = ? AND event_kind = 'submit' ORDER BY event_id DESC LIMIT 1").get(entry.id);
    let proof = null;
    try { proof = JSON.parse(row?.event_detail ?? 'null')?.submissionProof; } catch { /* an unreadable detail defers nothing */ }
    // The files the submit ran (its invariants) run again beside the deferred ones, on the merged tree.
    if (Array.isArray(proof?.deferredFiles) && proof.deferredFiles.length) found[String(entry.id)] = [...new Set([...proof.deferredFiles, ...(Array.isArray(proof.files) ? proof.files : [])])];
  }
  return Object.keys(found).length ? found : null;
}

/**
 * What a land job's runner does with a red: pair its failing cases when accepted main turns flakes.rerun on, with the
 * runner prefix of the item's check and of the proof command; with it off, still name them, so the board records an
 * unclassified observation. Null when the board's policy reads cannot name a prefix.
 */
function landingFlakes(root, policy, item, head, pairPrefix) {
  const rerun = policy.config.flakes?.rerun === true;
  const config = policy.config, pin = { head, main: policy.commit };
  const proof = typeof config.affectedTests === 'string' && config.affectedTests.trim() ? config.affectedTests : config.gate;
  return { rerun, prefixes: rerun ? { check: pairPrefix(root, item?.item_check ?? null, config, pin), proof: pairPrefix(root, proof, config, pin) } : { check: null, proof: null } };
}

/**
 * Offer the board's accepted, unmerged, unheld items as one land job, or return null when this machine lands them
 * itself (no trunk remote of record, and not pull or no local runner). While a land job is open no second automatic
 * one is offered: its receipt settles the items first. Named ids offer only those items; forced (the person's reason)
 * also takes named items not yet accepted, at their submitted commit, and is carried on the job. Each item's commit is
 * pushed to the trunk remote under landingItemRef first, since the runner fetches only from there.
 *
 * @param {object} ctx - The command context at the main checkout.
 * @param {string} root - The main checkout.
 * @param {{ pairPrefix?: Function, mainPolicy: (root: string) => { config: object, commit: string }, listItems: Function, checkedLandingCommit: Function, badgeDocuments?: (board: object) => { path: string, text: string }[] }} reads - The
 *   policy and board reads the lander already holds.
 * @param {{ local?: typeof ensureLocalRunner, ids?: number[] | null, forced?: string | null, board?: object | null }} [options] - board: the
 *   board a command already holds open, so a hand landing writes its offer there.
 * @returns {Promise<{ offered: string | null, items: number[], waiting: boolean, forced?: string } | null>}
 */
export async function offerPulledLanding(ctx, root, { mainPolicy, listItems, checkedLandingCommit, badgeDocuments, pairPrefix }, { local = ensureLocalRunner, ids = null, forced = null, board: opened = null } = {}) {
  const policy = mainPolicy(root);
  const configured = configTrunkRemote(policy.config);
  // No trunk remote: the board host's repository is trunk, landed by the local runner, which this starts again if it died.
  const hosted = !configured && runnerDispatchMode() === 'pull' && (await local(root)).running;
  if (!configured && !hosted) return null;
  const remote = configured ?? root;
  return (opened ? work => work(opened) : work => withBoard(ctx, work))(async board => {
    const open = ids ? null : openLandingJob(board.db);
    if (open) return { offered: open, items: [], waiting: false };
    // A verdict a main change made stale goes back to its lane first, as the engine's selection does; forced takes none [B3,C7].
    const all = await withoutStaleVerdicts(board, root, await landingTrunk(root, remote, policy.commit), listItems(board, { all: true }), { candidate: item => !forced && !item.item_hold_at && (!ids || ids.includes(item.item_id)),
      write: (operation, args) => ordered(ctx, board, operation, args), say: line => ctx.io.say?.(line) });
    for (const id of ids ?? []) if (!all.some(item => item.item_id === id && !item.item_merged_commit)) throw new Refused('LAND_NAMED', `#${id} is not an unmerged item on this board`, 'name only items that wait to land');
    const wanted = item => !item.item_merged_commit && (ids ? ids.includes(item.item_id) && (forced || item.item_status === 'verified') : item.item_status === 'verified' && !item.item_hold_at);
    // Accept order, as the engine's selection merges: each item's newest accept event; named ids keep the order named [C7].
    const accepted = new Map(board.db.prepare("SELECT item_id, MAX(event_id) AS event_id FROM event WHERE event_kind = 'accept' GROUP BY item_id").all().map(row => [row.item_id, row.event_id]));
    const rank = item => ids ? ids.indexOf(item.item_id) : accepted.get(item.item_id) ?? Number.MAX_SAFE_INTEGER;
    const chosen = all.filter(wanted).sort((left, right) => rank(left) - rank(right) || left.item_id - right.item_id);
    const commitOf = item => item.item_status === 'verified' ? checkedLandingCommit(board, item) : item.item_commit;
    // Each merge carries the engine's landing message from the item's frozen rows, so spec coverage reads its trailers [B3,R3,C7].
    const messages = checkLandingMessages(chosen, landingContext(root, policy.commit, policy.config, commitOf));
    const items = chosen.map(item => {
      const message = messages.get(item.item_id);
      return { id: item.item_id, commit: commitOf(item), ref: landingItemRef(item.item_id), header: message.header, trailers: message.trailers };
    });
    if (ids && items.length !== ids.length) throw new Refused('LAND_NOT_ACCEPTED', `${ids.filter(id => !items.some(entry => entry.id === id)).map(id => `#${id}`).join(' ')} is not accepted`, 'land it after its verify, or go around the gate with --forced "<why>"');
    if (!items.length) return { offered: null, items: [], waiting: false };
    for (const entry of items) {
      const pushed = tryGit(root, ['push', '--quiet', '--no-verify', remote, `+${entry.commit}:${entry.ref}`]);
      if (pushed.status !== 0) throw Object.assign(new Error(`could not publish #${entry.id} to the trunk remote: ${(pushed.stderr || pushed.stdout).slice(0, 300)}`), { code: 'LANDING_TRUNK_REMOTE' });
    }
    const listed = tryGit(root, ['ls-remote', '--', remote, TRUNK]);
    const expect = listed.status === 0 && /^[0-9a-f]{40}/u.test(listed.stdout) ? listed.stdout.slice(0, 40) : policy.commit;
    // Each item's submit may have deferred test files to this landing; the job runs them on the merged tree [C7].
    const deferred = deferredFilesOf(board.db, items);
    // The runner names a red's failing cases whether or not it pairs them; the prefixes are main's accepted policy, as the pulled gate's are [C7,H16].
    const flakes = typeof pairPrefix === 'function' ? landingFlakes(root, policy, chosen[0], items[0].commit, pairPrefix) : null;
    const job = offerLandingJob(board.db, { items, expect, trunk: TRUNK, forced, deferred, flakes, badges: badgeDocuments?.(board) ?? [],
      ...(hosted ? { config: { ...policy.config, trunk: { ...policy.config.trunk, remote } }, needs: [BOARD_HOST], checkout: true } : { config: policy.config }) });
    ctx.io.say?.(`offered ${forced ? 'forced ' : ''}land job ${job.id} for ${items.map(entry => `#${entry.id}`).join(' ')}; a runner merges and pushes trunk`);
    return { offered: job.id, items: items.map(entry => entry.id), waiting: false, ...(forced ? { forced } : {}) };
  });
}
