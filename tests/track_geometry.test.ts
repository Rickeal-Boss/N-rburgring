import { describe, expect, it } from 'vitest';
import {
  Nordschleife,
  TRACK_LENGTH,
  getTrack,
  getTrackFor,
  resetTrack,
  setTrackMode
} from '../src/track/nordschleife';
import { SUED_TRACK_LENGTH, newSuedschleife } from '../src/track/suedschleife';

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

describe('track frames orthonormal', () => {
  const track = new Nordschleife();
  it('up is unit, perpendicular to tangent, and stays near vertical everywhere', () => {
    for (let s = 0; s < track.length; s += 37) {
      const f = track.at(s);
      const t = { ...f.tangent };
      const r = { ...f.right };
      const u = { ...f.up };
      const dot = t.x * u.x + t.y * u.y + t.z * u.z;
      expect(Math.abs(dot)).toBeLessThan(1e-3);
      expect(Math.hypot(u.x, u.y, u.z)).toBeCloseTo(1, 6);
      expect(Math.hypot(r.x, r.y, r.z)).toBeCloseTo(1, 6);
      // 坡度最大 18%，up.y 理论下限 ≈ cos(atan(0.18))=0.984；留 0.95 裕量
      // V39 Karussell 30° 混凝土内坡（s≈20675，北环最急 RIGHT 弯）使 up 倾斜 ~33°
      // （up.y=cos(33°)≈0.838）—— 这是设计意图（真实 Karussell 陡坡「掉入」），
      // 非异常；其余段保持近垂直（≥0.95）。
      const inKarr = s > 20540 && s < 20810;
      expect(u.y).toBeGreaterThan(inKarr ? 0.83 : 0.95);
      const tr = t.x * r.x + t.y * r.y + t.z * r.z;
      expect(Math.abs(tr)).toBeLessThan(1e-3);
    }
  });
});

describe('suedschleife centerline', () => {
  const track = newSuedschleife();

  it('length matches the official ~7.7 km within 0.5%', () => {
    expect(Math.abs(track.length - SUED_TRACK_LENGTH) / SUED_TRACK_LENGTH < 0.005).toBe(true);
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
    for (const s of [0, 500, 2000, 4000, 6000, 7000]) {
      const p = track.toWorld(0, 0, s);
      const back = track.closestS(p.x, p.z);
      const diff = Math.abs(((back - s + track.length * 1.5) % track.length) - track.length * 0.5);
      expect(diff).toBeLessThan(12);
    }
  });

  it('locate returns lateral offset with the right sign', () => {
    const p = { ...track.toWorld(5, 0, 1500) };
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

describe('suedschleife frames orthonormal', () => {
  const track = newSuedschleife();
  it('up is unit, perpendicular to tangent, and stays near vertical everywhere', () => {
    for (let s = 0; s < track.length; s += 37) {
      const f = track.at(s);
      const t = { ...f.tangent };
      const r = { ...f.right };
      const u = { ...f.up };
      const dot = t.x * u.x + t.y * u.y + t.z * u.z;
      expect(Math.abs(dot)).toBeLessThan(1e-3);
      expect(Math.hypot(u.x, u.y, u.z)).toBeCloseTo(1, 6);
      expect(Math.hypot(r.x, r.y, r.z)).toBeCloseTo(1, 6);
      expect(u.y).toBeGreaterThan(0.95);
      const tr = t.x * r.x + t.y * r.y + t.z * r.z;
      expect(Math.abs(tr)).toBeLessThan(1e-3);
    }
  });
});

describe('track mode switching', () => {
  it('getTrack stays zero-arg and reflects the active mode', () => {
    resetTrack();
    setTrackMode('nordschleife');
    expect(getTrack().length).toBeCloseTo(TRACK_LENGTH, 0);
    expect(getTrackFor('suedschleife').length).toBeCloseTo(SUED_TRACK_LENGTH, 0);
    expect(getTrackFor('nordschleife').length).toBeCloseTo(TRACK_LENGTH, 0);
    setTrackMode('suedschleife');
    expect(getTrack().length).toBeCloseTo(SUED_TRACK_LENGTH, 0);
    resetTrack();
    // 复位后默认回到北环
    expect(getTrack().length).toBeCloseTo(TRACK_LENGTH, 0);
  });
});
