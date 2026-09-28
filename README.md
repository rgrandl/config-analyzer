# Config Interaction Analyzer

Finds resilience settings (timeouts, retries, queues, deadlines) that are reasonable for each service on its own
but risky in combination, recommends one conservative mitigation per finding, and simulates the original and
mitigated configs side by side.

**Status:** under construction. The design is in [DESIGN.md](DESIGN.md).

**Live app:** https://rgrandl.github.io/config-analyzer/

## Run locally

Requires Node 22 or later.

```sh
npm install
npm run dev        # dev server
npm test           # unit tests
npm run typecheck  # TypeScript checks
npm run build      # production build into dist/
```

## Layout

```
src/
  engine/        pure TypeScript, no React (enforced by tests/engine/boundary.test.ts)
    config/      input schema, parsing, validation, call graph
    analyzer/    budget math, rules, findings, mitigation
    simulator/   discrete-event simulator, metrics, run results, recovery
  ui/            React components
  demo/          demo system and scenario
tests/           mirrors src/
```
