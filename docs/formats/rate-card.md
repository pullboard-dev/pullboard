# Machine-local runner rate card

## Machine-local runner rate card

A runner's rate card is part of the machine's `settings.json`, as `runnerRates`: a map from a runner host to `{price, months, watts, kwhPrice}` (purchase price, whole months to pay it off, load watts and power price per kWh, each a number of 0 or more and months 1 or more). Set one with `pullboard settings runnerRates <runner> <price> <months> <watts> <kwhPrice>`; a missing or invalid field refuses with `BAD_RUNNER_RATES` and stores nothing.
