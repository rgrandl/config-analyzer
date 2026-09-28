// A binary min-heap of timed events. Events at the same time come out in the order they were pushed,
// which makes every run deterministic regardless of how the heap is laid out.

interface Entry<E> {
  readonly time: number;
  readonly sequence: number;
  readonly event: E;
}

export class EventQueue<E> {
  private readonly heap: Entry<E>[] = [];
  private nextSequence = 0;

  get size(): number {
    return this.heap.length;
  }

  push(time: number, event: E): void {
    this.heap.push({ time, sequence: this.nextSequence++, event });
    this.siftUp(this.heap.length - 1);
  }

  /** The earliest event, or undefined when empty. */
  pop(): { time: number; event: E } | undefined {
    const top = this.heap[0];
    const last = this.heap.pop();
    if (top === undefined || last === undefined) return undefined;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.siftDown(0);
    }
    return { time: top.time, event: top.event };
  }

  /** Time of the earliest event, or undefined when empty. */
  peekTime(): number | undefined {
    return this.heap[0]?.time;
  }

  private siftUp(index: number): void {
    let child = index;
    while (child > 0) {
      const parent = (child - 1) >> 1;
      if (!this.before(child, parent)) return;
      this.swap(child, parent);
      child = parent;
    }
  }

  private siftDown(index: number): void {
    let parent = index;
    for (;;) {
      const left = 2 * parent + 1;
      const right = left + 1;
      let smallest = parent;
      if (left < this.heap.length && this.before(left, smallest)) smallest = left;
      if (right < this.heap.length && this.before(right, smallest)) smallest = right;
      if (smallest === parent) return;
      this.swap(parent, smallest);
      parent = smallest;
    }
  }

  private before(a: number, b: number): boolean {
    const x = this.heap[a];
    const y = this.heap[b];
    if (!x || !y) return false;
    return x.time < y.time || (x.time === y.time && x.sequence < y.sequence);
  }

  private swap(a: number, b: number): void {
    const x = this.heap[a];
    const y = this.heap[b];
    if (!x || !y) return;
    this.heap[a] = y;
    this.heap[b] = x;
  }
}
