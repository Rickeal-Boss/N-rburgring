/**
 * 纽博格林南环（Südschleife）中心线 · 纯数据层（零依赖 / 零 three）
 *
 * 造型来源：按历史南环走向手工编排的 39 个路点（起终点直道 → 入口发卡 →
 * 陡降穿桥 → 密林 → 连续弯 → Müllenbach 发夹 → 长爬坡 → 东南大弯 →
 * 长左弯 → 起终点直道），经与北环同一条闭合 centripetal Catmull–Rom 插值 +
 * 等弧长重采样，缩放到 7 747 m（南环官方长度约 7.7 km）。
 *
 * 坐标系：x 东、z 北、y 上；起终点直道在北端（z≈130），与北环起终点区域邻近
 * （北环起终线在原点附近 z≈146）。行驶方向自起点先向西南（朝向 Südkehre），
 * 首尾闭合、切向一致（闭合 Catmull-Rom 天然 C1）。
 *
 * 高程与北环同构（低频 + 地标包），但 bump 中心按南环总长 L=7747 的比例重设，
 * 不复用北环 elevationRaw（其 bumpAt 中心按 L=20831 设计会错位）。特征：
 * 入口丘陵 → 陡降穿桥（Müllenbach 前下坡）→ 长爬坡高点 → 收尾缓坡。
 *
 * 路面几何复用北环 ROAD（halfWidth 7 / kerbWidth 1.4 / shoulderWidth 3.2 /
 * railOffset 11.2 / sampleSpacing 4）——本文件不重复定义，直接由 Nordschleife
 * 构造器消费（构造器内部用 ROAD.sampleSpacing 采样）。
 */

import { Nordschleife } from './nordschleife';
import type { ElevationProfile } from './nordschleife';

/** 南环官方长度（≈7.7 km） */
export const SUED_TRACK_LENGTH = 7747;

/** 世界尺度下南环路点（米）；形状按历史走向手工编排，整体按 SUED_TRACK_LENGTH 归一 */
export const SUED_WAYPOINTS: ReadonlyArray<readonly [number, number]> = [
  // 起终点直道（北端，朝西南出发）
  // 【海豚跳修复】闭合边界（s≈0/7746）bank 陡变区：原路点 [-60,10]/[-190,-120]/[-330,-190]
  //   在 [40,130]（北端 65° 折返弧顶）处集中 C2 不连续尖峰，致发卡入口 curvature 峰过窄，
  //   V38 的 5 点 bank 窗（±8m）抹不平。现将三路点重参数化为 [-14,63]/[-175.25,-135]/
  //   [-334.25,-192.75]（沿折线弧长分散 65° 转角 + 发卡入口角外扩 5m 加宽 curvature 峰），
  //   max 折角 1.044°→0.496°（0.5m 步长，<0.5° 阈值）。起终点几何位移 24cm（1/32000），
  //   发卡入口半径 36→41m（+14%），圈速影响 ~0.1% 级，均属轻微。仅改本文件。
  [40, 130], [-14, 63], [-175.25, -135],
  // 入口发卡（西侧）
  [-334.25, -192.75], [-460, -240], [-540, -360], [-510, -480], [-360, -540], [-190, -570],
  // 陡降穿桥 / 密林（向东南）
  [-20, -620], [150, -740], [230, -880],
  // 连续弯（S 形）
  [190, -1040], [60, -1170],
  // Müllenbach 发夹（南侧）
  [-140, -1250], [-360, -1270], [-540, -1340], [-540, -1490], [-360, -1570], [-120, -1520],
  // 长爬坡（向东北，x≤400 保持回程在东侧走廊）
  [120, -1390], [280, -1320], [400, -1330],
  // 东南大弯（宽半径 U 形折返：入口向东南，绕南折返北上）
  [520, -1420], [620, -1500], [700, -1570], [780, -1580], [850, -1500], [880, -1380],
  // 长左弯 → 回程沿东侧北上（x≈850，远离爬坡 x≤400）
  [880, -1220], [860, -1040], [820, -860], [760, -680], [680, -520],
  [580, -360], [460, -180], [330, -10], [210, 70], [95, 115]
];

const TAU = Math.PI * 2;

/** raised-cosine 包：中心 1，|d|≥w 时 0，端点一阶导为 0（与北环同构） */
function bumpAt(s: number, center: number, width: number): number {
  const d = Math.abs(s - center);
  if (d >= width) return 0;
  const c = Math.cos((Math.PI / 2) * (d / width));
  return c * c;
}

/**
 * 南环高程剖面：低频起伏 + 四处地标包。全部按弧长定义 ⇒ 闭合天然成立。
 * bump 中心按南环 L 比例重设（不复用北环 elevationRaw）。
 */
export const suedElevationRaw: ElevationProfile = (s, L) => {
  const t = (s / L) * TAU;
  let y = 5.5 * Math.sin(2 * t + 0.4) + 3.0 * Math.sin(5 * t + 1.1) + 1.8 * Math.sin(11 * t + 2.0);
  y += 6 * bumpAt(s, L * 0.10, 350); // 入口丘陵
  y -= 12 * bumpAt(s, L * 0.30, 500); // 陡降穿桥（Müllenbach 前下坡）
  y += 26 * bumpAt(s, L * 0.62, 750); // 长爬坡高点
  y += 5 * bumpAt(s, L * 0.88, 300); // 收尾缓坡
  return y;
};

/** 构建南环赛道实例（复用北环 Nordschleife 类，传南环路点/长度/高程） */
export function newSuedschleife(): Nordschleife {
  return new Nordschleife(SUED_WAYPOINTS, SUED_TRACK_LENGTH, suedElevationRaw);
}

// 复用北环路面几何参数（不重复定义）；南环构建经 Nordschleife 构造器消费 ROAD。
export { ROAD } from './nordschleife';
