import { hostname } from 'node:os';

/** The name this machine goes by in the project list: its host name without the network domain. */
export function viewMachineName(name = hostname()) {
  return String(name).trim().split('.')[0];
}
