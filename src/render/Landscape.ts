/**
 * 纽北 · 横向剖面地形带（一个 Mesh / 一个材质）+ 地形采样纯函数
 *
 * 断面列（局部横向 x，单位 m）：
 *   [-1400, -800, -420, -220, -120, -60, -24, -8, 8, 24, 60, 120, 220, 420, 800, 1400]
 * 高程（相对路面中心平面）：
 *   |x|=8   −0.38  ← 低于土路肩外缘（−0.35），保证 3.2m 土带完整可见
 *   |x|=24  −0.45 ；60 −1.2 ；120 −2.2 ；220 −3.6 ；420 −7.0 ；800 −18 ；1400 −40
 *   |x| ∈ (60, 1400] 叠加低频起伏（振幅 0.8~18m，spec A2 中/远场滚动；沿弧长取周期函数
 *   ⇒ 闭合无接缝）；|x| ∈ (40, 300] 再叠 ~35m 波长 ±0.6m 高频小起伏（近中场呼吸感）。
 *   ⚠ 铁律：|x|≤24m 所有起伏恒 0（不顶穿路肩/路面），24→60m 渐入。
 *
 * ⚠ 为什么不照抄「|x|≤8 贴路面（y≈0）」：土路肩在 8.4→11.6 已按要求压低 0.35，
 *   若地面在 8→24 只从 0 降到 −0.4，土带外缘会在 x≈9.2 处没入草地 ⇒ 3.2m 土带只剩
 *   0.8m 可见。取 −0.38 起坡后土带全宽可见、且地面恒在土带之下（无翻边/无 z-fight 面）。
 *
 * ⚠ 横倾（bank）只在 |x| ≤ 24 内跟随（与土路肩外缘同高），24→60 渐隐到 0：
 *   赛道横倾最大 5.5°，若一路外推到 1400m 会抬升 130m+；而完全不跟随又会在
 *   土路肩外缘留下最大 1.1m 的台阶。24m 内同高 + 36m 渐隐是两难的折中。
 *
 * 列宽纪律（spec §8）：弯心内侧 R_min≈28.6m，内侧首列 8→24 的 16m 列宽 < 28.6m ⇒ 不自交。
 *
 * `terrainPoint()` 是**唯一地形高程真源**：树/岩石/看台等地物都用它落地，
 * 与地形网格顶点逐点同源（改剖面只改这一处）。
 */
import * as THREE from 'three';
import { getTrack } from '../track/nordschleife';
import { canvasTexture, makeCanvas } from '../util/canvasTex';
import { makeLcg } from '../util/math';

/** 横向列（对称，从最左到最右） */
const COLUMNS: readonly number[] = [
  -1400, -800, -420, -220, -120, -60, -24, -8, 8, 24, 60, 120, 220, 420, 800, 1400
];

/** 基准剖面（|x| → 相对路面中心的高差） */
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

/**
 * 低频起伏包络（|x| → 振幅 m；列宽外的区间平滑插值）。
 * spec A2：中/远场滚动加大 —— 60m 起就有 0.8m 呼吸感，120~420m 抬到 4~10m
 * （可见近丘），800/1400m 抬到 14/18m —— 1400m 列本身在 −40m，加起伏后仍全在
 * 路面之下，但能把「一刀切的地平线」变成起伏山脊。
 * ⚠ 铁律：|x|≤24m 起伏恒 0（不顶穿路肩/路面），24→60m 渐入 —— 在 `terrainPoint`
 *   里用 smoothstep(24,60,|x|) 门控，`tableAt` 在 x≤60 会返回 0.8 只是「包络」，
 *   真正生效的振幅还要乘门控（见下）。
 */
const NOISE_AMP: readonly (readonly [number, number])[] = [
  [60, 0.8],
  [120, 4.0],
  [220, 7.5],
  [420, 10],
  [800, 14],
  [1400, 18]
];

/** 平滑阶跃：x 在 [edge0,edge1] 内 0→1，边缘外钳制（列间曲率连续） */
function sstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/* ── spec A1：地形大尺度色块（vertex colors）────────────────────────────
 * 4 个基色（浅草/深草/橄榄/干土）按世界 (x,z) 低频噪声平滑混合，给高空俯瞰的
 * 「纯绿地毯」加草甸/林斑/土斑节奏。噪声用多组异频正弦叠加（确定性，无随机表），
 * 块尺度 ~150~300m（spec 120~260m 附近）；另加 `makeLcg` 每顶点 ±8% 亮度抖。
 *
 * ⚠ 关键：three 的 `map × vertexColor` 是相乘。若顶点色直接用基色（均值 ~0.4），
 *   与绿色贴图（均值 ~0.38）相乘会把整片地面压成深绿泥潭（0.4×0.38≈0.15 线性）。
 *   因此这里把混合色**归一化到 4 基色均值**（SPEC_MEAN）——顶点色成为「贴图均值
 *   1.0 附近的调制」，整场亮度保住现状基线，同时保留基色间的**相对**块间对比
 *   （浅草 ≈1.1×、深草 ≈0.7×、橄榄 ≈1.15×、干土 ≈0.9×）。渲染结果 = 绿贴图 ×
 *   调制 ⇒ 有明暗/色相节奏的田野，非纯色地毯。
 */
const C_LIGHT_GRASS = new THREE.Color(0x6f7d4f);
const C_DARK_GRASS = new THREE.Color(0x46523a);
const C_OLIVE = new THREE.Color(0x7a7a4e);
const C_DRY = new THREE.Color(0x6b5c40);
/** 4 基色 RGB 均值（sRGB 0..1），顶点色归一化除此 */
const SPEC_MEAN = new THREE.Color(
  (0x6f + 0x46 + 0x7a + 0x6b) / 4 / 255,
  (0x7d + 0x52 + 0x7a + 0x5c) / 4 / 255,
  (0x4f + 0x3a + 0x4e + 0x40) / 4 / 255
);

/**
 * V2 第 5 基色：苔藓/岩屑点缀色（更细色斑层次）。低权重混入，4 基色低频混结构不变，
 * 只给 150~300m 大色块之间加一层 ~50~90m 的细斑节奏。
 */
const C_MOSS = new THREE.Color(0x5a6b4a);
/** V2 岩壁/碎石色（陡坡露岩；归一化后是亮暖灰「碎石」调制） */
const C_ROCK = new THREE.Color(0x8f867c);
/** V2 近路鲜草（路肩外 8..24m 更鲜更密；归一化后偏亮饱和绿） */
const C_FRESH = new THREE.Color(0x5f7f3a);
/** 岩/鲜草色归一化到 4 基色均值（与基色同一调制空间，保证平均亮度仍在 ~1.0 附近）。
 *  ⚠ 逐通道手除（THREE.Color 无 divide，用 r/g/b 分量比）。 */
const ROCK_NORM = new THREE.Color(C_ROCK.r / SPEC_MEAN.r, C_ROCK.g / SPEC_MEAN.g, C_ROCK.b / SPEC_MEAN.b);
const FRESH_NORM = new THREE.Color(C_FRESH.r / SPEC_MEAN.r, C_FRESH.g / SPEC_MEAN.g, C_FRESH.b / SPEC_MEAN.b);

const _vcA = new THREE.Color();
const _vcB = new THREE.Color();
/** 世界 (x,z) → 顶点色（调制系数，均值 ~1.0）；`rnd` 提供确定性 ±8% 亮度抖 */
function sampleVertexColor(x: number, z: number, rnd: () => number, out: THREE.Color): THREE.Color {
  // 双轴低频噪声（块尺度 ~150~300m）：n0 绿度（深草↔浅草）、n1 干度（橄榄↔干土）
  const n0 = 0.5 + 0.5 * Math.sin(x * 0.031 + 1.3) * Math.sin(z * 0.029 + 2.7);
  const n1 = 0.5 + 0.5 * Math.sin(x * 0.024 + 0.4) * Math.sin(z * 0.022 + 4.1);
  const n2 = 0.5 + 0.5 * Math.sin(x * 0.047 + 5.9) * Math.sin(z * 0.045 + 1.1);
  const dryMix = n2 * 0.55; // 干土/橄榄混入比例（多数为绿，偶见干斑）
  // V2 第 5 基色层次：更高频双轴噪声（块尺度 ~50~90m）按低权重混入苔藓/岩屑色，
  // 给大色块之间加一层更细的节奏 —— 只加层次，4 基色低频混 + 亮度抖结构不变。
  const n3 = 0.5 + 0.5 * Math.sin(x * 0.061 + 3.4) * Math.sin(z * 0.057 + 0.9);
  _vcA.copy(C_DARK_GRASS).lerp(C_LIGHT_GRASS, n0);
  _vcB.copy(C_OLIVE).lerp(C_DRY, n1);
  out.copy(_vcA).lerp(_vcB, dryMix);
  out.lerp(C_MOSS, n3 * 0.2);
  out.r /= SPEC_MEAN.r;
  out.g /= SPEC_MEAN.g;
  out.b /= SPEC_MEAN.b;
  const j = 1 + (rnd() - 0.5) * 0.16; // ±8% 亮度抖
  return out.multiplyScalar(j);
}

function tableAt(table: readonly (readonly [number, number])[], x: number): number {
  if (x <= table[0][0]) return table[0][1];
  const last = table[table.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < table.length; i++) {
    const a = table[i - 1];
    const b = table[i];
    if (x <= b[0]) {
      const t = (x - a[0]) / (b[0] - a[0]);
      // smoothstep：列间曲率连续，避免折线状山脊
      return a[1] + (b[1] - a[1]) * (t * t * (3 - 2 * t));
    }
  }
  return last[1];
}

const TAU = Math.PI * 2;

/**
 * 弧长 s + 横向 lateral → 地形世界坐标（与地形网格顶点**同源**）。
 * 横向位置用水平右向（不含 bank），高程 = 中心高程 + bank 近场跟随 + 剖面 + 低频起伏。
 */
export function terrainPoint(s: number, lateral: number, out: THREE.Vector3): THREE.Vector3 {
  const track = getTrack();
  const f = track.at(s);
  const L = track.length;
  const rl = Math.hypot(f.tangent.x, f.tangent.z) || 1;
  const rhx = f.tangent.z / rl;
  const rhz = -f.tangent.x / rl;
  const ax = Math.abs(lateral);
  const bankFade = ax <= 24 ? 1 : Math.max(0, 1 - (ax - 24) / 36);
  const bankY = f.right.y * lateral * bankFade;
  // 主低频起伏（包络 × 门控）：铁律 |x|≤24 恒 0，24→60m 平滑渐入（防顶穿路肩/路面）
  const amp = tableAt(NOISE_AMP, ax) * sstep(24, 60, ax);
  const phase = lateral < 0 ? 2.1 : 0;
  const n1 = Math.sin((s / L) * TAU * 7 + 1.7);
  const n2 = Math.sin((s / L) * TAU * 23 + 0.4);
  const bumps = amp * (n1 * Math.cos(lateral * 0.004 + phase) * 0.6 + n2 * Math.sin(lateral * 0.006 + phase) * 0.4);
  // 近中场地表高频小起伏（~35m 波长，±0.6m）：只作用于 |x|>40m，smoothstep(40,80) 渐入，
  // 给 60~300m 近中场草甸「呼吸感」（spec A2）。波长 2π/0.18≈35m、2π/0.12≈52m。
  const hfAmp = 0.6 * sstep(40, 80, ax);
  const hf =
    hfAmp *
    (Math.sin(s * 0.18 + lateral * 0.09 + 1.2) * 0.7 + Math.sin(s * 0.12 + lateral * 0.15 + 4.4) * 0.3);
  out.set(
    f.center.x + rhx * lateral,
    f.center.y + bankY + tableAt(PROFILE, ax) + bumps + hf,
    f.center.z + rhz * lateral
  );
  return out;
}

/** 仅取高程（落地用；比 terrainPoint 少写两个分量，语义相同） */
const SCRATCH = new THREE.Vector3();
export function terrainY(s: number, lateral: number): number {
  return terrainPoint(s, lateral, SCRATCH).y;
}

/** 草地/泥土混合贴图（1024²，偏灰绿；spec A1：升 1024、加大块低频色斑、UV 世界尺度 40m） */
function grassTexture(): THREE.CanvasTexture {
  const size = 1024;
  const [canvas, ctx] = makeCanvas(size, size);
  ctx.fillStyle = '#5b6844';
  ctx.fillRect(0, 0, size, size);
  const rnd = makeLcg(20260832);
  // 中尺度色斑：草地明暗（保留原颗粒性格，仅随画布升到 1024）
  for (let i = 0; i < 420; i++) {
    const g = Math.floor(84 + rnd() * 44);
    const r = g - Math.floor(6 + rnd() * 16);
    const b = g - Math.floor(20 + rnd() * 18);
    ctx.fillStyle = `rgba(${r},${g},${b},${(0.10 + rnd() * 0.22).toFixed(3)})`;
    const rad = 8 + rnd() * 46;
    ctx.beginPath();
    ctx.ellipse(rnd() * size, rnd() * size, rad, rad * (0.5 + rnd() * 0.7), rnd() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  // 大块低频色斑（spec A1：80~240px 椭圆，与 vertex color 同色系，alpha 0.15~0.3，~120 枚）
  // 在 40m 世界尺度下 = 3~9m 的草甸/林斑/土斑块，给高空俯瞰的中尺度节奏。
  const PATCH: readonly (readonly [number, number, number])[] = [
    [0x6f, 0x7d, 0x4f], // 浅草
    [0x46, 0x52, 0x3a], // 深草
    [0x7a, 0x7a, 0x4e], // 橄榄
    [0x6b, 0x5c, 0x40] // 干土
  ];
  for (let i = 0; i < 120; i++) {
    const p = PATCH[Math.floor(rnd() * PATCH.length)];
    const a = 0.15 + rnd() * 0.15;
    ctx.fillStyle = `rgba(${p[0]},${p[1]},${p[2]},${a.toFixed(3)})`;
    const rad = 40 + rnd() * 80; // 半径 40~120 ⇒ 直径 80~240px
    ctx.beginPath();
    ctx.ellipse(rnd() * size, rnd() * size, rad, rad * (0.5 + rnd() * 0.7), rnd() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  // 泥土斑（暖褐）
  for (let i = 0; i < 54; i++) {
    ctx.fillStyle = `rgba(${Math.floor(104 + rnd() * 28)},${Math.floor(88 + rnd() * 22)},${Math.floor(62 + rnd() * 18)},${(
      0.06 + rnd() * 0.13
    ).toFixed(3)})`;
    const rad = 6 + rnd() * 30;
    ctx.beginPath();
    ctx.ellipse(rnd() * size, rnd() * size, rad, rad * (0.5 + rnd() * 0.6), rnd() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  // V2 更细色斑层次：小尺度苔藓/岩屑点缀（第 5 基色系），给近地草面再加一层细碎节奏
  // （40m 世界尺度下 6~28px = 0.23~1.1m，8m 内可读的「绿地狱」细斑）。一次性烘焙，零逐帧成本。
  for (let i = 0; i < 220; i++) {
    const g = Math.floor(78 + rnd() * 30);
    const r = g - Math.floor(4 + rnd() * 10);
    const b = g - Math.floor(24 + rnd() * 20);
    ctx.fillStyle = `rgba(${r},${g},${b},${(0.05 + rnd() * 0.1).toFixed(3)})`;
    const rad = 3 + rnd() * 14;
    ctx.beginPath();
    ctx.ellipse(rnd() * size, rnd() * size, rad, rad * (0.5 + rnd() * 0.7), rnd() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  // 细颗粒（8m 尺度可读）
  for (let i = 0; i < 9000; i++) {
    const g = Math.floor(72 + rnd() * 78);
    ctx.fillStyle = `rgba(${g - 4},${g + 4},${g - 10},${(0.05 + rnd() * 0.14).toFixed(3)})`;
    const r = 0.5 + rnd() * 1.8;
    ctx.fillRect(rnd() * size, rnd() * size, r, r);
  }
  const tex = canvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

export class Landscape {
  private readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.MeshStandardMaterial;
  private readonly texture: THREE.CanvasTexture;

  constructor(scene: THREE.Scene) {
    const track = getTrack();
    const spacing = 8;
    const n = Math.max(8, Math.round(track.length / spacing));
    const step = track.length / n;
    const rings = n + 1;
    const cols = COLUMNS.length;
    const pos = new Float32Array(rings * cols * 3);
    const uv = new Float32Array(rings * cols * 2);
    const col = new Float32Array(rings * cols * 3);
    const index: number[] = [];
    const tmp = new THREE.Vector3();
    const vc = new THREE.Color();
    const vRnd = makeLcg(0x5eecd1); // 顶点色确定性抖

    // 世界坐标缓存（第二遍算坡度用，避免重复 terrainPoint）
    const wx = new Float32Array(rings * cols);
    const wz = new Float32Array(rings * cols);
    // Pass 1：位置 + UV（spec A1：UV 世界尺度 40m，大块色斑更连贯）
    for (let i = 0; i < rings; i++) {
      const s = i * step;
      for (let c = 0; c < cols; c++) {
        const x = COLUMNS[c];
        terrainPoint(s, x, tmp);
        const idx = i * cols + c;
        const o = idx * 3;
        pos[o] = tmp.x;
        pos[o + 1] = tmp.y;
        pos[o + 2] = tmp.z;
        wx[idx] = tmp.x;
        wz[idx] = tmp.z;
        const t = idx * 2;
        uv[t] = tmp.x / 40;
        uv[t + 1] = tmp.z / 40;
      }
    }
    // Pass 2：顶点色 = 4 基色低频混 + 第 5 基色细斑 + 亮度抖（sampleVertexColor），
    // 再叠加 V2 两层颜色层次：陡坡露岩（岩壁/碎石带）+ 近路鲜草过渡带。
    // ⚠ 只改颜色，不动高程（|x|≤24 起伏恒 0 / 横倾跟随逻辑完全不受影响）。
    for (let i = 0; i < rings; i++) {
      for (let c = 0; c < cols; c++) {
        const idx = i * cols + c;
        const ax = Math.abs(COLUMNS[c]);
        sampleVertexColor(wx[idx], wz[idx], vRnd, vc);
        // 局部坡度：取横向邻点 (c-1) 与纵向邻点 (i-1) 的最大高差/水平距比
        let slope = 0;
        if (c > 0) {
          const dx = wx[idx] - wx[idx - 1];
          const dz = wz[idx] - wz[idx - 1];
          const dh = Math.hypot(dx, dz);
          slope = Math.max(slope, Math.abs(pos[idx * 3 + 1] - pos[(idx - 1) * 3 + 1]) / Math.max(0.5, dh));
        }
        if (i > 0) {
          const dx = wx[idx] - wx[idx - cols];
          const dz = wz[idx] - wz[idx - cols];
          const dh = Math.hypot(dx, dz);
          slope = Math.max(slope, Math.abs(pos[idx * 3 + 1] - pos[(idx - cols) * 3 + 1]) / Math.max(0.5, dh));
        }
        // V2 岩壁/碎石：陡坡（>10% 坡开始露岩，~22% 全露）。×sstep(24,60,|x|) 门控保证
        // |x|≤24 完全无岩（路肩/路面不受影响）；×rockPatch（~75m 斑块噪声）把整面岩板
        // 打散成「露头」而不是连续岩墙 —— 读作绿地狱里的岩壁/碎石带。
        // V3：混入权重 0.85 → 0.80（微收敛，防整面岩板读作过亮的亮暖灰，不推翻 V2 结构）。
        const rockPatch = 0.55 + 0.45 * Math.sin(wx[idx] * 0.083 + 2.2) * Math.sin(wz[idx] * 0.077 + 5.5);
        const rockMix = sstep(0.1, 0.22, slope) * sstep(24, 60, ax) * rockPatch * 0.8;
        if (rockMix > 0) vc.lerp(ROCK_NORM, rockMix);
        // V2 近路鲜草：路肩外 8..24m 草色更鲜更密（只调色），24→60m 渐隐回常态。
        // V3：权重 0.55 → 0.50（微收敛，防鲜草带读作过饱和的亮绿，路肩/路面不受影响）。
        const freshMix = sstep(6, 12, ax) * (1 - sstep(24, 40, ax));
        if (freshMix > 0) vc.lerp(FRESH_NORM, freshMix * 0.5);
        const o = idx * 3;
        col[o] = vc.r;
        col[o + 1] = vc.g;
        col[o + 2] = vc.b;
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

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.geometry.setIndex(index);
    this.geometry.computeVertexNormals();
    this.geometry.computeBoundingSphere();

    this.texture = grassTexture();
    this.material = new THREE.MeshStandardMaterial({
      map: this.texture,
      vertexColors: true, // spec A1：大尺度色块
      roughness: 0.95,
      metalness: 0.02
    });

    const mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh = mesh;
    mesh.name = 'landscape';
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    scene.add(mesh);
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}
