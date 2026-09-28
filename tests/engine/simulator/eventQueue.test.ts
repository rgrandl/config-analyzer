import { describe, expect, it } from 'vitest';
import { EventQueue } from '../../../src/engine/simulator/eventQueue';

describe('EventQueue', () => {
  it('pops events in time order, and ties in push order', () => {
    // Plan: push events at times 5, 1, 5, 3, 1.
    // Verifies: they come out at 1, 1, 3, 5, 5, with each pair of ties in the order pushed.
    const queue = new EventQueue<string>();
    for (const [time, name] of [[5, 'a'], [1, 'b'], [5, 'c'], [3, 'd'], [1, 'e']] as const) queue.push(time, name);
    const popped: string[] = [];
    for (let next = queue.pop(); next; next = queue.pop()) popped.push(next.event);
    expect(popped).toEqual(['b', 'e', 'd', 'a', 'c']);
    expect(queue.pop()).toBeUndefined();
  });

  it('stays ordered when events are scheduled from the current time, as the simulator does', () => {
    // Plan: pop events one by one; each pop schedules up to two new events at or after its time,
    //   with pseudo-random offsets that often collide, until 5000 events have been processed.
    // Verifies: times never go backwards, ties come out in push order, and every pushed event is popped.
    const queue = new EventQueue<number>();
    let pushed = 0;
    const push = (time: number) => queue.push(time, pushed++);
    push(0);
    let popped = 0;
    let last = { time: -Infinity, order: -1 };
    for (let next = queue.pop(); next; next = queue.pop()) {
      popped++;
      expect(next.time > last.time || (next.time === last.time && next.event > last.order)).toBe(true);
      last = { time: next.time, order: next.event };
      if (pushed < 5000) {
        push(next.time + (next.event * 7919) % 5);
        push(next.time + (next.event * 104729) % 3);
      }
    }
    expect(popped).toBe(pushed);
  });
});
