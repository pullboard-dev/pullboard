/** Record native outcomes and report quarantine without changing any process or gate verdict [C7,H16]. */
import { COORDINATOR } from './config.js';
import { laneOf } from './lanes.js';
import { readGateReceipt } from './gate-run-receipt.js';
import { receiptStore } from './gate-run-receipt.js';
import { flakeQuarantines } from './quarantine.js';
import { quarantineOn } from './quarantine.js';

/** Capture owner lanes at the sender; replay consumes recorded ids and never resolves receiver files. */
export function receiptRecorder(ctx, { agentId, acceptedConfig, board, ordered, withBoard }) {
  return async receiptId => {
    const receipt = readGateReceipt(receiptStore(ctx.info.root), receiptId);
    if (!receipt || agentId !== COORDINATOR && !(receipt.version === 2 && receipt.testOutcomes && receipt.proof.seat === agentId)) return;
    const files = [...new Set((receipt.testOutcomes ?? receipt.failures).map(row => row.file))];
    const owners = Object.fromEntries(files.map(file => {
      const owner = laneOf(acceptedConfig, file);
      return [file, owner === COORDINATOR ? Object.keys(acceptedConfig.lanes)[0] : owner];
    }));
    const lane = owners[files[0]] ?? Object.keys(acceptedConfig.lanes)[0];
    /** Report matching active identities after recording, retaining the actual failed count and exit. */
    const write = async target => {
      await ordered(ctx, target, 'recordGateRun', [{ agentId, receipt, lane, ...(receipt.testOutcomes ? { owners } : {}) }]);
      if (!quarantineOn(target) || !receipt.testOutcomes) return;
      const active = flakeQuarantines(target).filter(row => row.nativeCore && row.status === 'quarantined');
      for (const row of receipt.testOutcomes) {
        const entry = active.find(value => value.file === row.file && value.name === row.name);
        if (entry && !row.skipped) ctx.io.say(`quarantined: ${row.file} :: ${row.name} (repair #${entry.item}); actual ${row.passed ? 'pass' : 'fail'}, blocking verdict unchanged`);
      }
    };
    await (board ? write(board) : withBoard(ctx, write));
  };
}
