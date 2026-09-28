// How the page runs a simulation: a function it is given, so tests can run it in-process while the app
// runs it in a Web Worker.
import type { Scenario, SystemConfig } from '../engine/config/schema';
import { compareRuns, type Comparison } from '../engine/simulator/compare';

export interface SimulationInput {
  readonly original: SystemConfig;
  readonly mitigated: SystemConfig;
  readonly scenario: Scenario;
}

export type WorkerReply = { readonly ok: true; readonly comparison: Comparison } | { readonly ok: false; readonly message: string };

/** Runs the comparison; aborting the signal cancels it and rejects with an AbortError. */
export type RunSimulation = (input: SimulationInput, signal: AbortSignal) => Promise<Comparison>;

/** The app's runner: a fresh worker per run, terminated when it answers or when the run is cancelled. */
export const runInWorker: RunSimulation = (input, signal) =>
  new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./simulationWorker.ts', import.meta.url), { type: 'module' });
    const finish = () => {
      worker.terminate();
      signal.removeEventListener('abort', cancel);
    };
    const cancel = () => {
      finish();
      reject(new DOMException('The simulation was cancelled.', 'AbortError'));
    };
    signal.addEventListener('abort', cancel);
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      finish();
      if (event.data.ok) resolve(event.data.comparison);
      else reject(new Error(event.data.message));
    };
    worker.onerror = (event) => {
      finish();
      reject(new Error(event.message || 'The simulation stopped unexpectedly.'));
    };
    worker.postMessage(input);
  });

/** Runs in the calling thread; for tests, where there is no worker. */
export const runInProcess: RunSimulation = async (input, signal) => {
  const comparison = compareRuns(input.original, input.mitigated, input.scenario);
  if (signal.aborted) throw new DOMException('The simulation was cancelled.', 'AbortError');
  return comparison;
};
