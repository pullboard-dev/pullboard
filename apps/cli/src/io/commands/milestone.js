/** The pullboard milestone command, in its own module so an item adding another command never edits these lines. */
import * as store from '../../../../../packages/store/index.js';
import { retainedReceipts } from '../../../../../packages/gate/index.js';
import { recordTimeCheckpoint } from '../../../../../packages/stats/index.js';
import { checkReleaseReferences } from '../../../../../packages/spec/index.js';
import {
  mainCheckout,
} from '../../../../../packages/git/index.js';
import {
  Refused,
} from '../../../../../packages/kernel/index.js';
import { requirePersonChannel } from '../../../../../packages/person/index.js';
import {
  actOn,
  ordered,
} from '../entry.js';

/** Run `pullboard milestone` and return its exit code. */
export async function run(io, { first, second, rest, values }) {
  const act = (work) => actOn(io, work);
  return act(async (ctx, board, me) => {
  const ids = (text) => (text ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  let name;
  let entry;
  if (values.limit !== undefined && first !== 'edit' || values.swap !== undefined && first !== 'items') throw new Refused('USAGE', 'use milestone edit --limit <n>|none, or milestone items --add <id> --swap <id>');
  if (first === 'focus') {
    if (!second || rest.length || (values.overflow !== undefined && !['on', 'off'].includes(values.overflow))) {
      throw new Refused('USAGE', 'pullboard milestone focus <name|off> [--overflow off|on]');
    }
    if (second !== 'off' && !store.milestones(board).some(value => value.name === second)) {
      throw new Refused('NO_MILESTONE', `no milestone named ${second}`);
    }
    const common = { agentId: me.id, reason: 'Set release focus', window: { activeItems: null } };
    await ordered(ctx, board, 'setLineSetting', [{ ...common, key: 'focusMilestone', value: second === 'off' ? false : { name: second, overflow: values.overflow === 'on' } }]);
    io.result?.({ focus: second === 'off' ? null : second, overflow: values.overflow === 'on' });
    io.say(second === 'off' ? 'milestone focus cleared' : `milestone focus: ${second}; overflow ${values.overflow ?? 'off'}`);
    return 0;
  } else if (first === 'add') {
    if (!second || rest.length || values.before !== undefined || values.add !== undefined || values.remove !== undefined || values.name !== undefined) {
      throw new Refused('USAGE', 'pullboard milestone add <name> [--note ...] [--items 1,2,3]');
    }
    name = await ordered(ctx, board, 'addMilestone', [{ agentId: me.id, name: second, note: values.note ?? null, items: ids(values.items), ...(values.reason === undefined ? {} : { reason: values.reason }) }]);
  } else if (first === 'items') {
    if (!second || rest.length || Boolean(values.add) === Boolean(values.remove) || (values.swap !== undefined && (!values.add || values.remove)) || values.items !== undefined || values.note !== undefined || values.before !== undefined || values.name !== undefined) {
      throw new Refused('USAGE', 'pullboard milestone items <name> --add ids [--swap id] [--reason "<why>"] or --remove ids');
    }
    name = second;
    const next = await ordered(ctx, board, 'editMilestoneItems', [name, {
      agentId: me.id,
      add: values.add === undefined ? [] : ids(values.add),
      remove: values.remove === undefined ? [] : ids(values.remove),
      ...(values.swap === undefined ? {} : { swap: ids(values.swap) }),
      ...(values.reason === undefined ? {} : { reason: values.reason }),
    }]);
    entry = { ...store.milestones(board).find((value) => value.name === name), items: next };
  } else if (first === 'order') {
    if (!second || rest.length !== 1 || !rest[0].trim() || values.items !== undefined || values.note !== undefined || values.before !== undefined || values.name !== undefined || values.add !== undefined || values.remove !== undefined) {
      throw new Refused('USAGE', 'pullboard milestone order <name> <ids>');
    }
    name = second;
    await ordered(ctx, board, 'orderMilestoneItems', [name, { agentId: me.id, items: ids(rest[0]), ...(values.reason === undefined ? {} : { reason: values.reason }) }]);
  } else if (['pin', 'sink', 'lift'].includes(first)) {
    if (!second || rest.length !== 1 || !rest[0].trim() || ['items', 'note', 'before', 'name', 'add', 'remove', 'target'].some((key) => values[key] !== undefined)
      || (first === 'lift') !== (values.reason === undefined)) {
      throw new Refused('USAGE', first === 'lift' ? 'pullboard milestone lift <name> <ids>' : `pullboard milestone ${first} <name> <ids> --reason "<why>"`);
    }
    name = second;
    await ordered(ctx, board, 'orderMilestoneItems', [name, { agentId: me.id, items: ids(rest[0]), place: first, ...(first === 'lift' ? {} : { reason: values.reason }) }]);
  } else if (first === 'move') {
    if (!second || rest.length || !values.before || values.items !== undefined || values.note !== undefined || values.name !== undefined || values.add !== undefined || values.remove !== undefined) {
      throw new Refused('USAGE', 'pullboard milestone move <name> --before <other>');
    }
    name = second;
    await ordered(ctx, board, 'moveMilestone', [name, { agentId: me.id, before: values.before }]);
    entry = store.milestones(board).find((value) => value.name === name);
  } else if (first === 'edit') {
    if (!second || rest.length || (values.name === undefined && values.note === undefined && values.target === undefined && values.limit === undefined && values.mode === undefined) || values.items !== undefined || values.before !== undefined || values.add !== undefined || values.remove !== undefined || values.next !== undefined) {
      throw new Refused('USAGE', 'pullboard milestone edit <name> [--name <new name>] [--note <text>] [--target <date and time>|none] [--limit <n>|none] [--mode rollover|explicit]');
    }
    if (values.as !== undefined && values.as !== 'person' || values.as === 'person' && (values.limit === undefined || !ctx.info.isMain)) {
      throw new Refused('USAGE', 'a raised milestone limit belongs to the person in the primary checkout: milestone edit <name> --limit <n>|none --as person');
    }
    if (values.as === 'person') requirePersonChannel(ctx.io.personChannel);
    name = second;
    entry = await ordered(ctx, board, 'editMilestone', [name, { agentId: me.id, newName: values.name, note: values.note, ...(values.target === undefined ? {} : { target: store.canonicalMilestoneTarget(values.target) }), ...(values.limit === undefined ? {} : { limit: values.limit }), ...(values.mode === undefined ? {} : { mode: values.mode }), ...(values.as === 'person' ? { asPerson: true, channel: 'terminal' } : {}) }]);
    name = entry.name;
  } else if (first === 'ship') {
    if (!second || rest.length || ['items', 'note', 'before', 'name', 'add', 'remove', 'target'].some((key) => values[key] !== undefined)) {
      throw new Refused('USAGE', 'pullboard milestone ship <name> [--next <name>]');
    }
    if (values.as !== undefined && values.as !== 'person' || values.as === 'person' && !ctx.info.isMain || values.reason !== undefined && values.as !== 'person') {
      throw new Refused('USAGE', 'a release override belongs to the person in the primary checkout: milestone ship <name> --as person --reason \"why\"');
    }
    name = second;
    checkReleaseReferences(ctx.info.root, board, name, mainCheckout(ctx.info.root)?.commit ?? null, store);
    const shipped = await ordered(ctx, board, 'shipMilestone', [name, { agentId: me.id, coordinatorActions: true, commit: mainCheckout(ctx.info.root)?.commit ?? null, ...(values.next === undefined ? {} : { next: values.next }), ...(values.as === 'person' ? { asPerson: true, reason: values.reason, channel: 'terminal' } : {}) }]);
    recordTimeCheckpoint(ctx, board, { reason: 'release', label: name, retainedReceipts, events: store.events });
    io.result?.(shipped);
    const outcome = shipped.moved.length ? `moved ${shipped.moved.map((id) => `#${id}`).join(', ')} into ${shipped.into}` : 'no local items moved';
    const external = shipped.notMoved.length ? `; not moved across boards: ${shipped.notMoved.join(', ')}` : '';
    io.say(`milestone shipped: ${name} at ${shipped.milestone.shipped.commit}; ${outcome}${external}`);
    return 0;
  } else if (first === 'remove') {
    if (!second || rest.length || values.items !== undefined || values.note !== undefined || values.before !== undefined || values.name !== undefined || values.add !== undefined || values.remove !== undefined) {
      throw new Refused('USAGE', 'pullboard milestone remove <name>');
    }
    name = second;
    await ordered(ctx, board, 'removeMilestone', [name, { agentId: me.id }]);
    entry = { name };
  } else {
    throw new Refused('USAGE', 'use pullboard milestone add, items, order, pin, sink, lift, move, edit, ship or remove');
  }
  entry ??= store.milestones(board).find((value) => value.name === name);
  const pins = first === 'order' ? (entry.order ?? []).filter(id => Object.hasOwn(entry.reasons ?? {}, String(id))) : [];
  io.result?.({ milestone: entry, ...(first === 'order' ? { pins } : {}) });
  if (pins.length) io.say(`pins keep their place ahead of this order: ${pins.map(id => '#' + id).join(', ')}; lift a pin explicitly to change that`);
  io.say(`milestone ${first === 'remove' ? 'removed' : first === 'add' ? 'added' : 'updated'}: ${name}`);
  return 0;
});
}
