import { describe, expect, it } from "vitest";
import { createPeriodicEvents, PeriodicSchedule, type PeriodicEvents } from "./periodic";

/** Every event time in [t0, t1), found one render quantum (`step` seconds) at a time. */
function collect(schedule: PeriodicSchedule, t0: number, t1: number, step = 128 / 48000) {
  const events: PeriodicEvents = createPeriodicEvents(8);
  const times: number[] = [];
  const indices: number[] = [];
  for (let t = t0; t < t1; t += step) {
    schedule.eventsIn(t, Math.min(t + step, t1), events);
    for (let i = 0; i < events.count; i++) {
      times.push(events.times[i] ?? Number.NaN);
      indices.push(events.indices[i] ?? Number.NaN);
    }
  }
  return { times, indices };
}

describe("PeriodicSchedule", () => {
  it("puts event n at n · period without jitter", () => {
    const { times, indices } = collect(new PeriodicSchedule(1, 1, 0.5), 0, 3);
    expect(indices).toEqual([0, 1, 2, 3, 4, 5]);
    expect(times).toEqual([0, 0.5, 1, 1.5, 2, 2.5]);
  });

  it("jitters each event within its bound, deterministically, keeping them in order", () => {
    const schedule = new PeriodicSchedule(4, 2, 0.25, 0.2);
    const { times, indices } = collect(schedule, -10, 30);
    expect(collect(new PeriodicSchedule(4, 2, 0.25, 0.2), -10, 30).times).toEqual(times);
    expect(times).toEqual(times.toSorted((a, b) => a - b));
    indices.forEach((n, i) => {
      expect(Math.abs((times[i] ?? 0) - n * 0.25)).toBeLessThanOrEqual(0.2 * 0.25 + 1e-12);
    });
    // Every grid slot has exactly one event.
    expect(indices).toEqual(
      Array.from({ length: indices.length }, (_, i) => i + (indices[0] ?? 0)),
    );
    expect(new Set(times.map((t, i) => t - (indices[i] ?? 0) * 0.25)).size).toBeGreaterThan(100);
  });

  it("is time-addressable: a render starting anywhere finds the same events", () => {
    const whole = collect(new PeriodicSchedule(7, 1, 0.3, 0.3), 0, 20);
    const late = collect(new PeriodicSchedule(7, 1, 0.3, 0.3), 9.9, 20, 0.001);
    const tail = whole.times.filter((t) => t >= 9.9);
    expect(late.times).toHaveLength(tail.length);
    late.times.forEach((t, i) => {
      expect(t).toBeCloseTo(tail[i] ?? Number.NaN, 12);
    });
  });

  it("caps jitter below half a period", () => {
    const schedule = new PeriodicSchedule(1, 1, 1, 5);
    const { times, indices } = collect(schedule, 0, 200);
    indices.forEach((n, i) => {
      expect(Math.abs((times[i] ?? 0) - n)).toBeLessThanOrEqual(0.45);
    });
  });

  it("re-anchors a period change at the next event, so nothing jumps or repeats", () => {
    const schedule = new PeriodicSchedule(3, 1, 1, 0.1);
    const before = collect(schedule, 0, 5.2);
    const next = schedule.nextIndex(5.2);
    const nextTime = schedule.timeOf(next);
    schedule.setPeriod(0.5, 5.2);
    expect(schedule.timeOf(next)).toBe(nextTime);
    const after = collect(schedule, 5.2, 10);
    expect(after.indices[0]).toBe(next);
    expect(after.times[0]).toBe(nextTime);
    const all = [...before.times, ...after.times];
    expect(all).toEqual(all.toSorted((a, b) => a - b));
    // Gaps follow the new period (within the jitter) after the change.
    for (let i = 1; i < after.times.length; i++) {
      const gap = (after.times[i] ?? 0) - (after.times[i - 1] ?? 0);
      expect(gap).toBeGreaterThan(0.5 * 0.8 - 1e-9);
      expect(gap).toBeLessThan(0.5 * 1.2 + 1e-9);
    }
  });

  it("brings the next event forward to `latest` when it would come later", () => {
    const schedule = new PeriodicSchedule(5, 1, 60, 0.3);
    const next = schedule.nextIndex(1);
    expect(schedule.timeOf(next)).toBeGreaterThan(11);
    schedule.setPeriod(10, 1, 11);
    const after = collect(schedule, 1, 100, 0.05);
    expect(after.indices[0]).toBe(next);
    expect(after.times[0]).toBeCloseTo(11, 9);
    for (let i = 1; i < after.times.length; i++) {
      const gap = (after.times[i] ?? 0) - (after.times[i - 1] ?? 0);
      expect(gap).toBeGreaterThan(10 * 0.4 - 1e-9);
      expect(gap).toBeLessThan(10 * 1.6 + 1e-9);
    }
  });

  it("keeps the next event's time when it already comes before `latest`", () => {
    const schedule = new PeriodicSchedule(5, 1, 10, 0.3);
    const next = schedule.nextIndex(1);
    const time = schedule.timeOf(next);
    schedule.setPeriod(60, 1, 61);
    expect(schedule.timeOf(next)).toBe(time);
  });

  it("ignores a change to the same period", () => {
    const schedule = new PeriodicSchedule(3, 1, 1, 0.1);
    const t = schedule.timeOf(4);
    schedule.setPeriod(1, 2.5);
    expect(schedule.timeOf(4)).toBe(t);
  });

  it("stops at the list's capacity", () => {
    const schedule = new PeriodicSchedule(1, 1, 0.01);
    const events = createPeriodicEvents(3);
    expect(schedule.eventsIn(0, 1, events)).toBe(3);
    expect(Array.from(events.indices)).toEqual([0, 1, 2]);
  });
});
