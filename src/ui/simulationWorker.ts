// Runs the four simulations off the main thread, so the page stays responsive and the run can be cancelled.
// Receives the two configs and the scenario; answers with the comparison or an error message.
import { compareRuns } from '../engine/simulator/compare';
import type { SimulationInput, WorkerReply } from './simulation';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<SimulationInput>) => void) | null;
  postMessage: (reply: WorkerReply) => void;
};

scope.onmessage = (event) => {
  try {
    const { original, mitigated, scenario } = event.data;
    scope.postMessage({ ok: true, comparison: compareRuns(original, mitigated, scenario) });
  } catch (error) {
    scope.postMessage({ ok: false, message: error instanceof Error ? error.message : String(error) });
  }
};
