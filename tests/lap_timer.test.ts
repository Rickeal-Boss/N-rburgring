/**
 * 圈速计时回归（docs/NR_D2_SPEC.md §6 口径）
 *
 * LapTimer 只依赖「弧长 s + 速度 + dt」，因此用长度桩就能完整覆盖过线/分段/最佳
 * 语义，不必构造 20831.6m 的真实赛道；真实赛道的整圈行为由 tests/autopilot_lap
 * 的整圈仿真覆盖（`#autodrive` 同源控制器）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { LapTimer, type LapSplit } from '../src/core/LapTimer';
import type { Nordschleife } from '../src/track/nordschleife';

const L = 3000;
/** 只需 length 的赛道桩（LapTimer 不读其它字段） */
const track = { length: L } as unknown as Nordschleife;
const DT_MS = 1000 / 120;

interface DriveOptions {
  from: number;
  to: number;
  speed?: number;
  dtMs?: number;
  /** 超过 1 圈是否回绕（默认 true） */
  wrap?: boolean;
}

/** 以恒定「每步 s 增量」把车从 from 开到 to（可跨多圈），返回步数 */
function drive(timer: LapTimer, o: DriveOptions): number {
  const stepM = o.speed === undefined ? 1 : Math.max(0.05, o.speed * ((o.dtMs ?? DT_MS) / 1000));
  const dtMs = o.dtMs ?? DT_MS;
  let s = o.from;
  let steps = 0;
  const total = Math.abs(o.to - o.from);
  const dir = o.to >= o.from ? 1 : -1;
  let done = 0;
  while (done < total - 1e-9) {
    s += dir * stepM;
    done += stepM;
    if (o.wrap !== false) s = ((s % L) + L) % L;
    timer.step(s, dir * (o.speed ?? 10), dtMs);
    steps++;
    if (steps > 2_000_000) throw new Error('drive() did not converge');
  }
  return steps;
}

/** 从 from 正向跑到 to（自动回绕一次） */
function lapOnce(timer: LapTimer, from: number, speed = 20): 'lap' | 'sector' | 'best' | null {
  let ev: 'lap' | 'sector' | 'best' | null = null;
  const stepM = speed * (DT_MS / 1000);
  let s = from;
  const target = from + L;
  while (s < target) {
    s += stepM;
    const wrapped = ((s % L) + L) % L;
    const e = timer.step(wrapped, speed, DT_MS);
    if (e === 'best' || (e === 'lap' && ev !== 'best')) ev = e;
  }
  return ev;
}

describe('LapTimer', () => {
  let timer: LapTimer;
  beforeEach(() => {
    timer = new LapTimer(track);
    timer.resetAll();
    timer.resetLap();
  });

  it('正向过线启动计时，跑满一圈才 lap+1', () => {
    // 起点在 −40m（与 Drive.resetToStart 同口径）
    timer.step(L - 40, 10, DT_MS);
    expect(timer.state().running).toBe(false);
    expect(timer.state().lap).toBe(0);

    // 过线：只启动，不算圈
    timer.step(0.5, 10, DT_MS);
    expect(timer.state().running).toBe(true);
    expect(timer.state().lap).toBe(0);

    const ev = lapOnce(timer, 0.5);
    expect(ev === 'lap' || ev === 'best').toBe(true);
    const st = timer.state();
    expect(st.lap).toBe(1);
    expect(st.currentMs).toBeLessThan(st.lastMs ?? 0); // 新圈已重新起算
    expect(st.lastMs).toBeGreaterThan(0);
  });

  it('倒着过线不计圈', () => {
    timer.step(L - 40, 10, DT_MS);
    timer.step(0.5, 10, DT_MS);
    const lapBefore = timer.state().lap;
    // 先跑大半圈再反向退过线
    drive(timer, { from: 0.5, to: L - 300 });
    let s = L - 300;
    while (s > L - 40) {
      s -= 1;
      timer.step(s, -10, DT_MS);
    }
    // 反向穿线（prevS 小、s 大）
    timer.step(10, -10, DT_MS);
    expect(timer.state().lap).toBe(lapBefore);
  });

  it('本圈里程不足 0.9L 时过线不判圈（防刷圈）', () => {
    timer.step(L - 40, 10, DT_MS);
    timer.step(0.5, 10, DT_MS); // 起算
    // 只往前开 200m，再倒回起终线前（反向不累计里程），然后正向过线
    drive(timer, { from: 0.5, to: 200 });
    drive(timer, { from: 200, to: L - 100, speed: -10 });
    expect(timer.state().lap).toBe(0);
    const ev = timer.step(0.5, 10, DT_MS);
    expect(timer.state().lap).toBe(0);
    expect(ev).not.toBe('lap');
    expect(ev).not.toBe('best');
  });

  it('S1/S2 各记一次，S3 在过线时结算', () => {
    timer.step(L - 40, 10, DT_MS);
    timer.step(0.5, 10, DT_MS);
    const sectors: string[] = [];
    let s = 0.5;
    let ev: 'lap' | 'sector' | 'best' | null = null;
    while (s < L) {
      s += 2;
      const e = timer.step(((s % L) + L) % L, 20, DT_MS);
      if (e === 'sector') sectors.push(s < L / 2 ? 's1' : 's2');
      if (e === 'lap' || e === 'best') ev = e;
    }
    expect(sectors).toEqual(['s1', 's2']);
    expect(ev === 'lap' || ev === 'best').toBe(true);
    const sp = timer.state().splits;
    // 已进入新圈 ⇒ 本圈分段清空；上一圈的分段体现在 bestSplits
    expect(sp.s1).toBeNull();
    const best = timer.state().bestSplits as LapSplit;
    expect(best.s1).toBeGreaterThan(0);
    expect(best.s2).toBeGreaterThan(0);
    expect(best.s3).toBeGreaterThan(0);
  });

  it('更快的下一圈刷新最佳，更慢的不刷新', () => {
    timer.step(L - 40, 10, DT_MS);
    timer.step(0.5, 10, DT_MS);
    lapOnce(timer, 0.5, 20); // 基准圈
    const first = timer.state().bestMs;
    expect(first).toBeGreaterThan(0);

    lapOnce(timer, 0.5, 20); // 同速同圈 → 不更快（严格小于才刷新）
    expect(timer.state().bestMs).toBe(first);

    lapOnce(timer, 0.5, 40); // 快一倍
    expect(timer.state().bestMs).toBeLessThan(first as number);
    expect(timer.state().lap).toBe(3);
  });

  it('resetLap 清本圈但保留最佳；resetAll 清最佳', () => {
    timer.step(L - 40, 10, DT_MS);
    timer.step(0.5, 10, DT_MS);
    lapOnce(timer, 0.5, 20);
    const best = timer.state().bestMs;
    expect(best).toBeGreaterThan(0);

    timer.resetLap();
    const st = timer.state();
    expect(st.bestMs).toBe(best);
    expect(st.currentMs).toBe(0);
    expect(st.running).toBe(false);
    expect(st.lap).toBe(1); // 已完成圈数不清零

    timer.resetAll();
    expect(timer.state().bestMs).toBeNull();
    expect(timer.state().lap).toBe(0);
  });

  it('最佳与分段写进 localStorage 并可恢复（内存桩）', () => {
    const mem = new Map<string, string>();
    const stub = {
      getItem: (k: string): string | null => mem.get(k) ?? null,
      setItem: (k: string, v: string): void => void mem.set(k, v),
      removeItem: (k: string): void => void mem.delete(k)
    };
    const original = (globalThis as { localStorage?: unknown }).localStorage;
    (globalThis as { localStorage?: unknown }).localStorage = stub;
    try {
      const a = new LapTimer(track, 'nr.test.best');
      a.resetAll();
      a.step(L - 40, 10, DT_MS);
      a.step(0.5, 10, DT_MS);
      lapOnce(a, 0.5, 20);
      expect(mem.has('nr.test.best')).toBe(true);

      const b = new LapTimer(track, 'nr.test.best');
      expect(b.state().bestMs).toBe(a.state().bestMs);
      expect(b.state().bestSplits?.s1).toBe(a.state().bestSplits?.s1);
    } finally {
      if (original === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
      else (globalThis as { localStorage?: unknown }).localStorage = original;
    }
  });
});
