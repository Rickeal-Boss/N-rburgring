/**
 * 纽博格林北环（Nordschleife）中心线 · 纯数据层（零依赖 / 零 three）
 *
 * 造型来源：按公开赛道走向手工编排的 106 个路点（Hatzenbach → Flugplatz →
 * Schwedenkreuz → Aremberg → Fuchsröhre → Adenauer Forst → Metzgesfeld →
 * Kallenhard → Wehrseifen → Ex-Mühle → Bergwerk → Kesselchen → Klostertal →
 * Karussell → Hohe Acht → Wippermann → Eschbach → Brünnchen → Pflanzgarten →
 * Schwalbenschwanz → Galgenkopf → Döttinger Höhe → Antoniusbuche → Tiergarten →
 * Hohenrain → 起终线），经闭合 centripetal Catmull–Rom 插值 + 等弧长重采样，
 * 缩放到 20 831.6 m（北环官方长度 20.832 km）。
 *
 * 坐标系：x 东、z 北、y 上；起终线在原点附近，行驶方向沿 +z（北）。
 * 局部路面坐标：s = 沿路弧长，x = 横向（右正），y = 离路面高度。
 *
 * 本文件只提供几何，不做任何渲染/物理；所有采样数组在构造时一次算好。
 */

import { newSuedschleife } from './suedschleife';

export interface V3 {
  x: number;
  y: number;
  z: number;
}

export interface TrackFrame {
  s: number;
  /** 中心线世界位置 */
  center: V3;
  /** 单位切向（前进方向） */
  tangent: V3;
  /** 单位右向 = tangent × up0 */
  right: V3;
  /** 单位路面法向（含横倾） */
  up: V3;
  /** 有符号曲率：>0 左弯（XZ 平面逆时针），1/m */
  curvature: number;
  /** 纵向坡度 dy/ds */
  grade: number;
  /** 横倾角（rad），右高左低为正（左弯） */
  bank: number;
}

export const TRACK_LENGTH = 20831.6;

/** 高程剖面：按弧长 s（米）与总长 L（米）返回世界 y 高程（米） */
export type ElevationProfile = (s: number, L: number) => number;

/** 世界尺度下路点（米）；x 已含东西向压缩，整体按 TRACK_LENGTH 归一 */
export const WAYPOINTS: ReadonlyArray<readonly [number, number]> = [
  [-26.23, 145.71], [-78.68, 291.41], [-52.45, 437.12], [-118.02, 564.61], [-65.57, 710.32],
  [-144.25, 837.81], [-91.8, 983.52], [-170.48, 1111.02], [-131.14, 1274.94], [-209.82, 1420.64],
  [-196.7, 1584.56], [-288.5, 1730.27], [-393.41, 1875.98], [-511.43, 2021.68], [-642.57, 2167.39],
  [-760.59, 2331.31], [-917.95, 2477.02], [-1101.54, 2586.3], [-1285.14, 2622.73], [-1442.5, 2549.87],
  [-1586.75, 2404.16], [-1704.77, 2222.03], [-1835.91, 2094.54], [-1993.27, 2039.9], [-2163.75, 2094.54],
  [-2294.88, 2240.24], [-2399.79, 2422.38], [-2530.93, 2586.3], [-2701.41, 2713.79], [-2885.0, 2786.65],
  [-3081.7, 2786.65], [-3265.29, 2732.01], [-3435.77, 2640.94], [-3580.02, 2695.58], [-3698.04, 2859.5],
  [-3802.95, 3059.85], [-3934.09, 3205.55], [-4117.68, 3296.62], [-4314.38, 3405.9], [-4484.86, 3588.03],
  [-4616.0, 3824.81], [-4694.68, 4098.01], [-4720.91, 4371.21], [-4681.56, 4644.41], [-4589.77, 4844.76],
  [-4445.52, 4954.04], [-4288.16, 4972.25], [-4143.91, 4917.61], [-4012.77, 4808.33], [-3894.75, 4680.84],
  [-3737.38, 4626.2], [-3566.91, 4662.62], [-3409.54, 4753.69], [-3265.29, 4808.33], [-3107.93, 4790.12],
  [-2963.68, 4699.05], [-2832.54, 4571.56], [-2701.41, 4444.06], [-2557.16, 4371.21], [-2412.91, 4407.64],
  [-2281.77, 4516.92], [-2150.63, 4607.98], [-2006.38, 4626.2], [-1875.25, 4553.34], [-1744.11, 4444.06],
  [-1612.98, 4371.21], [-1468.73, 4389.42], [-1337.59, 4498.7], [-1180.23, 4589.77], [-1022.86, 4626.2],
  [-852.39, 4626.2], [-655.68, 4607.98], [-458.98, 4589.77], [-262.27, 4571.56], [-65.57, 4553.34],
  [131.14, 4553.34], [327.84, 4571.56], [524.55, 4607.98], [681.91, 4680.84], [813.04, 4771.9],
  [944.18, 4826.54], [1075.32, 4808.33], [1206.45, 4735.48], [1324.48, 4607.98], [1429.39, 4444.06],
  [1521.18, 4243.72], [1586.75, 4006.94], [1626.09, 3751.95], [1645.76, 3460.54], [1652.32, 3169.13],
  [1639.2, 2877.71], [1612.98, 2586.3], [1573.64, 2294.88], [1521.18, 2003.47], [1455.61, 1712.06],
  [1376.93, 1420.64], [1285.14, 1147.44], [1180.23, 892.46], [1062.2, 655.68], [931.07, 455.33],
  [786.82, 291.41], [629.45, 163.92], [458.98, 91.07], [288.5, 54.64], [131.14, 36.43],
  [52.45, 18.21]
];

/** 路面/路缘/路肩几何（米） */
export const ROAD = {
  /** 石板铺装半宽（原版 14m 全宽，贴图三带语义不变） */
  halfWidth: 7,
  /** 路缘石宽（两侧） */
  kerbWidth: 1.4,
  /** 路肩宽（路缘外草地/泥土带） */
  shoulderWidth: 3.2,
  /** 护栏距中心线 */
  railOffset: 11.2,
  /** 采样的目标步长（米） */
  sampleSpacing: 4
} as const;

const TAU = Math.PI * 2;
const WORLD_UP = 1;

function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/** raised-cosine 包：中心 1，|d|≥w 时 0，端点一阶导为 0 */
function bumpAt(s: number, center: number, width: number): number {
  const d = Math.abs(s - center);
  if (d >= width) return 0;
  const c = Math.cos((Math.PI / 2) * (d / width));
  return c * c;
}

/**
 * 高程：低频起伏 + 四处地标包（Hohe Acht 最高点 / Fuchsröhre 下坡 /
 * Wehrseifen 低点 / Karussell 台地）。全部按弧长定义 ⇒ 闭合天然成立。
 */
function elevationRaw(s: number, L: number): number {
  const t = (s / L) * TAU;
  let y = 6.5 * Math.sin(2 * t + 0.4) + 3.6 * Math.sin(5 * t + 1.1) + 2.1 * Math.sin(11 * t + 2.0);
  y += 34 * bumpAt(s, L * 0.405, 820);
  y -= 17 * bumpAt(s, L * 0.216, 420);
  y -= 9 * bumpAt(s, L * 0.335, 460);
  y += 5 * bumpAt(s, L * 0.404, 260);
  return y;
}

interface PlanPoint {
  x: number;
  z: number;
}

function dist2(a: PlanPoint, b: PlanPoint): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** 闭合 centripetal Catmull–Rom（Barry–Goldman） */
function catmullRomClosed(points: ReadonlyArray<readonly [number, number]>, substeps: number): PlanPoint[] {
  const n = points.length;
  const out: PlanPoint[] = [];
  const P = (i: number): PlanPoint => {
    const p = points[((i % n) + n) % n];
    return { x: p[0], z: p[1] };
  };
  for (let i = 0; i < n; i++) {
    const p0 = P(i - 1);
    const p1 = P(i);
    const p2 = P(i + 1);
    const p3 = P(i + 2);
    const t0 = 0;
    const t1 = t0 + Math.pow(Math.max(1e-6, dist2(p0, p1)), 0.5);
    const t2 = t1 + Math.pow(Math.max(1e-6, dist2(p1, p2)), 0.5);
    const t3 = t2 + Math.pow(Math.max(1e-6, dist2(p2, p3)), 0.5);
    for (let k = 0; k < substeps; k++) {
      const t = t1 + ((t2 - t1) * k) / substeps;
      const a1 = { x: p0.x + ((p1.x - p0.x) * (t - t0)) / (t1 - t0), z: p0.z + ((p1.z - p0.z) * (t - t0)) / (t1 - t0) };
      const a2 = { x: p1.x + ((p2.x - p1.x) * (t - t1)) / (t2 - t1), z: p1.z + ((p2.z - p1.z) * (t - t1)) / (t2 - t1) };
      const a3 = { x: p2.x + ((p3.x - p2.x) * (t - t2)) / (t3 - t2), z: p2.z + ((p3.z - p2.z) * (t - t2)) / (t3 - t2) };
      const b1 = { x: a1.x + ((a2.x - a1.x) * (t - t0)) / (t2 - t0), z: a1.z + ((a2.z - a1.z) * (t - t0)) / (t2 - t0) };
      const b2 = { x: a2.x + ((a3.x - a2.x) * (t - t1)) / (t3 - t1), z: a2.z + ((a3.z - a2.z) * (t - t1)) / (t3 - t1) };
      out.push({
        x: b1.x + ((b2.x - b1.x) * (t - t1)) / (t2 - t1),
        z: b1.z + ((b2.z - b1.z) * (t - t1)) / (t2 - t1)
      });
    }
  }
  return out;
}

function resampleClosed2D(dense: PlanPoint[], count: number): { points: PlanPoint[]; length: number } {
  const n = dense.length;
  const cum: number[] = new Array(n + 1).fill(0);
  for (let i = 1; i <= n; i++) cum[i] = cum[i - 1] + dist2(dense[i - 1], dense[i % n]);
  const total = cum[n];
  const out: PlanPoint[] = [];
  let cursor = 1;
  for (let i = 0; i < count; i++) {
    const target = (total * i) / count;
    while (cursor < n && cum[cursor] < target) cursor++;
    const a = dense[(cursor - 1) % n];
    const b = dense[cursor % n];
    const seg = cum[cursor] - cum[cursor - 1];
    const t = seg > 1e-9 ? (target - cum[cursor - 1]) / seg : 0;
    out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
  }
  return { points: out, length: total };
}

/** 归一化：把平面中心线缩放到目标长度 */
function normalizeLength(points: PlanPoint[], length: number, target: number): PlanPoint[] {
  const k = target / length;
  return points.map((p) => ({ x: p.x * k, z: p.z * k }));
}

export class Nordschleife {
  readonly length: number;
  readonly spacing: number;
  readonly count: number;
  /** 中心线（世界 xyz） */
  readonly center: Float64Array;
  private readonly tangent: Float64Array;
  private readonly right: Float64Array;
  private readonly up: Float64Array;
  private readonly curv: Float64Array;
  private readonly gradeArr: Float64Array;
  private readonly bankArr: Float64Array;
  /** 粗查索引（每 8 个采样取 1） */
  private readonly coarse: Float64Array;
  private readonly minX: number;
  private readonly maxX: number;
  private readonly minZ: number;
  private readonly maxZ: number;
  /** 复用的查询帧（零分配） */
  private readonly scratch: TrackFrame = {
    s: 0,
    center: { x: 0, y: 0, z: 0 },
    tangent: { x: 0, y: 0, z: 0 },
    right: { x: 0, y: 0, z: 0 },
    up: { x: 0, y: 0, z: 0 },
    curvature: 0,
    grade: 0,
    bank: 0
  };

  constructor(
    waypoints: ReadonlyArray<readonly [number, number]> = WAYPOINTS,
    targetLength: number = TRACK_LENGTH,
    elevation: ElevationProfile = elevationRaw
  ) {
    const dense = catmullRomClosed(waypoints, 24);
    const raw = resampleClosed2D(dense, 6000);
    const scaled = normalizeLength(raw.points, raw.length, targetLength);
    const count = Math.max(256, Math.round(targetLength / ROAD.sampleSpacing));
    const { points, length } = resampleClosed2D(scaled, count);
    this.count = count;
    this.length = length;
    this.spacing = length / count;

    // 第一遍：平面中心线 + 高程
    const cx = new Float64Array(count);
    const cy = new Float64Array(count);
    const cz = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      cx[i] = points[i].x;
      cz[i] = points[i].z;
      cy[i] = elevation((i * this.length) / count, this.length);
    }

    // 第二遍：3D 切向（含坡度）、右向、上向
    const tx = new Float64Array(count);
    const ty = new Float64Array(count);
    const tz = new Float64Array(count);
    const rx = new Float64Array(count);
    const ry = new Float64Array(count);
    const rz = new Float64Array(count);
    const ux = new Float64Array(count);
    const uy = new Float64Array(count);
    const uz = new Float64Array(count);
    const curv = new Float64Array(count);
    const grade = new Float64Array(count);
    const bank = new Float64Array(count);

    for (let i = 0; i < count; i++) {
      const a = (i - 1 + count) % count;
      const b = (i + 1) % count;
      let dx = cx[b] - cx[a];
      let dy = cy[b] - cy[a];
      let dz = cz[b] - cz[a];
      const dl = Math.hypot(dx, dy, dz) || 1;
      dx /= dl;
      dy /= dl;
      dz /= dl;
      tx[i] = dx;
      ty[i] = dy;
      tz[i] = dz;
      // right = normalize(tangent × worldUp)
      let rxv = dz;
      let rzv = -dx;
      const rl = Math.hypot(rxv, rzv) || 1;
      rxv /= rl;
      rzv /= rl;
      rx[i] = rxv;
      ry[i] = 0;
      rz[i] = rzv;
      // up = tangent × right = (dy·rz, dz·rx − dx·rz, −dy·rx)
      // ⚠ y 分量必须同时含 dz·rx 与 −dx·rz 两项：只写 dz·rx 时，东西向路段
      //   （dx 大、dz 小）在有任何坡度时 up 会严重偏离竖直（实测 s=13200 达 37.8°），
      //   凡用 makeBasis(right, up, tangent) 摆的建筑会被拧歪。
      ux[i] = dy * rzv;
      uy[i] = dz * rxv - dx * rzv;
      uz[i] = -dy * rxv;
      const ul = Math.hypot(ux[i], uy[i], uz[i]) || 1;
      ux[i] /= ul;
      uy[i] /= ul;
      uz[i] /= ul;
    }

    // 曲率/坡度：相邻帧差分
    for (let i = 0; i < count; i++) {
      const a = (i - 1 + count) % count;
      const b = (i + 1) % count;
      // 2D 有符号曲率（x,z 平面叉积）>0 = 左弯
      const crossY = tx[a] * tz[b] - tz[a] * tx[b];
      curv[i] = crossY / (2 * this.spacing);
      grade[i] = (cy[b] - cy[a]) / (2 * this.spacing);
    }

    // 横倾：由曲率驱动，限幅 5.5°，左弯左低（β 负）
    const MAX_BANK = (5.5 * Math.PI) / 180;
    for (let i = 0; i < count; i++) {
      const k = Math.abs(curv[i]);
      const w = smoothstep(0.006, 0.028, k);
      const signed = -Math.sign(curv[i]) * w * MAX_BANK;
      bank[i] = signed;
      if (signed !== 0) {
        const c = Math.cos(signed);
        const s = Math.sin(signed);
        const r0 = rx[i];
        const ry0 = ry[i];
        const rz0 = rz[i];
        const u0 = ux[i];
        const uy0 = uy[i];
        const uz0 = uz[i];
        // right' = right·cos − up·sin ; up' = up·cos + right·sin
        rx[i] = r0 * c - u0 * s;
        ry[i] = ry0 * c - uy0 * s;
        rz[i] = rz0 * c - uz0 * s;
        ux[i] = u0 * c + r0 * s;
        uy[i] = uy0 * c + ry0 * s;
        uz[i] = uz0 * c + rz0 * s;
      }
    }

    this.center = new Float64Array(count * 3);
    this.tangent = new Float64Array(count * 3);
    this.right = new Float64Array(count * 3);
    this.up = new Float64Array(count * 3);
    for (let i = 0; i < count; i++) {
      this.center[i * 3] = cx[i];
      this.center[i * 3 + 1] = cy[i];
      this.center[i * 3 + 2] = cz[i];
      this.tangent[i * 3] = tx[i];
      this.tangent[i * 3 + 1] = ty[i];
      this.tangent[i * 3 + 2] = tz[i];
      this.right[i * 3] = rx[i];
      this.right[i * 3 + 1] = ry[i];
      this.right[i * 3 + 2] = rz[i];
      this.up[i * 3] = ux[i];
      this.up[i * 3 + 1] = uy[i];
      this.up[i * 3 + 2] = uz[i];
    }
    this.curv = curv;
    this.gradeArr = grade;
    this.bankArr = bank;

    // 粗查索引
    const co = 8;
    const coarseLen = Math.ceil(count / co);
    this.coarse = new Float64Array(coarseLen * 3);
    for (let j = 0; j < coarseLen; j++) {
      const i = j * co;
      this.coarse[j * 3] = cx[i];
      this.coarse[j * 3 + 1] = cy[i];
      this.coarse[j * 3 + 2] = cz[i];
    }
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < count; i++) {
      if (cx[i] < minX) minX = cx[i];
      if (cx[i] > maxX) maxX = cx[i];
      if (cz[i] < minZ) minZ = cz[i];
      if (cz[i] > maxZ) maxZ = cz[i];
    }
    this.minX = minX;
    this.maxX = maxX;
    this.minZ = minZ;
    this.maxZ = maxZ;
  }

  /** 包围盒（世界 x/z） */
  get bounds(): { minX: number; maxX: number; minZ: number; maxZ: number } {
    return { minX: this.minX, maxX: this.maxX, minZ: this.minZ, maxZ: this.maxZ };
  }

  /** 弧长 → 帧（返回复用对象，只读；需要保留请 copy） */
  at(s: number): TrackFrame {
    const L = this.length;
    let q = s % L;
    if (q < 0) q += L;
    const f = q / this.spacing;
    const i0 = Math.floor(f) % this.count;
    const i1 = (i0 + 1) % this.count;
    const t = f - Math.floor(f);
    const a = i0 * 3;
    const b = i1 * 3;
    const out = this.scratch;
    out.s = q;
    out.center.x = this.center[a] + (this.center[b] - this.center[a]) * t;
    out.center.y = this.center[a + 1] + (this.center[b + 1] - this.center[a + 1]) * t;
    out.center.z = this.center[a + 2] + (this.center[b + 2] - this.center[a + 2]) * t;
    out.tangent.x = this.tangent[a] + (this.tangent[b] - this.tangent[a]) * t;
    out.tangent.y = this.tangent[a + 1] + (this.tangent[b + 1] - this.tangent[a + 1]) * t;
    out.tangent.z = this.tangent[a + 2] + (this.tangent[b + 2] - this.tangent[a + 2]) * t;
    out.right.x = this.right[a] + (this.right[b] - this.right[a]) * t;
    out.right.y = this.right[a + 1] + (this.right[b + 1] - this.right[a + 1]) * t;
    out.right.z = this.right[a + 2] + (this.right[b + 2] - this.right[a + 2]) * t;
    out.up.x = this.up[a] + (this.up[b] - this.up[a]) * t;
    out.up.y = this.up[a + 1] + (this.up[b + 1] - this.up[a + 1]) * t;
    out.up.z = this.up[a + 2] + (this.up[b + 2] - this.up[a + 2]) * t;
    out.curvature = this.curv[i0] + (this.curv[i1] - this.curv[i0]) * t;
    out.grade = this.gradeArr[i0] + (this.gradeArr[i1] - this.gradeArr[i0]) * t;
    out.bank = this.bankArr[i0] + (this.bankArr[i1] - this.bankArr[i0]) * t;
    // 相邻采样线性插值不是精确单位向量（实测最大 5e-5 偏差）——对外统一归一，
    // 否则 makeBasis(right, up, tangent) 摆出的建筑会有极轻微剪切。
    const tn = Math.hypot(out.tangent.x, out.tangent.y, out.tangent.z) || 1;
    out.tangent.x /= tn;
    out.tangent.y /= tn;
    out.tangent.z /= tn;
    const rn3 = Math.hypot(out.right.x, out.right.y, out.right.z) || 1;
    out.right.x /= rn3;
    out.right.y /= rn3;
    out.right.z /= rn3;
    const un = Math.hypot(out.up.x, out.up.y, out.up.z) || 1;
    out.up.x /= un;
    out.up.y /= un;
    out.up.z /= un;
    return out;
  }

  /** 局部坐标 → 世界坐标 */
  toWorld(x: number, y: number, s: number, out?: V3): V3 {
    const f = this.at(s);
    const o = out ?? { x: 0, y: 0, z: 0 };
    o.x = f.center.x + f.right.x * x + f.up.x * y;
    o.y = f.center.y + f.right.y * x + f.up.y * y;
    o.z = f.center.z + f.right.z * x + f.up.z * y;
    return o;
  }

  /** 世界坐标 → 最近弧长（粗查 + 邻域细化，约 700 次距离计算） */
  closestS(x: number, z: number): number {
    const co = 8;
    const n = this.count;
    const coarseLen = this.coarse.length / 3;
    let bestJ = 0;
    let bestD = Infinity;
    for (let j = 0; j < coarseLen; j++) {
      const dx = this.coarse[j * 3] - x;
      const dz = this.coarse[j * 3 + 2] - z;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        bestJ = j;
      }
    }
    const centerI = bestJ * co;
    let bestI = centerI;
    bestD = Infinity;
    for (let k = -co - 2; k <= co + 2; k++) {
      const i = ((centerI + k) % n + n) % n;
      const dx = this.center[i * 3] - x;
      const dz = this.center[i * 3 + 2] - z;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    }
    // 在 bestI 前后各 2 个采样内做抛物线细化
    const at = (i: number): number => {
      const ii = ((i % n) + n) % n;
      const dx = this.center[ii * 3] - x;
      const dz = this.center[ii * 3 + 2] - z;
      return dx * dx + dz * dz;
    };
    let lo = bestI - 1;
    let hi = bestI + 1;
    for (let it = 0; it < 8; it++) {
      const m1 = lo + (hi - lo) / 3;
      const m2 = hi - (hi - lo) / 3;
      const i1 = Math.round(m1);
      const i2 = Math.round(m2);
      if (at(i1) < at(i2)) hi = m2;
      else lo = m1;
    }
    const s = (((lo + hi) / 2) * this.spacing) % this.length;
    return s < 0 ? s + this.length : s;
  }

  /**
   * 世界坐标 → 沿路坐标 {s, lateral, height}。
   * lateral 用最近帧的 right 投影；height 为相对路面高度。
   */
  locate(x: number, y: number, z: number): { s: number; lateral: number; height: number; index: number } {
    const s = this.closestS(x, z);
    const f = this.at(s);
    const dx = x - f.center.x;
    const dy = y - f.center.y;
    const dz = z - f.center.z;
    return {
      s,
      lateral: dx * f.right.x + dy * f.right.y + dz * f.right.z,
      height: dx * f.up.x + dy * f.up.y + dz * f.up.z,
      index: Math.round(s / this.spacing) % this.count
    };
  }

  /** 某弧长处的航向角（绕 Y，0 = +Z，顺时针为正） */
  headingAt(s: number): number {
    const f = this.at(s);
    return Math.atan2(f.tangent.x, f.tangent.z);
  }

  /** 最小曲率半径（构造后自检用） */
  minRadius(): number {
    let maxK = 0;
    for (let i = 0; i < this.count; i++) maxK = Math.max(maxK, Math.abs(this.curv[i]));
    return maxK > 1e-9 ? 1 / maxK : Infinity;
  }

  /** 最大坡度绝对值 */
  maxGrade(): number {
    let g = 0;
    for (let i = 0; i < this.count; i++) g = Math.max(g, Math.abs(this.gradeArr[i]));
    return g;
  }

  /** 高程范围 */
  elevationRange(): { min: number; max: number } {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < this.count; i++) {
      const y = this.center[i * 3 + 1];
      if (y < min) min = y;
      if (y > max) max = y;
    }
    return { min, max };
  }
}

/** 赛道模式：北环（默认）或南环（Südschleife） */
export type TrackMode = 'nordschleife' | 'suedschleife';

let currentMode: TrackMode = 'nordschleife';
const cache: Partial<Record<TrackMode, Nordschleife>> = {};

function buildTrack(mode: TrackMode): Nordschleife {
  return mode === 'suedschleife' ? newSuedschleife() : new Nordschleife();
}

/** 取指定模式的赛道（惰性构建，双轨独立缓存） */
export function getTrackFor(mode: TrackMode): Nordschleife {
  let t = cache[mode];
  if (!t) {
    t = buildTrack(mode);
    cache[mode] = t;
  }
  return t;
}

/** 全局当前赛道（装配层只取一次，禁止各处 new）。保持无参、返回类型不变。 */
export function getTrack(): Nordschleife {
  return getTrackFor(currentMode);
}

/** 切换当前激活赛道模式（运行期消费方零改动） */
export function setTrackMode(mode: TrackMode): void {
  currentMode = mode;
}

/** 当前激活赛道模式（供 apex 选择等按模式参数化的消费方） */
export function getCurrentMode(): TrackMode {
  return currentMode;
}

/** 弯道 apex 选择结果：s=弧长、c=带符号曲率（>0 左弯 / <0 右弯；排序与阈值按 |c|） */
export interface ApexPick {
  s: number;
  c: number;
}

/** apex 选择常量（全弯道设施同源：观众/喷绘/apex板/刹车痕/砾石带/横幅/轮胎墙/岗亭/制动牌） */
const APEX_GAP = 700;
const APEX_MAX = 8;
const APEX_STEP = 10;
const APEX_MARGIN = 300;
/** 按模式参数化阈值：北环 0.006（曲率半径 <167m 急弯，自然得 6 个）；
 *  南环 curvature 序列更缓，0.006 只选到 4 个 ⇒ 放宽 0.0025 补满 6 个（密度与北环看齐）。
 *  ⚠ 勿全局降低（会扰动北环既有设施布局），必须按模式分流（V36 满铺口径）。 */
const APEX_THRESH: Record<TrackMode, number> = {
  nordschleife: 0.006,
  suedschleife: 0.0025
};

/**
 * 弯道 apex 选择（全设施同源唯一入口）：沿 s∈[300, L−300] 步长 10m 收集 |curv|>thresh
 * 候选 {s, c}，按 |c| 降序取前 8、且与已选 apex 间距 >700m。返回带符号 c（供内外侧判断）。
 *  V36 起按赛道模式参数化（北环 0.006 / 南环 0.0025），保证北环集合逐点不变、南环补满密度。
 */
export function selectApexes(mode: TrackMode): ApexPick[] {
  const tr = getTrackFor(mode);
  const L = tr.length;
  const thresh = APEX_THRESH[mode];
  const cand: ApexPick[] = [];
  for (let s = APEX_MARGIN; s < L - APEX_MARGIN; s += APEX_STEP) {
    const f = tr.at(s);
    const c = f.curvature;
    if (Math.abs(c) > thresh) cand.push({ s, c });
  }
  cand.sort((a, b) => Math.abs(b.c) - Math.abs(a.c));
  const apexes: ApexPick[] = [];
  for (const p of cand) {
    if (apexes.length >= APEX_MAX) break;
    if (apexes.every((v) => Math.abs(v.s - p.s) > APEX_GAP)) apexes.push(p);
  }
  return apexes;
}

/** 供测试/工具重置：清双轨缓存并复位模式 */
export function resetTrack(): void {
  delete cache.nordschleife;
  delete cache.suedschleife;
  currentMode = 'nordschleife';
}

/** 未使用的上向常量占位（保持树摇） */
export const TRACK_UP_AXIS = WORLD_UP;
