/** Preserved outside command-group help, composed in its original display order. */
export const outsideHelp = `Outside contributions
  pullboard intake <GitHub PR URL> --criterion "behavior" --check "command" [--lane <lane>]  record exact outside author/commit, already submitted; never execute it here
  pullboard intake <GitHub issue URL>  record author, source state and maintainer reply; repeating intake refreshes metadata
  pullboard verify <id> accept [--sandbox] --note "proof"  configured Docker only, no network/credentials, Node22.13 and24; required for outside items; missing provider refuses
  pullboard intake approve <id>        owner/person approval for the exact sensitive outside commit; every PR result post still needs separate person OK

`;
