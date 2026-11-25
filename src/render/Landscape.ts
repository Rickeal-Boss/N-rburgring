/**
 * 纽北 · 横向剖面地形带（一个 Mesh / 一个材质）+ 地形采样纯函数
 *
 * 断面列（局部横向 x，单位 m）：
 *   [-1400, -800, -420, -220, -120, -60, -24, -8, 8, 24, 60, 120, 220, 420, 800, 1400]
 * 高程（相对路面中心平面）：
 *   |x|=8   −0.38  ← 低于土路肩外缘（−0.35），保证 3.2m 土带完整可见
 *   |x|=24  −0.45 ；60 −1.2 ；120 −2.2 ；220 −3.6 ；420 −7.0 ；800 −18 ；1400 −40
 *   |x| ∈ (60, 420] 叠加低频起伏（±2.4~4.5m，沿弧长取周期函数 ⇒ 闭合无接缝）
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
 * 低频起伏包络（|x| → 振幅 m；列宽外的区间线性插值）。
 * 近场（≤60m）必须为 0（否则会顶穿路面/路肩）；120~420m 是可见的近丘；
 * 800/1400m 抬到 12~16m —— 1400m 列本身在 −40m，加起伏后仍全在路面之下，
 * 但能把「一刀切的地平线」变成起伏山脊（spec「远处雾过渡自然」的观感前提）。
 */
const NOISE_AMP: readonly (readonly [number, number])[] = [
  [60, 0],
  [120, 2.6],
  [220, 4.6],
  [420, 6.0],
  [800, 12],
  [1400, 16]
];

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
  const amp = tableAt(NOISE_AMP, ax);
  const phase = lateral < 0 ? 2.1 : 0;
  const n1 = Math.sin((s / L) * TAU * 7 + 1.7);
  const n2 = Math.sin((s / L) * TAU * 23 + 0.4);
  const bumps = amp * (n1 * Math.cos(lateral * 0.004 + phase) * 0.6 + n2 * Math.sin(lateral * 0.006 + phase) * 0.4);
  out.set(
    f.center.x + rhx * lateral,
    f.center.y + bankY + tableAt(PROFILE, ax) + bumps,
    f.center.z + rhz * lateral
  );
  return out;
}

/** 仅取高程（落地用；比 terrainPoint 少写两个分量，语义相同） */
const SCRATCH = new THREE.Vector3();
export function terrainY(s: number, lateral: number): number {
  return terrainPoint(s, lateral, SCRATCH).y;
}

/** 草地/泥土混合贴图（512²，偏灰绿，向旧 createSoilTexture 的颗粒尺度靠） */
function grassTexture(): THREE.CanvasTexture {
  const size = 512;
  const [canvas, ctx] = makeCanvas(size, size);
  ctx.fillStyle = '#5b6844';
  ctx.fillRect(0, 0, size, size);
  const rnd = makeLcg(20260832);
  // 大块色斑：草地明暗 + 泥土斑
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
    const index: number[] = [];
    const tmp = new THREE.Vector3();

    for (let i = 0; i < rings; i++) {
      const s = i * step;
      for (let c = 0; c < cols; c++) {
        const x = COLUMNS[c];
        terrainPoint(s, x, tmp);
        const o = (i * cols + c) * 3;
        pos[o] = tmp.x;
        pos[o + 1] = tmp.y;
        pos[o + 2] = tmp.z;
        const t = (i * cols + c) * 2;
        uv[t] = tmp.x / 12;
        uv[t + 1] = tmp.z / 12;
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
    this.geometry.setIndex(index);
    this.geometry.computeVertexNormals();
    this.geometry.computeBoundingSphere();

    this.texture = grassTexture();
    this.material = new THREE.MeshStandardMaterial({
      map: this.texture,
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
