/** Seal the advanced source at its origin; replicas replay these bytes [C7,V4,H16]. */
export function prepareBefore(board, values, { args, ports }) {
  values[1] = ports.sealSourceAdvance(board, values[0], args[1]);
}
