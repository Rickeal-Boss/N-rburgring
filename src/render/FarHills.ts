/**
 * 远景地平线 · 远山环（spec A3 双圈 + V2 第三层雾霭 = 3 mesh / 3 draw call）
 *
 * 为什么需要：Landscape 的横向剖面只铺到 ±1400m，剖面高程在 1400m 处已降到 −40m，
 * 于是天空与地面的交界是一条**平滑一刀切**的地平线（D1 截图可辨）。本模块在
 * 地形之外补低多边形山脊剪影，给地平线加「远山」层次。
 *
 * spec A3：近环 H 60→80 / 140→200、色 0x9c9384 → 0x9a9a86（略偏绿，读作远森林）；
 * 新增**第二圈外环**（radius ×1.4、高 100~150m、更浅色 0xa8a89b、`fog:true`）——
 * 大气透视两层山脊，给地平线加深度。V2 再加**第三层雾霭远山**（×1.9、H 130~200、
 * 最浅色 0xb5b5a9、`fog:true`）⇒ 三层山脊互相嵌套，空气透视读得出纵深。
 *
 * 几何（每圈）：闭合三角带（base 环 → 脊线环），角度分段 240（= 8~12 段可见山脊的
 * 低模感，但轮廓连续不锯齿）。每个角度：
 *   radius(θ) = max(spec 下限, 赛道在该方向的最远支撑距离) + 缓冲，再 ×radiusScale
 *   height(θ) = hMin..hMax（多个低频正弦叠加，确定性、无随机表）
 * 半径用**支撑函数**（赛道中心线在该方向上的最大投影）算，保证山脊环永远在
 * 赛道之外 —— 直接取「bbox 中心 + 2200~3200m」会在赛道最远端（离 bbox 中心
 * 约 4.0km）把山脊插进赛道中间，那是错的。
 *
 * 着色（每圈）：`MeshBasicMaterial`（不受光，雾同色）+ `fog: true`（与 Environment
 * 的 FogExp2 同色，远景自动被雾吃掉一部分）+ V2 `vertexColors`（基部 0.85、脊线 1.0，
 * 勾山脊天光高光/山脚雾霭层次）；不投影、不接收阴影；`frustumCulled=false`。
 * 尺寸/颜色口径来自 D2 任务书 + spec A3；不改 Renderer/Lighting/Environment 任何数值。
 */
import * as THREE from 'three';
import { getTrack } from '../track/nordschleife';

/** 雾色（与 config/environment.ts 的 fog.color 同值，作为地平线剪影基色） */
const HILL_COLOR_NEAR = 0x9a9a86;
/** 外环更浅（大气透视更远一层） */
const HILL_COLOR_OUTER = 0xa8a89b;
/** V2 第三层（最远）雾霭远山颜色：最浅，读作空气透视第三层
 *  V3 0xb5b5a9 → 0xbcbcb2（再浅一档）：空气透视第三层更贴近雾色，读作更远更霾 */
const HILL_COLOR_THIRD = 0xbcbcb2;
/** 角度分段（三角带 2 面/段 ⇒ 480 面/圈，低模剪影足够平滑） */
const SEGMENTS = 240;
/** 近环山脊高度区间 m（spec A3：60→80 / 140→200） */
const NEAR_H_MIN = 80;
const NEAR_H_MAX = 200;
/** 外环山脊高度区间 m（spec A3：100~150） */
const OUTER_H_MIN = 100;
const OUTER_H_MAX = 150;
/** V2 第三层山脊高度区间 m（×1.9 更远，抬高以保持可见角高） */
const THIRD_H_MIN = 130;
const THIRD_H_MAX = 200;
/** 外环半径倍数（spec A3：×1.4） */
const OUTER_RADIUS_SCALE = 1.4;
/** V2 第三层半径倍数（最远，大气透视） */
const THIRD_RADIUS_SCALE = 1.9;
/** V2 山脊顶点色：基部略暗（沉入雾霭）、脊线 1.0（勾出天光高光/背光层次） */
const RIDGE_BASE_TINT = 0.85;
/** 赛道支撑距离之外再留的缓冲 m（保证环永远在赛道外侧） */
const BUFFER = 900;
/** 半径下限 m（任务书 2200~3200 的下沿；赛道不占的方向就按这个来） */
const R_MIN = 2200;
/** 环底面相对赛道最低点再下沉 m（脊线以下全是实心「山体」，避免露底） */
const BASE_DROP = 160;

/** 确定性低频叠加（3 个互质周期，值域归一到 0..1）；`phase` 让外环与近环错峰（可见度） */
function ridgeShape(theta: number, phase = 0): number {
  const a = Math.sin(theta * 3 + 0.7 + phase);
  const b = Math.sin(theta * 7 + 2.1 + phase);
  const c = Math.sin(theta * 11 + 4.3 + phase);
  return Math.min(1, Math.max(0, 0.5 + (a * 0.5 + b * 0.3 + c * 0.2) * 0.5));
}

interface RingParts {
  geometry: THREE.BufferGeometry;
  material: THREE.MeshBasicMaterial;
  mesh: THREE.Mesh;
}

export class FarHills {
  private readonly parts: RingParts[] = [];

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

    // 近环：H 80~200、略偏绿（远森林）；外环：×1.4、H 100~150、更浅（大气透视）；
    // V2 第三层：×1.9、H 130~200、最浅（空气透视第三层）。各环相位错开（0/1.3/2.6），
    // 让外层在相邻内层的「低谷」处露出脊峰 ⇒ 三层山脊互相嵌套，地平线读出纵深。
    // V3 谷底雾霭：基部 tint 按圈递降（0.85 / 0.83 / 0.80），山脚逐层沉入雾带（零新增 mesh）。
    this.parts.push(this.buildRing(scene, samples, cx, cz, baseY, 1, NEAR_H_MIN, NEAR_H_MAX, HILL_COLOR_NEAR, 'far-hills', 0, RIDGE_BASE_TINT));
    this.parts.push(
      this.buildRing(scene, samples, cx, cz, baseY, OUTER_RADIUS_SCALE, OUTER_H_MIN, OUTER_H_MAX, HILL_COLOR_OUTER, 'far-hills-outer', 1.3, 0.83)
    );
    this.parts.push(
      this.buildRing(scene, samples, cx, cz, baseY, THIRD_RADIUS_SCALE, THIRD_H_MIN, THIRD_H_MAX, HILL_COLOR_THIRD, 'far-hills-third', 2.6, 0.80)
    );
  }

  /**
   * 造一圈远山（base 环 → 脊线环），并挂到场景；返回部件供 dispose。
   * V3：`baseTint` 控制基部雾霭强度（基部顶点色 = baseTint，与 material.color 相乘）。
   * 越远的圈 baseTint 越低 ⇒ 山脚越沉入雾霭（谷底雾带读法），空气透视逐层增强。
   */
  private buildRing(
    scene: THREE.Scene,
    samples: number[],
    cx: number,
    cz: number,
    baseY: number,
    radiusScale: number,
    hMin: number,
    hMax: number,
    color: number,
    name: string,
    phase: number,
    baseTint: number
  ): RingParts {
    const count = SEGMENTS;
    const pos = new Float32Array(count * 2 * 3);
    const col = new Float32Array(count * 2 * 3);
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
      const radius = Math.max(R_MIN, support + BUFFER) * radiusScale;
      const height = hMin + (hMax - hMin) * ridgeShape(th, phase);
      const o = i * 6;
      // 底环
      pos[o] = cx + dx * radius;
      pos[o + 1] = baseY;
      pos[o + 2] = cz + dz * radius;
      // 脊线环
      pos[o + 3] = cx + dx * radius;
      pos[o + 4] = baseY + height + BASE_DROP;
      pos[o + 5] = cz + dz * radius;
      // V2 背光/高光层次：基部略暗（沉入雾霭），脊线 1.0（勾出天光高光）。
      // 顶点色与 material.color 相乘 ⇒ 相对明暗由这条渐变提供，读作「山脊亮、山脚雾」。
      // V3：基部 tint 按圈递降（近 0.85 / 外 0.83 / 第三 0.80），山脚逐层沉入谷底雾霭。
      col[o] = baseTint;
      col[o + 1] = baseTint;
      col[o + 2] = baseTint;
      col[o + 3] = 1;
      col[o + 4] = 1;
      col[o + 5] = 1;
    }
    for (let i = 0; i < count; i++) {
      const a = i * 2;
      const b2 = a + 1;
      const c = ((i + 1) % count) * 2;
      const d = c + 1;
      // 双面（材质 DoubleSide）⇒ 绕序不影响可见性
      index.push(a, b2, c, c, b2, d);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geometry.setIndex(index);
    // MeshBasicMaterial 不用法线 ⇒ 不算法线（省一次 480 顶点的遍历）
    geometry.computeBoundingSphere();

    const material = new THREE.MeshBasicMaterial({
      color,
      side: THREE.DoubleSide,
      fog: true,
      vertexColors: true // V2：山脊高光 / 基部雾霭渐变
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false; // 环包住整个场景，包围球判可见性只会白算
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    scene.add(mesh);
    return { geometry, material, mesh };
  }

  dispose(): void {
    for (const p of this.parts) {
      p.mesh.removeFromParent();
      p.geometry.dispose();
      p.material.dispose();
    }
  }
}
