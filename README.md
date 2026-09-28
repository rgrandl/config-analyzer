# Config Interaction Analyzer

**Live app:** https://rgrandl.github.io/config-analyzer/

In a system of services, each team tunes its own settings. Each choice can be reasonable on its own while the
combination fails under stress: retries multiply across layers, callers give up before callees can answer, and
queues fill with work nobody is waiting for. Such a failure can outlast its cause.

This tool takes a service call graph with its resilience settings (timeouts, retries, backoff, retry budgets,
deadlines, queues) and:

1. **Finds** settings that are risky together, with the numbers behind each finding.
2. **Recommends** one conservative change per finding. Changes only tighten settings; timeouts and deadlines are
   never raised.
3. **Simulates** the original and the mitigated config under the same traffic and fault, and shows the difference
   in recovery, goodput, queues, retries and wasted work.

Everything runs in the browser; nothing is sent anywhere. The full design, with the formulas, the simulator's
semantics and the measured demo results, is in [DESIGN.md](DESIGN.md).

## Using the demo

The demo loads on the first visit: `api` calls `orders`, which calls `db` twice. The scenario sends 140 requests/s
for 60 s and slows `db` down 5× from 10 to 20 s.

- **One click:** "Quick demo: apply all 12 fixes and simulate" at the top applies every fix, runs the simulation
  and scrolls to the results. The original config never recovers after the fault; the mitigated one recovers as
  soon as it ends.
- **Step by step:**
  1. **Configure.** "Edit the config" opens the two YAML documents: the System tab (services and their settings;
     the findings come from this) and the Scenario tab (the traffic and the fault). Comments at the top of each
     explain every field. Errors are listed with their field path. "Reset to demo" puts the demo back.
  2. **Review the findings.** The call graph shows each service's finding count. Findings are sorted high first;
     each title states the consequence with its number, e.g. "A full db queue holds 2.5 s of work, but orders
     waits 150 ms". "Why?" opens the explanation and highlights the finding in the graph. Uncheck fixes to try a
     subset.
  3. **Apply the mitigations.** Shows every change applied, the changes left out as not needed, and a re-check of
     the mitigated config. The mitigated YAML can be copied into the editor.
  4. **Simulate.** Runs four simulations (original and mitigated, with and without the fault) and shows whether
     each config recovers, the numbers side by side, and charts for the whole run and for any one service.

To see which changes matter, uncheck some fixes (for example the deadline-propagation ones) and run again.

## Key assumptions

The analyzer and the simulator share one model of how services behave:

- **One aggregated instance per service**, with a fixed number of workers. Each request holds a worker for its
  whole life, including while it waits on calls and during backoff (thread-per-request).
- **FIFO queues.** A full queue rejects new requests immediately.
- **Calls are sequential**, in the order listed. A service does its own work first, then its calls.
- **Timeouts are per attempt** and cover the network round trip. The network adds a fixed one-way latency.
- **Every failure is retryable** (rejection, error, timeout, dropped request) and operations are idempotent. End
  users send one attempt and never retry.
- **Deadline propagation** means a service honors its caller's deadline, drops queued work that is already too late
  at no cost, and passes the remaining time on.
- **Traffic** is random (Poisson) arrivals at a fixed rate. Service times vary uniformly around their mean.
- **The analyzer uses worst cases** for latency (the longest service time, every attempt timing out, the full
  backoff) and means for capacity. Its healthy latencies ignore queueing; the simulator shows what queueing does.
- **Recovery** means that, after the last fault ends, every 1 s window of arriving requests succeeds at no less than
  90% of the success ratio before the fault, for 3 s in a row (configurable in the scenario).

## Limitations

- Only resilience settings: timeouts, retries, backoff and jitter, retry budgets, deadline propagation and queue
  sizes. No circuit breakers, connection pools, hedging, rate limiting, load shedding or adaptive queues.
- No parallel fan-out: calls from one service run one after another. The graph must be acyclic.
- One conservative fix per finding. Some findings have none: a service too slow for its caller's timeout even when
  healthy needs a person to decide (the tool never raises a timeout or a deadline).
- Its own YAML format only; no import from Envoy, Istio, Resilience4j or other real configs.
- A simulation stops after 5 million events and shows a partial result marked as such. Long runs at high request
  rates can reach that.
- The timeout floor multiplier (2) is fixed in the UI.

## Known quirks

- **The mitigated config also serves almost nothing during the demo's fault.** Its db queue is capped for the db's
  healthy speed, so while the db is 5× slower, queued requests expire and are dropped. The mitigations change what
  happens after the fault, not during it; the page says so next to the results. Keeping partial goodput under
  overload would need adaptive or LIFO queues.
- **Wasted work is a lower bound.** Only work for a caller that has already given up counts; work for a caller whose
  own caller has given up counts as useful.
- **Numbers can differ slightly between browsers** for the same seed, because arrival times use `Math.log`. Within
  one browser, runs are exactly reproducible, and all runs in a comparison happen in the same browser.
- **Two charts measure time differently.** Goodput counts successes by completion time (averaged over 1 s);
  the success ratio, and recovery, count requests by arrival time. The recovery marker lines up with the success
  ratio view.
- **Retry guards on a call that no longer retries are left out.** When the selected fixes make a call a single
  attempt, its backoff and retry-budget changes are listed as "not needed" instead of applied.
- **Results are kept when inputs change.** Editing the config, the scenario or the selection marks the results out
  of date, with a button to run again, rather than clearing them.
- **Faults must end early enough to confirm recovery:** at or before the run's end minus the recovery hold minus the
  user deadline. The scenario validation says so when one does not.

## Run locally

Requires Node 22 or later.

```sh
npm install
npm run dev        # dev server
npm test           # unit, simulator and UI smoke tests
npm run typecheck  # TypeScript checks
npm run build      # production build into dist/
```

Pushing to `main` runs the tests, builds, and deploys to GitHub Pages.

## Layout

```
src/
  engine/        pure TypeScript, no React (enforced by tests/engine/boundary.test.ts)
    config/      input schema, parsing, validation, call graph, shared formulas
    analyzer/    budget math, the five rules, findings, mitigation
    simulator/   discrete-event simulator, metrics, recovery, run comparison
  ui/            React components, chart data, the simulation Web Worker
  demo/          demo system and scenario
tests/           mirrors src/
```
