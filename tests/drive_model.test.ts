/**
 * 驾驶模型标定回归（D2 §B 口径）
 *
 * 全部用 core/Drive.ts 的**纯状态**在 Node 里逐步进（120Hz，与 Loop 同频），
 * 不碰渲染/音效 —— 这样「手感」是可复算的数值契约，而不是只能靠人眼判断。
 *
 * 断言来源（旧仓 FREE 表 + docs/NR_D2_SPEC.md §6）：
 *   · 0-100km/h 4.5~6.5s（390kW / 3300kg，恒扭矩→恒功率 + 驱动极限 0.82 裕度）
 *   · 100-0 制动 33~45m（ABS 1.1g；摩擦圆下纵向可用量随横摆载荷削减）
 *   · 低速满舵转弯半径 4~6m（34° 转角 / 3.43m 轴距 → 几何 5.0m，被 maxYawRate 0.9 兜住）
 *   · 高速 yawRate 必须被 gripLat/max(v, 5.5) 钳住（D2 把转角表放宽到 0.48rad 后，
 *     高速的限幅**只能**来自摩擦圆——这一条是「放宽转角不会变成瞬转」的证据）
 *   · 护栏 |lateral| ≤ 10.7（railLimit 10.6 + 1 步容差）
 *   · R 复位后 lateral ≈ 0
 */
import { describe, expect, it } from 'vitest';
import { Drive, DRIVE_MODEL, IDLE_INPUT, type DriveInput } from '../src/core/Drive';
import { autopilotInput } from '../src/core/AutoPilot';
import { GRAVITY, MS_TO_KMH } from '../src/config/physics';

const HZ = 120;
const DT = 1 / HZ;
/**
 * 纵向标定放在 Döttinger Höhe 直道（s≈17.2km，600m 内 max|κ|=0.0003 ⇒ R>3000m）。
 * 用 AutoPilot 只做**车道保持**（cruise 200 ⇒ 恒满油门、弯道限速不介入），
 * 这样纵向加速/制动不被「不转向就上护栏」污染；断言的量仍全部来自 Drive。
 */
const STRAIGHT_S = 17200;

function makeInput(): DriveInput {
  return { ...IDLE_INPUT };
}

/** AutoPilot 只做车道保持 + 满油门（复用同一 input，零分配） */
const autoInput = makeInput();
function autopilotWrite(drive: Drive, cruiseKmh: number): DriveInput {
  autopilotInput(drive.state, autoInput, cruiseKmh);
  return autoInput;
}

/** 推进 seconds 秒，每步前调用 set(input) 写输入；返回耗时 */
function run(drive: Drive, seconds: number, set: (input: DriveInput) => void): void {
  const input = makeInput();
  const steps = Math.round(seconds * HZ);
  for (let i = 0; i < steps; i++) {
    set(input);
    drive.step(DT, input);
  }
}

describe('drive model calibration', () => {
  it('0-100 km/h 在 4.5~6.5s', () => {
    const drive = new Drive();
    drive.teleportTo(STRAIGHT_S);
    let t = 0;
    let hit = -1;
    for (let i = 0; i < HZ * 15 && hit < 0; i++) {
      drive.step(DT, autopilotWrite(drive, 200));
      t += DT;
      if (drive.state.speed * MS_TO_KMH >= 100) hit = t;
    }
    expect(hit).toBeGreaterThan(4.5);
    expect(hit).toBeLessThan(6.5);
  });

  it('100-0 km/h 制动距离 33~45m', () => {
    const drive = new Drive();
    drive.teleportTo(STRAIGHT_S);
    // 先加速到 100km/h（车道保持由 AutoPilot 提供）
    let guard = 0;
    while (drive.state.speed * MS_TO_KMH < 100 && guard++ < HZ * 15) {
      drive.step(DT, autopilotWrite(drive, 200));
    }
    expect(drive.state.speed * MS_TO_KMH).toBeGreaterThan(98);

    let distance = 0;
    const input = makeInput();
    for (let i = 0; i < HZ * 20; i++) {
      const before = drive.state.speed;
      input.throttle = 0;
      input.brake = 1;
      drive.step(DT, input);
      const after = drive.state.speed;
      if (before <= 0) break;
      // 梯形积分（制动跨零点那一步会被 stopSpeed 截住）
      distance += Math.max(0, (before + Math.max(0, after)) * 0.5) * DT;
      if (after <= 0.08) break;
    }
    expect(distance).toBeGreaterThan(33);
    expect(distance).toBeLessThan(45);
  });

  it('低速满舵转弯半径 4~6m', () => {
    const drive = new Drive();
    drive.resetToStart();
    const target = 18 / MS_TO_KMH; // 18km/h ⇒ 收窄表下沿，满舵 34°
    // 先达到目标速度
    run(drive, 6, (input) => {
      input.steer = 1;
      input.throttle = drive.state.speed < target ? 1 : 0;
      input.brake = drive.state.speed > target + 0.4 ? 0.4 : 0;
    });
    // 稳态窗口：保持速度 + 满舵，量 (路程 / 航向变化)
    const s0 = drive.state.heading;
    let path = 0;
    const input = makeInput();
    const steps = HZ * 2;
    for (let i = 0; i < steps; i++) {
      input.steer = 1;
      input.throttle = drive.state.speed < target ? 0.5 : 0;
      input.brake = drive.state.speed > target + 0.3 ? 0.3 : 0;
      const before = drive.state.speed;
      drive.step(DT, input);
      path += Math.abs(0.5 * (before + drive.state.speed)) * DT;
    }
    let dh = drive.state.heading - s0;
    // 正确的 2π 取模（JS 的 % 保留符号，直接写 ((x+π)%2π)−π 在 |x|>π 时会错）
    dh = (((dh + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    const radius = path / Math.abs(dh);
    expect(radius).toBeGreaterThan(4);
    expect(radius).toBeLessThan(6);
  });

  it('高速满舵 yawRate 被 gripLat/max(v,5.5) 钳住（放转角不会瞬转）', () => {
    const drive = new Drive();
    drive.teleportTo(STRAIGHT_S);
    // 用车道保持加速到 120km/h 以上（直道，不会被护栏耗散）
    let guard = 0;
    while (drive.state.speed * MS_TO_KMH < 120 && guard++ < HZ * 20) {
      drive.step(DT, autopilotWrite(drive, 200));
    }
    expect(drive.state.speed * MS_TO_KMH).toBeGreaterThan(115);

    const gripLat = DRIVE_MODEL.tyreMu * GRAVITY;
    const input = makeInput();
    let maxYaw = 0;
    let worstOver = 0;
    for (let i = 0; i < HZ * 2; i++) {
      input.steer = 1;
      input.throttle = 0;
      drive.step(DT, input);
      const v = Math.abs(drive.state.speed);
      const cap = Math.min(DRIVE_MODEL.maxYawRate, gripLat / Math.max(v, DRIVE_MODEL.refSpeedMs));
      maxYaw = Math.max(maxYaw, Math.abs(drive.state.yawRate));
      worstOver = Math.max(worstOver, Math.abs(drive.state.yawRate) - cap);
    }
    expect(maxYaw).toBeGreaterThan(0.05); // 确实在转，不是没响应
    // 容许单步 2% 的阻尼过冲（yawRate 是 damp 逼近 target，target 本身已被钳）
    expect(worstOver).toBeLessThan(Math.max(0.01, maxYaw * 0.02));
  });

  it('全油门满舵乱开也不会穿护栏（|lateral| ≤ 10.7）', () => {
    const drive = new Drive();
    drive.resetToStart();
    let maxLat = 0;
    run(drive, 25, (input) => {
      input.throttle = 1;
      input.steer = Math.sin(drive.state.s * 0.02) > 0 ? 1 : -1;
      maxLat = Math.max(maxLat, Math.abs(drive.state.lateral));
    });
    expect(maxLat).toBeLessThanOrEqual(10.7);
  });

  it('R 复位后 lateral ≈ 0 且速度归零', () => {
    const drive = new Drive();
    drive.resetToStart();
    run(drive, 8, (input) => {
      input.throttle = 1;
      input.steer = 0.6;
    });
    expect(Math.abs(drive.state.lateral)).toBeGreaterThan(0.5);
    drive.resetToTrack();
    expect(Math.abs(drive.state.lateral)).toBeLessThan(1e-6);
    expect(drive.state.speed).toBe(0);
  });
});
