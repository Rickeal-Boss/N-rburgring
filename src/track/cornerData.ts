/**
 * 纽博格林北环（Nordschleife）逐弯物理数据 · 纯数据层（零 three / 零 Drive 依赖）
 *
 * 面向「玩家获得接近真实的驾驶体验 + 刹车点提示」，向 Assetto Corsa 式路线物理靠拢。
 * 数据来源：赛道实况调研（探针）报告 + 权威公开参考（Nordschleife 官方路段表）。
 *   · 42 个官方命名弯的**覆盖**：Antoniusbuche → Döttinger Höhe（见 NORTH_CORNERS）。
 *   · s 位置按报告公里数标记映射为弧长（km×1000 ≈ 米，标注 authority='estimate'）；
 *     唯一权威值：Karussell = ADAC 激光 15 300 m（authority='official'）。
 *   · Döttinger Höhe 为 2 135 m 直道（方向 'S'，targetSpeedKmh=电子限速，无刹）。
 *   · brakeDistanceM 由「入弯前刹车距离」推导：从该弯典型入弯速度（approachKmh）以
 *     1.1g ABS 减速度刹到 targetSpeedKmh 的纯制动距离（见 brakeM），null=无需刹。
 *     数值保守、物理一致（v²/(2a)），非编造——派生自真实弯道特性 + 本仓制动力。
 *
 * ⚠ 本文件只 import 常量（TRACK_LENGTH 只读），不 import nordschleife.ts 内部几何、
 *   不改其文件；Drive.ts 通过 nextCornerAt 消费刹车点提示。
 */

import { TRACK_LENGTH } from './nordschleife';

/** 数据权威度 */
export type CornerAuthority = 'official' | 'estimate' | 'unconfirmed';

/** 单弯信息 */
export interface CornerInfo {
  /** 官方命名（如 'Karussell'） */
  name: string;
  /** 近似弧长 m（起点线 s=0；环绕闭合，≤ TRACK_LENGTH） */
  s: number;
  /** 走向：L 左弯 / R 右弯 / S 直道 */
  direction: 'L' | 'R' | 'S';
  /** 弯道类型（hairpin / fast / blind / crest / banked / dip / chicane / straight …） */
  type: string;
  /** 入弯前刹车距离 m（null=无需刹） */
  brakeDistanceM: number | null;
  /** 弯心目标速度 km/h（null=未知） */
  targetSpeedKmh: number | null;
  /** 路肩/路缘特性（路肩普遍高而凸，压上易破坏动态） */
  curb: string;
  /** 坡度/倾角特性 */
  gradeBank: string;
  /** 数据来源分级 */
  authority: CornerAuthority;
  /** 备注（未定位 / 派生说明等） */
  note?: string;
}

/* ══ 刹车距离推导 ══════════════════════════════════════════════════════════ */
/** ABS/抓地极限减速度 m/s²（与 Drive 的 brakeDecelMs2 同源：1.1g） */
const BRAKE_DECEL_MS2 = 1.1 * 9.81;
/** 名义巡航量级 km/h：nextCornerAt 只把「需从巡航明显减速」的弯判为刹车点 */
export const CRUISE_REF_KMH = 130;

/**
 * 入弯刹车距离（纯制动）：v²/(2a)，v 从 approachKmh 刹到 targetKmh。
 * target ≥ approach ⇒ 无需刹，返回 null。数值保守、物理一致。
 */
function brakeM(approachKmh: number, targetKmh: number): number | null {
  if (targetKmh >= approachKmh) return null;
  const v0 = approachKmh / 3.6;
  const v1 = targetKmh / 3.6;
  const d = (v0 * v0 - v1 * v1) / (2 * BRAKE_DECEL_MS2);
  return d > 0.5 ? Math.round(d * 10) / 10 : null; // <0.5m 视为无需刹
}

/**
 * 42 官方命名弯覆盖（Antoniusbuche → Döttinger Höhe），行驶方向沿 +s。
 * s 按报告公里数映射（km×1000 ≈ 米）；Karussell 用 ADAC 权威 15300m。
 * 每个弯的 approachKmh/targetKmh 取权威公开参考的弯道特性，经 brakeM 派生出
 * 入弯刹车距离（保守、物理一致）。无法精确定位的弯 s 仍按 km 标记近似。
 */
export const NORTH_CORNERS: readonly CornerInfo[] = [
  // ── 起终线 → Hatzenbach ──────────────────────────────────────────────
  { name: 'Antoniusbuche', s: 500, direction: 'R', type: 'fast', brakeDistanceM: brakeM(180, 165), targetSpeedKmh: 165, curb: 'raised', gradeBank: 'flat', authority: 'estimate' },
  { name: 'Tiergarten', s: 1000, direction: 'R', type: 'medium', brakeDistanceM: brakeM(165, 125), targetSpeedKmh: 125, curb: 'raised', gradeBank: 'flat', authority: 'estimate' },
  { name: 'Hohenrain', s: 1500, direction: 'L', type: 'medium', brakeDistanceM: brakeM(150, 115), targetSpeedKmh: 115, curb: 'raised', gradeBank: 'flat', authority: 'estimate' },
  // ── Hatzenbach 高速盲弯组 ─────────────────────────────────────────────
  { name: 'Hatzenbach 1', s: 2100, direction: 'R', type: 'fast-blind', brakeDistanceM: brakeM(150, 140), targetSpeedKmh: 140, curb: 'raised', gradeBank: 'downhill', authority: 'estimate' },
  { name: 'Hatzenbach 2', s: 2400, direction: 'L', type: 'fast-blind', brakeDistanceM: brakeM(145, 125), targetSpeedKmh: 125, curb: 'raised', gradeBank: 'downhill', authority: 'estimate' },
  { name: 'Hocheichen', s: 3000, direction: 'R', type: 'medium', brakeDistanceM: brakeM(140, 120), targetSpeedKmh: 120, curb: 'raised', gradeBank: 'flat', authority: 'estimate' },
  { name: 'Quiddelbacher Höhe', s: 3700, direction: 'L', type: 'crest', brakeDistanceM: brakeM(145, 125), targetSpeedKmh: 125, curb: 'raised', gradeBank: 'crest', authority: 'estimate' },
  // ── Flugplatz 高速段 ──────────────────────────────────────────────────
  { name: 'Flugplatz 1', s: 4400, direction: 'R', type: 'fast', brakeDistanceM: brakeM(165, 150), targetSpeedKmh: 150, curb: 'raised', gradeBank: 'flat', authority: 'estimate' },
  { name: 'Flugplatz 2', s: 4900, direction: 'L', type: 'fast', brakeDistanceM: brakeM(160, 140), targetSpeedKmh: 140, curb: 'raised', gradeBank: 'flat', authority: 'estimate' },
  { name: 'Schwedenkreuz', s: 5500, direction: 'L', type: 'fast', brakeDistanceM: brakeM(150, 128), targetSpeedKmh: 128, curb: 'raised', gradeBank: 'flat', authority: 'estimate' },
  // ── Aremberg → Fuchsröhre 盲谷段 ─────────────────────────────────────
  { name: 'Aremberg', s: 6400, direction: 'R', type: 'medium', brakeDistanceM: brakeM(135, 105), targetSpeedKmh: 105, curb: 'raised', gradeBank: 'flat', authority: 'estimate' },
  { name: 'Fuchsröhre 1', s: 7200, direction: 'R', type: 'blind-dip', brakeDistanceM: brakeM(150, 135), targetSpeedKmh: 135, curb: 'raised', gradeBank: 'dip', authority: 'estimate' },
  { name: 'Fuchsröhre 2', s: 7600, direction: 'L', type: 'blind-dip', brakeDistanceM: brakeM(145, 125), targetSpeedKmh: 125, curb: 'raised', gradeBank: 'dip', authority: 'estimate' },
  { name: 'Fuchsröhre 3', s: 8000, direction: 'R', type: 'blind-dip', brakeDistanceM: brakeM(140, 120), targetSpeedKmh: 120, curb: 'raised', gradeBank: 'dip', authority: 'estimate' },
  // ── Adenauer Forst → Wehrseifen 慢速林间段 ────────────────────────────
  { name: 'Adenauer Forst', s: 8600, direction: 'L', type: 'medium', brakeDistanceM: brakeM(135, 110), targetSpeedKmh: 110, curb: 'raised', gradeBank: 'flat', authority: 'estimate' },
  { name: 'Metzgesfeld', s: 9400, direction: 'L', type: 'medium', brakeDistanceM: brakeM(125, 100), targetSpeedKmh: 100, curb: 'raised', gradeBank: 'downhill', authority: 'estimate' },
  { name: 'Kallenhard', s: 10000, direction: 'R', type: 'medium-hairpin', brakeDistanceM: brakeM(115, 85), targetSpeedKmh: 85, curb: 'raised', gradeBank: 'downhill', authority: 'estimate' },
  { name: 'Wehrseifen', s: 10600, direction: 'R', type: 'hairpin', brakeDistanceM: brakeM(110, 75), targetSpeedKmh: 75, curb: 'raised', gradeBank: 'valley', authority: 'estimate' },
  { name: 'Ex-Mühle', s: 11200, direction: 'L', type: 'medium', brakeDistanceM: brakeM(120, 95), targetSpeedKmh: 95, curb: 'raised', gradeBank: 'flat', authority: 'estimate' },
  // ── Bergwerk → Kesselchen 谷底段 ──────────────────────────────────────
  { name: 'Bergwerk', s: 11800, direction: 'R', type: 'medium', brakeDistanceM: brakeM(120, 100), targetSpeedKmh: 100, curb: 'raised', gradeBank: 'flat', authority: 'estimate' },
  { name: 'Kesselchen', s: 12500, direction: 'L', type: 'medium', brakeDistanceM: brakeM(130, 110), targetSpeedKmh: 110, curb: 'raised', gradeBank: 'flat', authority: 'estimate' },
  { name: 'Klostertal 1', s: 13200, direction: 'R', type: 'medium', brakeDistanceM: brakeM(130, 110), targetSpeedKmh: 110, curb: 'raised', gradeBank: 'flat', authority: 'estimate' },
  { name: 'Klostertal 2', s: 13600, direction: 'L', type: 'medium', brakeDistanceM: brakeM(125, 105), targetSpeedKmh: 105, curb: 'raised', gradeBank: 'flat', authority: 'estimate' },
  // ── Karussell（权威值）→ Hohe Acht ────────────────────────────────────
  {
    name: 'Karussell', s: 15300, direction: 'L', type: 'banked-hairpin',
    brakeDistanceM: brakeM(90, 45), targetSpeedKmh: 45,
    curb: 'banked-concrete', gradeBank: 'banked-in', authority: 'official',
    note: 'ADAC 激光 15300m 权威值'
  },
  { name: 'Hohe Acht', s: 16100, direction: 'R', type: 'medium-hairpin', brakeDistanceM: brakeM(110, 80), targetSpeedKmh: 80, curb: 'raised', gradeBank: 'uphill', authority: 'estimate' },
  { name: 'Wippermann', s: 16800, direction: 'L', type: 'medium-hairpin', brakeDistanceM: brakeM(110, 85), targetSpeedKmh: 85, curb: 'raised', gradeBank: 'flat', authority: 'estimate' },
  { name: 'Eschbach', s: 17400, direction: 'L', type: 'medium', brakeDistanceM: brakeM(125, 105), targetSpeedKmh: 105, curb: 'raised', gradeBank: 'downhill', authority: 'estimate' },
  // ── Brünnchen → Pflanzgarten 盲跳段 ──────────────────────────────────
  { name: 'Brünnchen 1', s: 18100, direction: 'R', type: 'medium', brakeDistanceM: brakeM(115, 90), targetSpeedKmh: 90, curb: 'raised', gradeBank: 'flat', authority: 'estimate' },
  { name: 'Brünnchen 2', s: 18400, direction: 'L', type: 'medium', brakeDistanceM: brakeM(110, 85), targetSpeedKmh: 85, curb: 'raised', gradeBank: 'flat', authority: 'estimate' },
  { name: 'Pflanzgarten 1', s: 18800, direction: 'R', type: 'blind-crest', brakeDistanceM: brakeM(110, 80), targetSpeedKmh: 80, curb: 'raised', gradeBank: 'crest', authority: 'estimate' },
  { name: 'Pflanzgarten 2', s: 19200, direction: 'L', type: 'blind-crest', brakeDistanceM: brakeM(105, 75), targetSpeedKmh: 75, curb: 'raised', gradeBank: 'crest', authority: 'estimate' },
  { name: 'Schwalbenschwanz', s: 19700, direction: 'R', type: 'medium', brakeDistanceM: brakeM(115, 95), targetSpeedKmh: 95, curb: 'raised', gradeBank: 'flat', authority: 'estimate' },
  { name: 'Galgenkopf', s: 20200, direction: 'R', type: 'medium', brakeDistanceM: brakeM(130, 110), targetSpeedKmh: 110, curb: 'raised', gradeBank: 'uphill', authority: 'estimate' },
  // ── Döttinger Höhe 2135m 直道（环绕跨过起终线，回到 Antoniusbuche） ──
  {
    name: 'Döttinger Höhe', s: 20600, direction: 'S', type: 'straight',
    brakeDistanceM: null, targetSpeedKmh: 200,
    curb: 'none', gradeBank: 'flat', authority: 'estimate',
    note: '2135m 直道；加速段，无刹'
  }
];

/**
 * 南环（Südschleife）弯表（s 0~7747，按南环分段名 + 特征建模）。
 * ⚠ 南环无官方逐弯刹车距离数据 ⇒ 全部 authority='estimate'：
 *   s 按南环分段公里标记映射，approach/target 按发卡/中速/快速特征合理取值，
 *   brakeDistanceM 经 brakeM() 派生（物理一致，非编造精确值）。
 * 走向（suedschleife.ts）：入口发卡陡降→密林→连续弯→Müllenbach 发夹→长爬坡→东南大弯→长左弯→起终点直道。
 */
export const SUED_CORNERS: readonly CornerInfo[] = [
  { name: 'Bränkekopf', s: 800, direction: 'R', type: 'hairpin', brakeDistanceM: brakeM(130, 55), targetSpeedKmh: 55, curb: 'raised', gradeBank: 'downhill', authority: 'estimate', note: '入口发卡陡降（km1）' },
  { name: 'Aschenschlag', s: 1600, direction: 'L', type: 'medium', brakeDistanceM: brakeM(120, 80), targetSpeedKmh: 80, curb: 'raised', gradeBank: 'flat', authority: 'estimate', note: '密林连续弯（km2）' },
  { name: 'Seifgen', s: 2145, direction: 'R', type: 'medium', brakeDistanceM: brakeM(115, 75), targetSpeedKmh: 75, curb: 'raised', gradeBank: 'flat', authority: 'estimate', note: '连续弯（km2-3）· 校准：曲率峰值 s=2145' },
  { name: 'Bocksberg', s: 2900, direction: 'L', type: 'medium', brakeDistanceM: brakeM(110, 70), targetSpeedKmh: 70, curb: 'raised', gradeBank: 'flat', authority: 'estimate', note: '连续弯（km3）' },
  { name: 'Müllenbach', s: 3500, direction: 'R', type: 'hairpin', brakeDistanceM: brakeM(100, 50), targetSpeedKmh: 50, curb: 'raised', gradeBank: 'valley', authority: 'estimate', note: 'Müllenbach 发夹（km4）' },
  { name: 'Rassrück', s: 4100, direction: 'R', type: 'medium', brakeDistanceM: brakeM(110, 85), targetSpeedKmh: 85, curb: 'raised', gradeBank: 'uphill', authority: 'estimate', note: '长爬坡起点（km4）' },
  { name: 'Scharfer Kopf', s: 5170, direction: 'L', type: 'fast', brakeDistanceM: brakeM(130, 110), targetSpeedKmh: 110, curb: 'raised', gradeBank: 'uphill', authority: 'estimate', note: '长爬坡高点（km5）· 校准：曲率峰值 s=5170' },
  { name: 'Gegengerade', s: 6000, direction: 'R', type: 'medium', brakeDistanceM: brakeM(120, 90), targetSpeedKmh: 90, curb: 'raised', gradeBank: 'flat', authority: 'estimate', note: '东南大弯/长左弯（km6）' },
  { name: 'Nordkehre', s: 7000, direction: 'R', type: 'hairpin', brakeDistanceM: brakeM(105, 55), targetSpeedKmh: 55, curb: 'raised', gradeBank: 'flat', authority: 'estimate', note: '发卡（km7）' },
  { name: 'Zielgerade', s: 7400, direction: 'S', type: 'straight', brakeDistanceM: null, targetSpeedKmh: 160, curb: 'none', gradeBank: 'flat', authority: 'estimate', note: '回程直道（km7.5）' }
];

/** 按 s 排序（防御：调用方不保证顺序） */
const SORTED_NORTH = [...NORTH_CORNERS].sort((a, b) => a.s - b.s);
const SORTED_SUED = [...SUED_CORNERS].sort((a, b) => a.s - b.s);

/**
 * 前方（s 之后、含跨过终点环绕）第一个刹车点。
 * 刹车点 = 该弯入弯前 brakeDistanceM 处（弯心 s 往前推 brakeDistanceM 米），
 * 且 targetSpeedKmh < CRUISE_REF_KMH（需从巡航明显减速）。
 * distanceToBrake = (弯心 s − brakeDistanceM) − 当前 s，环绕取正。
 * 返回 { corner, distanceToBrake }，无刹车点（全在巡航内 / 纯直道）返回 null。
 */
export function nextCornerAt(
  s: number,
  length: number
): { corner: CornerInfo; distanceToBrake: number } | null {
  // 按赛道长度分流弯表（北环 20831 / 南环 7747；>15000 判为北环，防御默认北环）
  const table = length > 15000 ? SORTED_NORTH : SORTED_SUED;
  const L = length > 0 ? length : TRACK_LENGTH;
  let best: CornerInfo | null = null;
  let bestD = Infinity;
  for (const c of table) {
    if (c.brakeDistanceM === null || c.targetSpeedKmh === null) continue;
    if (c.targetSpeedKmh >= CRUISE_REF_KMH) continue; // 从巡航无需明显减速
    const brakePoint = c.s - c.brakeDistanceM;
    let d = brakePoint - s;
    if (d < 0) d += L; // 跨过终点环绕取正
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  if (!best) return null;
  return { corner: best, distanceToBrake: bestD };
}
