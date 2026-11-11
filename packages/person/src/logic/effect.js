/** Signed bar intent binds normalized author fields, never local paths or generated baseline receipts [E22,V1]. */
import { Refused } from "../../../kernel/light.js";

const FIELDS = {
  add: ['by', 'lane', 'title', 'criterion', 'specIds', 'parentId', 'after', 'brief', 'route', 'check'],
  edit: ['agentId', 'brief', 'route', 'criterion', 'check', 'after', 'reason', 'reviewTier'],
  'bar-sign': ['revision', 'digest', 'note', 'coverage'],
};
/** Select author-controlled fields with omission preserved; generated evidence and identity cannot ride along. */
export function barEffectValues(verb, value) {
  return Object.fromEntries(FIELDS[verb].filter(key => value[key] !== undefined).map(key => [key, structuredClone(value[key])]));
}
/** Validate the bounded signed envelope without reading local files during relay replay. */
export function normalizePersonBarEffect(verb, effect) {
  if (!FIELDS[verb] || !effect || effect.version !== 1 || !effect.value || typeof effect.value !== 'object' || Array.isArray(effect.value)
      || Object.keys(effect).some(key => !['version', 'value', 'before'].includes(key))
      || (verb === 'add' && !['coordinator', 'person'].includes(effect.value.by))
      || (verb === 'edit' && effect.value.agentId !== 'coordinator')
      || Object.keys(effect.value).some(key => !FIELDS[verb].includes(key))
      || ['lane', 'title', 'criterion', 'brief', 'route', 'check', 'reason', 'note', 'digest', 'reviewTier'].some(key => effect.value[key] !== undefined && typeof effect.value[key] !== 'string')
      || ['specIds', 'after'].some(key => effect.value[key] !== undefined && (!Array.isArray(effect.value[key])
        || effect.value[key].some(value => key === 'specIds' ? typeof value !== 'string' : !Number.isSafeInteger(value) || value < 1)))
      || (effect.value.parentId !== undefined && effect.value.parentId !== null && (!Number.isSafeInteger(effect.value.parentId) || effect.value.parentId < 1)) || JSON.stringify(effect).length > 524288
      || (verb === 'add' ? effect.before !== undefined : !effect.before || !Number.isSafeInteger(effect.before.revision)
        || effect.before.revision < 0 || !/^[a-f0-9]{64}$/u.test(effect.before.digest ?? '')
        || Object.keys(effect.before).sort().join() !== 'digest,revision')) {
    throw new Refused('PERSON_REQUEST_RECEIPT', 'this bar request needs its exact normalized fields and current revision; show and confirm it again');
  }
  return { version: 1, value: barEffectValues(verb, effect.value), ...(effect.before ? { before: { revision: effect.before.revision, digest: effect.before.digest } } : {}) };
}
/** Compare complete JSON structures independent of object insertion order, retaining array order and omissions. */
export function sameBarEffect(left, right) {
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

/** Turn literal paired-browser fields into the exact displayed effect; native execution rechecks all policy. */
export function browserPersonBarEffect(state, move) {
  const args = move.args;
  const ids = text => text ? text.split(',').map(part => part.trim()).filter(Boolean) : [];
  const number = text => {
    if (!/^#?[1-9][0-9]*$/u.test(text ?? '')) throw new Refused('BAD_REQUEST', 'use an exact positive item id in this bar request');
    const value = Number(text.replace(/^#/u, ''));
    if (!Number.isSafeInteger(value)) throw new Refused('BAD_REQUEST', 'this item id is too large');
    return value;
  };
  let value;
  let before;
  if (move.verb === 'add') {
    value = { by: 'person', lane: args.lane, title: args.title, criterion: args.criterion ?? '', specIds: ids(args.specs),
      parentId: args.parent ? number(args.parent) : null, after: ids(args.after).map(number), brief: args.brief ?? '', route: args.route ?? 'strong',
      ...(args.check === undefined ? {} : { check: args.check }) };
  } else {
    const current = state.personBars?.find(entry => entry.id === move.item);
    if (!current) throw new Refused('BAR_SIGN_STALE', 'refresh this board to see its current bar revision before confirming');
    before = current.before;
    if (move.verb === 'edit') {
      value = { agentId: 'coordinator', ...Object.fromEntries(['brief', 'route', 'criterion', 'check', 'reason'].filter(key => args[key] !== undefined).map(key => [key, args[key]])),
        ...(args['review-tier'] === undefined ? {} : { reviewTier: args['review-tier'] }),
        ...(args.after === undefined ? {} : { after: args.after.trim() === 'none' ? [] : ids(args.after).map(number) }) };
    } else {
      if (!current.coverage) throw new Refused('BAR_COVERAGE', 'prepare the required recorded coverage with pullboard bar sign --coverage-file from a terminal, then confirm its exact proposal here');
      value = { revision: before.revision, digest: before.digest, note: args.note, coverage: current.coverage };
    }
  }
  return normalizePersonBarEffect(move.verb, { version: 1, value, ...(before ? { before } : {}) });
}
