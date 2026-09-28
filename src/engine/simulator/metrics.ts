// Bucket accounting (DESIGN.md §10.1). The event loop reports raw facts; this turns them into BucketMetrics.
// Worker time is split across every bucket a job spanned, so utilization and the wasted fraction stay in
// [0, 1]; queue depth per bucket includes the depth carried in from the bucket before.
import type { Ms } from '../config/schema';
import type { BucketMetrics, CallBucketMetrics, ServiceBucketMetrics } from './types';

interface ServiceSeries {
  readonly workers: number;
  readonly firstAttemptArrivals: number[];
  readonly retryArrivals: number[];
  readonly rejections: number[];
  readonly expiredDrops: number[];
  readonly completions: number[];
  readonly maxQueueDepth: number[];
  readonly busyMs: number[];
  readonly wastedMs: number[];
  depth: number;
  depthBucket: number;
}

interface CallSeries {
  readonly attempts: number[];
  readonly retries: number[];
  readonly timeouts: number[];
  readonly failures: number[];
}

export type UserResult = 'ok' | 'late' | 'failed';

export class MetricsCollector {
  private readonly bucketCount: number;
  private readonly userArrivals: number[];
  private readonly goodput: number[];
  private readonly lateSuccesses: number[];
  private readonly failures: number[];
  private readonly services = new Map<string, ServiceSeries>();
  private readonly calls = new Map<string, CallSeries>();

  constructor(
    private readonly bucketMs: Ms,
    private readonly durationMs: Ms,
    services: readonly { name: string; workers: number }[],
    callIds: readonly string[],
  ) {
    this.bucketCount = Math.max(1, Math.ceil(durationMs / bucketMs));
    this.userArrivals = this.zeros();
    this.goodput = this.zeros();
    this.lateSuccesses = this.zeros();
    this.failures = this.zeros();
    for (const { name, workers } of services) {
      this.services.set(name, {
        workers,
        firstAttemptArrivals: this.zeros(),
        retryArrivals: this.zeros(),
        rejections: this.zeros(),
        expiredDrops: this.zeros(),
        completions: this.zeros(),
        maxQueueDepth: this.zeros(),
        busyMs: this.zeros(),
        wastedMs: this.zeros(),
        depth: 0,
        depthBucket: 0,
      });
    }
    for (const id of callIds) {
      this.calls.set(id, { attempts: this.zeros(), retries: this.zeros(), timeouts: this.zeros(), failures: this.zeros() });
    }
  }

  userArrival(t: Ms): void {
    this.count(this.userArrivals, t);
  }

  /** A response reached the user: in time and ok, ok but after the deadline, or a failure. */
  userResult(t: Ms, result: UserResult): void {
    const series = result === 'ok' ? this.goodput : result === 'late' ? this.lateSuccesses : this.failures;
    this.count(series, t);
  }

  serviceArrival(service: string, t: Ms, isRetry: boolean): void {
    const s = this.service(service);
    this.count(isRetry ? s.retryArrivals : s.firstAttemptArrivals, t);
  }

  rejection(service: string, t: Ms): void {
    this.count(this.service(service).rejections, t);
  }

  expiredDrop(service: string, t: Ms): void {
    this.count(this.service(service).expiredDrops, t);
  }

  completion(service: string, t: Ms): void {
    this.count(this.service(service).completions, t);
  }

  /** Called whenever a service's queue length changes. */
  queueDepth(service: string, t: Ms, depth: number): void {
    const s = this.service(service);
    const bucket = this.bucket(t);
    this.carryDepth(s, bucket);
    s.depth = depth;
    s.maxQueueDepth[bucket] = Math.max(at(s.maxQueueDepth, bucket), depth);
  }

  /** A worker was held from startMs to endMs; `wasted` when the job's caller had already given up. */
  workerTime(service: string, startMs: Ms, endMs: Ms, wasted: boolean): void {
    const s = this.service(service);
    for (let bucket = this.bucket(startMs); bucket <= this.bucket(endMs); bucket++) {
      const from = Math.max(startMs, bucket * this.bucketMs);
      const to = Math.min(endMs, (bucket + 1) * this.bucketMs);
      if (to <= from) continue;
      s.busyMs[bucket] = at(s.busyMs, bucket) + (to - from);
      if (wasted) s.wastedMs[bucket] = at(s.wastedMs, bucket) + (to - from);
    }
  }

  callAttempt(callId: string, t: Ms, isRetry: boolean): void {
    const c = this.call(callId);
    this.count(c.attempts, t);
    if (isRetry) this.count(c.retries, t);
  }

  callTimeout(callId: string, t: Ms): void {
    this.count(this.call(callId).timeouts, t);
  }

  /** The call gave up: every allowed attempt failed, or no time was left. */
  callFailure(callId: string, t: Ms): void {
    this.count(this.call(callId).failures, t);
  }

  finish(): BucketMetrics[] {
    for (const s of this.services.values()) this.carryDepth(s, this.bucketCount - 1);
    return Array.from({ length: this.bucketCount }, (_, bucket) => {
      const startMs = bucket * this.bucketMs;
      const lengthMs = Math.min(this.bucketMs, this.durationMs - startMs);
      const services: Record<string, ServiceBucketMetrics> = {};
      for (const [name, s] of this.services) {
        const busy = at(s.busyMs, bucket);
        services[name] = {
          firstAttemptArrivals: at(s.firstAttemptArrivals, bucket),
          retryArrivals: at(s.retryArrivals, bucket),
          rejections: at(s.rejections, bucket),
          expiredDrops: at(s.expiredDrops, bucket),
          completions: at(s.completions, bucket),
          maxQueueDepth: at(s.maxQueueDepth, bucket),
          utilization: lengthMs > 0 ? busy / (s.workers * lengthMs) : 0,
          wastedFraction: busy > 0 ? at(s.wastedMs, bucket) / busy : 0,
        };
      }
      const calls: Record<string, CallBucketMetrics> = {};
      for (const [id, c] of this.calls) {
        calls[id] = {
          attempts: at(c.attempts, bucket),
          retries: at(c.retries, bucket),
          timeouts: at(c.timeouts, bucket),
          failures: at(c.failures, bucket),
        };
      }
      return {
        startMs,
        userArrivals: at(this.userArrivals, bucket),
        goodput: at(this.goodput, bucket),
        lateSuccesses: at(this.lateSuccesses, bucket),
        failures: at(this.failures, bucket),
        services,
        calls,
      };
    });
  }

  /** Buckets since the last queue change start (and peak at least) at the depth the queue had then. */
  private carryDepth(s: ServiceSeries, upTo: number): void {
    for (let bucket = s.depthBucket + 1; bucket <= upTo; bucket++) {
      s.maxQueueDepth[bucket] = Math.max(at(s.maxQueueDepth, bucket), s.depth);
    }
    s.depthBucket = Math.max(s.depthBucket, upTo);
  }

  private count(series: number[], t: Ms): void {
    const bucket = this.bucket(t);
    series[bucket] = at(series, bucket) + 1;
  }

  private bucket(t: Ms): number {
    return Math.min(this.bucketCount - 1, Math.max(0, Math.floor(t / this.bucketMs)));
  }

  private zeros(): number[] {
    return new Array<number>(this.bucketCount).fill(0);
  }

  private service(name: string): ServiceSeries {
    const s = this.services.get(name);
    if (!s) throw new Error(`Unknown service "${name}"`);
    return s;
  }

  private call(id: string): CallSeries {
    const c = this.calls.get(id);
    if (!c) throw new Error(`Unknown call "${id}"`);
    return c;
  }
}

/** Reads a bucket of a fixed-size series; every bucket index is in range by construction. */
function at(series: readonly number[], bucket: number): number {
  return series[bucket] ?? 0;
}
