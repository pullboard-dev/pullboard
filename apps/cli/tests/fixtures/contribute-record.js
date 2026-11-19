/** The record text the contribute check tests write into a scratch project [C7]. */
export const GOOD = `rows:
  - G1.2
version: "0.9.5"
ran: pullboard next
blocks: nothing
bar:
  - 1: the command prints a line [test]
check:
  - 1: apps/cli/tests/x.test.js > prints a line
refusal: |
  NO_LINE: nothing printed
`;
