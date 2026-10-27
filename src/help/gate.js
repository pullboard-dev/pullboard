/** Preserved gate command-group help, composed in its original display order. */
export const gateHelp = `Gate and hooks
  pullboard push-receipts               additive check of Git pre-push stdin, native receipts and accepted-policy smoke; does not replace the active hook
  pullboard gate [--landing]            run the configured gate; prioritize a trunk landing in the machine queue
  pullboard gate set "<command>"         record the project gate in the main checkout; commit it before running the gate
  pullboard hook pre-commit|pre-merge-commit|commit-msg|pre-push   git runs these

`;
