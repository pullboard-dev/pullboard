/** The pullboard field command: declare a typed item field and set it on an item, behind items.typedFields (#9351, #1321) [C7]. */
import { typedFieldsEnabled } from '../../../../../packages/config/index.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import * as store from '../../../../../packages/store/index.js';
import { actOn } from '../entry.js';
import { idArg } from '../entry.js';

const USAGE = 'pullboard field declare <name> <text|choice|number> [--choices a,b] | pullboard field set <id> <name> <value>';

/**
 * Read a typed value from its command-line text: a number field takes a number, anything else stays text.
 * Why here: the store judges the value's type, so a number field given "abc" must reach it as a string and be refused there.
 */
function valueFor(board, name, text) {
  const decl = board.db.prepare("SELECT field_type FROM field_decl WHERE field_name=?").get(name);
  return decl?.field_type === 'number' && text.trim() !== '' && Number.isFinite(Number(text)) ? Number(text) : text;
}

/** Run `pullboard field declare ...` or `pullboard field set ...` and return its exit code. */
export async function run(io, { first, second, rest, values }) {
  const enabled = typedFieldsEnabled();
  if (first === 'declare' && second && rest.length === 1) {
    const choices = typeof values.choices === 'string' ? values.choices.split(',').map(choice => choice.trim()).filter(Boolean) : [];
    return actOn(io, (ctx, board, me) => {
      const declared = store.declareItemField(board, { by: me.id, name: second, type: rest[0], choices, enabled });
      io.result?.({ field: declared });
      io.say(`declared ${declared.type} field ${declared.name}${declared.choices.length ? ` (${declared.choices.join(', ')})` : ''}`);
      return 0;
    });
  }
  if (first === 'set' && second && rest.length >= 2) {
    const id = idArg(second);
    const [name, ...text] = rest;
    return actOn(io, (ctx, board, me) => {
      if (!enabled) throw new Refused('FIELDS_OFF', 'typed item fields are off', 'turn on items.typedFields in the machine settings first');
      const set = store.setItemField(board, { by: me.id, id, name, value: valueFor(board, name, text.join(' ')), enabled });
      io.result?.({ field: set });
      io.say(`set ${name} on #${id} to ${set.value}`);
      return 0;
    });
  }
  throw new Refused('USAGE', 'field takes declare or set', USAGE);
}
