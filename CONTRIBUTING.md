# Contributing

Thanks for helping. A few rules keep the project small and predictable.

- No dependencies, neither runtime nor dev. Use the Node standard library.
- Code must run unchanged on Windows, macOS and Linux. Use `path.join`, spawn with an argument
  array and `shell: false`, handle CRLF input.
- Compression must stay deterministic and lossless. A new rule needs a test that rebuilds the
  original from the kept lines plus the expanded handles, or shows the exact span for JSON.
- Tests use `node:test`, the `fake` provider and local sockets only. Run `node --test`.
- If a change affects the README numbers, run `node scripts/bench.js` and paste the new table.
- Write plain sentences in docs and messages. No em or en dash characters.
