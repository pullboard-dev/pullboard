/** Audit-only discovery, complete-green reuse and measured cadence; no foreground tree walk [C7]. */
import {
  createHash,
} from 'node:crypto';
import {
  readFileSync,
} from 'node:fs';
import {
  join,
} from 'node:path';
import {
  gitExecFileSync,
} from '../../../../../git/index.js';
import {
  gitChildEnv,
} from '../../../../../git/index.js';
import {
  testActionKeys,
} from '../../test/action/cache.js';
import {
  incrementalAudit,
  auditInterval,
} from '../../test/economics.js';
import {
  refreshTestPlacement,
} from '../../test/placement/report.js';
import {
  readGateReceipt,
  receiptStore,
} from '../../run/receipt.js';
import {
  readMainAudit,
  saveMainAudit,
} from './state.js';
import {
  packageBranchCoverage,
} from '../../coverage.js';

/** Include installed audit semantics in cache keys so a tooling change cannot reuse old audit behavior. */
function semantics(config) {
  const files = ['economics.js', 'worker.js', '../../../logic/reporter/coverage.js', '../../test/placement.js', '../../main.js'];
  return createHash('sha256').update(JSON.stringify([config.gate, ...files.map(file => readFileSync(new URL(file, import.meta.url), 'utf8'))])).digest('hex');
}

/** Only a real stored complete green execution can anchor the advisory incremental cursor. */
export function lastGreenAudit(root, directory) {
  const prior = readMainAudit(join(directory, 'last-green.json'));
  if (!prior?.complete || !prior.green || typeof prior.receiptId !== 'string') return null;
  const receipt = readGateReceipt(receiptStore(root), prior.receiptId);
  return receipt?.green && receipt.collection?.complete ? prior : null;
}

/** Discover the full suite during audit work, publishing placement once and selecting exact changed action keys. */
export async function planMainAudit(root, board, directory, job, config, { forceFull = false } = {}, services) {
  refreshTestPlacement(board, { root, head: job.tip, config }, services);
  const keys = await testActionKeys(root, { commit: job.tip, options: ['scheduled-audit-coverage-v1', semantics(config)] });
  if (!keys.size) throw new Error('audit inventory contains no committed test files');
  const previous = lastGreenAudit(root, directory);
  const plan = incrementalAudit(keys, forceFull ? null : previous);
  return { ...plan, keys: Object.fromEntries([...keys].map(([file, value]) => [file, value.key])),
    previousEventId: previous?.landedEventId ?? 0, previousReceipt: previous?.receiptId ?? null };
}

/** Aggregate actual Node coverage events; unloaded product modules remain explicitly unknown. */
export function measuredAuditCoverage(root, output) {
  const samples = [];
  for (const line of output.split(/\r?\n/u)) if (line.startsWith('# pullboard-audit-coverage ')) {
    samples.push(JSON.parse(line.slice('# pullboard-audit-coverage '.length)));
  }
  const files = gitExecFileSync(['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: root, env: gitChildEnv(root), encoding: 'utf8' }).trim().split('\n');
  const expectedFiles = files.filter(file => /\.[cm]?js$/u.test(file) && !/(?:^|\/)(?:test|tests)\//u.test(file) && !/\.test\.[cm]?js$/u.test(file));
  const packages = [{ name: 'root', prefix: '' }, ...files.filter(file => file.endsWith('/package.json')).map(file => {
    const prefix = file.slice(0, -'/package.json'.length);
    return { name: prefix, prefix };
  })];
  return { version: 1, samples: samples.length, packages: packageBranchCoverage(samples, { expectedFiles, packages }) };
}

/** Store a complete-green audit cursor separately from native receipts; it never stamps a full gate. */
export function retainGreenAudit(directory, job, saved, receipt) {
  if (!receipt?.green || receipt.collection?.complete !== true || !saved.plan) return;
  saveMainAudit(join(directory, 'last-green.json'), { version: 1, complete: true, green: true,
    receiptId: receipt.id, tip: job.tip, tree: job.tree, landedEventId: job.landedEventId,
    keys: saved.plan.keys, reused: saved.plan.reused, previousReceipt: saved.plan.previousReceipt,
    at: new Date().toISOString(), coverage: saved.coverage });
}

/** Measure lambda only from actual audit-created repair items, with actual execution cost in waiting units. */
export function retainAuditCadence(board, directory, config, { runSeconds, now = Date.now() }) {
  const rows = board.db.prepare("SELECT event_id,event_at,event_detail FROM event WHERE event_kind='landing-test-defect' ORDER BY event_id").all();
  const windowStart = now - 14 * 24 * 3600000;
  const first = board.db.prepare('SELECT event_at FROM event ORDER BY event_id LIMIT 1').get();
  const start = Math.max(windowStart, Date.parse(first?.event_at ?? new Date(now).toISOString()));
  const items = new Set(rows.filter(row => Date.parse(row.event_at) >= start && JSON.parse(row.event_detail).defect?.audit)
    .map(row => JSON.parse(row.event_detail).defect.item));
  const inputs = { runCost: runSeconds * config.testEconomics.costOfWaiting,
    escapes: items.size, observationHours: Math.max(1, now - start) / 3600000,
    delayCost: config.testEconomics.costOfEscape };
  const cadence = { version: 1, ...auditInterval(inputs), inputs, at: new Date(now).toISOString(),
    dueAt: null, method: 'actual audit repair items per observed hour; run seconds times waiting cost; escape cost per hour of delay' };
  cadence.dueAt = cadence.hours === null ? null : new Date(now + cadence.hours * 3600000).toISOString();
  saveMainAudit(join(directory, 'schedule.json'), cadence);
  return cadence;
}
