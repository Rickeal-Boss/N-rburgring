/**
 * 纽北 · 低密度点缀（树 / 岩石 / 里程牌 / 起点建筑群 / 远景废墟）
 *
 * 密度纪律（P0）：树、岩石、里程牌全部 InstancedMesh，单类 1 个 draw call；
 * 远景一律 castShadow=false（只剩起点建筑群近景投影）。总数：
 *   树 ~1736（每侧 24m 交错，|x| ∈ [16,55]）、岩石 300（|x| ∈ [20,120]）、
 *   里程牌 21、弯道提示牌 8、起点建筑 6 件、远景废墟 8 组（合并成 2 个 mesh）。
 *
 * 落地真源：全部用 `terrainPoint()`（Landscape.ts 导出）取高程 —— 与地形网格顶点
 * 逐点同源，改剖面不会让树浮空/埋土。
 */
import * as THREE from 'three';
import { getTrack } from '../track/nordschleife';
import { mergeSafe } from '../util/geo';
import { makeLcg } from '../util/math';
import { terrainPoint } from './Landscape';
import { createSoilTexture } from './scene/roadTexture';

/** 起点建筑/废墟石材（土壤噪点当石纹，色相由 color 给） */
function stoneMaterial(soil: THREE.Texture): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    map: soil,
    color: 0xb9b1a6,
    roughness: 0.88,
    metalness: 0.03
  });
}

/** 世界系盒体（沿赛道局部坐标系摆放）：底面对齐地形 + yOff */
function boxAt(
  w: number,
  h: number,
  d: number,
  s: number,
  lateral: number,
  yOff = 0
): THREE.BufferGeometry {
  const track = getTrack();
  const f = track.at(s);
  const geo = new THREE.BoxGeometry(w, h, d);
  const right = new THREE.Vector3(f.right.x, f.right.y, f.right.z);
  const up = new THREE.Vector3(f.up.x, f.up.y, f.up.z);
  const tangent = new THREE.Vector3(f.tangent.x, f.tangent.y, f.tangent.z);
  const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, tangent));
  const p = terrainPoint(s, lateral, new THREE.Vector3());
  p.y += yOff + h / 2;
  const m = new THREE.Matrix4().compose(p, q, new THREE.Vector3(1, 1, 1));
  geo.applyMatrix4(m);
  return geo;
}

export class Scenery {
  private readonly group = new THREE.Group();
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly textures: THREE.Texture[] = [];

  constructor(scene: THREE.Scene) {
    const group = this.group;
    group.name = 'scenery';
    const track = getTrack();
    const L = track.length;

    /* ── 树：树干 cylinder + 树冠（两锥合并）────────────────────────────
     * 每侧 24m 一棵、左右交错 12m；确定性 LCG 抖动位置/缩放/朝向。
     * 单实例 12（干）+ 28（冠）= 40 tri（规格 40~70）。 */
    const rnd = makeLcg(80820832);
    const perSide = Math.floor(L / 24);
    const treeCount = perSide * 2;
    const trunkGeo = new THREE.CylinderGeometry(0.18, 0.26, 2.6, 6, 1, true);
    trunkGeo.translate(0, 1.3, 0);
    const coneA = new THREE.ConeGeometry(1.9, 3.4, 7, 1, true);
    coneA.translate(0, 3.4, 0);
    const coneB = new THREE.ConeGeometry(1.3, 2.4, 7, 1, true);
    coneB.translate(0, 5.2, 0);
    const canopyGeo = mergeSafe([coneA, coneB]);
    this.geometries.push(trunkGeo, canopyGeo);

    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x584434, roughness: 0.95 });
    const canopyMat = new THREE.MeshStandardMaterial({ color: 0xe8f0e0, roughness: 0.92 });
    this.materials.push(trunkMat, canopyMat);

    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, treeCount);
    const canopies = new THREE.InstancedMesh(canopyGeo, canopyMat, treeCount);
    trunks.name = 'tree-trunks';
    canopies.name = 'tree-canopies';
    trunks.castShadow = false;
    canopies.castShadow = false;
    trunks.receiveShadow = false;
    canopies.receiveShadow = false;

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const p = new THREE.Vector3();
    const sc = new THREE.Vector3();
    const col = new THREE.Color();
    let ti = 0;
    for (const side of [-1, 1]) {
      for (let i = 0; i < perSide; i++) {
        const s = i * 24 + (side > 0 ? 12 : 0) + (rnd() - 0.5) * 10;
        const lateral = side * (16 + rnd() * 39);
        const scale = 0.75 + rnd() * 0.6;
        terrainPoint(s, lateral, p);
        p.y -= 0.12; // 埋一点根，斜坡上不悬空
        e.set(0, rnd() * Math.PI * 2, 0);
        q.setFromEuler(e);
        sc.set(scale, scale * (0.85 + rnd() * 0.35), scale);
        m.compose(p, q, sc);
        trunks.setMatrixAt(ti, m);
        canopies.setMatrixAt(ti, m);
        // 冠色：灰绿 → 深绿（同一材质靠 instanceColor 分化，零额外 DC）
        col.setHSL(0.26 + rnd() * 0.05, 0.34 + rnd() * 0.16, 0.15 + rnd() * 0.09);
        canopies.setColorAt(ti, col);
        ti++;
      }
    }
    trunks.instanceMatrix.needsUpdate = true;
    canopies.instanceMatrix.needsUpdate = true;
    if (canopies.instanceColor) canopies.instanceColor.needsUpdate = true;
    trunks.computeBoundingSphere();
    canopies.computeBoundingSphere();
    group.add(trunks, canopies);

    /* ── 岩石：dodecahedron ~300（|x| ∈ [20,120]）──────────────────────── */
    const rockGeo = new THREE.DodecahedronGeometry(1, 0);
    this.geometries.push(rockGeo);
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x9a958c, roughness: 0.92, metalness: 0.02 });
    this.materials.push(rockMat);
    const rockCount = 300;
    const rocks = new THREE.InstancedMesh(rockGeo, rockMat, rockCount);
    rocks.name = 'rocks';
    rocks.castShadow = false;
    rocks.receiveShadow = false;
    for (let i = 0; i < rockCount; i++) {
      const s = (i / rockCount) * L + (rnd() - 0.5) * 20;
      const side = rnd() < 0.5 ? -1 : 1;
      const lateral = side * (20 + rnd() * 100);
      terrainPoint(s, lateral, p);
      p.y += 0.15;
      e.set(rnd() * Math.PI, rnd() * Math.PI, rnd() * Math.PI);
      q.setFromEuler(e);
      const sx = 0.5 + rnd() * 1.9;
      sc.set(sx, 0.4 + rnd() * 1.4, sx * (0.7 + rnd() * 0.6));
      m.compose(p, q, sc);
      rocks.setMatrixAt(i, m);
    }
    rocks.instanceMatrix.needsUpdate = true;
    rocks.computeBoundingSphere();
    group.add(rocks);

    /* ── 里程牌（每 1000m）+ 弯道提示牌（高曲率 8 处）────────────────── */
    this.buildMarkers(group, rnd);

    /* ── 起点建筑群（石砌看台 / 维修墙 / 双塔）+ 远景废墟 ─────────────── */
    const soil = createSoilTexture();
    soil.wrapS = THREE.RepeatWrapping;
    soil.wrapT = THREE.RepeatWrapping;
    soil.repeat.set(2, 2);
    this.textures.push(soil);
    const stone = stoneMaterial(soil);
    this.materials.push(stone);

    // 起点建筑群：近景投影（castShadow=true）
    const startGeo = mergeSafe([
      // 石砌看台：3 级台阶（22m 长，每级 2.4m 深、累计高 0.8/1.6/2.4）
      ...Array.from({ length: 3 }, (_, k) => boxAt(2.4, 0.8 * (k + 1), 22, 70, 17 + k * 2.4, 0)),
      // 维修墙：60m 长 × 1.2m 高（对侧）
      boxAt(0.4, 1.2, 60, 70, -13.5, 0),
      // 两座塔楼主体 8×14×8（对侧与同侧各一，避开看台）
      boxAt(8, 14, 8, 30, 27, 0),
      boxAt(8, 14, 8, 130, -26, 0)
    ]);
    this.geometries.push(startGeo);
    const startMesh = new THREE.Mesh(startGeo, stone);
    startMesh.name = 'start-buildings';
    startMesh.castShadow = true;
    startMesh.receiveShadow = true;
    group.add(startMesh);

    // 塔楼锥顶（4 面锥 ⇒ 金字塔顶，与方形塔身对齐）
    const roofGeoA = new THREE.ConeGeometry(5.9, 4.2, 4, 1);
    roofGeoA.rotateY(Math.PI / 4);
    const roofA = this.placeRoof(roofGeoA, 30, 27, 14);
    const roofGeoB = new THREE.ConeGeometry(5.9, 4.2, 4, 1);
    roofGeoB.rotateY(Math.PI / 4);
    const roofB = this.placeRoof(roofGeoB, 130, -26, 14);
    const roofMerged = mergeSafe([roofA, roofB]);
    this.geometries.push(roofMerged);
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x5a5550, roughness: 0.8, metalness: 0.08 });
    this.materials.push(roofMat);
    const roofMesh = new THREE.Mesh(roofMerged, roofMat);
    roofMesh.name = 'tower-roofs';
    roofMesh.castShadow = true;
    group.add(roofMesh);

    // 远景废墟/拱门：每 2500m 一组（3~5 box），全组合并成 1 个 mesh、不投影
    const ruinParts: THREE.BufferGeometry[] = [];
    const groups = Math.min(8, Math.floor(L / 2500));
    for (let g = 0; g < groups; g++) {
      const s = g * 2500 + 400;
      const side = g % 2 === 0 ? 1 : -1;
      const lateral = side * (60 + ((g * 37) % 50));
      // 两根立柱 + 过梁 + 一段残墙
      ruinParts.push(boxAt(1.2, 5.5, 1.2, s, lateral, 0));
      ruinParts.push(boxAt(1.2, 5.5, 1.2, s + 5, lateral, 0));
      ruinParts.push(boxAt(1.4, 1.0, 6.6, s + 2.5, lateral, 5.5));
      ruinParts.push(boxAt(1.0, 3.0, 4.0, s - 4, lateral + side * 3, 0));
    }
    if (ruinParts.length > 0) {
      const ruinGeo = mergeSafe(ruinParts);
      this.geometries.push(ruinGeo);
      const ruinMesh = new THREE.Mesh(ruinGeo, stone);
      ruinMesh.name = 'ruins';
      ruinMesh.castShadow = false;
      ruinMesh.receiveShadow = true;
      group.add(ruinMesh);
    }

    scene.add(group);
  }

  /** 塔顶锥：底面对齐塔身顶面（towerH 高） */
  private placeRoof(geo: THREE.BufferGeometry, s: number, lateral: number, towerH: number): THREE.BufferGeometry {
    const track = getTrack();
    const f = track.at(s);
    const right = new THREE.Vector3(f.right.x, f.right.y, f.right.z);
    const up = new THREE.Vector3(f.up.x, f.up.y, f.up.z);
    const tangent = new THREE.Vector3(f.tangent.x, f.tangent.y, f.tangent.z);
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, tangent));
    const p = terrainPoint(s, lateral, new THREE.Vector3());
    p.y += towerH + 2.1;
    geo.applyMatrix4(new THREE.Matrix4().compose(p, q, new THREE.Vector3(1, 1, 1)));
    return geo;
  }

  /** 里程牌（21 根）+ 弯道提示牌（8 处，曲率最大的采样点） */
  private buildMarkers(group: THREE.Group, rnd: () => number): void {
    const track = getTrack();
    const L = track.length;
    const kmCount = Math.floor(L / 1000);
    const postGeo = new THREE.BoxGeometry(0.16, 1.1, 0.16);
    const plateGeo = new THREE.BoxGeometry(0.62, 0.42, 0.06);
    this.geometries.push(postGeo, plateGeo);
    const postMat = new THREE.MeshStandardMaterial({ color: 0x4a4744, roughness: 0.85 });
    const plateMat = new THREE.MeshStandardMaterial({ color: 0xe8e2d6, roughness: 0.7, metalness: 0.1 });
    this.materials.push(postMat, plateMat);
    const posts = new THREE.InstancedMesh(postGeo, postMat, kmCount);
    const plates = new THREE.InstancedMesh(plateGeo, plateMat, kmCount);
    posts.name = 'km-posts';
    plates.name = 'km-plates';
    posts.castShadow = false;
    plates.castShadow = false;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const sc = new THREE.Vector3(1, 1, 1);
    for (let i = 0; i < kmCount; i++) {
      const s = i * 1000 + 30;
      const lateral = (i % 2 === 0 ? 1 : -1) * 13.2;
      terrainPoint(s, lateral, p);
      const f = track.at(s);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(f.tangent.x, f.tangent.z));
      const baseY = p.y;
      p.y = baseY + 0.55;
      m.compose(p, q, sc);
      posts.setMatrixAt(i, m);
      p.y = baseY + 1.18;
      m.compose(p, q, sc);
      plates.setMatrixAt(i, m);
    }
    posts.instanceMatrix.needsUpdate = true;
    plates.instanceMatrix.needsUpdate = true;
    posts.computeBoundingSphere();
    plates.computeBoundingSphere();
    group.add(posts, plates);

    // 弯道提示牌：8 处高曲率（沿 s 扫描取样，避免与里程牌重叠）
    const curveS: number[] = [];
    for (let s = 300; s < L - 300 && curveS.length < 8; s += 137) {
      const f = track.at(s);
      if (Math.abs(f.curvature) > 0.018) {
        if (curveS.every((v) => Math.abs(v - s) > 700)) curveS.push(s);
      }
    }
    while (curveS.length < 8) curveS.push(400 + curveS.length * 2300 + rnd() * 200);
    const cPostGeo = new THREE.BoxGeometry(0.14, 1.9, 0.14);
    const cPlateGeo = new THREE.BoxGeometry(0.9, 0.9, 0.06);
    this.geometries.push(cPostGeo, cPlateGeo);
    const cPosts = new THREE.InstancedMesh(cPostGeo, postMat, curveS.length);
    const cPlates = new THREE.InstancedMesh(cPlateGeo, plateMat, curveS.length);
    cPosts.name = 'curve-sign-posts';
    cPlates.name = 'curve-sign-plates';
    cPosts.castShadow = false;
    cPlates.castShadow = false;
    for (let i = 0; i < curveS.length; i++) {
      const s = curveS[i];
      const lateral = (i % 2 === 0 ? 1 : -1) * 13.6;
      terrainPoint(s, lateral, p);
      const f = track.at(s);
      // 牌面朝向来车：绕 Y 转 heading，再转 π 使牌面法线指向 −s
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(f.tangent.x, f.tangent.z) + Math.PI);
      const baseY = p.y;
      p.y = baseY + 0.95;
      m.compose(p, q, sc);
      cPosts.setMatrixAt(i, m);
      p.y = baseY + 2.1;
      m.compose(p, q, sc);
      cPlates.setMatrixAt(i, m);
    }
    cPosts.instanceMatrix.needsUpdate = true;
    cPlates.instanceMatrix.needsUpdate = true;
    cPosts.computeBoundingSphere();
    cPlates.computeBoundingSphere();
    group.add(cPosts, cPlates);
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const g of this.geometries) g.dispose();
    for (const mt of this.materials) mt.dispose();
    for (const t of this.textures) t.dispose();
  }
}
