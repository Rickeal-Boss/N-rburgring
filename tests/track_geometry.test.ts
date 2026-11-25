import { describe, expect, it } from 'vitest';
import { Nordschleife, TRACK_LENGTH } from '../src/track/nordschleife';

describe('nordschleife centerline', () => {
  const track = new Nordschleife();

  it('length matches the official 20.832 km within 0.5%', () => {
    expect(Math.abs(track.length - TRACK_LENGTH) / TRACK_LENGTH < 0.005).toBe(true);
  });

  it('is a closed loop with no seam jump', () => {
    const a = { ...track.at(0).center };
    const b = { ...track.at(track.length - track.spacing).center };
    const gap = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    expect(gap).toBeGreaterThan(track.spacing * 0.5);
    expect(gap).toBeLessThan(track.spacing * 2.5);
  });

  it('keeps a drivable minimum radius', () => {
    expect(track.minRadius()).toBeGreaterThan(20);
  });

  it('keeps grades under 18%', () => {
    expect(track.maxGrade()).toBeLessThan(0.18);
  });

  it('has a plausible elevation range', () => {
    const r = track.elevationRange();
    expect(r.max - r.min).toBeGreaterThan(25);
    expect(r.max - r.min).toBeLessThan(120);
  });

  it('closestS recovers the sample arc length', () => {
    for (const s of [0, 500, 4200, 9100, 15500, 20000]) {
      const p = track.toWorld(0, 0, s);
      const back = track.closestS(p.x, p.z);
      const diff = Math.abs(((back - s + track.length * 1.5) % track.length) - track.length * 0.5);
      expect(diff).toBeLessThan(12);
    }
  });

  it('locate returns lateral offset with the right sign', () => {
    const p = { ...track.toWorld(5, 0, 3000) };
    const loc = track.locate(p.x, p.y + 0.2, p.z);
    expect(loc.lateral).toBeGreaterThan(4);
    expect(loc.lateral).toBeLessThan(6.5);
    expect(loc.height).toBeGreaterThan(-1.5);
    expect(loc.height).toBeLessThan(2);
  });

  it('produces finite frames everywhere', () => {
    for (let s = 0; s < track.length; s += 137) {
      const f = track.at(s);
      for (const v of [f.center, f.tangent, f.right, f.up]) {
        expect(Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)).toBe(true);
      }
      expect(Math.abs(f.curvature)).toBeLessThan(0.2);
    }
  });

  it('banking follows corner direction (left turn => left side lower)', () => {
    let found = false;
    for (let s = 0; s < track.length; s += 41) {
      const f = track.at(s);
      if (Math.abs(f.curvature) > 0.02) {
        const left = { ...track.toWorld(-6, 0, s) };
        const right = { ...track.toWorld(6, 0, s) };
        const center = { ...track.toWorld(0, 0, s) };
        if (f.curvature > 0) {
          expect(left.y).toBeLessThan(right.y + 0.001);
        } else {
          expect(right.y).toBeLessThan(left.y + 0.001);
        }
        expect(Math.abs(left.y - center.y)).toBeGreaterThan(0.001);
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });
});
