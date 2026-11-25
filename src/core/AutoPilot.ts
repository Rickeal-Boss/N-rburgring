/**
 * 自动驾驶（QA 钩子 `#autodrive` 的控制器，**纯函数**、无 DOM 依赖）
 *
 * 目的：让 headless / 无输入的环境能跑完整圈，做圈速与里程的回归（D2 验收）。
 * 控制律是「纯追踪（pure pursuit）+ 弯道限速」，不追求圈速，只要求：
 *   · 稳定在 55~65 km/h 巡航（直道），弯道按摩擦圆反推的极限速度自动收油；
 *   · 横向偏差收敛到中线（|lateral| 远小于 8.4m 路肩阈值）；
 *   · 不触发 NaN、不打转、不被护栏卡死（否则圈时/里程断言会失败）。
 *
 * 为什么用纯追踪而不是「横向偏差 × 增益」：后者在 60km/h、40m 前视下是明显
 * 欠阻尼的（实测横向 ±8m 摆振、偶发贴护栏）；纯追踪直接把「车 → 前视点」的
 * 几何曲率换成前轮转角，横向误差由几何自然收敛，无振铃。
 *
 * 符号约定（与 core/Drive.ts 严格一致，改前必读）：
 *   前视点方位角 − 航向 = alpha > 0 ⇒ 目标在车头 +X 偏侧；而 steer 输入 > 0
 *   ⇒ yawRate > 0 ⇒ heading 增大 ⇒ 车头朝 +X 转。故 steer 与 alpha **同号**。
 *   （curl = 2·sinα/Ld 的纯追踪曲率；前轮转角 δ = atan(curl·轴距)，再除以
 *     `steerLimitFor(v)` 归一成 DriveInput.steer 的 [−1,1] 口径。）
 */
import { DRIVE_MODEL, steerLimitFor, type DriveInput, type DriveState } from './Drive';
import { GRAVITY, MS_TO_KMH } from '../config/physics';
import { getTrack } from '../track/nordschleife';
import { clamp } from '../util/math';

/** 轮胎附着（与 DRIVE_MODEL.tyreMu 同源，用于弯道限速反推） */
const TYRE_MU = 0.92;
const GRIP_LAT = TYRE_MU * GRAVITY;
/** 弯道限速的工程裕度（留 2% 抓地余量，避免贴边） */
const LIMIT_MARGIN = 0.97;
/** 弯道限速扫描点（前视距离的比例位置） */
const SCAN_FRACS: readonly number[] = [0.35, 0.6, 1];

function wrapAngle(a: number): number {
  let t = (a + Math.PI) % (Math.PI * 2);
  if (t < 0) t += Math.PI * 2;
  return t - Math.PI;
}

/**
 * 写入一步自动驾驶输入（复用 `out`，零分配）。
 * @param state Drive 的 state（只读）
 * @param out 待写的 DriveInput
 * @param cruiseKmh 直道巡航目标（验收口径 55~65，默认 60）
 */
export function autopilotInput(state: DriveState, out: DriveInput, cruiseKmh = 60): void {
  const track = getTrack();
  const v = state.speed;
  const av = Math.abs(v);
  // 前视距离随车速拉长（60km/h ≈ 23m），弯道再自动缩短
  const look = clamp(8 + av * 0.9, 8, 45);

  // ── 转向：纯追踪（车 → 前视点 的几何曲率）─────────────────────────
  const target = track.at(state.s + look);
  const dx = target.center.x - state.x;
  const dz = target.center.z - state.z;
  const ld = Math.max(5, Math.hypot(dx, dz));
  const alpha = wrapAngle(Math.atan2(dx, dz) - state.heading);
  const delta = Math.atan((2 * Math.sin(alpha) * DRIVE_MODEL.wheelbaseM) / ld);
  const steerMax = steerLimitFor(av * MS_TO_KMH);
  out.steer = clamp(delta / Math.max(0.05, steerMax), -1, 1);

  // ── 纵向：弯道极限速度（扫描前视三点取最急弯）──────────────────────
  let minRadius = Number.POSITIVE_INFINITY;
  for (const frac of SCAN_FRACS) {
    const curv = Math.abs(track.at(state.s + look * frac).curvature);
    if (curv > 1e-5) minRadius = Math.min(minRadius, 1 / curv);
  }
  const vLimit = Number.isFinite(minRadius) ? Math.sqrt(GRIP_LAT * minRadius) * LIMIT_MARGIN : Infinity;
  const targetMs = Math.max(30 / 3.6, Math.min(cruiseKmh / 3.6, vLimit));

  const err = targetMs - v;
  if (err > 0.2) {
    out.throttle = clamp(0.25 + err * 0.5, 0, 1);
    out.brake = 0;
  } else if (err < -0.35) {
    out.throttle = 0;
    out.brake = clamp(-err * 0.35, 0, 1);
  } else {
    out.throttle = clamp(0.12 + Math.max(0, err) * 0.4, 0, 0.28);
    out.brake = 0;
  }
  out.handbrake = false;
}
