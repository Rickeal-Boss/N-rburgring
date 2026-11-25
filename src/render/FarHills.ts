/**
 * 远景地平线 · 远山环（1 个 mesh / 1 个材质 / 1 个 draw call）
 *
 * 为什么需要：Landscape 的横向剖面只铺到 ±1400m，剖面高程在 1400m 处已降到 −40m，
 * 于是天空与地面的交界是一条**平滑一刀切**的地平线（D1 截图可辨）。本模块在
 * 地形之外补一圈低多边形山脊剪影，给地平线加一层「远山」层次。
 *
 * 几何：闭合三角带（base 环 → 脊线环），角度分段 240（= 8~12 段可见山脊的
 * 低模感，但轮廓连续不锯齿）。每个角度：
 *   radius(θ) = max(spec 下限, 赛道在该方向的最远支撑距离) + 缓冲
 *   height(θ) = 60~140m（多个低频正弦叠加，确定性、无随机表）
 * 半径用**支撑函数**（赛道中心线在该方向上的最大投影）算，保证山脊环永远在
 * 赛道之外 —— 直接取「bbox 中心 + 2200~3200m」会在赛道最远端（离 bbox 中心
 * 约 4.0km）把山脊插进赛道中间，那是错的。
 *
 * 着色：`MeshBasicMaterial`（不受光，雾色 0x9c9384）+ `fog: true`（与 Environment
 * 的 FogExp2 同色，远景自动被雾吃掉一部分）；不投影、不接收阴影。
 * 尺寸/颜色口径来自 D2 任务书；不改 Renderer/Lighting/Environment 任何数值。
 */
import * as THREE from 'three';
import { getTrack } from '../track/nordschleife';

/** 雾色（与 config/environment.ts 的 fog.color 同值，作为地平线剪影基色） */
const HILL_COLOR = 0x9c9384;
/** 角度分段（三角带 2 面/段 ⇒ 480 面，低模剪影足够平滑） */
const SEGMENTS = 240;
/** 山脊高度区间 m（任务书 60~140） */
const H_MIN = 60;
const H_MAX = 140;
/** 赛道支撑距离之外再留的缓冲 m（保证环永远在赛道外侧） */
const BUFFER = 900;
/** 半径下限 m（任务书 2200~3200 的下沿；赛道不占的方向就按这个来） */
const R_MIN = 2200;
/** 环底面相对赛道最低点再下沉 m（脊线以下全是实心「山体」，避免露底） */
const BASE_DROP = 160;

/** 确定性低频叠加（3 个互质周期，值域归一到 0..1） */
function ridgeShape(theta: number): number {
  const a = Math.sin(theta * 3 + 0.7);
  const b = Math.sin(theta * 7 + 2.1);
  const c = Math.sin(theta * 11 + 4.3);
  return Math.min(1, Math.max(0, 0.5 + (a * 0.5 + b * 0.3 + c * 0.2) * 0.5));
}

export class FarHills {
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly mesh: THREE.Mesh;

  constructor(scene: THREE.Scene) {
    const track = getTrack();
    const b = track.bounds;
    const cx = (b.minX + b.maxX) / 2;
    const cz = (b.minZ + b.maxZ) / 2;
    const { min } = track.elevationRange();
    const baseY = min - BASE_DROP;

    // 赛道中心线采样（每 ~64m 一点，足够算支撑函数）
    const stride = Math.max(1, Math.round(64 / track.spacing));
    const samples: number[] = [];
    for (let i = 0; i < track.count; i += stride) {
      samples.push(track.center[i * 3] - cx, track.center[i * 3 + 2] - cz);
    }

    const count = SEGMENTS;
    const pos = new Float32Array(count * 2 * 3);
    const index: number[] = [];
    for (let i = 0; i < count; i++) {
      const th = (i / count) * Math.PI * 2;
      const dx = Math.sin(th);
      const dz = Math.cos(th);
      // 支撑函数：赛道在该方向上的最远投影
      let support = 0;
      for (let k = 0; k < samples.length; k += 2) {
        const p = samples[k] * dx + samples[k + 1] * dz;
        if (p > support) support = p;
      }
      const radius = Math.max(R_MIN, support + BUFFER);
      const height = H_MIN + (H_MAX - H_MIN) * ridgeShape(th);
      const o = i * 6;
      // 底环
      pos[o] = cx + dx * radius;
      pos[o + 1] = baseY;
      pos[o + 2] = cz + dz * radius;
      // 脊线环
      pos[o + 3] = cx + dx * radius;
      pos[o + 4] = baseY + height + BASE_DROP;
      pos[o + 5] = cz + dz * radius;
    }
    for (let i = 0; i < count; i++) {
      const a = i * 2;
      const b2 = a + 1;
      const c = ((i + 1) % count) * 2;
      const d = c + 1;
      // 双面（材质 DoubleSide）⇒ 绕序不影响可见性
      index.push(a, b2, c, c, b2, d);
    }

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.geometry.setIndex(index);
    // MeshBasicMaterial 不用法线 ⇒ 不算法线（省一次 480 顶点的遍历）
    this.geometry.computeBoundingSphere();

    this.material = new THREE.MeshBasicMaterial({
      color: HILL_COLOR,
      side: THREE.DoubleSide,
      fog: true
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'far-hills';
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = false; // 环包住整个场景，包围球判可见性只会白算
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
    scene.add(this.mesh);
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}
