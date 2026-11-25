/**
 * 纽北自由驾驶 · 玩家驾驶模型（自行车模型 + 摩擦圆 + 手刹漂移）
 *
 * 手感来源：旧仓 config/physics.ts 的 VEHICLE/DRIVE/BRAKE 与 core/FreeDrive.ts 的
 * 「灵魂 12」（maxYawRate 0.9 / refSpeedMs 5.5 / tyreMu 0.92 / driftGripFloor 0.32 /
 * aligningStiffness 9200 / gripDecayTau 0.22 / gripRecoverTau 0.45 / 转向随速收窄 18→60km/h）。
 * 差别只在「往哪儿开」：本模型跑 20.83km 的纽北中心线，用 `track.locate` 把世界位姿
 * 折算成沿路坐标 s / lateral，并据此做路面高程、横倾、路肩与护栏。
 *
 * 坐标约定（与 track/nordschleife.ts 严格一致）：
 *   世界 y 上；车头 +Z 的模型经 body.rotY(π) + root.rotY(heading+π) 摆到 heading 方向；
 *   前向 f = (sin h, cos h)，h 增大 = 向左转（左舵车头朝 +Z 时 +X 在左）。
 *   `steer` 正 = 左（与 CarLike.setSteer 视觉口径一致），`yawRate` 正 = 左转。
 *
 * 纯状态（无 three / 无 DOM / 无 Game 依赖）—— 全部渲染/音效副作用经回调上抛，
 * 保证 Node 里可直接步进复算（D2 圈速与回归测试同一入口）。
 */
import { BRAKE, DRIVE as DRIVE_POWER, GRAVITY, MS_TO_KMH, VEHICLE } from '../config/physics';
import { getTrack } from '../track/nordschleife';
import { clamp, damp } from '../util/math';

/* ══ 标定表（集中一处，便于复算） ══════════════════════════════════════════ */
export const DRIVE_MODEL = {
  /** 计算质量（VEHICLE.totalMassKg 同源） */
  massKg: VEHICLE.totalMassKg,
  /** 双电机总功率 W */
  powerW: DRIVE_POWER.powerTotalKw * 1000,
  /** 传动效率 */
  driveEfficiency: VEHICLE.driveEfficiency,
  /** 风阻/滚阻 */
  dragCd: VEHICLE.dragCd,
  frontalAreaM2: VEHICLE.frontalAreaM2,
  airDensity: VEHICLE.airDensity,
  rollCrr: VEHICLE.rollResistCrr,
  /** 轴距 */
  wheelbaseM: VEHICLE.wheelbaseM,
  /** 轮胎附着系数（摩擦圆半径 = μ·g） */
  tyreMu: 0.92,
  /** 最大偏航角速度 rad/s（低速满舵上限） */
  maxYawRate: 0.9,
  /** 转向效能参考速度 m/s（低于此不因速度削弱转角） */
  refSpeedMs: 5.5,
  /** 低速最大前轮转角 rad（34°） */
  steerLowRad: (34 * Math.PI) / 180,
  /** 高速最大前轮转角 rad（6°） */
  steerHighRad: (6 * Math.PI) / 180,
  /** 转角收窄区间（km/h） */
  steerLowKmh: 18,
  steerHighKmh: 120,
  /** 转向输入一阶时间常数（低速/高速） */
  steerTauLow: 0.07,
  steerTauHigh: 0.14,
  /** caster 自回正：回正方向 τ 比率 */
  steerReturnRatio: 0.7,
  /** 横摆响应一阶滞后 s */
  yawResponseTau: 0.22,
  /** 手刹后轴抓地下限 */
  driftGripFloor: 0.32,
  /** 后轴抓地衰减/恢复时间常数 */
  gripDecayTau: 0.22,
  gripRecoverTau: 0.45,
  /** 手刹减速度 m/s²（受摩擦圆钳制） */
  handbrakeDecel: 9,
  /** 电子限速 200 km/h */
  maxSpeedMs: VEHICLE.maxSpeedKmh / MS_TO_KMH,
  /** 倒车限速 8 km/h */
  reverseMaxMs: 8 / MS_TO_KMH,
  /** 倒车驱动力（恒值 m/s²） */
  reverseAccelMs2: 1.6,
  /** ABS 制动减速度 1.1g（与 BRAKE.absMaxDecel 同源） */
  brakeDecelMs2: BRAKE.absMaxDecel,
  /** 驱动极限（轮胎附着 × 0.82 稳定裕度） */
  driveLimitN: 0.92 * GRAVITY * VEHICLE.totalMassKg * 0.82,
  /** 视觉侧倾上限 rad（3.5°，仅「横向 g」分量；另叠加路面横倾） */
  rollMaxRad: (3.5 * Math.PI) / 180,
  /** 视觉俯仰上限 rad（2.0°，仅「纵向 g」分量；另叠加路面坡度） */
  pitchMaxRad: (2.0 * Math.PI) / 180,
  /** 侧倾灵敏度：横向加速度参考值 m/s²（R157 重标定 6.0） */
  rollRefMs2: 6.0,
  /** 俯仰灵敏度（R156：pitchMaxRad / 7.756） */
  pitchRefMs2: 7.756,
  /** 二阶悬挂（R156：ω=8.5 / ζ=0.45） */
  susOmega: 8.5,
  susZeta: 0.45,
  /** 最终姿态限位（含路面坡度/横倾） */
  rollLimitRad: 0.16,
  pitchLimitRad: 0.2,
  /** 路肩抓地衰减（|lateral| > 8.4） */
  shoulderGrip: 0.86,
  /** 护栏位置（|lateral| = 10.6 触发碰撞） */
  railLimit: 10.6,
  /** 护栏碰撞速度保留比例 */
  railKeep: 0.82,
  /** 碰撞事件冷却 s（防 120Hz 每步触发） */
  impactCooldown: 0.35,
  /** 起步位置（起终线前 40m） */
  startOffsetM: 40
} as const;

/** 驾驶输入（0..1 / −1..1） */
export interface DriveInput {
  /** 油门 0..1 */
  throttle: number;
  /** 刹车 0..1（停稳后自动转倒车） */
  brake: number;
  /** 转向 −1..1（正 = 左） */
  steer: number;
  handbrake: boolean;
}

export const IDLE_INPUT: DriveInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };

export interface DriveState {
  /** 世界 x / z */
  x: number;
  z: number;
  /** 路面高程（世界 y） */
  y: number;
  /** 航向 rad（0 = 车头 +Z，正 = 左转） */
  heading: number;
  /** 有符号纵向速度 m/s（+ 前进） */
  speed: number;
  /** 前轮转角 rad（正 = 左） */
  steer: number;
  /** 侧滑角 rad（速度方向 = heading + slip；正 = 速度偏在车头左侧） */
  slip: number;
  /** 偏航角速度 rad/s（正 = 左转） */
  yawRate: number;
  /** 后轴抓地系数 0..1 */
  rearGrip: number;
  /** 本步纵向加速度 m/s² */
  accel: number;
  /** 视觉侧倾 rad（body.rotation.z） */
  roll: number;
  /** 视觉俯仰 rad（body.rotation.x） */
  pitch: number;
  /** 沿路弧长 m */
  s: number;
  /** 横向偏移 m（+ = 路右侧，与 track API 同号） */
  lateral: number;
}

/** HUD/遥测快照（复用对象，逐帧读，勿持有引用） */
export interface DriveTelemetry {
  speedKmh: number;
  lateral: number;
  s: number;
  heading: number;
  gear: 'D' | 'R' | 'N';
  y: number;
  throttle: number;
  brake: number;
}

/**
 * R156 常态悬挂二阶单步（簧上质量弹簧-阻尼积分，纯函数）。
 * 加速度 = ω²·(target−body) − 2ζω·vel；稳态 body = target，阶跃有 ~20% 过冲（ζ=0.45）。
 */
export function stepSuspension(
  body: number,
  vel: number,
  target: number,
  omega: number,
  zeta: number,
  dt: number
): readonly [number, number] {
  const acc = omega * omega * (target - body) - 2 * zeta * omega * vel;
  const nextVel = vel + acc * dt;
  return [body + nextVel * dt, nextVel];
}

/**
 * R157 悬挂目标曲线：软区线性 + bump stop 平滑饱和（无 clamp 硬顶）。
 * |input| ≤ aSoft 线性（斜率 maxRad/refMs2）；aSoft..aHard smoothstep 到 maxRad；≥aHard 饱和。
 */
export function suspensionTarget(
  input: number,
  maxRad: number,
  refMs2: number,
  aSoftFrac: number,
  aHard: number
): number {
  const a = Math.abs(input);
  const k = maxRad / refMs2;
  const aSoft = aSoftFrac * refMs2;
  let mag: number;
  if (a <= aSoft) {
    mag = k * a;
  } else if (a >= aHard) {
    mag = maxRad;
  } else {
    const t = (a - aSoft) / (aHard - aSoft);
    mag = k * aSoft + (maxRad - k * aSoft) * (t * t * (3 - 2 * t));
  }
  return Math.sign(input) * mag;
}

/** 速度敏感转角上限（18km/h 34° → 120km/h 6°，中间线性） */
export function steerLimitFor(speedKmh: number): number {
  const t = clamp(
    (speedKmh - DRIVE_MODEL.steerLowKmh) / (DRIVE_MODEL.steerHighKmh - DRIVE_MODEL.steerLowKmh),
    0,
    1
  );
  return DRIVE_MODEL.steerLowRad + (DRIVE_MODEL.steerHighRad - DRIVE_MODEL.steerLowRad) * t;
}

/** 转向输入一阶时间常数（回正更快：× steerReturnRatio） */
export function steerTauFor(speedKmh: number, returning = false): number {
  const t = clamp(
    (speedKmh - DRIVE_MODEL.steerLowKmh) / (DRIVE_MODEL.steerHighKmh - DRIVE_MODEL.steerLowKmh),
    0,
    1
  );
  const base = DRIVE_MODEL.steerTauLow + (DRIVE_MODEL.steerTauHigh - DRIVE_MODEL.steerTauLow) * t;
  return returning ? base * DRIVE_MODEL.steerReturnRatio : base;
}

/** 角度归一到 (−π, π] */
function wrapAngle(a: number): number {
  const t = (a + Math.PI) % (Math.PI * 2);
  return (t < 0 ? t + Math.PI * 2 : t) - Math.PI;
}

export class Drive {
  readonly state: DriveState = {
    x: 0,
    y: 0,
    z: 0,
    heading: 0,
    speed: 0,
    steer: 0,
    slip: 0,
    yawRate: 0,
    rearGrip: 1,
    accel: 0,
    roll: 0,
    pitch: 0,
    s: 0,
    lateral: 0
  };

  /** 撞击回调（Game 负责震屏/FOV punch/音效/火花） */
  onImpact: ((strength: number, x: number, y: number, z: number) => void) | null = null;
  /** 车身姿态回调（Game 写 body.rotation + car.applyWheelSuspension） */
  onBodyPose: ((roll: number, pitch: number) => void) | null = null;

  private rollBody = 0;
  private rollVel = 0;
  private pitchBody = 0;
  private pitchVel = 0;
  private impactCooldown = 0;
  private readonly telemetryObj: DriveTelemetry = {
    speedKmh: 0,
    lateral: 0,
    s: 0,
    heading: 0,
    gear: 'N',
    y: 0,
    throttle: 0,
    brake: 0
  };

  constructor() {
    this.resetToStart();
  }

  /** 回到起点（起终线前 40m、中线、朝 +s、速度 0） */
  resetToStart(): void {
    const track = getTrack();
    this.placeAt(track.length - DRIVE_MODEL.startOffsetM);
  }

  /** QA/调试：把车放到指定弧长（中线、朝 +s、速度 0） */
  teleportTo(s: number): void {
    this.placeAt(s);
  }

  /** R 键复位：回到**当前最近 s** 的中线，速度 0（圈时由 D2 的 LapTimer 决定是否清） */
  resetToTrack(): void {
    const st = this.state;
    const s = Number.isFinite(st.s) ? st.s : 0;
    this.placeAt(s);
  }

  private placeAt(s: number): void {
    const track = getTrack();
    const f = track.at(s);
    const st = this.state;
    st.s = ((s % track.length) + track.length) % track.length;
    st.lateral = 0;
    st.x = f.center.x;
    st.z = f.center.z;
    st.y = f.center.y;
    st.heading = Math.atan2(f.tangent.x, f.tangent.z);
    st.speed = 0;
    st.steer = 0;
    st.slip = 0;
    st.yawRate = 0;
    st.rearGrip = 1;
    st.accel = 0;
    st.roll = 0;
    st.pitch = 0;
    this.rollBody = 0;
    this.rollVel = 0;
    this.pitchBody = 0;
    this.pitchVel = 0;
    this.impactCooldown = 0;
    this.onBodyPose?.(0, 0);
  }

  /** 固定步长推进（1/120s） */
  step(dt: number, input: DriveInput): void {
    if (dt <= 0) return;
    const track = getTrack();
    const D = DRIVE_MODEL;
    const st = this.state;

    /* ── 0. 沿路坐标（步进前）：s / lateral / 路面高程 ─────────────────── */
    let s = track.closestS(st.x, st.z);
    let f = track.at(s);
    let dx = st.x - f.center.x;
    let dz = st.z - f.center.z;
    const rn = f.right.x * f.right.x + f.right.z * f.right.z || 1;
    let lateral = (dx * f.right.x + dz * f.right.z) / rn;
    const bank = f.bank;

    const v = st.speed;
    const av = Math.abs(v);
    const dir = v > 0 ? 1 : v < 0 ? -1 : 0;
    const speedKmh = av * MS_TO_KMH;

    /* ── 1. 转向输入（随速收窄 + 一阶平滑 + caster 自回正）─────────────── */
    const steerMax = steerLimitFor(speedKmh);
    const steerTarget = clamp(input.steer, -1, 1) * steerMax;
    const returning = Math.abs(steerTarget) < Math.abs(st.steer);
    st.steer = damp(st.steer, steerTarget, 1 / steerTauFor(speedKmh, returning), dt);

    /* ── 2. 后轴抓地（手刹收紧 / 松开恢复）────────────────────────────── */
    const gripTarget = input.handbrake ? D.driftGripFloor : 1;
    st.rearGrip = damp(st.rearGrip, gripTarget, 1 / (input.handbrake ? D.gripDecayTau : D.gripRecoverTau), dt);

    /* ── 3. 横向：yawRate = v·tan(δ)/L，摩擦圆钳 |v·yawRate| ≤ μg ─────── */
    const onShoulder = Math.abs(lateral) > 8.4;
    const mu = D.tyreMu * (onShoulder ? D.shoulderGrip : 1);
    const gripLat = mu * GRAVITY;
    const kin = (v * Math.tan(st.steer)) / D.wheelbaseM;
    // 手刹时后轴抓地下降 ⇒ 允许比前轮附着略大的横摆（甩尾的「转」分量）
    const driftYawBoost = 1 + (1 - st.rearGrip) * 0.35;
    const cap = Math.min(D.maxYawRate, (gripLat / Math.max(av, D.refSpeedMs)) * driftYawBoost);
    const yawTarget = clamp(kin, -cap, cap);
    st.yawRate = damp(st.yawRate, yawTarget, 1 / D.yawResponseTau, dt);

    /* 推头：请求横摆超过抓地上限 ⇒ 削速（前轮侧偏饱和的耗散） */
    const over = Math.abs(kin) - cap;
    const scrub = over > 0 ? Math.min(1.5, 0.02 * over * av) : 0;

    /* ── 4. 纵向力：电机（恒扭矩→恒功率）+ 制动（1.1g ABS）+ 阻力 ─────── */
    const latUse = Math.min(gripLat, Math.abs(st.yawRate * v));
    const longAvail = Math.sqrt(Math.max(0, D.brakeDecelMs2 * D.brakeDecelMs2 - latUse * latUse));
    const driveAvail = Math.sqrt(Math.max(0, gripLat * gripLat - latUse * latUse));
    const motorForce =
      Math.min((D.powerW * D.driveEfficiency) / Math.max(av, 1), D.driveLimitN) *
      clamp(input.throttle, 0, 1);

    let a = 0;
    if (motorForce > 0) a += Math.min(motorForce / D.massKg, driveAvail);
    if (input.brake > 0) {
      if (v > BRAKE.stopSpeed) a -= Math.min(D.brakeDecelMs2, longAvail) * clamp(input.brake, 0, 1);
      else a -= D.reverseAccelMs2; // 停稳后同键转倒车
    }
    if (input.handbrake) a -= dir * Math.min(D.handbrakeDecel, longAvail);
    const drag = 0.5 * D.airDensity * D.dragCd * D.frontalAreaM2 * v * v;
    const roll = D.rollCrr * D.massKg * GRAVITY;
    if (dir !== 0) {
      a -= dir * ((drag + roll) / D.massKg);
      a -= dir * scrub;
    }

    let vNext = v + a * dt;
    if (vNext > D.maxSpeedMs) vNext = D.maxSpeedMs;
    if (vNext < -D.reverseMaxMs) vNext = -D.reverseMaxMs;
    if (input.brake > 0 && v > 0 && vNext < 0) vNext = 0; // 制动不一步跨进倒车
    if (
      input.throttle === 0 &&
      input.brake === 0 &&
      !input.handbrake &&
      dir !== 0 &&
      vNext * dir <= 0
    ) {
      vNext = 0; // 滑行阻力不把车推过零点
    }
    st.accel = (vNext - v) / dt;
    st.speed = vNext;

    /* ── 5. 侧滑角（手刹甩尾 / 恢复）──────────────────────────────────── */
    // 正 slip = 速度方向偏在车头左侧。左转（steer>0）时车尾右滑 ⇒ 速度偏右 ⇒ slip<0
    const slipTarget = input.handbrake
      ? clamp(-st.steer * 1.6, -0.5, 0.5)
      : clamp(-st.steer * (1 - st.rearGrip) * 0.9, -0.35, 0.35);
    st.slip = damp(st.slip, slipTarget, 1 / (input.handbrake ? 0.35 : D.gripRecoverTau), dt);

    /* ── 6. 积分（梯形速度；位移用 heading+slip）──────────────────────── */
    const vAvg = 0.5 * (v + vNext);
    const moveHeading = st.heading + st.slip;
    st.x += Math.sin(moveHeading) * vAvg * dt;
    st.z += Math.cos(moveHeading) * vAvg * dt;
    st.heading = wrapAngle(st.heading + st.yawRate * dt);

    /* ── 7. 步进后沿路坐标 + 路面高程 ─────────────────────────────────── */
    s = track.closestS(st.x, st.z);
    f = track.at(s);
    dx = st.x - f.center.x;
    dz = st.z - f.center.z;
    const rn2 = f.right.x * f.right.x + f.right.z * f.right.z || 1;
    lateral = (dx * f.right.x + dz * f.right.z) / rn2;
    st.s = s;
    st.lateral = lateral;
    st.y = f.center.y + f.right.y * lateral;

    /* ── 8. 护栏碰撞（|lateral| > 10.6）：推回 + 切向保速 + 撞击回调 ──── */
    this.impactCooldown = Math.max(0, this.impactCooldown - dt);
    if (Math.abs(lateral) > D.railLimit) {
      const sign = lateral > 0 ? 1 : -1;
      const lat = sign * D.railLimit;
      st.x = f.center.x + f.right.x * lat;
      st.z = f.center.z + f.right.z * lat;
      st.y = f.center.y + f.right.y * lat;
      st.lateral = lat;
      st.slip *= 0.5;
      if (this.impactCooldown <= 0 && av > 1.2) {
        this.impactCooldown = D.impactCooldown;
        st.speed = vNext * D.railKeep;
        const strength = clamp(av / 25, 0.12, 1);
        this.onImpact?.(strength, st.x, st.y + 0.7, st.z);
      } else {
        // 贴墙持续刮擦：轻微耗散（不重复触发撞击演出）
        st.speed = vNext * Math.exp(-1.5 * dt);
      }
    }

    /* ── 9. 视觉姿态（R156 二阶悬挂 + 路面坡度/横倾）─────────────────── */
    const latAccel = st.yawRate * vAvg; // 正 = 左转（与旧仓 roll 目标同号）
    const rollTarget =
      suspensionTarget(latAccel, D.rollMaxRad, D.rollRefMs2, 0.7, 7.0) - bank;
    const pitchTarget =
      suspensionTarget(st.accel, D.pitchMaxRad, D.pitchRefMs2, 0.7, 11.0) +
      Math.atan(f.grade);
    [this.rollBody, this.rollVel] = stepSuspension(
      this.rollBody,
      this.rollVel,
      rollTarget,
      D.susOmega,
      D.susZeta,
      dt
    );
    [this.pitchBody, this.pitchVel] = stepSuspension(
      this.pitchBody,
      this.pitchVel,
      pitchTarget,
      D.susOmega,
      D.susZeta,
      dt
    );
    st.roll = clamp(this.rollBody, -D.rollLimitRad, D.rollLimitRad);
    st.pitch = clamp(this.pitchBody, -D.pitchLimitRad, D.pitchLimitRad);
    this.onBodyPose?.(st.roll, st.pitch);
  }

  /** HUD/遥测（复用对象） */
  get telemetry(): DriveTelemetry {
    const st = this.state;
    const t = this.telemetryObj;
    t.speedKmh = Math.abs(st.speed) * MS_TO_KMH;
    t.lateral = st.lateral;
    t.s = st.s;
    t.heading = st.heading;
    t.gear = st.speed < -0.2 ? 'R' : Math.abs(st.speed) < 0.05 ? 'N' : 'D';
    t.y = st.y;
    return t;
  }
}
