/**
 * 可驾驶表面高程（AC 式道路横剖面）+ 地形高程纯函数（唯一真源）。
 *
 * 本模块是「地形高程」与「可驾驶表面」的**唯一计算真源**，同时被：
 *   · 渲染（Landscape.terrainPoint 的地形网格 / Track 的路缘与路肩 ribbon）引用；
 *   · 物理（Drive 的车身 Y）引用 —— 保证「车贴着路面/路缘/路肩走」。
 *
 * ⚠ 铁律：`terrainHeight` 的数学与旧 Landscape 内联版**逐项相同**（仅迁移，未改值）。
 *   修改剖面/起伏只改这一处（旧仓「terrainPoint 是唯一地形高程真源」的纪律延续）。
 *
 * 断面（局部横向 |x|，m，相对路面中心平面）：
 *   |x|=8  −0.38  低于土路肩外缘（−0.35），保证 3.2m 土带完整可见；
 *   |x|∈(60,1400] 叠加低频起伏；|x|∈(40,300] 再叠 ~35m 波长 ±0.6m 高频小起伏。
 *   ⚠ |x|≤24m 所有起伏恒 0（不顶穿路肩/路面），24→60m 渐入；bank 只在 |x|≤24 跟随。
 *
 * 可驾驶表面（`surfaceHeight`）横剖面（与 Track.ts ribbon 同口径）：
 *   |x| ≤ 7         路面（平面外推，y=center.y+right.y·lateral）
 *   7  < |x| ≤ 8.4  白石路缘（真实凸起石条，KERB_LIP=0.10，smooth 起坡/落坡）
 *   |x| > 8.4       由路缘顶平滑过渡到地形高程（土路肩/草地，terrainHeight）
 *   —— 压路缘有真实「顶一下」、跑出路面车随地形下沉，不再悬浮。
 */
import { getTrack, ROAD } from './nordschleife';

/** 基准剖面（|x| → 相对路面中心的高差，m） */
const PROFILE: readonly (readonly [number, number])[] = [
  [8, -0.38],
  [24, -0.45],
  [60, -1.2],
  [120, -2.2],
  [220, -3.6],
  [420, -7.0],
  [800, -18],
  [1400, -40]
];

/** 低频起伏包络（|x| → 振幅 m） */
const NOISE_AMP: readonly (readonly [number, number])[] = [
  [60, 0.8],
  [120, 4.0],
  [220, 7.5],
  [420, 10],
  [800, 14],
  [1400, 18]
];

const TAU = Math.PI * 2;

/** 列间平滑插值（smoothstep；x≤表头/≥表尾钳制，列间曲率连续） */
function tableAt(table: readonly (readonly [number, number])[], x: number): number {
  if (x <= table[0][0]) return table[0][1];
  const last = table[table.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < table.length; i++) {
    const a = table[i - 1];
    const b = table[i];
    if (x <= b[0]) {
      const t = (x - a[0]) / (b[0] - a[0]);
      return a[1] + (b[1] - a[1]) * (t * t * (3 - 2 * t));
    }
  }
  return last[1];
}

/** 平滑阶跃：x 在 [edge0,edge1] 内 0→1，边缘外钳制 */
function sstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * 地形高程（世界 y）：弧长 s + 横向 lateral → 地形表面高度。
 * 与地形网格顶点**同源**（横向位置用水平右向，高程 = 中心高程 + bank 近场跟随 + 剖面 + 起伏）。
 * 纯函数（无 three / 无 DOM），Node 可复算。
 */
export function terrainHeight(s: number, lateral: number): number {
  const track = getTrack();
  const f = track.at(s);
  const L = track.length;
  const ax = Math.abs(lateral);
  const bankFade = ax <= 24 ? 1 : Math.max(0, 1 - (ax - 24) / 36);
  const bankY = f.right.y * lateral * bankFade;
  const amp = tableAt(NOISE_AMP, ax) * sstep(24, 60, ax);
  const phase = lateral < 0 ? 2.1 : 0;
  const n1 = Math.sin((s / L) * TAU * 7 + 1.7);
  const n2 = Math.sin((s / L) * TAU * 23 + 0.4);
  const bumps =
    amp * (n1 * Math.cos(lateral * 0.004 + phase) * 0.6 + n2 * Math.sin(lateral * 0.006 + phase) * 0.4);
  const hfAmp = 0.6 * sstep(40, 80, ax);
  const hf =
    hfAmp * (Math.sin(s * 0.18 + lateral * 0.09 + 1.2) * 0.7 + Math.sin(s * 0.12 + lateral * 0.15 + 4.4) * 0.3);
  return f.center.y + bankY + tableAt(PROFILE, ax) + bumps + hf;
}

/**
 * 白石路缘（真实凸起石条）顶面高度（m，相对路面平面）。
 * V38：0.10 → **0.20**（真实纽北路缘多段 >30cm，TCar/懂车帝/车质网多源实测；
 * 压上「过度弹跳导致失控」，读作 AC 式高路缘「顶一下」手感）。
 */
export const KERB_LIP = 0.2;

/** 路缘内缘 = 路面半宽（7m） */
const KERB_INNER = ROAD.halfWidth;
/** 路缘外缘 = 7 + 1.4 = 8.4m */
const KERB_OUTER = ROAD.halfWidth + ROAD.kerbWidth;
/** 路缘顶→地形过渡带宽度（m）：8.4 → 9.8 平滑落到土路肩/草地 */
const SHOULDER_BLEND = 1.4;

/**
 * 可驾驶表面高程（世界 y）：弧长 s + 横向 lateral → 车应贴着的表面高度。
 *
 * 横剖面（与 Track.ts ribbon 同口径）：
 *   |x| ≤ 7         路面平面（center.y + right.y·lateral）；
 *   7 < |x| ≤ 8.4   白石路缘：smooth 起坡（7→7.5）到 KERB_LIP，平台到 8.4；
 *   |x| > 8.4       由路缘顶（roadY+KERB_LIP）平滑过渡到 terrainHeight（8.4→9.8 渐入）。
 * 全程连续（无 Y 台阶），车压路缘「顶一下」、出路面随地形下沉，读作 AC 式路缘/路肩。
 */
export function surfaceHeight(s: number, lateral: number): number {
  const track = getTrack();
  const f = track.at(s);
  const ax = Math.abs(lateral);
  // 路面平面（含横倾 bank，与 buildRibbon 路面 ribbon 同源：f.center + f.right·x）
  const roadY = f.center.y + f.right.y * lateral;
  if (ax <= KERB_INNER) return roadY;
  if (ax <= KERB_OUTER) {
    // 路缘凸起：7→7.5 平滑起坡（sstep），平台 KERB_LIP 到 8.4
    const t = sstep(KERB_INNER, KERB_INNER + 0.5, ax);
    return roadY + KERB_LIP * t;
  }
  // 路缘之外：路缘顶平滑过渡到地形高程（8.4→9.8），之后纯地形
  const kerbTop = roadY + KERB_LIP;
  const terr = terrainHeight(s, lateral);
  const blend = sstep(KERB_OUTER, KERB_OUTER + SHOULDER_BLEND, ax);
  return kerbTop + (terr - kerbTop) * blend;
}
