// The discrete-event simulator (DESIGN.md §9): workers, queues, attempts, timeouts, retries, deadlines
// and faults, driven by one event queue. It honors the contracts shared with the budget math by calling the
// same functions (config/semantics.ts) and is deterministic: every random draw is keyed by logical identity.
import { CallGraph, type CallEdge } from '../config/callGraph';
import type { Fault, Ms, Scenario, ServiceConfig, SystemConfig } from '../config/schema';
import { carriedDeadlineMs, localWorkMs } from '../config/semantics';
import { afterFailure, attemptTimeout } from './clientPolicy';
import { EventQueue } from './eventQueue';
import { keyedUniform, mixHash, Purpose } from './keyedRandom';
import { MetricsCollector } from './metrics';
import type { RequestOutcome, Runner, RunResult } from './types';

/** By default a run stops, marked truncated, after this many events. */
export const MAX_EVENTS = 5_000_000;

export interface SimulatorOptions {
  /** Event cap; lower it in tests to exercise truncation. */
  maxEvents?: number;
}

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

interface ServiceRuntime {
  readonly name: string;
  readonly config: ServiceConfig;
  readonly calls: CallRuntime[];
  readonly faults: readonly Fault[];
  readonly queue: Job[];
  queueHead: number;
  busy: number;
  readonly running: Set<Job>;
}

interface CallRuntime {
  readonly edge: CallEdge;
  /** Position in graph.calls; part of the random keys of the jobs this call creates. */
  readonly index: number;
  readonly callee: ServiceRuntime;
  /** Retry-budget tokens; Infinity when the call has no budget. */
  tokens: number;
}

/** One request from a caller (a job, or the end user when `callerJob` is undefined) to a callee. */
interface Attempt {
  readonly request: RequestState;
  readonly callerJob: Job | undefined;
  readonly callee: ServiceRuntime;
  readonly attemptNo: number;
  readonly sentAtMs: Ms;
  readonly timeoutMs: Ms;
  /** Identifies the callee's job for random draws: the caller's path plus this call and attempt. */
  readonly pathHash: number;
  status: 'pending' | 'answered' | 'timedOut';
}

/** Work a service does for one attempt it received. */
interface Job {
  readonly service: ServiceRuntime;
  readonly attempt: Attempt;
  readonly deadlineMs: Ms;
  startedAtMs: Ms;
  failsLocally: boolean;
  callIndex: number;
  nextAttemptNo: number;
}

interface RequestState {
  readonly index: number;
  readonly outcome: RequestOutcome;
}

type SimEvent =
  | { readonly kind: 'userArrival'; readonly request: RequestState }
  | { readonly kind: 'attemptArrives'; readonly attempt: Attempt }
  | { readonly kind: 'workDone'; readonly job: Job }
  | { readonly kind: 'attemptTimeout'; readonly attempt: Attempt }
  | { readonly kind: 'response'; readonly attempt: Attempt; readonly ok: boolean }
  | { readonly kind: 'retryReady'; readonly job: Job };

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export function createSimulator(options: SimulatorOptions = {}): Runner {
  const maxEvents = options.maxEvents ?? MAX_EVENTS;
  return { run: (system, scenario, arrivals) => new Simulation(system, scenario, arrivals, maxEvents).run() };
}

/** The simulator with default options. */
export const simulator: Runner = createSimulator();

class Simulation {
  private readonly events = new EventQueue<SimEvent>();
  private readonly services = new Map<string, ServiceRuntime>();
  private readonly metrics: MetricsCollector;
  private readonly requests: RequestState[];
  private readonly latencyMs: Ms;
  private readonly entry: ServiceRuntime;
  private now: Ms = 0;
  private nextArrival = 0;

  constructor(
    private readonly system: SystemConfig,
    private readonly scenario: Scenario,
    arrivals: readonly Ms[],
    private readonly maxEvents: number,
  ) {
    this.latencyMs = system.networkLatencyMs;
    const graph = new CallGraph(system.services);

    for (const [name, config] of Object.entries(system.services)) {
      this.services.set(name, {
        name,
        config,
        calls: [],
        faults: scenario.faults.filter((fault) => fault.service === name),
        queue: [],
        queueHead: 0,
        busy: 0,
        running: new Set(),
      });
    }
    graph.calls.forEach((edge, index) => {
      const retryBudget = edge.config.retryBudget;
      this.service(edge.caller).calls.push({
        edge,
        index,
        callee: this.service(edge.callee),
        tokens: retryBudget ? retryBudget.maxTokens : Infinity,
      });
    });

    this.entry = this.service(system.entry.service);
    this.metrics = new MetricsCollector(
      scenario.bucketMs,
      scenario.durationMs,
      Object.entries(system.services).map(([name, config]) => ({ name, workers: config.workers })),
      graph.calls.map((edge) => edge.id),
    );
    this.requests = arrivals.map((arrivalMs, index) => ({
      index,
      outcome: { arrivalMs, completionMs: null, ok: false },
    }));
  }

  run(): RunResult {
    this.scheduleNextArrival();
    let eventCount = 0;
    let truncated = false;

    for (let time = this.events.peekTime(); time !== undefined && time < this.scenario.durationMs; time = this.events.peekTime()) {
      if (eventCount >= this.maxEvents) {
        truncated = true;
        break;
      }
      const next = this.events.pop();
      if (!next) break;
      this.now = next.time;
      eventCount++;
      this.handle(next.event);
    }

    const endedAtMs = truncated ? this.now : this.scenario.durationMs;
    this.flushRunningJobs(endedAtMs);
    return {
      buckets: this.metrics.finish(),
      requests: this.requests.map((request) => request.outcome),
      eventCount,
      truncated,
      endedAtMs,
    };
  }

  private handle(event: SimEvent): void {
    switch (event.kind) {
      case 'userArrival':
        return this.onUserArrival(event.request);
      case 'attemptArrives':
        return this.onAttemptArrives(event.attempt);
      case 'workDone':
        return this.onWorkDone(event.job);
      case 'attemptTimeout':
        return this.onAttemptTimeout(event.attempt);
      case 'response':
        return this.onResponse(event.attempt, event.ok);
      case 'retryReady':
        return this.startAttempt(event.job, event.job.nextAttemptNo);
    }
  }

  // --- End user ------------------------------------------------------------

  /** Arrivals are fed one at a time, so the event queue only ever holds the next one. */
  private scheduleNextArrival(): void {
    const request = this.requests[this.nextArrival];
    if (!request) return;
    this.nextArrival++;
    this.events.push(request.outcome.arrivalMs, { kind: 'userArrival', request });
  }

  /** The user is a caller with one attempt whose timeout is the deadline; it never retries. */
  private onUserArrival(request: RequestState): void {
    this.metrics.userArrival(this.now);
    this.send({
      request,
      callerJob: undefined,
      callee: this.entry,
      attemptNo: 1,
      sentAtMs: this.now,
      timeoutMs: this.system.entry.deadlineMs,
      pathHash: mixHash(0, 0),
      status: 'pending',
    });
    this.scheduleNextArrival();
  }

  // --- Callee side -----------------------------------------------------------

  private onAttemptArrives(attempt: Attempt): void {
    const service = attempt.callee;
    this.metrics.serviceArrival(service.name, this.now, attempt.attemptNo > 1);
    const job: Job = {
      service,
      attempt,
      deadlineMs: service.config.deadlinePropagation
        ? carriedDeadlineMs(attempt.sentAtMs, attempt.timeoutMs, this.latencyMs)
        : Infinity,
      startedAtMs: 0,
      failsLocally: false,
      callIndex: 0,
      nextAttemptNo: 1,
    };

    if (service.busy < service.config.workers) {
      this.startJob(job);
    } else if (this.queueLength(service) < capacityOf(service.config)) {
      service.queue.push(job);
      this.metrics.queueDepth(service.name, this.now, this.queueLength(service));
    } else {
      this.metrics.rejection(service.name, this.now);
      this.respond(attempt, false);
    }
  }

  /** Takes a worker and starts the local work, unless the job already expired (dropped at no cost). */
  private startJob(job: Job): void {
    const { service } = job;
    if (this.now >= job.deadlineMs) {
      this.metrics.expiredDrop(service.name, this.now);
      this.respond(job.attempt, false);
      return;
    }
    service.busy++;
    service.running.add(job);
    job.startedAtMs = this.now;

    // The fault active when the local work starts decides both its slowdown and its error rate.
    const fault = service.faults.find((f) => f.startMs <= this.now && this.now < f.endMs);
    const workMs = localWorkMs(service.config, this.draw(job, Purpose.serviceTime), fault?.latencyMultiplier ?? 1);
    job.failsLocally = this.draw(job, Purpose.error) < (fault?.errorRate ?? 0);
    this.events.push(this.now + workMs, { kind: 'workDone', job });
  }

  private onWorkDone(job: Job): void {
    if (job.failsLocally) this.finishJob(job, false);
    else this.startCall(job, 0);
  }

  private startCall(job: Job, callIndex: number): void {
    if (callIndex >= job.service.calls.length) {
      this.finishJob(job, true);
      return;
    }
    job.callIndex = callIndex;
    this.startAttempt(job, 1);
  }

  /** Releases the worker, answers the caller, and starts queued work. */
  private finishJob(job: Job, ok: boolean): void {
    const { service } = job;
    service.busy--;
    service.running.delete(job);
    // Work finished for a caller that already gave up is wasted.
    this.metrics.workerTime(service.name, job.startedAtMs, this.now, job.attempt.status !== 'pending');
    this.metrics.completion(service.name, this.now);
    this.respond(job.attempt, ok);
    this.startQueuedJobs(service);
  }

  private startQueuedJobs(service: ServiceRuntime): void {
    while (service.busy < service.config.workers && this.queueLength(service) > 0) {
      const job = service.queue[service.queueHead];
      service.queueHead++;
      if (service.queueHead > 1024 && service.queueHead * 2 > service.queue.length) {
        service.queue.splice(0, service.queueHead);
        service.queueHead = 0;
      }
      this.metrics.queueDepth(service.name, this.now, this.queueLength(service));
      if (job) this.startJob(job);
    }
  }

  // --- Caller side -----------------------------------------------------------

  private startAttempt(job: Job, attemptNo: number): void {
    const call = this.currentCall(job);
    const remainingMs = this.remainingMs(job);
    // A safeguard: afterFailure never schedules a retry past the deadline, and a later call only starts after an
    // earlier one answered in time, so with the current policy an attempt always starts with time left.
    if (remainingMs <= 0) {
      this.metrics.callFailure(call.edge.id, this.now);
      this.finishJob(job, false);
      return;
    }
    const retryBudget = call.edge.config.retryBudget;
    if (attemptNo === 1 && retryBudget) call.tokens = Math.min(retryBudget.maxTokens, call.tokens + retryBudget.ratio);

    const timeoutMs = attemptTimeout(call.edge.config, { attempt: attemptNo, remainingMs, tokens: call.tokens, draw: 0 });
    this.metrics.callAttempt(call.edge.id, this.now, attemptNo > 1);
    this.send({
      request: job.attempt.request,
      callerJob: job,
      callee: call.callee,
      attemptNo,
      sentAtMs: this.now,
      timeoutMs,
      pathHash: mixHash(mixHash(job.attempt.pathHash, call.index), attemptNo),
      status: 'pending',
    });
  }

  private send(attempt: Attempt): void {
    this.events.push(this.now + this.latencyMs, { kind: 'attemptArrives', attempt });
    this.events.push(this.now + attempt.timeoutMs, { kind: 'attemptTimeout', attempt });
  }

  private respond(attempt: Attempt, ok: boolean): void {
    this.events.push(this.now + this.latencyMs, { kind: 'response', attempt, ok });
  }

  private onAttemptTimeout(attempt: Attempt): void {
    if (attempt.status !== 'pending') return;
    attempt.status = 'timedOut';
    if (!attempt.callerJob) return; // The user gave up; any later response is late.
    this.metrics.callTimeout(this.currentCall(attempt.callerJob).edge.id, this.now);
    this.onAttemptFailed(attempt.callerJob, attempt);
  }

  private onResponse(attempt: Attempt, ok: boolean): void {
    // A response exactly at the timeout counts as a timeout; the timeout event handles it.
    const inTime = attempt.status === 'pending' && this.now < attempt.sentAtMs + attempt.timeoutMs;
    if (!attempt.callerJob) {
      this.onUserResponse(attempt, ok, inTime);
      return;
    }
    if (!inTime) return;
    attempt.status = 'answered';
    if (ok) this.startCall(attempt.callerJob, attempt.callerJob.callIndex + 1);
    else this.onAttemptFailed(attempt.callerJob, attempt);
  }

  private onUserResponse(attempt: Attempt, ok: boolean, inTime: boolean): void {
    const { outcome } = attempt.request;
    if (outcome.completionMs !== null) return;
    outcome.completionMs = this.now;
    if (inTime) attempt.status = 'answered';
    outcome.ok = ok && inTime;
    this.metrics.userResult(this.now, !ok ? 'failed' : inTime ? 'ok' : 'late');
  }

  private onAttemptFailed(job: Job, attempt: Attempt): void {
    const call = this.currentCall(job);
    const decision = afterFailure(call.edge.config, {
      attempt: attempt.attemptNo,
      remainingMs: this.remainingMs(job),
      tokens: call.tokens,
      draw: this.draw(job, Purpose.backoff, call.index, attempt.attemptNo),
    });
    if (!decision.retry) {
      this.metrics.callFailure(call.edge.id, this.now);
      this.finishJob(job, false);
      return;
    }
    if (call.edge.config.retryBudget) call.tokens -= 1;
    job.nextAttemptNo = attempt.attemptNo + 1;
    this.events.push(this.now + decision.delayMs, { kind: 'retryReady', job });
  }

  // --- Helpers ---------------------------------------------------------------

  /** Time left before the job's deadline; Infinity when its service does not propagate deadlines. */
  private remainingMs(job: Job): Ms {
    return job.service.config.deadlinePropagation ? job.deadlineMs - this.now : Infinity;
  }

  private currentCall(job: Job): CallRuntime {
    const call = job.service.calls[job.callIndex];
    if (!call) throw new Error(`Job in ${job.service.name} has no call ${job.callIndex}`);
    return call;
  }

  /** A keyed draw for this job: the same logical work gets the same value in every run. */
  private draw(job: Job, purpose: number, ...extra: number[]): number {
    return keyedUniform(this.scenario.seed, job.attempt.request.index, job.attempt.pathHash, purpose, ...extra);
  }

  private queueLength(service: ServiceRuntime): number {
    return service.queue.length - service.queueHead;
  }

  private service(name: string): ServiceRuntime {
    const service = this.services.get(name);
    if (!service) throw new Error(`Unknown service "${name}"`);
    return service;
  }

  /** Worker time of jobs still running when the run ends. */
  private flushRunningJobs(endedAtMs: Ms): void {
    for (const service of this.services.values()) {
      for (const job of service.running) {
        this.metrics.workerTime(service.name, job.startedAtMs, endedAtMs, job.attempt.status !== 'pending');
      }
    }
  }
}

function capacityOf(config: ServiceConfig): number {
  return config.queueCapacity === 'unbounded' ? Infinity : config.queueCapacity;
}
