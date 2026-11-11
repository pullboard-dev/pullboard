/** Explicit, frozen machine authority never treats an evidence narrative as executable proof [V1,V4,H16]. */
import { createHash } from 'node:crypto';
import { criterionClauses } from '../../../../state/index.js';
import { Refused } from '../../../../kernel/index.js';

/** Bind opt-in to the exact acceptance bar; any later edit disables the old authorization. */
export function machineBarDigest(item) {
  return createHash('sha256').update(JSON.stringify([item.item_criterion, item.item_check, item.item_spec_ids, item.item_brief])).digest('hex');
}

/** Require one explicit executable command for every numbered command clause, with no missing or duplicate clauses. */
export function machineClauseCommands(item, commands) {
  const clauses = criterionClauses(item.item_criterion);
  if (!clauses.length || clauses.some(clause => clause.kind !== 'command')) {
    throw new Refused('MACHINE_JUDGMENT', 'machine verification requires every numbered clause to declare [command]; keep human review for judgment clauses');
  }
  if (!Array.isArray(commands) || commands.length !== clauses.length || commands.some((entry, index) =>
    !entry || entry.clause !== clauses[index].number || typeof entry.command !== 'string' || !entry.command.trim()
    || Object.keys(entry).sort().join(',') !== 'clause,command')) {
    throw new Refused('MACHINE_COMMANDS', 'supply one {clause, command} entry per numbered clause, in order');
  }
  return commands.map(({ clause, command }) => ({ clause, command: command.trim() }));
}

/** Validate native receipts against the frozen bar and exact composed source, never caller-written success flags. */
export function machineProofProblem(item, authorization, receipts, { commit, tree, main, seat, frozenCheck }) {
  const commands = [{ clause: 0, command: frozenCheck }, ...authorization.commands];
  if (!frozenCheck || !Array.isArray(receipts) || receipts.length !== commands.length) {
    return new Refused('MACHINE_PROOF', 'machine verification needs the frozen check and every clause receipt on the composed tree');
  }
  if (new Set(receipts.map(receipt => receipt?.id)).size !== receipts.length) return new Refused('MACHINE_PROOF', 'each machine command needs its own native receipt');
  for (const [index, entry] of commands.entries()) {
    const receipt = receipts[index];
    const hash = createHash('sha256').update(entry.command).digest('hex');
    if (!receipt || receipt.version !== 2 || receipt.green !== true || receipt.command !== hash || receipt.head !== commit || receipt.tree !== tree || receipt.main !== main
      || receipt.proof?.item !== item.item_id || receipt.proof?.frozenDigest !== item.item_frozen_digest
      || receipt.proof?.seat !== seat || receipt.proof?.exitCode !== 0 || receipt.proof?.sourceClean !== true) {
      return new Refused('MACHINE_PROOF', `machine ${entry.clause ? `clause ${entry.clause}` : 'frozen check'} has no matching green native receipt on the composed tree`);
    }
  }
  return null;
}
