# RFC 0009: Contribution records

- Status: proposed, 8 November 2026. By Corey Olson.
- Builds on RFC 0005. Ids in brackets (CR1…) become spec rows with new ids on approval.

## Summary

An outside issue or PR is a **contribution record**: 2-3 short sentences for people, then strict YAML for machines. A shipped skill writes it and runs the gate locally. CI runs the same gate from base and decides. An accepted record files as a board item: title, rows, bar, check.

The record is host-independent. GitHub shows it as an issue or PR body.

## Motivation

This repository's 13 open issues and PRs, 8 November 2026:
- Bodies ran 25-1,472 words. As records: 30-170.
- Key facts were buried. A failed full gate read as "not run". Ruled-out fixes sat in prose. Legal blockers sat in a closing checklist.
- The shortest reports were too thin to act on.
- Maintainers rebuilt title, rows, bar and check by hand.

## Design

### Record [CR1]

- **Title:** the outcome, phrased as an item title. No type prefix, no row list.
- **Summary:**
  - 2-3 sentences, ≤20 words each, present tense. The thing, why, impact.
  - Names the real thing: command, refusal code, file.
  - Fields are canonical; the summary may restate cause or impact.
  - Constraints, failures and blockers stay in fields, never cut for length.
- **Nothing inherent:**
  - no kind (the template sets it);
  - no change list or size (the diff shows them);
  - no closing keywords;
  - nothing the gate computes (base commit, CLA, row status).

### Fields [CR2]

Closed key list; any other key is refused.

| Field | Shapes | Meaning |
|---|---|---|
| `rows` | all but Ask | Spec rows served, listed singly |
| `env` | Bug, Security, Flaky, Performance | Where seen, incl. local changes |
| `version` | Bug, Security, Flaky, Performance | Quoted |
| `ran` | Bug, Security | Command run |
| `cause` | Bug, Security, Flaky, Performance | Why, if known |
| `blocks` | Bug, Flaky, Performance | What it stops |
| `impact` | Security | What an attacker gains; who's exposed |
| `disclose` | Security | Public date; default 90 days |
| `test` | Flaky | `<test file> > <test name>` |
| `rate` | Flaky | `<failures>/<runs>`, one command |
| `since` | Flaky, Performance | First commit or version, if known |
| `metric` | Performance | What's measured, with unit |
| `baseline`, `measured` | Performance | `<number> at <commit>`, same command |
| `refs` | Fix | Same-repo issue numbers |
| `draft` | Fix, Proposal | `true` if not ready to land |
| `have`, `want` | Ask | `want`: `guidance` or `feature` |
| `conflicts_with`, `decision_needed` | Proposal | Approved rows it excepts; the call needed |
| `forbidden` | Bug, Fix | Ruled-out fixes; advisory until accepted |
| `compat` | Bug, Fix | Must keep working |
| `status` | Fix, Proposal | `failed`, `not_run`, `not_claimed`. Passes are proven by the gate, not claimed |
| `bar` | all but Ask | `n: clause [kind]` |
| `later_bar` | Proposal | What the implementation must prove |
| `check` | with `bar` | `n: <command>` per clause |
| `evidence` | Fix | `n: result`, for clauses the gate can't run |
| `refusal` / `error` | Bug | Exact text, last |

Order: one-line fields, lists, then bar, check, evidence, raw text last. The skill keeps it; the gate doesn't enforce it.

### Shapes [CR2a]

| Shape | For | Required |
|---|---|---|
| Bug | Something broke | `version`, `ran`, `blocks`, `bar`, `check`, `refusal`/`error` |
| Ask | Question or feature request | `have`, `want` |
| Fix | A change | `bar`, `check`; `rows` if it serves the spec |
| Proposal | New or changed rows | `rows`, `decision_needed`, `bar`; `later_bar` |
| Security | A vulnerability | `version`, `impact`, `disclose`, `bar` |
| Flaky | Passes and fails on one commit | `test`, `rate`, `env`, `bar` (`<n>/<n>` runs, `[measurement]`) |
| Performance | Slower or bigger | `metric`, `baseline`, `measured`, `bar` (threshold, `[measurement]`), `check` |

Security records are **never public**. The skill sends them through the private channel. The gate refuses a public Security-shaped issue or PR and hides its text.

### Clause kinds [CR3]

| Kind | `check` | Gate |
|---|---|---|
| `[test]` | `<test file in repo> > <test name>` | Head's test vs **base** source: the named test runs and fails on an assertion (not a load error, not zero tests). Vs head source: passes. |
| `[test, kept]` | same | **Base's** test vs head source: passes. Editing a kept test flags review. |
| `[command]` | allowlisted command | Exit code changes base → head as the clause states. |
| `[measurement]` | prints one number; threshold in clause | Re-measured on head against the threshold. |
| unverifiable here | `none` + reason | Shown unverified (e.g. Windows-only proof). A maintainer decides. |

- **The run:** the verdict comes from the gate's own reporter. Node is pinned. Paths resolve through symlinks and must stay inside the repository.
- **Base source:** base plus only the PR's test-directory changes (the test file, plus the helpers and fixtures it imports). A missing helper, import or symbol is a load error and doesn't count.
- **Limit:** CR3 proves a test is bound to the change, not that it means what the clause says. A test asserting only that a new symbol exists still passes. A maintainer judges meaning at acceptance, and the gate output says so.

### Skill [CR4]

`pullboard-contribute`:
- gathers facts and copies every constraint into `forbidden`, `compat` or `bar` before compressing;
- redacts secrets, tokens, home paths and hostnames;
- writes the record and runs the gate locally.

Submissions go out proper. CI decides.

### Gate [CR5]

Runs from base or a pinned release, never from the PR. Checks:
- **YAML:**
  - strict subset; closed keys;
  - no anchors, aliases, tags or multi-doc;
  - ASCII keys and ids; no bidi or zero-width characters anywhere;
  - ≤16 KB, ≤50 clauses.
- **Text:** summary limits; no links or images in title or summary; a secret scan.
- **References:**
  - rows resolve in **base's** spec, each reported approved, draft, or added-by-PR;
  - refs resolve in this repository.
- **Bar:** every clause has a check, run per CR3.
- **Profile:** the author has a signed CLA (CR7).
- **Gate paths:** a PR touching the gate, CI workflows, runners, test-runner config or the allowlist goes to review and doesn't run. Otherwise head's tests run under base's config.
- **`forbidden`:** shown to the maintainer, not checked. It's a judgment call.

**The format is required.** A failing record isn't triaged, filed or merged:
- A PR: the gate is a required check.
- An issue: it gets `needs-format` and stays out of triage.

**One comment explains every failure:** field or line, rule, fix, and the skill command that fixes it.
- Quotes are escaped and truncated, with mentions, links and URLs neutralized.
- The gate never closes anything, and it re-runs on every edit.
- Each result binds to the head commit plus a record hash.

### Acceptance [CR6]

- **Filing:** a maintainer accepts. The item files from the stored, hashed snapshot, not the live body. Comments never amend a record.
- **Builders:** they see only the accepted bar. Contributor text enters prompts as quoted data. `rows` and `forbidden` affect routing, priority or builders only after acceptance.
- **New rows:** rows a PR adds aren't approved by acceptance; they follow spec approval.

### Profile and CLA [CR7]

- **Signing:** a contributor registers a profile in the project's contribution system and signs, once, by typed name, an individual CLA modelled on the Apache ICLA.
- **Scope:** it covers all their contributions. Every contribution passes the gate under that profile.
- **Proof:** the profile system holds the signed record: name, email, account, CLA version and time. On a contributor's first PR, the gate posts their acceptance as a comment, so the host keeps a second witness.
- **In records:** nothing about it.

## Security [CR8]

Every field is untrusted. Beyond CR3-CR7:
- **Sandbox:**
  - throwaway and VM-isolated (gVisor or Firecracker class);
  - network off; read-only base; no secrets;
  - CPU, time and output caps.
- **CI:**
  - `pull_request`, never `pull_request_target` with a PR checkout;
  - a separate trusted workflow posts results as data;
  - one bot account replies.
- **Skill:** a pinned, signed release, made of data plus a fixed script.
- **Abuse:** a per-account rate limit, and a per-account cap on open `needs-format` threads.

## Costs

- **Contributors:**
  - sign once;
  - use the skill or write records by hand;
  - must pass the gate either way.
- **Maintainers:** keep the key list, the allowlist and the sandbox.
- **Nuance:** what fits no field goes in `not_claimed` and the summary.

## Who it affects

Opted-in repositories and their outside contributors. Off by default. This repository starts with 0.9.4: its issue templates use records, and `pullboard contribute check` checks one. The skill, profiles and the full gate follow.

## Measure

- Words per record, as filed vs as a record.
- Maintainer triage time.
- Records filed as items without rewriting.
- Gate refusals, and why.
