/**
 * 纽博格林北环 · 路面放样（沿中心线 s 的 ribbon 生成器）
 *
 * 断面（局部坐标：x 横向、y 离路面，见 src/track/nordschleife.ts）：
 *   |x| ≤ 7        石板铺装（三带贴图，u=0..1，v=s/12 ⇒ 与旧仓 2.4m 条石同密度）
 *   7 < |x| ≤ 8.4  白石路缘（抬高 0.03）
 *   8.4 < |x| ≤ 11.6 土路肩（soil 贴图，向外压低 0.35）
 *   |x| = 11.2     护栏（立柱 InstancedMesh 每 5m + 双梁 ribbon）
 *
 * 所有几何体沿**弧长**逐段生成（不能只放一个中心），三角绕序朝上：
 * 每段四边形 `[L0, L1, R0] + [R0, L1, R1]`，其中 L 为左列、R 为右列、0/1 为前/后环。
 * 推导：L0→L1 = 切向 ds、L0→R0 = 右向 dx ⇒ cross(切向, 右向) = 路面法向（朝上）。
 * （nordschleife 的 `right` 恰为 up×tangent，故切向×右向 = +up。）
 *
 * 性能：路面/路缘/路肩/横梁各 1 个 draw call；立柱 1 个 InstancedMesh。
 * 立柱不投影（castShadow=false），远景不参与阴影 pass；路面只 receiveShadow。
 */
import * as THREE from 'three';
import { getTrack, getCurrentMode, selectApexes } from '../track/nordschleife';
import { KERB_LIP } from '../track/surface';
import { mergeSafe } from '../util/geo';
import { makeLcg } from '../util/math';
import { canvasTexture, makeCanvas, textTexture } from '../util/canvasTex';
import { createSoilTexture, roadTexture } from './scene/roadTexture';
import { terrainPoint } from './Landscape';

/** 路缘石板白（R27_PALETTE.stoneWhite：旧仓 castle 石材族同色） */
const KERB_WHITE = 0xe5dcd9;
/** 护栏金属灰 */
const RAIL_GREY = 0x8a8f96;
/** 石材基色（龙门架） */
const STONE_GREY = 0xb9b1a6;

/* ── V16 刹车痕迹（brake marks）参数 ────────────────────────────────────
 * 弯道入口入弯减速区（apex 前 45m）路面上的黑色双轮迹。全部并入 1 个
 * InstancedMesh（1 DC / 1 材质 / 0 纹理），零外部资源。 */
/** 刹车区弧长（m）：apex 前 45m = 入弯减速区 */
const BRAKE_MARK_LEN = 45;
/** 轮迹采样步长（m）：每 2.5m 一小段四边形，前后衔接成连续轮迹 */
const BRAKE_MARK_STEP = 2.5;
/** 胎宽（m）：每块轮迹横向宽 */
const BRAKE_MARK_WIDTH = 0.28;
/** 轮距半宽（m）：车宽 2.0m 的轮距近似，左右两条轮迹各偏移 ±0.8 */
const BRAKE_MARK_LATERAL = 0.8;
/** 贴路面抬升（m）：沿 up 抬 2cm 防 z-fighting（路面带 y=0 列在 center 上） */
const BRAKE_MARK_LIFT = 0.02;

/* ── V26 赛车线（racing line）参数 ────────────────────────────────────
 * 沿全赛道连续、随弯道「外-内-外」横向移动的轮胎磨痕带（赛车游戏最标志性的
 * 走线细节）。偏移纯由曲率驱动（确定性），全部并入 1 个 InstancedMesh
 * （1 DC / 1 材质 / 0 纹理），零外部资源。 */
/** 采样步长（m）：与 BRAKE_MARK_STEP 一致，段与段边缘衔接成连续带 */
const RACE_STEP = 2.5;
/** 左右两条带相对线中心的横向偏移（m）：与 BRAKE_MARK_LATERAL 一致 */
const RACE_BAND_OFF = 0.8;
/** 单条带宽（m）：与 BRAKE_MARK_WIDTH 一致 */
const RACE_BAND_W = 0.28;
/** 抬升（m）：防 z-fighting，与 BRAKE_MARK_LIFT 一致 */
const RACE_LIFT = 0.02;
/** 满曲率时线中心最大切入（m）：带外缘 max 2.6+0.8+0.14=3.54 < 7 路宽，安全 */
const RACE_CUTIN = 2.6;
/** 达到该曲率即满切入（与 V16/V17 apex 阈值一致） */
const RACE_CURV_FULL = 0.006;
/** 死区：|curv| 小于此 → 偏移=0（压制直道曲率噪声的符号抖动） */
const RACE_CURV_DEAD = 0.0012;
/** 环绕移动平均窗口（样本数，≈22.5m） */
const RACE_SMOOTH_WIN = 9;
/** 移动平均遍数 */
const RACE_SMOOTH_PASS = 3;
/** 透明度（比刹车痕 0.55 轻，读作「走线橡胶」而非「重刹痕迹」） */
const RACE_OPACITY = 0.32;

/* ── V17 砾石缓冲带（gravel runoff）参数 ────────────────────────────────
 * 弯道**外侧**路肩上的砾石跑偏区（与 V16 刹车痕迹配套：刹车痕在入弯入口的
 * 路面、砾石带横跨出口外侧路肩）。全部并入 1 个合并 mesh（1 DC / 1 材质 /
 * 0 纹理 / 顶点色微抖读作砾石颗粒）。 */
/** 缓冲带起止（相对 apex，m）：apex−30（弯心附近）到 apex+50（出口跑偏区） */
const GRAVEL_START = -30;
/** 缓冲带终止（相对 apex，m） */
const GRAVEL_END = 50;
/** 弧长采样步长（m）：每 4m 一段横向 quad，前后衔接成连续砾石带 */
const GRAVEL_STEP = 4;
/** 砾石带内缘 |lateral|（m）：路缘 8.4 之外留 0.2m 土肩边 */
const GRAVEL_INNER = 8.6;
/** 砾石带外缘 |lateral|（m）：护栏 11.2 内留 0.1m 边距 */
const GRAVEL_OUTER = 11.1;
/** 贴土路肩抬升（m）：沿 up 抬 3cm 防与土路肩 ribbon z-fighting */
const GRAVEL_LIFT = 0.03;
/** 砾石基色（暖灰） */
const GRAVEL_COLOR = 0x8a8478;

/* ── V20 护栏广告横幅（guardrail banners）参数 ──────────────────────────────
 * 护栏上的赞助横幅，真实赛道最常见的氛围元素。起点直道 7 块（s=15/35/.../135
 * 交替两侧）+ 每个弯道 apex 外侧护栏 1 块（apex+10 出口侧，外侧符号与 V17
 * gravel 同源）。全部并入 1 个合并 mesh（1 DC / 1 材质 / 1 canvasTexture）。 */
/** 横幅长（沿 tangent，m） */
const BANNER_LEN = 4;
/** 横幅高（沿 up，m）：0.5 覆盖双梁 0.43-0.83（上下各留 0.05 包边） */
const BANNER_HEIGHT = 0.5;
/** 横幅厚（沿 right，m）：0.05，内缘 11.175 > 11.106 clip-free */
const BANNER_THICK = 0.05;
/** 横幅中心 y（相对路面 center 平面，m）：覆盖双梁 0.43-0.83 */
const BANNER_Y = 0.63;
/** 起点直道横幅：[s, 侧别]（+1 为 +right、-1 为 −right，交替两侧） */
const STRAIGHT_BANNERS: ReadonlyArray<readonly [number, number]> = [
  [15, 1],
  [35, -1],
  [55, 1],
  [75, -1],
  [95, 1],
  [115, -1],
  [135, -1]
];

/* ── V21 弯道外侧设施（corner tire walls + marshal posts）参数 ───────────────
 * 每弯 apex 外侧两样标志性赛道设施，与 V16 刹车痕 / V17 砾石带 / V20 护栏横幅
 * 同弯配套（apex 选择与 buildGravelRunoff/buildGuardrailBanners 同源）：
 *  1) 轮胎墙：InstancedMesh 低模轮胎（3 高 × 6 列，列距 0.62m，跨 apex±≈1.9m），
 *     中心 |lateral|=12.4（护栏 11.2 之外，内缘 12.08 > 11.106 clip-free）。
 *  2) 旗语员岗亭：apex+30 出口侧、|lateral|=14.5（内缘 13.7 > 11.106 clip-free）
 *     的小盒 + 平屋顶 + 旗杆 + 旗，全部 mergeSafe 为 1 mesh。 */
/** 轮胎外半径（m）：圆柱 r=0.32，水平投影内缘 12.4−0.32=12.08 > 11.106 */
const TIRE_RADIUS = 0.32;
/** 轮胎高（m）：沿局部 up 0.22，逐行堆叠 */
const TIRE_HEIGHT = 0.22;
/** 轮胎墙列数（沿 tangent） */
const TIRE_COLS = 6;
/** 轮胎墙行数（沿 up 堆叠） */
const TIRE_ROWS = 3;
/** 列距（m）：沿 tangent，6 列跨 ±1.55（含胎半径 ±1.87≈±1.9m） */
const TIRE_COL_STEP = 0.62;
/** 轮胎墙中心 |lateral|（m）：护栏 11.2 之外 */
const TIRE_LATERAL = 12.4;
/** 轮胎白（列奇偶交替，与赛道白路缘同族） */
const TIRE_WHITE = 0xf0eee8;
/** 轮胎黑 */
const TIRE_BLACK = 0x1c1d20;
/** 岗亭弧长偏移（相对 apex，m）：出口侧 */
const MARSHAL_S_OFFSET = 30;
/** 岗亭中心 |lateral|（m）：内缘 14.5−0.8=13.7 > 11.106 */
const MARSHAL_LATERAL = 14.5;
/** 旗杆旁偏（m）：沿 right 向外（远离赛道），杆在 15.7 */
const MARSHAL_POLE_OFF = 1.2;
/** 岗亭石色（与 STONE_GREY 龙门架同族） */
const MARSHAL_HUT_COLOR = 0xb9b1a6;
/** 岗亭平屋顶深色 */
const MARSHAL_ROOF_COLOR = 0x3a3a3e;
/** 旗杆灰 */
const MARSHAL_POLE_COLOR = 0x9a9ea3;
/** 旗语旗亮黄 */
const MARSHAL_FLAG_COLOR = 0xd9b23a;

/* ── V22 制动距离牌（braking distance boards 100/50/25m）参数 ─────────────
 * 每弯 apex 入口外侧放 3 块制动距离牌（距 apex 100/50/25m），与 V16 刹车痕 /
 * V17 砾石带 / V20 护栏横幅 / V21 轮胎墙+岗亭同弯配套，读作「弯道接近 100-50-25
 * 提示牌」。纽北实况：白色方牌 + 黑字距离数字，立弯道入口外侧。 */
/** 距 apex 的制动距离标记（m）：入口侧递减（100→50→25 读作接近提示） */
const BRAKEBOARD_MARKERS: ReadonlyArray<number> = [100, 50, 25];
/** 板宽（沿 right，m） */
const BRAKEBOARD_W = 1.2;
/** 板高（沿 up，m） */
const BRAKEBOARD_H = 0.8;
/** 板厚（沿 tangent，m） */
const BRAKEBOARD_T = 0.06;
/** 板中心 |lateral|（m）：护栏 11.2 之外；板内缘 12.8−0.6=12.2 > 11.106 clip-free */
const BRAKEBOARD_LATERAL = 12.8;
/** 立柱高（m）：0.08×0.08×1.2 双立柱 */
const BRAKEBOARD_POST_H = 1.2;
/** 立柱截面（m）：0.08 见方 */
const BRAKEBOARD_POST_T = 0.08;
/** 立柱沿 right 相对板中心偏（m）：双立柱立于板左右端（板宽 1.2，内偏 0.2） */
const BRAKEBOARD_POST_OFF = 0.4;
/** 立柱灰（护栏立柱同族） */
const BRAKEBOARD_POST_COLOR = 0x8a8f96;

/* ── V24 直道赞助广告挡墙（straight sponsor hoardings）参数 ────────────────
 * 长直道护栏后草地上的赞助广告挡墙，读作赛道广告墙，填补最空且最常高速经过的
 * 直道。区别于 V20（护栏横幅@弯道+起点直道，lateral 11.2 贴护栏）：V24 是**护栏
 * 后草地上的广告挡墙@长直道**，|lateral|=12.5。全部并入 1 个合并 mesh
 * （1 DC / 1 材质 / 1 canvasTexture）。 */
/** 直道判定曲率阈值（1/m）：|curvature| < 0.0004 ⇔ 半径 > 2500m */
const HOARD_STRAIGHT_CURV = 0.0004;
/** 直道判定最小连续跨度（m） */
const HOARD_STRAIGHT_MIN_LEN = 600;
/** 直道扫描步长（m） */
const HOARD_SCAN_STEP = 10;
/** 取最长直道段数（2-3） */
const HOARD_STRAIGHT_MAX = 3;
/** 兜底直道曲率阈值（1/m）：无 ≥600m 严格直道时放宽，取最长近直段（南环最长直道） */
const HOARD_FALLBACK_CURV = 0.0006;
/** 兜底直道最小连续跨度（m） */
const HOARD_FALLBACK_MIN_LEN = 200;
/** 挡墙板长（沿 tangent，m） */
const HOARD_LEN = 6;
/** 挡墙板高（沿 up，m） */
const HOARD_HEIGHT = 2;
/** 挡墙板厚（沿 right，m）：内缘 12.5−0.075=12.425 > 11.106 clip-free */
const HOARD_THICK = 0.15;
/** 挡墙中心 |lateral|（m）：护栏 11.2 之外、草地；内缘 12.425 > 11.106 车走廊 */
const HOARD_LATERAL = 12.5;
/** 板沿 tangent 排列间距（m）：40m 步进两侧交错 ⇒ 每侧每 80m 一块 */
const HOARD_PITCH = 40;
/** 每直道段最多板数（两侧交错分派；每侧 ≈ 一半 ⇒ 6-10 块/侧） */
const HOARD_MAX_PER_SEG = 20;
/** 立柱截面（m）：0.1×0.1×2.0 */
const HOARD_POST_T = 0.1;
/** 立柱高（m）：与板同高 2.0 */
const HOARD_POST_H = 2;
/** 立柱沿 tangent 相对板中心偏（m）：板长 6m、内偏 0.2 ⇒ ±2.8 */
const HOARD_POST_OFF = 2.8;
/** 立柱灰（护栏立柱同族） */
const HOARD_POST_COLOR = 0x8a8f96;
/** 立柱 UV 采样点（贴图纯白预留区）：灰×白=干净灰柱 */
const HOARD_POST_UV: readonly [number, number] = [0.025, 0.5];
/** 与里程牌 s 的最小让位距离（m）：<5m 则跳过该板 */
const HOARD_KM_CLEAR = 5;

/* ── V28 赛道赞助龙门架（sponsor gantry）参数 ───────────────────────────────
 * 横跨赛道的广告龙门架（纽北/所有真实赛道的标志性元素：车手从架下穿过、远处
 * 极醒目）。北环满 2 座；南环无长直道净空需求，按扫描实际取 0-1 座。全部并入
 * 1 个合并 mesh（1 DC / 1 材质 / 1 canvasTexture）。 */
/** 龙门架数（北环满 2；南环由扫描决定，设计上限 1） */
const GANTRY_COUNT = 2;
/** 立柱宽（沿 right，m） */
const GANTRY_COL_W = 0.5;
/** 立柱高（沿 up，m） */
const GANTRY_COL_H = 6.5;
/** 立柱中心 |lateral|（m）：内缘 11.5−0.25=11.25 > 11.106 车走廊 clip-free */
const GANTRY_COL_LAT = 11.5;
/** 横梁长（沿 right，m）：跨 ±11.5，与 V14 发车灯架横梁同法 */
const GANTRY_BEAM_W = 23;
/** 横梁高（沿 up，m） */
const GANTRY_BEAM_H = 0.6;
/** 横梁厚（沿 tangent，m） */
const GANTRY_BEAM_T = 0.5;
/** 横梁基座 y（m）：梁 5.8-6.4，立柱顶 6.5 齐 */
const GANTRY_BEAM_Y = 5.8;
/** 赞助板宽（沿 right，m） */
const GANTRY_BOARD_W = 11;
/** 赞助板高（沿 up，m） */
const GANTRY_BOARD_H = 1.8;
/** 赞助板厚（沿 tangent，m） */
const GANTRY_BOARD_T = 0.18;
/** 赞助板基座 y（m）：板 4.6-6.4，悬梁下；车高 1.4m 净空 3.2m */
const GANTRY_BOARD_Y = 4.6;
/** 龙门架须 |curv|<0.003（近直段） */
const GANTRY_STRAIGHT_CURV = 0.003;
/** 近直段最小跨度（m） */
const GANTRY_MIN_SPAN = 150;
/** 与既有结构最小间距（m）：起点/观赛点/弯道 apex */
const GANTRY_CLEAR = 120;
/** 与 V24 挡墙段最小间距（m） */
const GANTRY_HOARD_CLEAR = 60;
/** 近直段扫描步长（m），与 V24 HOARD_SCAN_STEP 同法 */
const GANTRY_SCAN_STEP = 10;
/** 立柱/横梁顶点色（深灰金属） */
const GANTRY_COL_COLOR = 0x33343a;
/** 贴图纯白采样 v（柱/梁/板缘 UV→(0.5,WHITE_V) 白区 ⇒ 灰×白=干净深灰） */
const GANTRY_WHITE_V = 0.9;

/**
 * 土路肩剖面局部高（相对路面 center 平面，m）。
 * 与 buildRibbon 的土路肩列 `strip(8.4,-0.02,11.6,-0.35)` 同源（线性 8.4→11.6）。
 * 取可见表面（土路肩 ribbon）而非 Landscape.terrainPoint —— terrainPoint 在该带
 * 恒低 0.088~0.340m（已数值验证），砾石若贴地形会**埋入土路肩之下**不可见。
 */
function shoulderY(latAbs: number): number {
  const t = Math.min(1, Math.max(0, (latAbs - 8.4) / (11.6 - 8.4)));
  return -0.02 + t * -0.33;
}

/** 一个横向列：局部 x + 局部 y + 贴图 u */
interface Column {
  x: number;
  y: number;
  u: number;
}

/**
 * 沿中心线放样一条 ribbon。
 * @param columns 断面列（从左到右，按局部 x 递增）
 * @param spacing 采样步长（米）
 * @param vScale  v 方向一个贴图周期对应的弧长（米）
 * @param closed  是否首尾闭合（赛道恒 true）
 */
function buildRibbon(
  columns: readonly Column[],
  spacing: number,
  vScale: number,
  closed = true
): THREE.BufferGeometry {
  const track = getTrack();
  const n = Math.max(3, Math.round(track.length / spacing));
  const step = track.length / n;
  const rings = closed ? n + 1 : n;
  const cols = columns.length;
  const pos = new Float32Array(rings * cols * 3);
  const uv = new Float32Array(rings * cols * 2);
  const index: number[] = [];

  for (let i = 0; i < rings; i++) {
    const s = i * step;
    const f = track.at(s);
    // at() 返回复用对象 —— 只在本环内消费，绝不跨环保留引用
    for (let c = 0; c < cols; c++) {
      const col = columns[c];
      const o = (i * cols + c) * 3;
      pos[o] = f.center.x + f.right.x * col.x + f.up.x * col.y;
      pos[o + 1] = f.center.y + f.right.y * col.x + f.up.y * col.y;
      pos[o + 2] = f.center.z + f.right.z * col.x + f.up.z * col.y;
      const t = (i * cols + c) * 2;
      uv[t] = col.u;
      uv[t + 1] = (i * step) / vScale;
    }
  }

  for (let i = 0; i < n; i++) {
    for (let c = 0; c < cols - 1; c++) {
      const l0 = i * cols + c;
      const l1 = (i + 1) * cols + c;
      const r0 = l0 + 1;
      const r1 = l1 + 1;
      index.push(l0, l1, r0, r0, l1, r1);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(index);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/** 单条带（两列）—— 左右成对构件用 */
function strip(x0: number, y0: number, x1: number, y1: number, u0 = 0, u1 = 1): Column[] {
  return [
    { x: x0, y: y0, u: u0 },
    { x: x1, y: y1, u: u1 }
  ];
}

/**
 * 路面标线 + 中央行车带磨损 —— 直接烘焙进 roadTex 的底层 canvas。
 * V2 增强（零新增 mesh/材质/DC，只重画既有 roadTexture 画布）：
 *  - 中央白色虚线（x=0，4m 实 / 8m 空，12m 周期与 v=s/12 对齐，跨缝无缝平铺）；
 *  - 两侧白色边线（路缘内侧 x=±6.5，加暗描边增强对浅色边带的对比）；
 *  - 中央行车带两道轮迹磨损暗纹（x=±1.2，低 alpha 渐变，代表橡胶沉积）。
 * roadTexture 是 1024×880 画布：横向 1024px = 14m（73.1px/m）、纵向 880px = 12m（73.3px/m）。
 */
function bakeRoadMarkings(tex: THREE.CanvasTexture): void {
  const canvas = tex.image as HTMLCanvasElement;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const W = canvas.width;
  const H = canvas.height;
  const xToPx = (x: number): number => ((x + 7) / 14) * W; // 局部 x（米）→ 画布 px（u 方向）
  const pxM = W / 14;
  const pxV = H / 12;

  // 中央虚线：白色 4m 实段（0..4m），其余 8m 留空
  const cx = xToPx(0);
  const dashW = 0.14 * pxM;
  ctx.fillStyle = '#e8e6e0';
  ctx.fillRect(cx - dashW / 2, 0, dashW, 4 * pxV);

  // 两侧边线：白色实线 + 暗描边（对浅色边带保持可读性）
  for (const side of [-1, 1]) {
    const ex = xToPx(side * 6.5);
    const lw = 0.12 * pxM;
    ctx.fillStyle = 'rgba(52,50,46,0.42)';
    ctx.fillRect(ex - lw / 2 - 2, 0, lw + 4, H);
    ctx.fillStyle = '#ece9e2';
    ctx.fillRect(ex - lw / 2, 0, lw, H);
  }

  // 中央行车带轮迹磨损：两道低 alpha 暗纹（中心到边缘渐变，不形成硬黑条）
  for (const side of [-1, 1]) {
    const wx = xToPx(side * 1.2);
    const ww = 0.34 * pxM;
    const grad = ctx.createLinearGradient(wx - ww / 2, 0, wx + ww / 2, 0);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(0.5, 'rgba(22,20,17,0.09)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(wx - ww / 2, 0, ww, H);
  }

  // V3 弯道内侧胎痕加深：轮迹带朝**中心线**一侧额外压暗（不对称渐变，代表纽北重磨损
  // 的橡胶沉积/刹车痕）。贴图沿 s 平铺 12m 周期，故用恒定内偏做方向性磨损近似。
  for (const side of [-1, 1]) {
    const wx = xToPx(side * 1.2);
    const ww = 0.34 * pxM;
    const innerX = wx - (side * ww) / 2; // 朝中心线一侧的边缘（side=-1 为 +x、side=+1 为 −x）
    const g0 = innerX + side * ww * 0.42; // 渐变起点（外侧）
    const g1 = innerX - side * ww * 0.12; // 渐变终点（内侧，略越过边缘）
    const gx0 = Math.min(g0, g1);
    const gx1 = Math.max(g0, g1);
    const innerGrad = ctx.createLinearGradient(gx0, 0, gx1, 0);
    innerGrad.addColorStop(0, 'rgba(0,0,0,0)');
    innerGrad.addColorStop(1, 'rgba(16,14,12,0.15)');
    ctx.fillStyle = innerGrad;
    ctx.fillRect(gx0, 0, gx1 - gx0, H);
  }

  tex.needsUpdate = true;
}

/**
 * 路缘红白交替贴图（零新增材质，赋给既有 kerbMat.map）。
 * kerb 几何 v = s/4（每 4m 一个周期）⇒ 画布上 2m 红 + 2m 白交替；横向 u=0..1 不变色
 * （色带沿弧长方向，横跨路缘宽）。附表面微颗粒 + 交界暗缝，读得出生动的红白路缘石。
 */
function kerbTexture(): THREE.CanvasTexture {
  const size = 128;
  const [canvas, ctx] = makeCanvas(size, size);
  ctx.fillStyle = '#c0392b'; // 路缘红
  ctx.fillRect(0, 0, size, size / 2);
  ctx.fillStyle = `#${KERB_WHITE.toString(16).padStart(6, '0')}`; // 路缘白（KERB_WHITE 同族）
  ctx.fillRect(0, size / 2, size, size / 2);
  ctx.fillStyle = 'rgba(38,30,26,0.4)'; // 交界暗缝
  ctx.fillRect(0, size / 2 - 2, size, 4);
  const random = makeLcg(0x7c0c7c); // 表面颗粒（确定性）
  for (let i = 0; i < 420; i++) {
    const g = Math.floor(200 + random() * 55);
    ctx.fillStyle = `rgba(${g},${g - 8},${g - 14},${(0.05 + random() * 0.1).toFixed(3)})`;
    ctx.fillRect(random() * size, random() * size, 1.5, 1.5);
  }

  // V3 红白交界掉漆斑：交界带（v≈0.5）颜料剥落露出灰石 —— 集中在交界，另少量随机散布。
  const chip = makeLcg(0x3a1d5e);
  const paintChip = (cx: number, cy: number, r: number, alpha: number): void => {
    const g = Math.floor(150 + chip() * 62);
    ctx.fillStyle = `rgba(${g},${g - 6},${g - 13},${alpha.toFixed(3)})`;
    ctx.beginPath();
    ctx.ellipse(cx, cy, r, r * (0.5 + chip() * 0.9), 0, 0, Math.PI * 2);
    ctx.fill();
  };
  for (let i = 0; i < 26; i++) {
    // 交界掉漆：集中在 size/2 ± 7px，多为小点、少数大块
    paintChip(
      chip() * size,
      size / 2 + (chip() - 0.5) * 14,
      1 + chip() * (chip() < 0.3 ? 3.4 : 1.6),
      0.22 + chip() * 0.34
    );
  }
  for (let i = 0; i < 12; i++) {
    // 随机散布少量掉漆（避开交界带以免重叠过密）
    const cy = chip() * size;
    if (Math.abs(cy - size / 2) < 10) continue;
    paintChip(chip() * size, cy, 0.8 + chip() * 1.8, 0.12 + chip() * 0.22);
  }
  const tex = canvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/**
 * V20 护栏横幅贴图 —— 512×64 程序化双色横幅（4m×0.5m ⇒ 128px/m 等比）：
 * 上部品牌色带 + 米白底 + 中间深色字条（白色抽象「赞助商」字块）+ 底缘白线收边。
 * 与 V14 广告牌横幅同风格（深蓝 racing 品牌色），1 张共享，明度靠顶点色微调区分。
 */
function bannerTexture(): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(512, 64);
  // 上部品牌色带（深蓝，racing 品牌观感，与 V14 同族）
  ctx.fillStyle = '#1f4e8c';
  ctx.fillRect(0, 0, 512, 15);
  // 品牌带下缘白色分隔线
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 14, 512, 3);
  // 下部米白底
  ctx.fillStyle = '#efe9dc';
  ctx.fillRect(0, 17, 512, 47);
  // 中间深色字条（赞助商名条）
  ctx.fillStyle = '#20242a';
  ctx.fillRect(0, 30, 512, 22);
  // 字条上白色抽象文字块（多段，读作品牌名）
  ctx.fillStyle = '#f4f1ea';
  ctx.fillRect(26, 35, 78, 12);
  ctx.fillRect(120, 35, 112, 12);
  ctx.fillRect(248, 35, 88, 12);
  ctx.fillRect(352, 35, 96, 12);
  ctx.fillRect(464, 35, 24, 12);
  // 底缘细白线收边
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 60, 512, 4);
  const tex = canvasTexture(canvas);
  tex.anisotropy = 4;
  return tex;
}

/**
 * V22 制动距离牌贴图 —— 384×128 三格（每格 128×128）：
 * 左「100」、中「50」、右「25」，白底 + 黑数字 + 黑细边框，读作官方制动牌。
 * 数字格横向分带：100→[0,1/3]、50→[1/3,2/3]、25→[2/3,1]（UV 重映射用）。
 * 每格顶部（边框内、数字上方）留纯白边，供立柱 UV 采样（灰×白=干净灰柱）。
 */
function brakeBoardTexture(): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(384, 128);
  const CELL = 128;
  const digits = ['100', '50', '25'];
  for (let i = 0; i < 3; i++) {
    const x0 = i * CELL;
    // 白底
    ctx.fillStyle = '#f4f2ec';
    ctx.fillRect(x0, 0, CELL, CELL);
    // 黑细边框（内缩 6px，宽 3px）
    ctx.strokeStyle = '#15151a';
    ctx.lineWidth = 3;
    ctx.strokeRect(x0 + 6, 6, CELL - 12, CELL - 12);
    // 黑数字（居中）。⚠ 数字横向预压缩：板面 1.2m×0.8m = 1.5:1 横向，而贴图每格
    // 128×128（1:1）全幅映射到板面（±Z 面 u 沿板宽、v 沿板高）⇒ 不预压缩数字会被
    // 横向拉伸 1.5 倍读作「扁宽」。预压缩 1/(W/H) 使数字在板上恢复正方形、读正。
    ctx.fillStyle = '#15151a';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 60px Arial, "Helvetica Neue", sans-serif';
    ctx.save();
    ctx.translate(x0 + CELL / 2, CELL / 2 + 2);
    ctx.scale(1 / (BRAKEBOARD_W / BRAKEBOARD_H), 1); // 横向预压缩 1.5 倍
    ctx.fillText(digits[i], 0, 0);
    ctx.restore();
  }
  const tex = canvasTexture(canvas);
  tex.anisotropy = 4;
  return tex;
}

/**
 * V24 赞助广告挡墙贴图 —— 1024×256 程序化赞助墙（6m×2m ⇒ 171px/m 等比）：
 * 上部红色品牌带 + 中部米白底上三块多彩赞助块（各带抽象白字条）+ 底部深炭条，
 * 与 V20（深蓝带+米白+深字条）**不同设计**（红色系 racing 品牌带 + 大字条）。
 * 左缘 u∈[0,0.055] 主字段留纯白，供立柱 UV 采样（灰×白=干净灰柱）。
 */
function hoardingTexture(): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(1024, 256);
  // 底部深炭条（y 190..256）
  ctx.fillStyle = '#23262b';
  ctx.fillRect(0, 190, 1024, 66);
  // 中部米白底（y 60..190）
  ctx.fillStyle = '#f2eee4';
  ctx.fillRect(0, 60, 1024, 130);
  // 上部红色品牌带（y 0..56）
  ctx.fillStyle = '#b3202a';
  ctx.fillRect(0, 0, 1024, 56);
  // 品牌带白色分隔线（y 54..60）
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 54, 1024, 6);
  // 左缘纯白预留区（x 0..56、y 60..190）：立柱 UV 采样 ⇒ 灰×白=干净灰柱
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 60, 56, 130);
  // 中部三块多彩赞助块（各 288px 宽、40px 间隙），各带白色抽象字条
  const blocks: ReadonlyArray<readonly [number, string]> = [
    [64, '#1f3f66'], // 深蓝
    [392, '#1e6b3c'], // 绿
    [720, '#d97a1f'] // 橙
  ];
  for (const [x0, color] of blocks) {
    ctx.fillStyle = color;
    ctx.fillRect(x0, 60, 288, 130);
    // 块内白色抽象文字条（读作赞助商标识）
    ctx.fillStyle = '#f4f1ea';
    ctx.fillRect(x0 + 18, 76, 252, 18);
    ctx.fillRect(x0 + 18, 116, 252, 26);
    ctx.fillRect(x0 + 18, 158, 168, 18);
  }
  // 底部深炭条上白色文字条
  ctx.fillStyle = '#f4f1ea';
  ctx.fillRect(24, 210, 200, 26);
  ctx.fillRect(268, 210, 320, 26);
  ctx.fillRect(632, 210, 176, 26);
  ctx.fillRect(852, 210, 148, 26);
  const tex = canvasTexture(canvas);
  tex.anisotropy = 4;
  return tex;
}

/**
 * V28 赞助龙门架贴图 —— 1024×256 程序化（深炭底 + 上缘品牌红带 + 居中大号白字
 * 「GELLHORN」+ 两侧多彩赞助块 + 底部细白条），与 V20（深蓝带+米白）、V24
 * （红带+米白+深炭条）**不同设计**（深炭 racing 观感 + 大号品牌字 + 多彩块）。
 * 上缘 y∈[0,30] 留整幅纯白采样带（v≈0.9 白区），供柱/梁/板缘 UV 采样
 * （灰×白=干净深灰）；红带 y∈[34,88] 位于横梁遮挡区（板顶 0.6m 嵌梁内），读作
 * 梁下红边。文字在 4:1 画布映射 11×1.8m 板（6.1:1）略横向拉伸，既定设计可接受。
 */
function gantryTexture(): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(1024, 256);
  // 深炭底（整幅）
  ctx.fillStyle = '#1e2026';
  ctx.fillRect(0, 0, 1024, 256);
  // 上缘纯白采样带（y 0..30）：柱/梁/板缘 UV→(0.5,0.9) 采样 ⇒ 灰×白=干净深灰
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 1024, 30);
  // 上缘品牌红带（y 34..84，被横梁遮挡区覆盖，读作梁下红边）
  ctx.fillStyle = '#b3202a';
  ctx.fillRect(0, 34, 1024, 50);
  // 红带下白色分隔线（y 84..88）
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 84, 1024, 4);
  // 居中大号白字 GELLHORN（粗体，读正非镜像；v=1=画布顶）
  ctx.fillStyle = '#f4f1ea';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 78px Arial, "Helvetica Neue", sans-serif';
  ctx.fillText('GELLHORN', 512, 126);
  // 两侧多彩赞助块（蓝/绿/橙/紫，V24 不同配色），各带白色抽象字条
  const blocks: ReadonlyArray<readonly [number, string]> = [
    [40, '#1f3f66'], // 深蓝
    [200, '#1e6b3c'], // 绿
    [688, '#d97a1f'], // 橙
    [848, '#5a3f8f'] // 紫
  ];
  for (const [x0, color] of blocks) {
    ctx.fillStyle = color;
    ctx.fillRect(x0, 170, 136, 70);
    ctx.fillStyle = '#f4f1ea';
    ctx.fillRect(x0 + 12, 184, 112, 12);
    ctx.fillRect(x0 + 12, 206, 112, 12);
  }
  // 底部细白条（y 244..256）
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 244, 1024, 12);
  const tex = canvasTexture(canvas);
  tex.anisotropy = 4;
  return tex;
}

export class Track {
  /** 场景根（Game 只 add 这一个组，dispose 时统一释放） */
  readonly group = new THREE.Group();
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly textures: THREE.Texture[] = [];

  constructor(scene: THREE.Scene, anisotropy: number) {
    this.group.name = 'track';
    const track = getTrack();

    /* ── 石板路面（半宽 7m，三带贴图 v=s/12）──────────────────────────── */
    const roadTex = roadTexture(anisotropy);
    bakeRoadMarkings(roadTex); // V2：中线/边线/行车带磨损烘焙进既有 roadTexture 画布
    this.textures.push(roadTex);
    this.materials.push(
      new THREE.MeshStandardMaterial({
        map: roadTex,
        roughness: 0.9,
        metalness: 0.04,
        envMapIntensity: 0.15,
        vertexColors: true // V25：顶点色（明度 patch）× 贴图 ⇒ 路面色调变化
      })
    );
    const roadGeo = buildRibbon(
      [
        { x: -7, y: 0, u: 0 },
        { x: 7, y: 0, u: 1 }
      ],
      4,
      12
    );
    // V25 路面色调变化（road surface variation）：真实纽北路面色调/粗糙度不尽相同
    // （有的光滑有的粗糙），用**顶点色**大尺度明暗 patch + 环间小噪点，读作路面新旧/
    // 粗糙度差异。色 × map ⇒ 明暗 patch 乘既有路面纹理（不动 V2 烘焙的中线/边线，只乘
    // 明度）。零新增 mesh/材质/DC/纹理（只加 color attribute 到既有路面网格 + roadMat.
    // vertexColors）。
    // 铁律：
    //  - 独立种子 0x5a5a5a（makeLcg 确定性），不扰既有 rnd/RND 序列；
    //  - 每环 2 顶点同明度（同一横向断面），color count 必须 = position.count；
    //  - 明度 clamp 到 [0.88, 1.0]（patch 0.90..1.00 + 噪声 ±0.02 ⇒ 无黑斑/过曝）。
    const roadPos = roadGeo.getAttribute('position');
    const roadVCount = roadPos.count;
    const roadRingCount = roadVCount / 2; // 2 列（x=±7）⇒ 环数 = 顶点数 / 2
    const roadRandom = makeLcg(0x5a5a5a);
    const roadStep = track.length / (roadRingCount - 1); // 环间实际弧长（≈4m）
    const roadCol = new Float32Array(roadVCount * 3);
    let roadBrightness = 0.9 + roadRandom() * 0.1; // patch 基明度（0.90..1.00）
    let roadPatchLeft = 150 + roadRandom() * 250; // 当前 patch 剩余长度（m，150..400）
    for (let r = 0; r < roadRingCount; r++) {
      // 环间小噪点 ±0.02（读作沥青颗粒/打磨差异），与 patch 基明度叠加
      const noise = (roadRandom() * 2 - 1) * 0.02;
      const b = Math.min(1, Math.max(0.88, roadBrightness + noise));
      for (let c = 0; c < 2; c++) {
        const vi = r * 2 + c;
        roadCol[vi * 3] = b;
        roadCol[vi * 3 + 1] = b;
        roadCol[vi * 3 + 2] = b;
      }
      roadPatchLeft -= roadStep;
      if (roadPatchLeft <= 0) {
        // 换新 patch：新基明度 + 新 patch 长度（150..400m）
        roadBrightness = 0.9 + roadRandom() * 0.1;
        roadPatchLeft = 150 + roadRandom() * 250;
      }
    }
    roadGeo.setAttribute('color', new THREE.BufferAttribute(roadCol, 3));
    this.geometries.push(roadGeo);
    const road = new THREE.Mesh(roadGeo, this.materials[0]);
    road.name = 'road-surface';
    road.receiveShadow = true;
    this.group.add(road);

    /* ── 白石路缘（|x| ∈ [7, 8.4]，真实凸起石条 KERB_LIP=0.10）────────────
     * V2 红白交替贴图（色已烘焙进 kerbTexture，材质色纯白）。
     * 剖面（与 track/surface.surfaceHeight 的 KERB_LIP 同源）：内缘起坡 0→KERB_LIP、
     * 平台、外缘落坡 KERB_LIP→−0.02（接土路肩内缘）—— 压上「顶一下」读作真石条。
     * DoubleSide：侧面（内外立面）从任何角度可见。 */
    const kerbTex = kerbTexture();
    this.textures.push(kerbTex);
    const kerbMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.8,
      map: kerbTex,
      side: THREE.DoubleSide
    });
    this.materials.push(kerbMat);
    // 左右路缘：4 列剖面（内缘底→内缘顶→外缘顶→外缘底），u 沿宽向 0→1。
    const kerbColsL: Column[] = [
      { x: -7, y: 0, u: 0 },
      { x: -7, y: KERB_LIP, u: 0.34 },
      { x: -8.4, y: KERB_LIP, u: 0.67 },
      { x: -8.4, y: -0.02, u: 1 }
    ];
    const kerbColsR: Column[] = [
      { x: 7, y: 0, u: 0 },
      { x: 7, y: KERB_LIP, u: 0.34 },
      { x: 8.4, y: KERB_LIP, u: 0.67 },
      { x: 8.4, y: -0.02, u: 1 }
    ];
    const kerbGeo = mergeSafe([buildRibbon(kerbColsL, 4, 4), buildRibbon(kerbColsR, 4, 4)]);
    this.geometries.push(kerbGeo);
    const kerb = new THREE.Mesh(kerbGeo, kerbMat);
    kerb.name = 'kerb';
    kerb.receiveShadow = true;
    this.group.add(kerb);

    /* ── 土路肩（|x| ∈ [8.4, 11.6]，向外压低 0.35）────────────────────── */
    const soil = createSoilTexture();
    soil.repeat.set(1, 1);
    this.textures.push(soil);
    const shoulderMat = new THREE.MeshStandardMaterial({
      color: 0x8d7c64,
      map: soil,
      roughness: 0.92,
      metalness: 0.02
    });
    this.materials.push(shoulderMat);
    const shoulderGeo = mergeSafe([
      buildRibbon(strip(-11.6, -0.35, -8.4, -0.02), 4, 6),
      buildRibbon(strip(8.4, -0.02, 11.6, -0.35), 4, 6)
    ]);
    this.geometries.push(shoulderGeo);
    const shoulder = new THREE.Mesh(shoulderGeo, shoulderMat);
    shoulder.name = 'shoulder';
    shoulder.receiveShadow = true;
    this.group.add(shoulder);

    /* ── 护栏（横梁 ribbon + 立柱 InstancedMesh）────────────────────────
     * 横梁：x=±11.2 的**双梁**竖直薄带 —— 下梁 y 0.43~0.53、上梁 y 0.73~0.83
     *   （各 0.10 厚，中心 0.48 / 0.78），DoubleSide 单面片，合并成 1 个 mesh（1 DC）。
     * 立柱：每 **5m** 一根，坐落在土路肩（11.2 处 ≈ −0.31）上、顶端探到上梁上沿 ——
     *   箱体 0.16×1.32×0.16，底沿可见路肩表面（shoulderY 剖面）固定埋入 0.15m、
     *   顶探出上梁（上下梁 0.43~0.83 均被立柱贯穿搭接）。立柱竖直（绕 Y），中心取
     *   路肩表面 +（半高 0.66 − 埋深 0.15），斜坡上不再随 f.up 漂移 ⇒ 不悬空/不深插。 */
    const railMat = new THREE.MeshStandardMaterial({
      color: RAIL_GREY,
      roughness: 0.55,
      metalness: 0.65,
      side: THREE.DoubleSide
    });
    this.materials.push(railMat);
    const beamGeo = mergeSafe([
      buildRibbon(strip(-11.2, 0.43, -11.2, 0.53), 4, 4),
      buildRibbon(strip(11.2, 0.43, 11.2, 0.53), 4, 4),
      buildRibbon(strip(-11.2, 0.73, -11.2, 0.83), 4, 4),
      buildRibbon(strip(11.2, 0.73, 11.2, 0.83), 4, 4)
    ]);
    this.geometries.push(beamGeo);
    const beam = new THREE.Mesh(beamGeo, railMat);
    beam.name = 'guardrail-beam';
    beam.receiveShadow = true;
    this.group.add(beam);

    const postGeo = new THREE.BoxGeometry(0.16, 1.32, 0.16);
    this.geometries.push(postGeo);
    const postCount = Math.floor(track.length / 5) * 2;
    const posts = new THREE.InstancedMesh(postGeo, railMat, postCount);
    posts.name = 'guardrail-posts';
    posts.castShadow = false;
    posts.receiveShadow = true;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const one = new THREE.Vector3(1, 1, 1);
    const p = new THREE.Vector3();
    const step = track.length / (postCount / 2);
    let idx = 0;
    for (let i = 0; i < postCount / 2; i++) {
      const s = i * step;
      const f = track.at(s);
      const heading = Math.atan2(f.tangent.x, f.tangent.z);
      q.setFromAxisAngle(up, heading);
      for (const side of [-1, 1]) {
        // 立柱竖直（q 只绕 Y 旋转 ⇒ 局部 Y = 世界 Y），原中心沿 f.up 偏移 0.19 在斜坡处
        // 使立柱底随 f.up.y 波动 + f.up 横向分量漂移 ⇒ 插入路肩下草地或悬空。
        // 改为底贴可见路肩表面（shoulderY 剖面，与 buildRibbon 路肩 ribbon 同源），固定埋入：
        //   路肩表面 Y = center.y + right.y·(side·11.2) + up.y·shoulderY(11.2)
        //   立柱中心 Y = 表面Y + (半高 1.32/2 − 埋深 0.15)，横向不再叠加 f.up 漂移。
        const surfY = f.center.y + f.right.y * side * 11.2 + f.up.y * shoulderY(11.2);
        p.set(
          f.center.x + f.right.x * side * 11.2,
          surfY + (0.66 - 0.15),
          f.center.z + f.right.z * side * 11.2
        );
        m.compose(p, q, one);
        posts.setMatrixAt(idx++, m);
      }
    }
    posts.instanceMatrix.needsUpdate = true;
    posts.computeBoundingSphere();
    this.group.add(posts);

    // V12 护栏反光片（纽北标志性白色反光条）：贴上梁内侧（y=0.78、x=±11.10、法线朝路心），
    // 每 20m 一侧、s 偏移 +12（避开立柱 s=0,5,10.. 的 z-fighting）。白色微反光（emissive 暗暖），
    // 玩家贴墙/黄昏可见。BoxGeometry 厚 0.05 沿 right（±X 法线）、长 0.16 沿 tangent。+1 DC/+1 材质。
    const reflGeo = new THREE.BoxGeometry(0.05, 0.1, 0.16);
    this.geometries.push(reflGeo);
    const reflMat = new THREE.MeshStandardMaterial({
      color: 0xf6f4ec,
      roughness: 0.32,
      metalness: 0.25,
      emissive: 0x1c1a16
    });
    this.materials.push(reflMat);
    const reflPerSide = Math.floor(track.length / 20);
    const refl = new THREE.InstancedMesh(reflGeo, reflMat, reflPerSide * 2);
    refl.name = 'guardrail-reflectors';
    refl.castShadow = false;
    refl.receiveShadow = false;
    const rq = new THREE.Quaternion();
    let ridx = 0;
    for (let i = 0; i < reflPerSide; i++) {
      const s = i * 20 + 12;
      const f = track.at(s);
      const heading = Math.atan2(f.tangent.x, f.tangent.z);
      rq.setFromAxisAngle(up, heading);
      for (const side of [-1, 1]) {
        p.set(
          f.center.x + f.right.x * side * 11.1 + f.up.x * 0.78,
          f.center.y + f.right.y * side * 11.1 + f.up.y * 0.78,
          f.center.z + f.right.z * side * 11.1 + f.up.z * 0.78
        );
        m.compose(p, rq, one);
        refl.setMatrixAt(ridx++, m);
      }
    }
    refl.instanceMatrix.needsUpdate = true;
    refl.computeBoundingSphere();
    this.group.add(refl);

    /* ── 起终线：2m 宽黑白条带 + 龙门架 ─────────────────────────────── */
    this.group.add(this.buildStartLine());
    this.group.add(this.buildGate());

    // V16 刹车痕迹（并入既有 group，1 InstancedMesh / 1 DC）
    this.buildBrakeMarks();

    // V26 赛车线（沿全赛道连续、随弯道横向移动的轮胎磨痕带，1 InstancedMesh / 1 DC）
    this.buildRacingLine();

    // V17 砾石缓冲带（弯道外侧路肩跑偏区，并入既有 group，1 合并 mesh / 1 DC）
    this.buildGravelRunoff();

    // V20 护栏广告横幅（护栏双梁上的赞助横幅，并入既有 group，1 合并 mesh / 1 DC）
    this.buildGuardrailBanners();

    // V21 弯道外侧设施（轮胎墙 + 旗语员岗亭，与 V16/V17/V20 同弯配套）
    this.buildCornerTireWalls();
    this.buildMarshalPosts();

    // V22 制动距离牌（弯道入口外侧 100/50/25m 提示牌，与 V16/V17/V20/V21 同弯配套）
    this.buildBrakeBoards();

    // V24 直道赞助广告挡墙（护栏后草地上的广告墙@长直道，1 合并 mesh / 1 DC）
    this.buildStraightHoardings();

    // V28 赛道赞助龙门架（横跨赛道的广告龙门架@近直段，北环满 2、南环 0-1）
    this.buildGantries();

    this.group.matrixAutoUpdate = false;
    this.group.updateMatrix();
    scene.add(this.group);
  }

  /**
   * 起终线条带（横跨 14m 路面，2m 宽，交替白石/深色格）+ 后方起跑格。
   * V2：把网格向后扩到 s=-24..2（**并入既有 start-line mesh**，零新增 mesh/材质/DC）：
   *  - s=0..2：不透明黑白格起终带（贴图顶部区域）；
   *  - s=-24..0：**透明背景**上叠白色起跑格框（贴图底部区域）——透明底让石板路面
   *    从框间透出，避免一整块不透明色片贴在路上；只有格框与格带不透明。
   * 几何仍用 ribbon 逐环按中心线帧构造（赛道带横倾/坡度，基向量手推易错），
   * 绕序与路面同源必朝上。
   */
  private buildStartLine(): THREE.Object3D {
    const track = getTrack();
    // 画布：顶 0..40px = 起终格带（不透明），底 40..128px = 起跑格区（透明底 + 白框）
    const W = 512;
    const H = 128;
    const BAND_H = 40; // 格带高度（px）
    const GRID_LEN = 24; // 起跑格沿弧长长度（s=-24..0）
    const gridV = (H - BAND_H) / H; // 格带与格区分界处的 v（flipY）
    const [canvas, ctx] = makeCanvas(W, H);

    // 起终格带：24 格 × 2 行 交替白石/深色
    const cells = 24;
    const cw = W / cells;
    const rowH = BAND_H / 2;
    for (let i = 0; i < cells; i++) {
      for (let row = 0; row < 2; row++) {
        const dark = (i + row) % 2 === 0;
        ctx.fillStyle = dark ? '#2b2a28' : '#e5dcd9';
        ctx.fillRect(i * cw, row * rowH, cw, rowH);
      }
    }

    // 起跑格：10 个白色格框，左右交错（格带后方，透明底）
    const HALF = 7;
    for (let i = 0; i < 10; i++) {
      const sC = -22 + i * 2.2; // s 从 -22 到 -2.2
      const side = i % 2 === 0 ? 1 : -1;
      const xC = side * 3.2;
      const px = ((xC + HALF) / 14) * W;
      const py = BAND_H + ((-sC) / GRID_LEN) * (H - BAND_H); // s=-24→py=H(底)，s=0→py=BAND_H
      const halfPx = (2.2 / 14) * W * 0.5; // 框半宽（横向 2.2m）
      const halfPy = (2.6 / GRID_LEN) * (H - BAND_H) * 0.5; // 框半长（纵向 2.6m）
      ctx.strokeStyle = 'rgba(240,238,232,0.92)';
      ctx.lineWidth = 2;
      ctx.strokeRect(px - halfPx, py - halfPy, halfPx * 2, halfPy * 2);
      ctx.fillStyle = 'rgba(240,238,232,0.10)';
      ctx.fillRect(px - halfPx, py - halfPy, halfPx * 2, halfPy * 2);
    }

    const tex = canvasTexture(canvas);
    this.textures.push(tex);
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      roughness: 0.85,
      metalness: 0.03,
      transparent: true // 格区透明底让路面透出；格带/格框不透明
    });
    this.materials.push(mat);

    const LIFT = 0.012;
    // 三环（s=-24 / 0 / 2）× 两列（x=±7）→ 6 顶点、2 个四边形
    const rings: ReadonlyArray<{ s: number; v: number }> = [
      { s: -GRID_LEN, v: 0 }, // 格区底（py=H）
      { s: 0, v: gridV }, // 格区顶/格带底
      { s: 2, v: 1 } // 格带顶
    ];
    const pos = new Float32Array(rings.length * 2 * 3);
    const uv = new Float32Array(rings.length * 2 * 2);
    for (let r = 0; r < rings.length; r++) {
      const f = track.at(rings[r].s);
      for (let c = 0; c < 2; c++) {
        const x = c === 0 ? -HALF : HALF;
        const o = (r * 2 + c) * 3;
        pos[o] = f.center.x + f.right.x * x + f.up.x * LIFT;
        pos[o + 1] = f.center.y + f.right.y * x + f.up.y * LIFT;
        pos[o + 2] = f.center.z + f.right.z * x + f.up.z * LIFT;
        const t = (r * 2 + c) * 2;
        uv[t] = c;
        uv[t + 1] = rings[r].v;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    // 两个四边形：环0→环1、环1→环2（绕序与 buildRibbon 同源朝上）
    geo.setIndex([0, 2, 1, 1, 2, 3, 2, 4, 3, 3, 4, 5]);
    geo.computeVertexNormals();
    this.geometries.push(geo);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'start-line';
    mesh.receiveShadow = true;
    return mesh;
  }

  /** 龙门架（跨 14m 路面：石柱 0.9m 见方 + 横梁 1.2m + 「GELLHORN」字牌）
   *  V15 穿模修复：立柱 ±7.45 → **±11.7**（0.9m 立柱内缘 11.25 > 护栏 11.2 > 走廊 11.106，
   *  立柱落在护栏外、车体够不到 ⇒ clip-free；横梁随之 16.6 → **23.4m**）。
   *  ⚠ 原 ±7.45 立柱落在路肩（7.4..10.1 可驶区）内，车贴护栏极限时会穿过立柱 —— V6 登记
   *  穿模遗留项，本轮闭合（与 V14 发车灯架 ±11.5 同置于护栏外）。 */
  private buildGate(): THREE.Object3D {
    const track = getTrack();
    const group = new THREE.Group();
    group.name = 'start-gate';

    const stoneMat = new THREE.MeshStandardMaterial({ color: STONE_GREY, roughness: 0.85 });
    this.materials.push(stoneMat);
    const pillarGeo = new THREE.BoxGeometry(0.9, 6.2, 0.9);
    const beamGeo = new THREE.BoxGeometry(23.4, 1.2, 0.9);
    this.geometries.push(pillarGeo, beamGeo);
    for (const side of [-1, 1]) {
      const pillar = new THREE.Mesh(pillarGeo, stoneMat);
      pillar.position.set(side * 11.7, 3.1, 0);
      pillar.castShadow = true;
      pillar.receiveShadow = true;
      group.add(pillar);
    }
    const beam = new THREE.Mesh(beamGeo, stoneMat);
    beam.position.set(0, 5.9, 0);
    beam.castShadow = true;
    beam.receiveShadow = true;
    group.add(beam);

    // 字牌：程序化 Canvas（不引外部资源），挂在横梁朝向来车的一面（局部 −Z）
    const signTex = textTexture(['GELLHORN'], '#1b1d20', '#f1dcae', 1024, 160);
    this.textures.push(signTex);
    const signMat = new THREE.MeshStandardMaterial({
      map: signTex,
      roughness: 0.7,
      metalness: 0.05,
      emissive: 0x1a1712,
      emissiveIntensity: 0.35
    });
    this.materials.push(signMat);
    const signGeo = new THREE.PlaneGeometry(7.6, 1.0);
    this.geometries.push(signGeo);
    const sign = new THREE.Mesh(signGeo, signMat);
    sign.position.set(0, 5.9, -0.47);
    sign.rotation.y = Math.PI; // 法线朝 −Z（来车方向）
    group.add(sign);

    const f = track.at(0);
    const center = track.toWorld(0, 0, 0);
    const basis = new THREE.Matrix4().makeBasis(
      new THREE.Vector3(f.right.x, f.right.y, f.right.z),
      new THREE.Vector3(f.up.x, f.up.y, f.up.z),
      new THREE.Vector3(f.tangent.x, f.tangent.y, f.tangent.z)
    );
    group.quaternion.setFromRotationMatrix(basis);
    group.position.set(center.x, center.y, center.z);
    return group;
  }

  /**
   * V16 刹车痕迹（brake marks）：弯道入口路面上的黑色双轮迹。
   *
   * 定位：复刻 Scenery.buildMarkers 的弯道 apex 选择（|curv|>0.006 候选、按 |curv|
   * 降序取前 8、间距 >700；北环 ≈6 / 南环 ≈4）。每个 apex 的刹车区 = [apex−45, apex]
   * （入弯减速区），沿区每 2.5m 放一小段四边形，左右两条轮迹 |lateral| = 0.8（车宽
   * 2.0m 轮距近似，居中）。
   *
   * 朝向/贴合：每块沿赛道局部系摆（makeBasis(right, up, tangent)），底面贴路面
   * （center + right*lateral + up*0.02），法线朝上（up）。尺寸：宽 0.28m（沿 right）
   * × 长 2.5m（沿 tangent，前后采样点衔接成连续轮迹）。已用 three 数值验证：
   *   normal·up = 1、宽 0.28 沿 right、长 2.5 沿 tangent、up 向厚度 0、det(makeBasis)=+1
   *   （非反射，PlaneGeometry.rotateX(−π/2) 把 XY 面翻到 XZ 面、法线 +Z→+Y）。
   *
   * 渐隐：instanceColor 灰度从入口 0.15（浓）到 apex 0.75（淡），线性衰减；材质
   * MeshBasicMaterial({color:0xffffff, transparent:true, opacity:0.55}) —— 深灰 ×
   * 透明度读作渐隐轮迹（instanceColor 独立生效：three 在 instancingColor 时自动
   * 定义 USE_COLOR，色乘 diffuseColor，无需 material.vertexColors）。
   *
   * 性能/合规：全部并入 1 个 InstancedMesh（1 DC / 1 材质 / 0 纹理）；PlaneGeometry
   * 每实例 2 tri（北环 6 弯 = 216 实例 / 432 tri，南环 4 弯 = 144 实例 / 288 tri）；
   * 不投影不接收阴影（castShadow/receiveShadow=false）；depthWrite=false 防贴路面闪烁；
   * |lateral|=0.8 ≤ 7（路面半宽）⇒ 无穿模。
   */
  private buildBrakeMarks(): void {
    const track = getTrack();
    // 弯道 apex 选择（与 Scenery.buildMarkers 同源）：收集 |curv|>0.006 候选，
    // 按 |curv| 降序取前 8、间距 >700（北环 ≈6 / 南环 ≈4）。
    const apexes = selectApexes(getCurrentMode()).map((p) => p.s);
    if (apexes.length === 0) return;

    // 每 apex 采样段数 = BRAKE_MARK_LEN / BRAKE_MARK_STEP（45/2.5 = 18 段，恰好铺满
    // [apex−45, apex]）。每段中心放一块四边形、段两侧各一条轮迹 ⇒ 每 apex 2×18 实例。
    const perApex = Math.floor(BRAKE_MARK_LEN / BRAKE_MARK_STEP);
    const total = apexes.length * perApex * 2;
    if (total === 0) return;

    // 基础四边形：PlaneGeometry 默认在 XY 面（法线 +Z），rotateX(−π/2) 翻到 XZ 面
    // （法线 +Y = up）。配合 makeBasis(right, up, tangent)：局部 X→right（宽 0.28）、
    // 局部 Z→tangent（长 2.5）、局部 Y→up（法线朝上）。
    const geo = new THREE.PlaneGeometry(BRAKE_MARK_WIDTH, BRAKE_MARK_STEP);
    geo.rotateX(-Math.PI / 2);
    this.geometries.push(geo);

    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.55,
      depthWrite: false
    });
    this.materials.push(mat);

    const marks = new THREE.InstancedMesh(geo, mat, total);
    marks.name = 'brake-marks';
    marks.castShadow = false;
    marks.receiveShadow = false;

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const one = new THREE.Vector3(1, 1, 1);
    const rv = new THREE.Vector3();
    const uv = new THREE.Vector3();
    const tv = new THREE.Vector3();
    const basis = new THREE.Matrix4();
    const col = new THREE.Color();
    let idx = 0;
    for (const apex of apexes) {
      for (let k = 0; k < perApex; k++) {
        // 段中心：apex−45 起、每 2.5m 一段（段 k 中心 = apex−45 + (k+0.5)*2.5）
        const sC = apex - BRAKE_MARK_LEN + (k + 0.5) * BRAKE_MARK_STEP;
        const f = track.at(sC);
        rv.set(f.right.x, f.right.y, f.right.z);
        uv.set(f.up.x, f.up.y, f.up.z);
        tv.set(f.tangent.x, f.tangent.y, f.tangent.z);
        basis.makeBasis(rv, uv, tv);
        q.setFromRotationMatrix(basis);
        // 渐隐：t=0（入口最浓）→ t=1（apex 最淡），instanceColor 灰度 0.15 → 0.75
        const t = perApex > 1 ? k / (perApex - 1) : 0;
        const g = 0.15 + t * 0.6;
        col.setRGB(g, g, g);
        for (const side of [-1, 1]) {
          p.set(
            f.center.x + f.right.x * side * BRAKE_MARK_LATERAL + f.up.x * BRAKE_MARK_LIFT,
            f.center.y + f.right.y * side * BRAKE_MARK_LATERAL + f.up.y * BRAKE_MARK_LIFT,
            f.center.z + f.right.z * side * BRAKE_MARK_LATERAL + f.up.z * BRAKE_MARK_LIFT
          );
          m.compose(p, q, one);
          marks.setMatrixAt(idx, m);
          marks.setColorAt(idx, col);
          idx++;
        }
      }
    }
    marks.instanceMatrix.needsUpdate = true;
    if (marks.instanceColor) marks.instanceColor.needsUpdate = true;
    marks.computeBoundingSphere();
    this.group.add(marks);
  }

  /**
   * V26 赛车线（racing line）：沿全赛道连续、随弯道「外-内-外」横向移动的
   * 轮胎磨痕带。
   *
   * 偏移（核心，纯曲率驱动、确定性）：沿全弧长每 RACE_STEP=2.5m 采样，原始偏移
   *   off = -sign(curvature) * RACE_CUTIN * min(1, |curv|/RACE_CURV_FULL)
   * （curv>0 左弯曲率中心在 −right ⇒ 切入弯内取负；curv<0 右弯取正），死区
   * |curv|<RACE_CURV_DEAD 内 off=0 压制直道曲率噪声的符号抖动；再环绕移动平均
   * （窗口 RACE_SMOOTH_WIN=9 样本 ≈22.5m、RACE_SMOOTH_PASS=3 遍，i=0 与 i=N-1
   * 相邻——闭环赛道）平滑成连续赛车线。
   *
   * 实例：每样本线中心 lateral=off[i]，两条带 at off[i]±RACE_BAND_OFF（±0.8m，
   * 与 V16 轮距一致），各放一块宽 RACE_BAND_W=0.28 × 长 RACE_STEP=2.5 的四边形
   * （PlaneGeometry.rotateX(−π/2) 法线 +Y，makeBasis(right, up, tangent) 局部 X→right
   * 宽、局部 Z→tangent 长、局部 Y→up 法线朝上），前后采样点衔接成连续磨痕带；
   * 抬升 RACE_LIFT=0.02 防 z-fighting。
   *
   * 走向：线中心 max|off|=2.6（满曲率）+ 带外缘 0.8+0.14=3.54 < 7（路面半宽）
   * ⇒ 赛车线始终在路面内，零穿模。
   *
   * 性能/合规：全部并入 1 个 InstancedMesh（1 DC / 1 材质 / 0 纹理）；
   * PlaneGeometry 每实例 2 tri（北环 8332 采样 = 16664 实例 / 33328 tri，
   * 南环 3098 采样 = 6196 实例 / 12392 tri）；不投影不接收阴影
   * （castShadow/receiveShadow=false）；depthWrite=false 防贴路面闪烁；
   * instanceColor 灰度随曲率加深（直道 0.32 → 急弯 0.18，读作「走线橡胶」）。
   */
  private buildRacingLine(): void {
    const track = getTrack();
    const L = track.length;
    const N = Math.floor(L / RACE_STEP);
    if (N < 2) return;

    // 1) 原始偏移：弯道切入弯内（curv>0 左弯曲率中心在 −right ⇒ offset 取负；
    //    curv<0 右弯取正），死区 |curv|<RACE_CURV_DEAD 内 off=0。⚠ at() 返回复用
    //    对象，这里只读 .curvature（number 拷贝），读完即用不跨循环保存 at() 结果。
    const raw = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const c = track.at(i * RACE_STEP).curvature;
      const ac = Math.abs(c);
      let off = 0;
      if (ac >= RACE_CURV_DEAD) {
        const k = Math.min(1, ac / RACE_CURV_FULL);
        off = (c > 0 ? -1 : 1) * RACE_CUTIN * k; // = -sign(c)*CUTIN*k
      }
      raw[i] = off;
    }

    // 2) 环绕移动平均（i=0 与 i=N-1 相邻——闭环赛道），RACE_SMOOTH_PASS 遍
    let off: Float64Array = raw;
    const hw = Math.floor(RACE_SMOOTH_WIN / 2);
    for (let pass = 0; pass < RACE_SMOOTH_PASS; pass++) {
      const next = new Float64Array(N);
      for (let i = 0; i < N; i++) {
        let sum = 0;
        for (let j = -hw; j <= hw; j++) {
          sum += off[(i + j + N) % N];
        }
        next[i] = sum / (2 * hw + 1);
      }
      off = next;
    }

    // 3) 每样本放两条带：线中心 lateral=off[i]，两条带 at off[i]±RACE_BAND_OFF
    const total = N * 2;
    const geo = new THREE.PlaneGeometry(RACE_BAND_W, RACE_STEP);
    geo.rotateX(-Math.PI / 2);
    this.geometries.push(geo);

    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: RACE_OPACITY,
      depthWrite: false
    });
    this.materials.push(mat);

    const marks = new THREE.InstancedMesh(geo, mat, total);
    marks.name = 'racing-line';
    marks.castShadow = false;
    marks.receiveShadow = false;

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const one = new THREE.Vector3(1, 1, 1);
    const rv = new THREE.Vector3();
    const uv = new THREE.Vector3();
    const tv = new THREE.Vector3();
    const basis = new THREE.Matrix4();
    const col = new THREE.Color();
    let idx = 0;
    for (let i = 0; i < N; i++) {
      const sC = i * RACE_STEP;
      const f = track.at(sC);
      // ⚠ at() 返回复用对象：center/right/up/tangent 必须在**下一次 at() 调用前**
      // 全部拷出到局部 Vector3，防被覆写（铁律#11）。
      const curv = f.curvature; // number 拷贝，读即用
      rv.set(f.right.x, f.right.y, f.right.z);
      uv.set(f.up.x, f.up.y, f.up.z);
      tv.set(f.tangent.x, f.tangent.y, f.tangent.z);
      basis.makeBasis(rv, uv, tv);
      q.setFromRotationMatrix(basis);
      // 走线越弯越浓（直道 0.32、急弯 0.18），读作「走线橡胶」
      const ac = Math.abs(curv);
      const k = Math.min(1, ac / RACE_CURV_FULL);
      const g = 0.32 - 0.14 * k;
      col.setRGB(g, g, g);
      for (const side of [-1, 1]) {
        p.set(
          f.center.x + f.right.x * (off[i] + side * RACE_BAND_OFF) + f.up.x * RACE_LIFT,
          f.center.y + f.right.y * (off[i] + side * RACE_BAND_OFF) + f.up.y * RACE_LIFT,
          f.center.z + f.right.z * (off[i] + side * RACE_BAND_OFF) + f.up.z * RACE_LIFT
        );
        m.compose(p, q, one);
        marks.setMatrixAt(idx, m);
        marks.setColorAt(idx, col);
        idx++;
      }
    }
    marks.instanceMatrix.needsUpdate = true;
    if (marks.instanceColor) marks.instanceColor.needsUpdate = true;
    marks.computeBoundingSphere();
    this.group.add(marks);
  }

  /**
   * V17 砾石缓冲带（gravel runoff）：弯道**外侧**路肩上的砾石跑偏区。
   *
   * 定位：复用 V16 buildBrakeMarks 的 apex 选择（|curv|>0.006 候选、按 |curv| 降序
   * 取前 8、间距 >700；北环 ≈6 / 南环 ≈4），保证每个砾石带与同弯刹车痕配套。每弯
   * 外侧沿弧长 [apex−30, apex+50]（出口跑偏区）、每 4m 一条横向 quad（沿 right 从
   * |lateral| 8.6 到 11.1，宽 2.5m），相邻块弧长衔接成连续砾石带。
   *
   * 弯道外侧判定（铁律）：`curvature>0`（左弯）曲率中心在 −right（车朝 +Z、右=+right、
   * 左弯曲率中心在左=−right）⇒ 外侧在 **+right**；`curvature<0`（右弯）⇒ 外侧在 −right。
   * 即 `outside = curvature > 0 ? +1 : -1`（× right 方向）。
   *
   * 贴地：每个 quad 的 4 顶点**顶点级**取土路肩表面高（shoulderY(|lateral|) + 抬 3cm，
   * 同 buildRibbon 路肩列同源），避免跨路肩坡度时 quad 悬空/埋地。⚠ 不用
   * Landscape.terrainPoint 的高程：已数值验证 terrainPoint 在该带恒低 0.088~0.340m
   * （在土路肩 ribbon 之下），贴它会把砾石埋入土路肩不可见；横向用 f.right（含 bank）
   * 与土路肩 ribbon 完全同框，边缘无缝对齐。抬升沿 up（路肩表面法向）⇒ 薄片贴面。
   *
   * 绕序：横向列按**增大 signed lateral** 排序（col0<col1），索引与 buildRibbon 同源
   * `[l0,l1,r0,r0,l1,r1]` ⇒ 法线 = cross(切向, 右向) = up 朝上（左右弯一致）。
   *
   * 性能/合规：全部并入 1 个 BufferGeometry（1 DC / 1 材质 / 0 纹理），每 quad 2 tri
   * （北环 6 弯 = 120 quad / 240 tri，南环 4 弯 = 80 quad / 160 tri）；顶点色微抖
   * （0.85..1.0 灰度，makeLcg 确定性）读作砾石颗粒，基色 0x8a8478 相乘；
   * castShadow=false / receiveShadow=true（贴地薄片，不投影）；|lateral| ∈ [8.6, 11.1]
   * 在路肩（8.4~11.6）内、护栏 11.2 内、无立柱/凸起 ⇒ 不构成新穿模（车可驶过，路肩跑偏区）。
   */
  private buildGravelRunoff(): void {
    const track = getTrack();
    // 弯道 apex 选择（与 V16 buildBrakeMarks 同源，保证砾石带与刹车痕同弯配套）
    const apexes = selectApexes(getCurrentMode()).map((p) => p.s);
    if (apexes.length === 0) return;

    // 每弯外侧采样段数（80m / 4m = 20 段，恰好铺满 [apex−30, apex+50]）
    const segsPerApex = Math.floor((GRAVEL_END - GRAVEL_START) / GRAVEL_STEP);
    const totalSegs = apexes.length * segsPerApex;
    if (totalSegs === 0) return;

    const pos = new Float32Array(totalSegs * 4 * 3);
    const col = new Float32Array(totalSegs * 4 * 3);
    const index: number[] = [];
    const random = makeLcg(0x9a9a9a); // 顶点色微抖（确定性）
    let vi = 0;

    for (const apex of apexes) {
      const fA = track.at(apex);
      // 弯道外侧符号：curvature>0（左弯）⇒ 外侧 +right；<0（右弯）⇒ −right
      const outside = fA.curvature > 0 ? 1 : -1;
      // 横向列按增大 signed lateral 排序（绕序朝上，左右弯一致）
      const lat0 = Math.min(outside * GRAVEL_INNER, outside * GRAVEL_OUTER);
      const lat1 = Math.max(outside * GRAVEL_INNER, outside * GRAVEL_OUTER);

      for (let k = 0; k < segsPerApex; k++) {
        const s0 = apex + GRAVEL_START + k * GRAVEL_STEP;
        const s1 = s0 + GRAVEL_STEP;
        const base = vi;
        // 4 顶点：s0/s1 × lat0/lat1，顶点级贴土路肩表面（shoulderY + LIFT，沿 up）
        const quads: ReadonlyArray<readonly [number, number]> = [
          [s0, lat0],
          [s0, lat1],
          [s1, lat0],
          [s1, lat1]
        ];
        for (const [si, lat] of quads) {
          const f = track.at(si);
          const hy = shoulderY(Math.abs(lat)) + GRAVEL_LIFT;
          pos[vi * 3] = f.center.x + f.right.x * lat + f.up.x * hy;
          pos[vi * 3 + 1] = f.center.y + f.right.y * lat + f.up.y * hy;
          pos[vi * 3 + 2] = f.center.z + f.right.z * lat + f.up.z * hy;
          // 顶点色微抖：0.85..1.0 灰度（读作砾石颗粒）
          const g = 0.85 + random() * 0.15;
          col[vi * 3] = g;
          col[vi * 3 + 1] = g;
          col[vi * 3 + 2] = g;
          vi++;
        }
        // 索引（buildRibbon 同源绕序朝上）：(s0,lat0),(s0,lat1),(s1,lat0),(s1,lat1)
        index.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(index);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    this.geometries.push(geo);

    const mat = new THREE.MeshStandardMaterial({
      color: GRAVEL_COLOR,
      roughness: 0.95,
      metalness: 0.02,
      vertexColors: true
    });
    this.materials.push(mat);

    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'gravel-runoff';
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  /**
   * V20 护栏广告横幅（guardrail banners）：贴在护栏双梁上的赞助横幅。
   *
   * 定位：
   *  - 起点直道 7 块（s=15/35/.../135 交替两侧，见 STRAIGHT_BANNERS）；
   *  - 每个弯道 apex 外侧护栏 1 块（s=apex+10 出口侧，外侧符号 = curvature>0 ? +1 : -1，
   *    与 V17 gravel 同源，保证横幅与同弯刹车痕/砾石配套）。
   * 弯道 apex 选择复用 buildBrakeMarks/buildGravelRunoff 逻辑（|curv|>0.006 候选、
   * 按 |curv| 降序取前 8、间距 >700；北环 6 / 南环 4）。
   *
   * 摆放：每块沿赛道局部系 makeBasis(right, up, tangent) 摆（长 4m 沿 tangent、
   * 高 0.5m 沿 up、厚 0.05m 沿 right），中心 = center + right*lateral + up*0.63
   * （覆盖双梁 0.43-0.83，读作"贴在护栏上的横幅"）。det(makeBasis)=+1 纯旋转，
   * 无反射（与 V16 brake marks 同源已数值验证）。
   *
   * 穿模（铁律）：|lateral| = 11.2、厚 0.05 ⇒ 内缘 11.175 > 11.106（护栏 11.2 +
   * 车半宽 1.006 走廊）clip-free；与 V12 反光片（lateral 11.10）横向错开 0.05m 净空
   * （反光片外缘 11.125 < 横幅内缘 11.175），起点直道反光片 s=12+20k 与横幅中心距
   * 3m（横幅半长 2 + 反光片半长 0.08 ⇒ 0.92m s 净空无重叠）；弯道最小中心距 2m ⇒
   * 仅 0.08m s 重叠但横向错开 0.05m，无 3D 相交。
   *
   * 朝向：横幅面朝赛道（法线朝 −right 侧即朝路心）；BoxGeometry 默认 UV 整幅映射
   * 到 ±X 面（长沿 u、高沿 v、flipY ⇒ 画布顶=横幅顶），两侧横幅文字左右可读性
   * 已用绕序核验（+right 侧 nx 面 u 沿 +tangent、−right 侧 px 面 u 沿 −tangent，
   * 均与驾驶员视向一致）。
   *
   * 性能/合规：全部并入 1 个 BufferGeometry（1 DC / 1 材质 / 1 纹理），每块 12 tri
   * （北环 13 块 = 156 tri / 南环 11 块 = 132 tri）；顶点色 0.88..1.0 明度微调区分块
   * （makeLcg 确定性）；castShadow=false / receiveShadow=false（与反光片同，
   * 贴护栏薄片不投影）。零外部资源。
   *
   * 已知微瑕疵：最紧弯（北环 apex 760 / 南环 apex 5280）横幅端部曲率半径小、
   * 弦矢高 > 横幅半厚 0.025 ⇒ 护栏梁在横幅最端 0.26m 内微凸出横幅面 ≈8mm
   * （读作护栏继续延伸过横幅，真实横幅均嵌于护栏、护栏边可见）；其余弯道 <0.8cm。
   */
  private buildGuardrailBanners(): void {
    const track = getTrack();
    // 弯道 apex 选择（与 buildBrakeMarks/buildGravelRunoff 同源，保证同弯配套）
    const apexes = selectApexes(getCurrentMode()).map((p) => p.s);

    // 摆放表：[s, lateral]
    const placements: [number, number][] = [];
    for (const [s, side] of STRAIGHT_BANNERS) placements.push([s, side * 11.2]);
    for (const apex of apexes) {
      const f = track.at(apex);
      const outside = f.curvature > 0 ? 1 : -1;
      placements.push([apex + 10, outside * 11.2]);
    }
    if (placements.length === 0) return;

    const tex = bannerTexture();
    this.textures.push(tex);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: tex,
      roughness: 0.72,
      metalness: 0.05,
      vertexColors: true // 顶点色乘贴图，微调各块明度
    });
    this.materials.push(mat);

    const random = makeLcg(0xb0b0b0); // 顶点色微抖（确定性）
    const panels: THREE.BufferGeometry[] = [];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const one = new THREE.Vector3(1, 1, 1);
    const rv = new THREE.Vector3();
    const uv3 = new THREE.Vector3();
    const tv = new THREE.Vector3();
    const basis = new THREE.Matrix4();
    for (const [s, lateral] of placements) {
      const f = track.at(s);
      rv.set(f.right.x, f.right.y, f.right.z);
      uv3.set(f.up.x, f.up.y, f.up.z);
      tv.set(f.tangent.x, f.tangent.y, f.tangent.z);
      basis.makeBasis(rv, uv3, tv);
      q.setFromRotationMatrix(basis);
      p.set(
        f.center.x + f.right.x * lateral + f.up.x * BANNER_Y,
        f.center.y + f.right.y * lateral + f.up.y * BANNER_Y,
        f.center.z + f.right.z * lateral + f.up.z * BANNER_Y
      );
      const geo = new THREE.BoxGeometry(BANNER_THICK, BANNER_HEIGHT, BANNER_LEN);
      geo.applyMatrix4(m.compose(p, q, one));
      // 顶点色明度（0.88..1.0，区分各块避免全部雷同）
      const bright = 0.88 + random() * 0.12;
      const n = geo.getAttribute('position').count;
      const colArr = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        colArr[i * 3] = bright;
        colArr[i * 3 + 1] = bright;
        colArr[i * 3 + 2] = bright;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(colArr, 3));
      panels.push(geo);
    }
    const geo = mergeSafe(panels);
    this.geometries.push(geo);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'guardrail-banners';
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    this.group.add(mesh);
  }

  /**
   * V21 弯道外侧轮胎墙（corner tire walls）：每弯 apex 外侧的堆叠轮胎缓冲墙。
   *
   * 定位：apex 选择与 buildGravelRunoff/buildGuardrailBanners 同源（|curv|>0.006 候选、
   * 按 |curv| 降序取前 8、间距 >700；北环 6 / 南环 4），外侧符号 = curvature>0 ? +1 : -1
   * （与 V17 gravel 同源），保证轮胎墙与同弯刹车痕/砾石/横幅配套。
   *
   * 摆放：每墙 6 列（沿 tangent，列距 0.62m，跨 apex±1.55m，含胎半径跨 ±1.87≈±1.9m）
   * × 3 行（沿 up 堆叠），中心 |lateral|=12.4（护栏 11.2 之外；轮胎内缘 12.4−0.32=12.08
   * > 11.106 车走廊 clip-free）。圆柱轴 = 局部 Y = up（轮胎平放堆叠）。
   *
   * 接地：逐列 terrainPoint(s_col, outside*12.4) 取地面点（|lateral|≤24 走廊起伏恒 0、
   * 平滑地面），第 k 行轮胎中心 = ground + up*(k*0.22+0.11)，即每列底胎正好坐地、
   * 墙随横倾（bank）微倾斜；跨墙 3 点采样差 = bank 坡度（北环最大 0.092m / 南环最大
   * 0.238m，见验证），逐列接地故不浮不陷。
   *
   * 性能/合规：1 个 InstancedMesh（1 DC / 1 材质 / 0 纹理），每胎 CylinderGeometry
   * (0.32,0.32,0.22,8) ≈ 32 tri（含上下盖）；北环 6×18=108 / 南环 4×18=72 实例；
   * instanceColor 列奇偶交替白 0xf0eee8/黑 0x1c1d20、每行轻微明度差（makeLcg 确定性）；
   * castShadow=false / receiveShadow=true。零外部资源。
   */
  private buildCornerTireWalls(): void {
    const track = getTrack();
    // 弯道 apex 选择（与 buildGravelRunoff 同源，保证同弯配套）
    const apexes = selectApexes(getCurrentMode()).map((p) => p.s);
    if (apexes.length === 0) return;

    const tireGeo = new THREE.CylinderGeometry(TIRE_RADIUS, TIRE_RADIUS, TIRE_HEIGHT, 8);
    this.geometries.push(tireGeo);
    const tireMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, // instanceColor 提供本色
      roughness: 0.85,
      metalness: 0.0
    });
    this.materials.push(tireMat);

    const total = apexes.length * TIRE_COLS * TIRE_ROWS;
    const tires = new THREE.InstancedMesh(tireGeo, tireMat, total);
    tires.name = 'corner-tire-walls';
    tires.castShadow = false;
    tires.receiveShadow = true;

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    const basis = new THREE.Matrix4();
    const rv = new THREE.Vector3();
    const uv3 = new THREE.Vector3();
    const tv = new THREE.Vector3();
    const ground = new THREE.Vector3();
    const pos = new THREE.Vector3();
    const col = new THREE.Color();
    const random = makeLcg(0x5e5e5e); // 每行明度微差（确定性）
    let idx = 0;

    for (const apex of apexes) {
      const fA = track.at(apex);
      const outside = fA.curvature > 0 ? 1 : -1;
      for (let c = 0; c < TIRE_COLS; c++) {
        const s = apex + (c - (TIRE_COLS - 1) / 2) * TIRE_COL_STEP;
        const f = track.at(s);
        terrainPoint(s, outside * TIRE_LATERAL, ground);
        rv.set(f.right.x, f.right.y, f.right.z);
        uv3.set(f.up.x, f.up.y, f.up.z);
        tv.set(f.tangent.x, f.tangent.y, f.tangent.z);
        basis.makeBasis(rv, uv3, tv);
        q.setFromRotationMatrix(basis);
        // 列奇偶交替白/黑基色
        const base = c % 2 === 0 ? TIRE_WHITE : TIRE_BLACK;
        for (let row = 0; row < TIRE_ROWS; row++) {
          const lift = row * TIRE_HEIGHT + TIRE_HEIGHT / 2;
          pos.set(
            ground.x + f.up.x * lift,
            ground.y + f.up.y * lift,
            ground.z + f.up.z * lift
          );
          m.compose(pos, q, one);
          tires.setMatrixAt(idx, m);
          // 每行轻微明度差（确定性），基色乘 0.9..1.02
          const bright = 0.9 + random() * 0.12;
          col.setHex(base);
          col.r = Math.min(1, col.r * bright);
          col.g = Math.min(1, col.g * bright);
          col.b = Math.min(1, col.b * bright);
          tires.setColorAt(idx, col);
          idx++;
        }
      }
    }

    tires.instanceMatrix.needsUpdate = true;
    if (tires.instanceColor) tires.instanceColor.needsUpdate = true;
    tires.computeBoundingSphere();
    this.group.add(tires);
  }

  /**
   * V21 弯道外侧旗语员岗亭（marshal posts）：每弯 apex 外侧出口侧的旗语员岗亭。
   *
   * 定位：apex 选择与 buildCornerTireWalls/buildGravelRunoff 同源；s=apex+30（出口侧）、
   * |lateral|=14.5（岗亭内缘 14.5−0.8=13.7 > 11.106 车走廊 clip-free），外侧符号同源。
   *
   * 摆放：岗亭小盒 1.6(沿 right)×1.8(高)×1.6(沿 tangent)，底 = terrainPoint(s,
   * outside*14.5).y；顶加平屋顶盒 1.8×0.15×1.8（深色，四边各挑 0.1m）；旗杆圆柱
   * r=0.04 h=3m 6 段立岗亭旁（沿 right 向外偏 1.2m ⇒ 杆在 15.7，底贴地）；旗小盒
   * 0.02×0.5×0.9 挂杆顶（沿 tangent 伸出 0.9m，亮黄 0xd9b23a）。全部沿赛道局部系
   * makeBasis(right, up, tangent) 摆（det=+1 纯旋转无反射）。
   *
   * 接地：逐部件 terrainPoint 取地面点（岗亭 14.5 / 杆 15.7），|lateral|≤24 走廊起伏
   * 恒 0、平滑地面，沿 up 抬升 ⇒ 底贴地不浮不陷。
   *
   * 性能/合规：全部 mergeSafe 为 1 BufferGeometry（1 DC / 1 材质 / 0 纹理），各部件
   * 手动写顶点色（岗亭石色、屋顶深色、杆灰、旗亮黄）；每岗 60 tri（盒 12×2 + 杆 24
   * + 旗 12）；castShadow=false / receiveShadow=true。零外部资源。⚠ 不 import 私有
   * paintGeo，顶点色按 V20 L990-999 同法手写。
   */
  private buildMarshalPosts(): void {
    const track = getTrack();
    // 弯道 apex 选择（与 buildCornerTireWalls 同源）
    const apexes = selectApexes(getCurrentMode()).map((p) => p.s);
    if (apexes.length === 0) return;

    const parts: THREE.BufferGeometry[] = [];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    const basis = new THREE.Matrix4();
    const rv = new THREE.Vector3();
    const uv3 = new THREE.Vector3();
    const tv = new THREE.Vector3();
    const ground = new THREE.Vector3();
    const pos = new THREE.Vector3();

    // 部件并入合并 mesh：applyMatrix4 后按部件色手写顶点色（V20 同法）
    const addPart = (geo: THREE.BufferGeometry, color: number): void => {
      geo.applyMatrix4(m);
      const n = geo.getAttribute('position').count;
      const c = new THREE.Color(color);
      const colArr = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        colArr[i * 3] = c.r;
        colArr[i * 3 + 1] = c.g;
        colArr[i * 3 + 2] = c.b;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(colArr, 3));
      parts.push(geo);
    };

    for (const apex of apexes) {
      const fA = track.at(apex);
      const outside = fA.curvature > 0 ? 1 : -1;
      const s = apex + MARSHAL_S_OFFSET;
      const f = track.at(s);
      terrainPoint(s, outside * MARSHAL_LATERAL, ground);
      rv.set(f.right.x, f.right.y, f.right.z);
      uv3.set(f.up.x, f.up.y, f.up.z);
      tv.set(f.tangent.x, f.tangent.y, f.tangent.z);
      basis.makeBasis(rv, uv3, tv);
      q.setFromRotationMatrix(basis);

      // 岗亭盒（1.6×1.8×1.6，底贴地，中心抬 0.9）
      pos.set(ground.x + f.up.x * 0.9, ground.y + f.up.y * 0.9, ground.z + f.up.z * 0.9);
      m.compose(pos, q, one);
      addPart(new THREE.BoxGeometry(1.6, 1.8, 1.6), MARSHAL_HUT_COLOR);

      // 平屋顶盒（1.8×0.15×1.8，座于 1.8 高，中心抬 1.875）
      pos.set(
        ground.x + f.up.x * 1.875,
        ground.y + f.up.y * 1.875,
        ground.z + f.up.z * 1.875
      );
      m.compose(pos, q, one);
      addPart(new THREE.BoxGeometry(1.8, 0.15, 1.8), MARSHAL_ROOF_COLOR);

      // 旗杆（沿 right 向外偏 1.2m ⇒ 杆在 15.7，底贴地，中心抬 1.5）
      const poleGnd = new THREE.Vector3();
      terrainPoint(s, outside * (MARSHAL_LATERAL + MARSHAL_POLE_OFF), poleGnd);
      pos.set(
        poleGnd.x + f.up.x * 1.5,
        poleGnd.y + f.up.y * 1.5,
        poleGnd.z + f.up.z * 1.5
      );
      m.compose(pos, q, one);
      addPart(new THREE.CylinderGeometry(0.04, 0.04, 3, 6), MARSHAL_POLE_COLOR);

      // 旗（挂杆顶，沿 tangent 伸出 0.9m；中心抬 2.75、tangent 偏 0.45）
      pos.set(
        poleGnd.x + f.up.x * 2.75 + f.tangent.x * 0.45,
        poleGnd.y + f.up.y * 2.75 + f.tangent.y * 0.45,
        poleGnd.z + f.up.z * 2.75 + f.tangent.z * 0.45
      );
      m.compose(pos, q, one);
      addPart(new THREE.BoxGeometry(0.02, 0.5, 0.9), MARSHAL_FLAG_COLOR);
    }

    const geo = mergeSafe(parts);
    this.geometries.push(geo);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff, // 顶点色提供本色
      roughness: 0.8,
      metalness: 0.05,
      vertexColors: true
    });
    this.materials.push(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'corner-marshal-posts';
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  /**
   * V22 制动距离牌（braking distance boards）：每弯 apex 入口外侧的 100/50/25m
   * 接近提示牌。
   *
   * 定位：apex 选择与 buildGravelRunoff 同源（|curv|>0.006 候选、按 |curv| 降序
   * 取前 8、间距 >700；北环 6 / 南环 4），外侧符号 = curvature>0 ? +1 : -1
   * （与 V17 gravel 同源），保证制动牌与同弯刹车痕/砾石/横幅/轮胎墙配套。
   *
   * 摆放：每 apex 在入口侧 s=apex−100/−50/−25 各 1 块，板中心 |lateral|=12.8
   * （护栏 11.2 之外；板内缘 12.8−0.6=12.2 > 11.106 车走廊 clip-free）。板
   * BoxGeometry(1.2 沿 right, 0.8 沿 up, 0.06 沿 tangent)，沿 makeBasis(right, up,
   * tangent) 摆（det=+1 纯旋转无反射），中心 = terrainPoint(s, outside*12.8) +
   * up*(POST_H + H/2)（底坐立柱顶、立柱底贴地）。板下方 2 立柱（0.08×0.08×1.2 灰，
   * 沿 right ±0.4，立柱底贴地、顶接板底）。
   *
   * 贴图：1 张 384×128 三格 canvasTexture（左「100」、中「50」、右「25」，白底 +
   * 黑数字 + 黑细边框）。UV 重映射把 ±Z 面（pz=idx16-19、nz=idx20-23，前后两大面）
   * 的 u 从 [0,1] 映射到对应数字格（100→[0,1/3]、50→[1/3,2/3]、25→[2/3,1]）；
   * 已数值验证朝来车面（nz，−tangent）数字读正非镜像（nz 面 u=0 在局部 +X=+right、
   * 驾驶员 screen_right=−right ⇒ u=0 落屏幕左、u=1 落屏幕右，与贴图左→右一致）。
   * 板侧/顶/底缘（px/nx/py/ny，idx0-15）与立柱 UV 全部映射到数字格顶部白边
   * （v=0.85，纯白）⇒ 边缘白、灰柱×白贴图=干净灰柱。
   *
   * 性能/合规：全部 mergeSafe 为 1 BufferGeometry（1 DC / 1 材质 / 1 贴图）；每牌
   * 12 tri + 2 立柱×12 tri = 36 tri，3 牌/apex × 10 apex = 30 牌 ≈ 1080 tri；板顶点
   * 色白、立柱顶点色灰（手动写，V20 同法）；castShadow=false / receiveShadow=true；
   * 零外部资源。
   */
  private buildBrakeBoards(): void {
    const track = getTrack();
    // 弯道 apex 选择（与 buildGravelRunoff 同源，保证同弯配套）
    const apexes = selectApexes(getCurrentMode()).map((p) => p.s);
    if (apexes.length === 0) return;

    const tex = brakeBoardTexture();
    this.textures.push(tex);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: tex,
      roughness: 0.6,
      metalness: 0.03,
      vertexColors: true // 板白 / 立柱灰，贴图提供数字
    });
    this.materials.push(mat);

    const parts: THREE.BufferGeometry[] = [];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    const basis = new THREE.Matrix4();
    const rv = new THREE.Vector3();
    const uv3 = new THREE.Vector3();
    const tv = new THREE.Vector3();
    const ground = new THREE.Vector3();
    const pos = new THREE.Vector3();

    // 顶点色写（V20 同法）：色数组长度 = 顶点数
    const paintColor = (geo: THREE.BufferGeometry, color: number): void => {
      const n = geo.getAttribute('position').count;
      const c = new THREE.Color(color);
      const colArr = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        colArr[i * 3] = c.r;
        colArr[i * 3 + 1] = c.g;
        colArr[i * 3 + 2] = c.b;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(colArr, 3));
    };

    // 数字格横向分带：100→[0,1/3]、50→[1/3,2/3]、25→[2/3,1]
    const cellSpan = 1 / 3;
    // 白边采样点（数字格顶部边框内、数字上方，纯白）：灰×白=灰柱 / 板缘纯白
    const WHITE_V = 0.85;

    for (const apex of apexes) {
      const fA = track.at(apex);
      const outside = fA.curvature > 0 ? 1 : -1;
      for (let k = 0; k < BRAKEBOARD_MARKERS.length; k++) {
        const marker = BRAKEBOARD_MARKERS[k];
        const s = apex - marker;
        const f = track.at(s);
        terrainPoint(s, outside * BRAKEBOARD_LATERAL, ground);
        rv.set(f.right.x, f.right.y, f.right.z);
        uv3.set(f.up.x, f.up.y, f.up.z);
        tv.set(f.tangent.x, f.tangent.y, f.tangent.z);
        basis.makeBasis(rv, uv3, tv);
        q.setFromRotationMatrix(basis);

        const cellStart = k * cellSpan;
        const cellEnd = cellStart + cellSpan;

        // 板：中心 = ground + up*(POST_H + H/2)，底坐立柱顶
        pos.set(
          ground.x + f.up.x * (BRAKEBOARD_POST_H + BRAKEBOARD_H / 2),
          ground.y + f.up.y * (BRAKEBOARD_POST_H + BRAKEBOARD_H / 2),
          ground.z + f.up.z * (BRAKEBOARD_POST_H + BRAKEBOARD_H / 2)
        );
        const boardGeo = new THREE.BoxGeometry(BRAKEBOARD_W, BRAKEBOARD_H, BRAKEBOARD_T);
        // UV：±Z 面（pz=idx16-19、nz=idx20-23）u → 数字格；板缘（idx0-15）→ 白边
        const bUv = boardGeo.getAttribute('uv');
        for (let vi = 0; vi < 24; vi++) {
          if (vi >= 16) {
            const u = bUv.getX(vi);
            bUv.setX(vi, cellStart + u * (cellEnd - cellStart));
          } else {
            bUv.setXY(vi, cellStart + 0.5, WHITE_V);
          }
        }
        bUv.needsUpdate = true;
        m.compose(pos, q, one);
        boardGeo.applyMatrix4(m);
        paintColor(boardGeo, 0xffffff);
        parts.push(boardGeo);

        // 2 立柱（0.08×0.08×1.2 灰，沿 right ±0.4，底贴地、顶接板底）
        for (const off of [-BRAKEBOARD_POST_OFF, BRAKEBOARD_POST_OFF]) {
          const postGeo = new THREE.BoxGeometry(
            BRAKEBOARD_POST_T,
            BRAKEBOARD_POST_H,
            BRAKEBOARD_POST_T
          );
          const pUv = postGeo.getAttribute('uv');
          for (let vi = 0; vi < pUv.count; vi++) {
            pUv.setXY(vi, cellStart + 0.5, WHITE_V); // 白边采样 ⇒ 干净灰柱
          }
          pUv.needsUpdate = true;
          pos.set(
            ground.x + f.right.x * off + f.up.x * (BRAKEBOARD_POST_H / 2),
            ground.y + f.right.y * off + f.up.y * (BRAKEBOARD_POST_H / 2),
            ground.z + f.right.z * off + f.up.z * (BRAKEBOARD_POST_H / 2)
          );
          m.compose(pos, q, one);
          postGeo.applyMatrix4(m);
          paintColor(postGeo, BRAKEBOARD_POST_COLOR);
          parts.push(postGeo);
        }
      }
    }

    const geo = mergeSafe(parts);
    this.geometries.push(geo);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'brake-boards';
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  /**
   * V24 直道检测：扫描 s（步 10m），找 |curvature| < HOARD_STRAIGHT_CURV 的连续
   * 跨度 ≥ HOARD_STRAIGHT_MIN_LEN 的段（直道），按跨度降序取最长 HOARD_STRAIGHT_MAX
   * 段。若无严格直道命中（如南环：|κ|<0.0004 最长连续仅 390m < 600m），兜底放宽
   * 阈值至 HOARD_FALLBACK_CURV 取最长近直段（≥ HOARD_FALLBACK_MIN_LEN）—— 替代规范
   * 字面 s=17000 兜底（其南环取模落 1506，位于弯道过渡区，若照字面会放弯上；北环
   * Döttinger Höhe 已由严格直道命中，兜底不触发，与规范意图一致）。
   */
  private findStraightSpans(L: number): [number, number][] {
    const track = getTrack();
    const collect = (thresh: number, minLen: number): { s0: number; s1: number }[] => {
      const runs: { s0: number; s1: number }[] = [];
      let runStart: number | null = null;
      for (let s = 0; s <= L; s += HOARD_SCAN_STEP) {
        const straight = Math.abs(track.at(s).curvature) < thresh;
        if (straight) {
          if (runStart === null) runStart = s;
        } else if (runStart !== null) {
          if (s - runStart >= minLen) runs.push({ s0: runStart, s1: s });
          runStart = null;
        }
      }
      // 闭合赛道：末段直道延伸至 s=L（=起点）也计入
      if (runStart !== null && L - runStart >= minLen) runs.push({ s0: runStart, s1: L });
      return runs;
    };

    let runs = collect(HOARD_STRAIGHT_CURV, HOARD_STRAIGHT_MIN_LEN);
    if (runs.length === 0) {
      const relaxed = collect(HOARD_FALLBACK_CURV, HOARD_FALLBACK_MIN_LEN);
      if (relaxed.length === 0) return [];
      runs = [relaxed.reduce((a, b) => (b.s1 - b.s0 > a.s1 - a.s0 ? b : a))];
    }
    runs.sort((a, b) => b.s1 - b.s0 - (a.s1 - a.s0));
    return runs.slice(0, HOARD_STRAIGHT_MAX).map((r) => [r.s0, r.s1]);
  }

  /**
   * V24 直道赞助广告挡墙（straight sponsor hoardings）：护栏后草地上的广告挡墙。
   *
   * 定位：findStraightSpans 取最长 2-3 段长直道（北环 Döttinger Höhe [16260,19310]
   * ≈3.05km + [13070,13710] ≈640m；南环无严格直道，兜底取 [5680,6330] 最长近直段）。
   * 每段沿两侧（±HOARD_LATERAL 交错：40m 步进交替两侧 ⇒ 每侧每 80m 一块）摆放。
   *
   * 摆放：每块沿赛道局部系 makeBasis(right, up, tangent) 摆（det=+1 纯旋转无反射），
   * 板 BoxGeometry(0.15 沿 right × 2.0 沿 up × 6.0 沿 tangent)，中心 = terrainPoint(s,
   * ±12.5) + up*1.0（板底贴地、中心抬 1.0）；板下两侧 2 立柱（0.1×0.1×2.0 灰，沿
   * tangent ±2.8、底贴地、与板同高）。terrainPoint 在 |lateral|=12.5 ≤ 24 ⇒ 起伏门控
   * 恒 0、平滑地面（仅 bank 近场跟随 + PROFILE 缓降 −0.39m），板底贴地不浮不陷。
   *
   * 穿模（铁律）：|lateral|=12.5、板厚 0.15 ⇒ 板内缘 12.5−0.075=12.425 > 11.106 车走廊
   * clip-free；立柱沿 tangent 不增 lateral ⇒ 内缘 12.5−0.05=12.45 > 11.106。与 V20 横幅
   * （11.2 贴护栏）、V21 轮胎墙（12.4 @弯道外侧）、里程牌（13.2，s=i*1000+30）均不同
   * lateral/s：挡墙在直道（V21 在弯道），与里程牌横向错开 0.7m 净空；直道内里程牌 s 与
   * 板 s 距离 <5m 时跳过该板（HOARD_KM_CLEAR），避免视觉叠读。
   *
   * 朝向：板面法线朝路心（±X 面，与 V20 同源）。BoxGeometry 默认 UV 整幅映射到 ±X 面
   * （长沿 u、高沿 v、flipY ⇒ 画布顶=板顶）。已数值验证（BoxGeometry UV 逐顶点 + 驾驶员
   * screen-right = view_dir × up）：+right 侧 nx 面 u 沿 +tangent、−right 侧 px 面 u 沿
   * −tangent，两例 screen-right 均 = +u 方向 ⇒ 文字在朝赛道面读正非镜像。
   *
   * 性能/合规：全部 mergeSafe 为 1 BufferGeometry（1 DC / 1 材质 / 1 贴图），每块
   * 12 tri（板）+ 2×12 tri（立柱）= 36 tri（北环 2 段 ≈35 块 ≈1260 tri）；板顶点色白、
   * 立柱顶点色灰（手动写，V20 同法）；castShadow=false / receiveShadow=true；零外部资源。
   */
  private buildStraightHoardings(): void {
    const track = getTrack();
    const L = track.length;

    // 直道检测（最长 2-3 段）
    const spans = this.findStraightSpans(L);
    if (spans.length === 0) return;

    // 里程牌 s 表（每 1000m 一根，s=i*1000+30，与 Scenery.buildMarkers 同源）
    const kmSigns: number[] = [];
    for (let i = 0; i < Math.floor(L / 1000); i++) kmSigns.push(i * 1000 + 30);

    // 摆放表：[s, signed lateral]，40m 步进两侧交错（每侧每 80m 一块）
    const placements: [number, number][] = [];
    for (const [s0, s1] of spans) {
      const len = s1 - s0;
      const usable = Math.max(0, len - 80); // 端部 40m 让位（不入弯）
      const count = Math.min(HOARD_MAX_PER_SEG, Math.floor(usable / HOARD_PITCH) + 1);
      const span = (count - 1) * HOARD_PITCH;
      const start = s0 + (len - span) / 2; // 居中摆放
      for (let k = 0; k < count; k++) {
        const s = start + k * HOARD_PITCH;
        // 里程牌让位：板 s 与里程牌 s 距离 <5m 则跳过（避免视觉叠读）
        if (kmSigns.some((ks) => Math.abs(s - ks) < HOARD_KM_CLEAR)) continue;
        placements.push([s, (k % 2 === 0 ? 1 : -1) * HOARD_LATERAL]);
      }
    }
    if (placements.length === 0) return;

    const tex = hoardingTexture();
    this.textures.push(tex);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: tex,
      roughness: 0.72,
      metalness: 0.05,
      vertexColors: true // 板白 / 立柱灰，贴图提供赞助内容
    });
    this.materials.push(mat);

    const parts: THREE.BufferGeometry[] = [];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    const basis = new THREE.Matrix4();
    const rv = new THREE.Vector3();
    const uv3 = new THREE.Vector3();
    const tv = new THREE.Vector3();
    const ground = new THREE.Vector3();
    const pos = new THREE.Vector3();

    // 顶点色写（V20 同法）：色数组长度 = 顶点数
    const paintColor = (geo: THREE.BufferGeometry, color: number): void => {
      const n = geo.getAttribute('position').count;
      const c = new THREE.Color(color);
      const colArr = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        colArr[i * 3] = c.r;
        colArr[i * 3 + 1] = c.g;
        colArr[i * 3 + 2] = c.b;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(colArr, 3));
    };

    for (const [s, lateral] of placements) {
      const f = track.at(s);
      terrainPoint(s, lateral, ground);
      rv.set(f.right.x, f.right.y, f.right.z);
      uv3.set(f.up.x, f.up.y, f.up.z);
      tv.set(f.tangent.x, f.tangent.y, f.tangent.z);
      basis.makeBasis(rv, uv3, tv);
      q.setFromRotationMatrix(basis);

      // 板：0.15(沿 right)×2.0(沿 up)×6.0(沿 tangent)，中心 = ground + up*1.0（板底贴地）
      pos.set(
        ground.x + f.up.x * (HOARD_HEIGHT / 2),
        ground.y + f.up.y * (HOARD_HEIGHT / 2),
        ground.z + f.up.z * (HOARD_HEIGHT / 2)
      );
      m.compose(pos, q, one);
      const boardGeo = new THREE.BoxGeometry(HOARD_THICK, HOARD_HEIGHT, HOARD_LEN);
      boardGeo.applyMatrix4(m);
      paintColor(boardGeo, 0xffffff);
      parts.push(boardGeo);

      // 2 立柱（0.1×0.1×2.0 灰，沿 tangent ±2.8，底贴地、与板同高）
      for (const off of [-HOARD_POST_OFF, HOARD_POST_OFF]) {
        const postGeo = new THREE.BoxGeometry(HOARD_POST_T, HOARD_POST_H, HOARD_POST_T);
        // 立柱 UV 采样贴图纯白预留区 ⇒ 灰×白=干净灰柱
        const pUv = postGeo.getAttribute('uv');
        for (let vi = 0; vi < pUv.count; vi++) {
          pUv.setXY(vi, HOARD_POST_UV[0], HOARD_POST_UV[1]);
        }
        pUv.needsUpdate = true;
        pos.set(
          ground.x + f.tangent.x * off + f.up.x * (HOARD_POST_H / 2),
          ground.y + f.tangent.y * off + f.up.y * (HOARD_POST_H / 2),
          ground.z + f.tangent.z * off + f.up.z * (HOARD_POST_H / 2)
        );
        m.compose(pos, q, one);
        postGeo.applyMatrix4(m);
        paintColor(postGeo, HOARD_POST_COLOR);
        parts.push(postGeo);
      }
    }

    const geo = mergeSafe(parts);
    this.geometries.push(geo);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'straight-hoardings';
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  /**
   * V28 赛道赞助龙门架（sponsor gantry）：横跨赛道的广告龙门架（北环满 2 座，
   * 南环按扫描取 0-1 座）——真实赛道的标志性元素，车手从架下穿过、远处极醒目。
   *
   * 定位（仿 V24 findStraightSpans）：扫描 s 步 10m，收集 |curv|<0.003 的连续近直段
   * （跨度 ≥150m），按跨度降序取前 GANTRY_COUNT，排除与既有结构重叠的候选（起点
   * s<500、观赛点/弯道 apex 距 <120m、V24 挡墙段距 <60m），落点 = 段中心。北环命中
   * 2 座（长直道）；南环（更短、直道更少）按设计上限 1 座。
   *
   * 摆放：每座 = 左右立柱（0.5×6.5×0.5，底贴地，|lateral|=11.5）+ 横梁（23×0.6×0.5，
   * 跨 ±11.5，梁 5.8-6.4）+ 赞助板（11×1.8×0.18，板 4.6-6.4 悬梁下、朝来车双面 UV）。
   * 全部沿 makeBasis(right, up, tangent) 摆（det=+1 纯旋转无反射），中心 =
   * terrainPoint + up*（半高/基座+半高）。
   *
   * 穿模（铁律）：立柱内缘 11.5−0.25=11.25 > 11.106 车走廊 clip-free；横梁/赞助板
   * 悬空 y≥4.6 > 车高 1.4m（净空 3.2m）⇒ 零穿模。已数值验证三落点 right.y=0
   * （bank 恒 0），柱顶与梁端共面无错位。
   *
   * 贴图：1 张 1024×256 gantryTexture（深炭 + GELLHORN + 多彩块）。±Z 面（板
   * pz=idx16-19、nz=idx20-23）UV 默认 [0,1]×[0,1] 贴图全幅；板缘（idx0-15）与柱/梁
   * UV→(0.5,0.9) 白区采样（灰×白=干净深灰）。已数值验证 ±tangent 两朝来车面 u 沿
   * ∓tangent、screen-right=+u ⇒ 文字读正非镜像；v=1=画布顶（flipY）。
   *
   * 性能/合规：全部 mergeSafe 为 1 BufferGeometry（1 DC / 1 材质 / 1 贴图）；每座
   * 柱 2×12 + 梁 12 + 板 12 = 48 tri（北环 2 座 ≈96 tri）；castShadow=false /
   * receiveShadow=false；零外部资源。
   */
  private buildGantries(): void {
    const track = getTrack();
    const L = track.length;
    const isNorth = L > 15000;

    // 观赛点（北环 Brünnchen/Aremberg/Schwalbenschwanz、南环 Müllenbach，V13 同源）
    const spectators = isNorth ? [6400, 18250, 19700] : [3505];
    // V24 挡墙段（北环 Döttinger Höhe + [13070,13710]、南环 [5680,6330]）
    const hoardSegs: [number, number][] = isNorth
      ? [
          [16260, 19310],
          [13070, 13710]
        ]
      : [[5680, 6330]];

    // 弯道 apex（与 buildBrakeBoards 同源：|curv|>0.006、按 |curv| 降序取前 8、间距 >700）
    const apexes: number[] = [];
    const cand: { s: number; c: number }[] = [];
    for (let s = 300; s < L - 300; s += GANTRY_SCAN_STEP) {
      const c = Math.abs(track.at(s).curvature);
      if (c > 0.006) cand.push({ s, c });
    }
    cand.sort((a, b) => b.c - a.c);
    for (const { s } of cand) {
      if (apexes.length >= 8) break;
      if (apexes.every((v) => Math.abs(v - s) > 700)) apexes.push(s);
    }

    // 近直段扫描（仿 findStraightSpans）：收集 |curv|<0.003 连续段（≥150m）
    const runs: { s0: number; s1: number }[] = [];
    let runStart: number | null = null;
    for (let s = 0; s <= L; s += GANTRY_SCAN_STEP) {
      const straight = Math.abs(track.at(s).curvature) < GANTRY_STRAIGHT_CURV;
      if (straight) {
        if (runStart === null) runStart = s;
      } else if (runStart !== null) {
        if (s - runStart >= GANTRY_MIN_SPAN) runs.push({ s0: runStart, s1: s });
        runStart = null;
      }
    }
    if (runStart !== null && L - runStart >= GANTRY_MIN_SPAN) runs.push({ s0: runStart, s1: L });
    runs.sort((a, b) => b.s1 - b.s0 - (a.s1 - a.s0));

    // 排除与既有结构重叠的候选，按跨度降序取前 N（北环满 GANTRY_COUNT；南环按设计 0-1）
    const maxCount = isNorth ? GANTRY_COUNT : 1;
    const placements: number[] = [];
    for (const r of runs) {
      if (placements.length >= maxCount) break;
      if (r.s0 < 500) continue; // 起点区（已有 buildGate）
      if (spectators.some((sp) => r.s1 > sp - GANTRY_CLEAR && r.s0 < sp + GANTRY_CLEAR)) continue;
      if (apexes.some((ap) => r.s1 > ap - GANTRY_CLEAR && r.s0 < ap + GANTRY_CLEAR)) continue;
      if (hoardSegs.some(([a, b]) => r.s1 > a - GANTRY_HOARD_CLEAR && r.s0 < b + GANTRY_HOARD_CLEAR)) continue;
      placements.push(r.s0 + (r.s1 - r.s0) / 2);
    }
    if (placements.length === 0) return;

    const tex = gantryTexture();
    this.textures.push(tex);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: tex,
      roughness: 0.6,
      metalness: 0.05,
      vertexColors: true // 柱/梁深灰 / 板白，贴图提供赞助内容
    });
    this.materials.push(mat);

    const parts: THREE.BufferGeometry[] = [];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    const basis = new THREE.Matrix4();
    const rv = new THREE.Vector3();
    const uv3 = new THREE.Vector3();
    const tv = new THREE.Vector3();
    const ground = new THREE.Vector3();
    const pos = new THREE.Vector3();

    // 顶点色写（V20 同法）：色数组长度 = 顶点数
    const paintColor = (geo: THREE.BufferGeometry, color: number): void => {
      const n = geo.getAttribute('position').count;
      const c = new THREE.Color(color);
      const colArr = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        colArr[i * 3] = c.r;
        colArr[i * 3 + 1] = c.g;
        colArr[i * 3 + 2] = c.b;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(colArr, 3));
    };

    for (const s of placements) {
      // 铁律：at() 返回复用对象，先拷出 right/up/tangent 再调 terrainPoint（内部也调 at()）
      const f = track.at(s);
      rv.set(f.right.x, f.right.y, f.right.z);
      uv3.set(f.up.x, f.up.y, f.up.z);
      tv.set(f.tangent.x, f.tangent.y, f.tangent.z);
      basis.makeBasis(rv, uv3, tv);
      q.setFromRotationMatrix(basis);

      // 立柱 ×2（0.5×6.5×0.5，中心 = terrainPoint(s,±11.5) + up*3.25，底贴地）
      for (const side of [-1, 1]) {
        terrainPoint(s, side * GANTRY_COL_LAT, ground);
        pos.set(
          ground.x + uv3.x * (GANTRY_COL_H / 2),
          ground.y + uv3.y * (GANTRY_COL_H / 2),
          ground.z + uv3.z * (GANTRY_COL_H / 2)
        );
        const colGeo = new THREE.BoxGeometry(GANTRY_COL_W, GANTRY_COL_H, GANTRY_COL_W);
        const colUv = colGeo.getAttribute('uv');
        for (let vi = 0; vi < colUv.count; vi++) colUv.setXY(vi, 0.5, GANTRY_WHITE_V);
        colUv.needsUpdate = true;
        m.compose(pos, q, one);
        colGeo.applyMatrix4(m);
        paintColor(colGeo, GANTRY_COL_COLOR);
        parts.push(colGeo);
      }

      // 横梁（23×0.6×0.5，中心 = terrainPoint(s,0) + up*6.1，梁 5.8-6.4）
      terrainPoint(s, 0, ground);
      pos.set(
        ground.x + uv3.x * (GANTRY_BEAM_Y + GANTRY_BEAM_H / 2),
        ground.y + uv3.y * (GANTRY_BEAM_Y + GANTRY_BEAM_H / 2),
        ground.z + uv3.z * (GANTRY_BEAM_Y + GANTRY_BEAM_H / 2)
      );
      const beamGeo = new THREE.BoxGeometry(GANTRY_BEAM_W, GANTRY_BEAM_H, GANTRY_BEAM_T);
      const beamUv = beamGeo.getAttribute('uv');
      for (let vi = 0; vi < beamUv.count; vi++) beamUv.setXY(vi, 0.5, GANTRY_WHITE_V);
      beamUv.needsUpdate = true;
      m.compose(pos, q, one);
      beamGeo.applyMatrix4(m);
      paintColor(beamGeo, GANTRY_COL_COLOR);
      parts.push(beamGeo);

      // 赞助板（11×1.8×0.18，中心 = terrainPoint(s,0) + up*5.5，板 4.6-6.4 悬梁下）
      terrainPoint(s, 0, ground);
      pos.set(
        ground.x + uv3.x * (GANTRY_BOARD_Y + GANTRY_BOARD_H / 2),
        ground.y + uv3.y * (GANTRY_BOARD_Y + GANTRY_BOARD_H / 2),
        ground.z + uv3.z * (GANTRY_BOARD_Y + GANTRY_BOARD_H / 2)
      );
      const boardGeo = new THREE.BoxGeometry(GANTRY_BOARD_W, GANTRY_BOARD_H, GANTRY_BOARD_T);
      const bUv = boardGeo.getAttribute('uv');
      for (let vi = 0; vi < 24; vi++) {
        // ±Z 面（idx16-23）默认 UV [0,1]×[0,1] 贴图全幅保留；板缘（idx0-15）→白区
        if (vi < 16) bUv.setXY(vi, 0.5, GANTRY_WHITE_V);
      }
      bUv.needsUpdate = true;
      m.compose(pos, q, one);
      boardGeo.applyMatrix4(m);
      paintColor(boardGeo, 0xffffff);
      parts.push(boardGeo);
    }

    const geo = mergeSafe(parts);
    this.geometries.push(geo);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'gantries';
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    this.group.add(mesh);
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const mt of this.materials) mt.dispose();
    for (const t of this.textures) t.dispose();
    this.group.removeFromParent();
  }
}
