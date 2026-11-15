/** Preserved gate command-group help, composed in its original display order. */
export const gateHelp = `Gate and hooks
  pullboard push-receipts               additive check of Git pre-push stdin, native receipts and accepted-policy smoke; does not replace the active hook
  pullboard gate [--landing [--receipt]]  run the configured gate; --receipt produces fresh native landing evidence
  pullboard gate --withdraw <id>         stop the item's queued or running gate; its holder or the coordinator; submit again to start a new one
  pullboard gate set "<command>"         record the project gate in the main checkout; commit it before running the gate
  pullboard hook pre-commit|pre-merge-commit|commit-msg|pre-push   git runs these

`;
