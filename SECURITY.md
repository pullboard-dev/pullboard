# Security

Please report a vulnerability privately, through **Report a vulnerability** on this repository's Security tab, rather than in a public issue. Say what you found, how to reproduce it, and what it affects. You'll get an answer within a few days.

What Pullboard does and doesn't touch:

- The CLI runs locally and opens no outbound network connection; its boundary test (`test/boundary.test.js`) keeps it that way. The opt-in relay, once it ships, will be the one exception, and only when you turn it on. `pullboard view` listens on 127.0.0.1 only, behind a per-session secret.
- The board lives in your repo's `.git` directory and never goes into a commit.
- The CLI runs the commands your repo configures (the gate, checks, fixers), as you would at a terminal. A repo's `pullboard.json` can name any command, so treat it like any other script in a repo you clone.
- The relay, once it ships, will hold board records, never code, and will never write to a repository.
