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
import { nextCornerAt } from '../track/cornerData';
import { clamp, damp } from '../util/math';
import { FREE_BODY_IMPACT_OSC } from '../config/freeBodyFeel';

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
  /**
   * 高速最大前轮转角 rad —— D2 手感校准：6°(0.1047) → **0.48 rad（27.5°）**。
   * 旧仓 FREE 表口径：满舵转动量随速收窄的是**响应**，不是把方向盘变成微调旋钮；
   * 6° 在 120km/h 只剩 0.1rad，转向像「坏了的助力」。0.48 配合下面 60km/h 的收窄
   * 上限，高速真正的限幅来自摩擦圆（gripLat / v），不是转角表（见文件头第 3 步）。
   */
  steerHighRad: 0.48,
  /** 转角收窄区间（km/h）：18 → 60（旧仓 FREE 表；120 时仍按满收窄值 0.48 处理） */
  steerLowKmh: 18,
  steerHighKmh: 60,
  /** 转向输入一阶时间常数（低速/高速）
   *  V2 手感微调：steerTauHigh 0.14 → **0.134**（−4.3%，±5% 内）——高速转向略更利落，
   *  减轻「120km/h 打舵等半拍」的肉感；低速 steerTauLow 0.07 不动（低速已够跟手）。 */
  steerTauLow: 0.07,
  steerTauHigh: 0.134,
  /** caster 自回正：回正方向 τ 比率 */
  steerReturnRatio: 0.7,
  /**
   * 横摆响应一阶滞后 s —— D2：0.22 → **0.07**。
   * 0.22 是「打舵后要等 ~0.7s 车头才转」的橡皮感；涡扇电车该跟手。
   * 高频抖动由转向输入自身的一阶 τ（0.07/0.14）+ 摩擦圆钳制兜住，不靠这里。
   */
  yawResponseTau: 0.07,
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
  /** V21 砾石抓地下限（护栏前 |lateral|=10.1）：8.4→0.86 线性渐降至 10.1→0.72 */
  gravelGripFloor: 0.72,
  /** 护栏碰撞横向极限：护栏梁在 ±11.2（Track.ts），车身半宽 ~1.0（V800 2.006m）
   *  ⇒ clamp = railOffset − halfWidth − 0.1 余量 = 10.1，车身外缘 11.1 < 11.2 不穿梁。
   *  测试断言 |lateral| ≤ 10.7（10.1 + 1 步容差仍兼容）。 */
  railLimit: 10.1,
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
  /** 前方刹车点提示（cornerData.nextCornerAt 逐帧刷新；null=无刹车点/全在巡航内） */
  cornerHint: { name: string; distanceToBrake: number } | null;
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

/** 速度敏感转角上限（18km/h 34° → 60km/h 27.5°(0.48rad)，中间线性；D2 校准） */
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
  /** R126 撞墙「被顶晃动」欠阻尼二阶通道（目标=0 自由振荡，叠加在 rollBody/pitchBody 上） */
  private impactRollOsc = 0;
  private impactRollOscVel = 0;
  private impactPitchOsc = 0;
  private impactPitchOscVel = 0;
  private impactCooldown = 0;
  private readonly telemetryObj: DriveTelemetry = {
    speedKmh: 0,
    lateral: 0,
    s: 0,
    heading: 0,
    gear: 'N',
    y: 0,
    throttle: 0,
    brake: 0,
    cornerHint: null
  };
  /** 复用的 cornerHint 对象（避免每帧新分配；telemetryObj.cornerHint 指向它） */
  private cornerHintObj: { name: string; distanceToBrake: number } | null = null;

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
    this.impactRollOsc = 0;
    this.impactRollOscVel = 0;
    this.impactPitchOsc = 0;
    this.impactPitchOscVel = 0;
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
    const latAbs = Math.abs(lateral);
    const onShoulder = latAbs > 8.4;
    // V21 砾石抓地深度渐变：|lateral| 8.4→0.86 .. 10.1（护栏前）→0.72，路面恒 1.0。
    // 跑宽上砾石（弯道外侧跑偏区）抓地随深度线性下滑，真正付出抓地代价。
    const shoulderFactor = onShoulder
      ? D.shoulderGrip - (D.shoulderGrip - D.gravelGripFloor) * clamp((latAbs - 8.4) / (10.1 - 8.4), 0, 1)
      : 1;
    const mu = D.tyreMu * shoulderFactor;
    // V6 横倾（bank）内倾帮助过弯（AC 式「倾角」物理）：路面朝弯内倾斜，重力沿坡面
    // 产生向弯内分力 g·sin(|bank|)，净可用横向抓地 = mu·g·cos(bank) + g·sin(bank)。
    // bank 生成规则「左弯左低」（nordschleife）⇒ 恒内倾 ⇒ 恒帮助（|bank|≤5.5° ⇒ +≤0.94 m/s²）。
    // 直道/起点 bank≈0（实测 s=0..800 全 0.00°）⇒ 对转弯半径、yawRate、0-100 回归无影响。
    const bankAbs = Math.abs(bank);
    const gripLat = mu * GRAVITY * Math.cos(bankAbs) + GRAVITY * Math.sin(bankAbs);
    // 路肩破坏动态 V2 —— 报告：路肩普遍高而凸，压上破坏动态强（比 V1 更真实）。
    // 分带（|lateral|）：
    //   路缘凸起（curb lip） 7.5~8.8 —— 高而凸，压上「顶一下」，向内推很强（×1.6）；
    //   土路肩（gravel）    8.8~10.1 —— 松散，持续拖拽（railLimit 之前，草地不可达）。
    // V25b 路缘惩罚加强（真实纽北「路肩很高，绝逼不能有吃路肩的想法」）：
    //   路缘带（7.5~8.8）curbTier 1.2 → **1.6**（更强向内推），curbYaw 系数 0.04 → **0.06**
    //   （更强横摆失稳，读作「压路缘弹跳失控前兆」）；砾石带（8.8~10.1）curbTier 仍 1.0 不动。
    // 随速增强：≤60km/h 无破坏（正常路面 / 低速完全不受影响），80km/h 达 V1 基线 1.0，
    //           160km/h 饱和 1.4×（速度越高破坏越强）。
    // 方向恒为向路内（减小 |lateral|）；整量被下方 cap 钳住 ⇒ 不突破摩擦圆 / yawRate 断言。
    const speedK =
      speedKmh <= 60 ? 0 : speedKmh >= 160 ? 1.4 : clamp((speedKmh - 60) / 20, 0, 1) * (1 + 0.4 * clamp((speedKmh - 80) / 80, 0, 1));
    const depth = latAbs > 7.5 ? clamp((latAbs - 7.5) / 2, 0, 1) : 0; // 7.5→0 .. 9.5→1
    const curbTier = latAbs > 7.5 && latAbs < 8.8 ? 1.6 : 1.0; // 路缘凸起很强（V25b：1.2→1.6）
    const curbMag = depth * curbTier * speedK; // 0..2.24（速度/分带增强）
    const curbYaw = curbMag > 0 ? -Math.sign(lateral) * curbMag * 0.06 : 0; // 向路内 rad/s（V25b：0.04→0.06）
    const kin = (v * Math.tan(st.steer)) / D.wheelbaseM + curbYaw;
    // 手刹时后轴抓地下降 ⇒ 允许比前轮附着略大的横摆（甩尾的「转」分量）
    // 弯中纵向载荷转移（用上一步纵向加速度 st.accel 作代理）：加速时后轴卸载 ⇒ 横摆略活
    // （油门转），制动时前轴加载 ⇒ 横摆略稳（刹车稳）。幅度 ±6%，只改 yaw 动态，
    // 不改变总摩擦圆 / 制动距离 / 转弯半径基线（见 drive_model 回归）。
    const loadK = clamp(st.accel / D.brakeDecelMs2, -1, 1);
    const driftYawBoost = (1 + (1 - st.rearGrip) * 0.35) * (1 + loadK * 0.06);
    const cap = Math.min(D.maxYawRate, (gripLat / Math.max(av, D.refSpeedMs)) * driftYawBoost);
    // V3 轮胎侧偏非线性过渡：载荷利用率 u = |yawRate·v|/gripLat 接近极限（>0.85）时
    // 前轮侧偏角增大 → 抓地渐进下滑 → 转向响应渐钝（推头/滑移前兆），幅值 ≤4%。
    // 低速转弯利用率仅 ~0.5（不触发），故转弯半径 / 低速手感不受影响；只软化高速极限区。
    let yawTarget = clamp(kin, -cap, cap);
    const util = Math.min(1, Math.abs(st.yawRate * v) / gripLat);
    const soften = 1 - 0.04 * clamp((util - 0.85) / 0.15, 0, 1);
    yawTarget *= soften;
    // 横摆响应随速度微调（±5% 内）：高速略增阻尼（更稳不飘），低速更跟手。
    const yawTau = D.yawResponseTau * (1 + 0.05 * clamp((speedKmh - 80) / 120, 0, 1));
    st.yawRate = damp(st.yawRate, yawTarget, 1 / yawTau, dt);

    /* 推头：请求横摆超过抓地上限 ⇒ 削速（前轮侧偏饱和的耗散） */
    const over = Math.abs(kin) - cap;
    const scrub = over > 0 ? Math.min(1.5, 0.02 * over * av) : 0;

    /* ── 4. 纵向力：电机（恒扭矩→恒功率）+ 制动（1.1g ABS）+ 阻力 ─────── */
    const latUse = Math.min(gripLat, Math.abs(st.yawRate * v));
    const longAvail = Math.sqrt(Math.max(0, D.brakeDecelMs2 * D.brakeDecelMs2 - latUse * latUse));
    const driveAvail = Math.sqrt(Math.max(0, gripLat * gripLat - latUse * latUse));
    // V3 起步扭矩爬坡：0→12km/h 驱动极限从 90% 线性爬满（重车起步沉稳不窜，
    // 而非瞬时满扭矩「窜出去」）；≥12km/h 全扭矩（不影响 0-100 主体，见回归）。
    // 幅度 10%（±5% 内保守微调）——起步初段略柔、不窜，12km/h 后与 V2 一致。
    const launchK = speedKmh <= 12 ? 0.9 + 0.1 * (speedKmh / 12) : 1;
    const driveLimit = D.driveLimitN * launchK;
    const motorForce =
      Math.min((D.powerW * D.driveEfficiency) / Math.max(av, 1), driveLimit) *
      clamp(input.throttle, 0, 1);

    let a = 0;
    // V3 怠速蠕行：D 挡松油门/松刹车低速缓慢滑行（≤5km/h），模拟液力变矩器怠速带
    // （重车蠕行沉稳不窜）；只在前进/静止、无刹车无手刹时生效，超 5km/h 即停（不叠加驱动）。
    // 幅度 0.45 m/s²（≈0.05g）—— 低速蠕行真实感；对 0-100 / 制动 / 巡航均无实质影响。
    if (v >= 0 && input.brake <= 0 && !input.handbrake && speedKmh < 5) a += 0.45;
    if (motorForce > 0) a += Math.min(motorForce / D.massKg, driveAvail);
    if (input.brake > 0) {
      if (v > BRAKE.stopSpeed) {
        // V3 渐进制动踏板感：brake 经 smoothstep 映射（小脚更渐进、大脚近线性），
        // brake=1 → 映射=1（制动距离 / ABS 1.1g 基线不变，见 drive_model 回归）。
        const b = clamp(input.brake, 0, 1);
        const bEff = b * b * (3 - 2 * b);
        a -= Math.min(D.brakeDecelMs2, longAvail) * bEff;
      } else a -= D.reverseAccelMs2; // 停稳后同键转倒车
    }
    if (input.handbrake) a -= dir * Math.min(D.handbrakeDecel, longAvail);
    const drag = 0.5 * D.airDensity * D.dragCd * D.frontalAreaM2 * v * v;
    const roll = D.rollCrr * D.massKg * GRAVITY;
    if (dir !== 0) {
      a -= dir * ((drag + roll) / D.massKg);
      a -= dir * scrub;
      // 路肩附加阻力（V2 随速/分带增强，≤0.25 m/s²）
      // V21 砾石带（8.8-10.1）拖拽略增：max 0.12*1.4≈0.17 m/s²，跑宽上砾石真正变慢。
      const gravelDepth = latAbs > 8.8 ? clamp((latAbs - 8.8) / 1.3, 0, 1) : 0;
      a -= dir * (curbMag * 0.15 + gravelDepth * 0.12 * speedK);
    }

    // V4 纵向重力分量（AC 式「斜坡/倾角」物理）：上坡减速 / 下坡加速。
    // f.grade = 中心差分 dy/ds = sin(坡度角)；重力沿坡分量 g·sin α = g·grade。
    // 方向恒沿 ±s（重力只随坡向、不随车头）；乘 sign(v) 使掉头/倒车符号正确，
    // v=0 静止不滑（简化，无坡道溜车模型）。纽北 |grade|max≈0.072 ⇒ ≤0.71 m/s²，
    // 直道标定段（s=17200）|grade|≈0.0083 ⇒ ≈0.08 m/s²，落在 0-100/制动回归容差内。
    a -= GRAVITY * f.grade * Math.sign(v);

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
        // R126 撞墙「被顶晃动」：一次性注入角速度（撞击法向速度 av 加权，pitch 负=车头朝墙点头），
        // 下方二阶自由振荡过冲回摆一次。与旧仓 FREE_BODY_IMPACT_OSC 同源（ω8/ζ0.5），只叠视觉姿态。
        this.impactRollOscVel += FREE_BODY_IMPACT_OSC.rollGain * av;
        this.impactPitchOscVel -= FREE_BODY_IMPACT_OSC.pitchGain * av;
      } else {
        // 贴墙持续刮擦：轻微耗散（不重复触发撞击演出）
        st.speed = vNext * Math.exp(-1.5 * dt);
      }
    }

    /* ── 9. 视觉姿态（R156 二阶悬挂 + 路面坡度/横倾）─────────────────── */
    const latAccel = st.yawRate * vAvg; // 正 = 左转（与旧仓 roll 目标同号）
    // 路肩「顶一下」侧倾扰动：压上高凸路缘，车身朝路内微倾（视觉小颠簸，≤0.012rad）。
    const curbRoll = curbMag > 0 ? -Math.sign(lateral) * curbMag * 0.012 : 0;
    const rollTarget =
      suspensionTarget(latAccel, D.rollMaxRad, D.rollRefMs2, 0.7, 7.0) - bank + curbRoll;
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
    // R126 撞墙「被顶晃动」二阶自由振荡（目标=0 衰减；与 R156 常态二阶独立叠加）。
    // ζ=0.5 ⇒ 一次清晰回摆 ~16%，不过冲失控；幅值由 FREE_BODY_IMPACT_OSC 参数有界。
    {
      const oi = FREE_BODY_IMPACT_OSC;
      const rollAcc = oi.omega * oi.omega * -this.impactRollOsc - 2 * oi.zeta * oi.omega * this.impactRollOscVel;
      this.impactRollOscVel += rollAcc * dt;
      this.impactRollOsc += this.impactRollOscVel * dt;
      const pitchAcc = oi.omega * oi.omega * -this.impactPitchOsc - 2 * oi.zeta * oi.omega * this.impactPitchOscVel;
      this.impactPitchOscVel += pitchAcc * dt;
      this.impactPitchOsc += this.impactPitchOscVel * dt;
    }
    st.roll = clamp(this.rollBody + this.impactRollOsc, -D.rollLimitRad, D.rollLimitRad);
    st.pitch = clamp(this.pitchBody + this.impactPitchOsc, -D.pitchLimitRad, D.pitchLimitRad);
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
    // 前方刹车点提示（cornerData.nextCornerAt，按当前赛道 length 分流；环绕取正；复用对象避免每帧分配）
    const hint = nextCornerAt(st.s, getTrack().length);
    if (hint) {
      if (!this.cornerHintObj) this.cornerHintObj = { name: '', distanceToBrake: 0 };
      this.cornerHintObj.name = hint.corner.name;
      this.cornerHintObj.distanceToBrake = hint.distanceToBrake;
      t.cornerHint = this.cornerHintObj;
    } else {
      t.cornerHint = null;
    }
    return t;
  }
}
