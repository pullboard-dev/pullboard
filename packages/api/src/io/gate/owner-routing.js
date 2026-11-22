import { offeredRequest } from '../jobs.js';
import { ledgerInputKeys } from './files.js';

const INPUT_KEY = /^[0-9a-f]{64}$/u;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const OUTCOME_KEYS = /^(?:failure,)?file,name,(?:owner,)?passed,skipped$/u;

/** A repository-relative source path with the same portable shape used by authenticated runner outcomes. */
export const sourcePath = path => typeof path === 'string' && !!path && path.length <= 4096 && !path.startsWith('/') && !/^[A-Za-z]:/u.test(path) && !/[\\\r\n\0]/u.test(path) && !path.split('/').some(part => !part || part === '.' || part === '..');

/** The immutable selected files from one offered shard request, or null when its request is absent or malformed. */
export function selectedShardFiles(db, job) {
  let files = null;
  try { files = offeredRequest(db, job)?.input?.data?.shard?.files ?? null; }
  catch (error) { if (!error?.code) throw error; }
  if (!Array.isArray(files) || !files.length || files.some(file => !sourcePath(file)) || new Set(files).size !== files.length) return null;
  return [...files];
}

/** The exact selected list and its server offered input keys for one shard, or null when the offer is not sound. */
export function selectedShardContext(db, job) {
  let request = null;
  try { request = offeredRequest(db, job); } catch (error) { if (!error?.code) throw error; }
  const files = selectedShardFiles(db, job);
  const data = request?.input?.data?.shard;
  if (!files || !data || !Array.isArray(data.files) || data.files.length !== files.length || data.files.some((file, index) => file !== files[index])) return null;
  const keys = ledgerInputKeys([{ ledger: data.ledger }]);
  return { files, keys };
}

/** A validated same-shard outcome's explicit owner, never inferred from its source or case name. */
export function outcomeOwnerRoute(part, failure, index) {
  const outcomes = part.phase?.testOutcomes;
  if (outcomes === undefined) return { legacy: true };
  if (!Array.isArray(outcomes) || !outcomes.length || outcomes.length > 100000) return null;
  const identities = new Set();
  for (const row of outcomes) {
    if (!row || !OUTCOME_KEYS.test(Object.keys(row).sort()) || !sourcePath(row.file) || ('owner' in row && !sourcePath(row.owner))
      || typeof row.name !== 'string' || !row.name || row.name.length > 8192 || /[\r\n\0]/u.test(row.name)
      || typeof row.passed !== 'boolean' || typeof row.skipped !== 'boolean'
      || ('failure' in row && (!/^(assertion|error)$/u.test(row.failure) || row.passed || row.skipped))) return null;
    const id = JSON.stringify([row.file, row.name]);
    if (identities.has(id)) return null;
    identities.add(id);
  }
  const matches = outcomes.filter(row => row.file === failure.file && row.name === failure.name);
  if (matches.length !== 1) return null;
  const row = matches[0];
  if (row.passed !== false || row.skipped !== false || !('owner' in row)) return { legacy: true };
  const selected = part.selected;
  const inputKey = selected?.keys?.[row.owner];
  if (!selected?.files?.includes(row.owner) || !INPUT_KEY.test(inputKey ?? '')) return null;
  return { file: row.owner, sourceFile: row.file, name: row.name, signature: part.phase?.failureSignatures?.[index] ?? null,
    shard: part.job, attempt: part.attempt ?? null, head: part.phase?.head ?? part.head ?? null, inputKey };
}

/** Resolve each failure only against the validated owner outcome from its own shard. */
export function combinedReceiptRouting(reds, failures) {
  const ownerRoutes = [];
  let ownerRoutesInvalid = false;
  if (failures) for (const part of reds) {
    const identities = new Set();
    for (let index = 0; index < (part.phase?.failures ?? []).length; index += 1) {
      const failure = part.phase.failures[index], identity = JSON.stringify([failure.file, failure.name]);
      const route = identities.has(identity) ? null : outcomeOwnerRoute(part, failure, index);
      identities.add(identity);
      if (!route) { ownerRoutesInvalid = true; ownerRoutes.push(null); }
      else ownerRoutes.push(route.legacy ? null : route);
    }
  }
  const keys = Object.fromEntries(reds.flatMap(part => {
    const own = ledgerInputKeys([part.phase]);
    return [...(part.phase?.failures ?? []), ...(part.phase?.errors ?? [])].filter(row => own[row?.file]).map(row => [row.file, own[row.file]]);
  }));
  return { ...(ownerRoutes.length ? { ownerRoutes, ownerRoutesInvalid } : {}), ...(Object.keys(keys).length ? { failedInputKeys: keys } : {}) };
}

/** Build comparison cases and input keys while preserving the original case identity beside its dispatch path. */
export function ownerComparisonCases(red, gate) {
  const signed = (phase, index) => Array.isArray(phase.failureSignatures) && /^[0-9a-f]{64}$/u.test(phase.failureSignatures[index] ?? '') ? phase.failureSignatures[index] : null;
  if (red.some(phase => phase.ownerRoutesInvalid === true || phase.ownerRoutes !== undefined && (!Array.isArray(phase.ownerRoutes) || phase.ownerRoutes.length !== phase.failures.length))) return null;
  const shardJobs = new Set((gate.shards ?? []).map(row => row?.job).filter(value => typeof value === 'string'));
  const inputKeys = ledgerInputKeys(red);
  for (const phase of red) for (const [file, key] of Object.entries(phase.failedInputKeys ?? {})) {
    if (!sourcePath(file) || !INPUT_KEY.test(key ?? '') || inputKeys[file] && inputKeys[file] !== key) return null;
    inputKeys[file] = key;
  }
  const cases = red.flatMap(phase => phase.failures.map(({ file, name }, index) => {
    const route = phase.ownerRoutes?.[index] ?? null;
    const row = { phase: String(phase.role), file, name, signature: signed(phase, index) ?? route?.signature ?? null };
    if (!route) return { ...row, caseFile: file };
    if (!Array.isArray(phase.ownerRoutes) || !sourcePath(route.file) || route.sourceFile !== file || route.name !== name
      || !/^[0-9a-f]{64}$/u.test(route.signature ?? '') || route.signature !== row.signature || !SHA.test(String(route.head)) || route.head !== gate.source
      || typeof route.shard !== 'string' || !shardJobs.has(route.shard) || !Number.isSafeInteger(route.attempt) || route.attempt < 1 || !INPUT_KEY.test(route.inputKey ?? '')
      || inputKeys[route.file] && inputKeys[route.file] !== route.inputKey) return null;
    inputKeys[route.file] = route.inputKey;
    return { ...row, file: route.file, caseFile: file, shard: route.shard, attempt: route.attempt, head: route.head };
  }));
  return cases.some(row => row === null) ? null : { cases, inputKeys };
}
