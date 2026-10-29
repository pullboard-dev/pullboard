/** Keep only the bound proof receipt, so a run made up by hand never reaches a replica. */
export function prepareBefore(board, values, { args, ports }) {
  const receipt = ports.boundProofReceipt(board, args[0]);
  values[0] = { agentId: args[0].agentId, itemId: args[0].itemId, receipt };
}
