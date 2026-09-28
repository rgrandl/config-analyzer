// End-user arrivals: a Poisson process at `rps`, generated once and shared by every run of a comparison.
import type { Ms, Scenario } from '../config/schema';
import { keyedUniform, Purpose } from './keyedRandom';
import type { ArrivalSource } from './types';

/** Sorted arrival times in [0, durationMs). Gaps are exponential: −ln(1 − u) / rate, with u keyed by index. */
export const poissonArrivals: ArrivalSource = (scenario: Scenario): Ms[] => {
  const ratePerMs = scenario.rps / 1000;
  const arrivals: Ms[] = [];
  for (let index = 0, time = 0; ; index++) {
    time += -Math.log(1 - keyedUniform(scenario.seed, Purpose.arrival, index)) / ratePerMs;
    if (time >= scenario.durationMs) return arrivals;
    arrivals.push(time);
  }
};
