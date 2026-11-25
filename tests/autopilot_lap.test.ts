/**
 * 整圈回归（`#autodrive` 同源控制器 + 真实 20.832km 赛道）
 *
 * 这条测试把 D2 的「圈时能不能真的跑出来」钉成可复算的断言：
 *   Drive（物理）+ AutoPilot（控制器）+ LapTimer（判圈）在 Node 里以 120Hz
 *   从起终线前 40m 起步跑完整圈，检查
 *     · 恰好 1 圈（不跳圈、不多计）；
 *     · 单圈用时落在合理区间（60km/h 巡航 ≈ 20.8km/60 ≈ 21min）；
 *     · 全程 |lateral| < 8.4m（不上土路肩、不蹭护栏）；
 *     · 沿路里程单调递增，无 NaN —— 也就是「无跳圈 / 无数值崩坏」的直接证据。
 *
 * 运行成本：约 150k 物理步 ≈ 2s（closestS 是 O(1700) 的暴力最近点）。
 */
import { describe, expect, it } from 'vitest';
import { autopilotInput } from '../src/core/AutoPilot';
import { Drive, IDLE_INPUT, type DriveInput } from '../src/core/Drive';
import { LapTimer } from '../src/core/LapTimer';
import { getTrack } from '../src/track/nordschleife';

const HZ = 120;
const DT = 1 / HZ;

describe('autodrive full lap', () => {
  it('60km/h 巡航跑完整圈：1 圈、无跳圈、不上路肩', { timeout: 240_000 }, () => {
    const track = getTrack();
    const L = track.length;
    const drive = new Drive();
    drive.resetToStart();
    const lap = new LapTimer(track, 'nr.test.autopilot');
    lap.resetAll();

    const input: DriveInput = { ...IDLE_INPUT };
    let prevS = drive.state.s;
    let progress = 0;
    let maxLat = 0;
    let maxBack = 0;
    let lapEvent = 0;
    let lastLapMs: number | null = null;
    let lastS = drive.state.s;

    // 上限 40min 物理时间（远超 21min 巡航耗时，跑不完说明控制器卡住了）
    const maxSteps = HZ * 60 * 40;
    for (let i = 0; i < maxSteps; i++) {
      autopilotInput(drive.state, input);
      drive.step(DT, input);
      const st = drive.state;
      expect(Number.isFinite(st.x) && Number.isFinite(st.z) && Number.isFinite(st.speed)).toBe(true);
      let ds = st.s - prevS;
      if (ds > L / 2) ds -= L;
      else if (ds < -L / 2) ds += L;
      progress += ds;
      if (-ds > maxBack) maxBack = -ds;
      prevS = st.s;
      lastS = st.s;
      const lat = Math.abs(st.lateral);
      if (lat > maxLat) maxLat = lat;
      const ev = lap.step(st.s, st.speed, DT * 1000);
      if (ev === 'lap' || ev === 'best') {
        lapEvent++;
        lastLapMs = lap.state().lastMs;
        break;
      }
    }

    void lastS;
    expect(lapEvent).toBe(1);
    expect(maxLat).toBeLessThan(8.4);
    expect(maxBack).toBeLessThan(1.5); // 每步回退 < 1.5m（无传送/无跳变）
    expect(progress).toBeGreaterThan(L);
    expect(lastLapMs).not.toBeNull();
    // 60km/h 巡航的理论圈时 ≈ 1250s；放开 850~1700s（含起步与低速弯）
    expect(lastLapMs as number).toBeGreaterThan(850_000);
    expect(lastLapMs as number).toBeLessThan(1_700_000);
    // 最佳圈在首次完圈时同步建立
    expect(lap.state().bestMs).toBe(lastLapMs);
  });
});
