/**
 * 纽北 · 低密度点缀（树 / 岩石 / 里程牌 / 起点建筑群 / 远景废墟）
 *
 * 密度纪律（P0）：树、岩石、里程牌全部 InstancedMesh，单类 1 个 draw call；
 * 远景一律 castShadow=false（只剩起点建筑群近景投影）。总数：
 *   树 ~2600（每侧 16m 交错，|x| ∈ [16,55]，D2 由 24m 加密）、岩石 300、
 *   里程牌 21、弯道提示牌 8、起点建筑 6 件、远景废墟 8 组（合并成 1 个 mesh）。
 *
 * 落地真源：全部用 `terrainPoint()`（Landscape.ts 导出）取高程 —— 与地形网格顶点
 * 逐点同源，改剖面不会让树浮空/埋土。
 *
 * 石材（D2）：起点建筑群/废墟改用程序化 **ashlar 石砌贴图**（`scene/ashlarTexture`）。
 * 原先复用土路肩的 soil 噪点图，放大到 60m 墙 / 14m 塔身时已看不出砌块（读成纯色）。
 */
import * as THREE from 'three';
import { getTrack } from '../track/nordschleife';
import { mergeSafe } from '../util/geo';
import { makeLcg } from '../util/math';
import { terrainPoint } from './Landscape';
import { createAshlarTexture } from './scene/ashlarTexture';

/** 起点建筑/废墟石材（ashlar 错缝砖贴图，色相/明度由 color 给） */
function stoneMaterial(ashlar: THREE.Texture): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    map: ashlar,
    color: 0xd8d2c8,
    roughness: 0.88,
    metalness: 0.03
  });
}

/** 石砌贴图一个 repeat 对应的世界尺寸 m（256² = 4 砖宽 × 6 皮 ⇒ 砖宽 1m、皮高 0.43m） */
const ASHLAR_TILE_M = 4;

/**
 * 把 BoxGeometry 的 6 个面 UV 按**实际边长**缩放 —— 否则 60m 维修墙与 8m 塔身
 * 共用同一张 0..1 UV，砌块尺度会差 7 倍（墙上是巨大石块、塔上是碎砖）。
 * 面序（three.js）：+x, −x, +y, −y, +z, −z，各 4 顶点。
 */
function scaleBoxUv(geo: THREE.BufferGeometry, w: number, h: number, d: number): void {
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  const spans: ReadonlyArray<readonly [number, number]> = [
    [d, h],
    [d, h], // ±x：u 沿 depth、v 沿 height
    [w, d],
    [w, d], // ±y：u 沿 width、v 沿 depth
    [w, h],
    [w, h] // ±z：u 沿 width、v 沿 height
  ];
  for (let f = 0; f < 6; f++) {
    const su = spans[f][0] / ASHLAR_TILE_M;
    const sv = spans[f][1] / ASHLAR_TILE_M;
    for (let i = 0; i < 4; i++) {
      const idx = f * 4 + i;
      uv.setXY(idx, uv.getX(idx) * su, uv.getY(idx) * sv);
    }
  }
  uv.needsUpdate = true;
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
  scaleBoxUv(geo, w, h, d);
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

    /* ── 树：冷杉（两锥）+ 阔叶（压扁二十面体），62/38 混植 ──────────────
     * D2：每侧 **16m** 一棵（原先 24m）、左右交错 8m；确定性 LCG 抖动位置/缩放/朝向。
     * 总数 = floor(L/16)*2 ≈ 2600，按 ~62% 冷杉 / 38% 阔叶 随机分配（同种子可复现）。
     * 冷杉单实例 12（干）+ 28（冠）= 40 tri；阔叶 12（短干）+ 80（Icosa(1.4,1)）= 92 tri。
     * 4 个 InstancedMesh（干/冠 × 2 种，2 DC 新增），全部 castShadow=false。 */
    const rnd = makeLcg(80820832);
    const TREE_SPACING = 16;
    const perSide = Math.floor(L / TREE_SPACING);
    const treeCount = perSide * 2;

    // 先掷一遍类型（62/38），按实际计数分配 InstancedMesh —— 保证 setMatrixAt 不越界
    const coniferAt = new Uint8Array(treeCount);
    let nConifer = 0;
    for (let i = 0; i < treeCount; i++) {
      const isConifer = rnd() < 0.62 ? 1 : 0;
      coniferAt[i] = isConifer;
      nConifer += isConifer;
    }
    const nBroad = treeCount - nConifer;

    const trunkGeo = new THREE.CylinderGeometry(0.18, 0.26, 2.6, 6, 1, true);
    trunkGeo.translate(0, 1.3, 0);
    const coneA = new THREE.ConeGeometry(1.9, 3.4, 7, 1, true);
    coneA.translate(0, 3.4, 0);
    const coneB = new THREE.ConeGeometry(1.3, 2.4, 7, 1, true);
    coneB.translate(0, 5.2, 0);
    const canopyGeo = mergeSafe([coneA, coneB]);

    // 阔叶：短干 + 压扁树冠（y×0.75，冠底坐 1.8m 干顶）
    const blTrunkGeo = new THREE.CylinderGeometry(0.16, 0.22, 1.8, 6, 1, true);
    blTrunkGeo.translate(0, 0.9, 0);
    const blCanopyGeo = new THREE.IcosahedronGeometry(1.4, 1);
    blCanopyGeo.scale(1, 0.75, 1);
    blCanopyGeo.translate(0, 1.8 + 1.4 * 0.75, 0); // 干顶 1.8 + 冠半高 1.05
    this.geometries.push(trunkGeo, canopyGeo, blTrunkGeo, blCanopyGeo);

    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3a2c, roughness: 0.95 });
    const canopyMat = new THREE.MeshStandardMaterial({ color: 0x8a9a72, roughness: 0.92 });
    const blCanopyMat = new THREE.MeshStandardMaterial({ color: 0x96a05c, roughness: 0.92 });
    this.materials.push(trunkMat, canopyMat, blCanopyMat);

    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, nConifer);
    const canopies = new THREE.InstancedMesh(canopyGeo, canopyMat, nConifer);
    const blTrunks = new THREE.InstancedMesh(blTrunkGeo, trunkMat, nBroad);
    const blCanopies = new THREE.InstancedMesh(blCanopyGeo, blCanopyMat, nBroad);
    trunks.name = 'tree-trunks';
    canopies.name = 'tree-canopies';
    blTrunks.name = 'tree-broadleaf-trunks';
    blCanopies.name = 'tree-broadleaf-canopies';
    for (const im of [trunks, canopies, blTrunks, blCanopies]) {
      im.castShadow = false;
      im.receiveShadow = false;
    }

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const p = new THREE.Vector3();
    const sc = new THREE.Vector3();
    const col = new THREE.Color();
    let ci = 0;
    let bi = 0;
    let slot = 0;
    for (const side of [-1, 1]) {
      for (let i = 0; i < perSide; i++) {
        const s = i * TREE_SPACING + (side > 0 ? TREE_SPACING / 2 : 0) + (rnd() - 0.5) * 8;
        const lateral = side * (16 + rnd() * 39);
        const scale = 0.6 + rnd() * 0.9;
        terrainPoint(s, lateral, p);
        p.y -= 0.12; // 埋一点根，斜坡上不悬空
        e.set(0, rnd() * Math.PI * 2, 0);
        q.setFromEuler(e);
        sc.set(scale, scale * (0.85 + rnd() * 0.35), scale);
        m.compose(p, q, sc);
        if (coniferAt[slot]) {
          trunks.setMatrixAt(ci, m);
          canopies.setMatrixAt(ci, m);
          // 冷杉：色相 0.24~0.32 / 明度 0.14~0.24 / 饱和 0.25~0.40（线性空间；
          // 乘 canopyMat 0x8a9a72 落暗橄榄，不再是荧光浅绿）
          col.setHSL(0.24 + rnd() * 0.08, 0.25 + rnd() * 0.15, 0.14 + rnd() * 0.10);
          canopies.setColorAt(ci, col);
          ci++;
        } else {
          blTrunks.setMatrixAt(bi, m);
          blCanopies.setMatrixAt(bi, m);
          // 阔叶：暖绿 色相 0.20~0.30 / 明度 0.16~0.26 / 饱和 0.30~0.45
          col.setHSL(0.20 + rnd() * 0.10, 0.30 + rnd() * 0.15, 0.16 + rnd() * 0.10);
          blCanopies.setColorAt(bi, col);
          bi++;
        }
        slot++;
      }
    }
    for (const im of [trunks, canopies, blTrunks, blCanopies]) {
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.computeBoundingSphere();
    }
    group.add(trunks, canopies, blTrunks, blCanopies);

    /* ── 岩石：dodecahedron ~300（|x| ∈ [20,120]）+ 巨石簇 ────────────────
     * 巨石簇（B2）：4 处 × 3~5 块（|x|∈[18,60]，块径 1.2~2.6m），并入现 rocks
     * InstancedMesh（只加实例数，不加 DC）。簇位/块形用独立 LCG rnd2 —— 不扰动
     * 主 rnd 序列，原 300 散石与树/牌/废墟布局逐点不变。 */
    const rockGeo = new THREE.DodecahedronGeometry(1, 0);
    this.geometries.push(rockGeo);
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x9a958c, roughness: 0.92, metalness: 0.02 });
    this.materials.push(rockMat);
    const RND2 = makeLcg(0x51f15e); // B2 新增散布专用 LCG
    const SCATTER_BASE = 300;
    const clusterSizes = [3, 4, 5, 4]; // 4 处，每簇 3~5 块
    const clusterRocks = clusterSizes.reduce((a, b) => a + b, 0);
    const rockCount = SCATTER_BASE + clusterRocks;
    const rocks = new THREE.InstancedMesh(rockGeo, rockMat, rockCount);
    rocks.name = 'rocks';
    rocks.castShadow = false;
    rocks.receiveShadow = false;
    for (let i = 0; i < SCATTER_BASE; i++) {
      const s = (i / SCATTER_BASE) * L + (rnd() - 0.5) * 20;
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
    let ri = SCATTER_BASE;
    for (let c = 0; c < clusterSizes.length; c++) {
      const cs = RND2() * L;
      const cl = (RND2() < 0.5 ? -1 : 1) * (18 + RND2() * 42);
      const baseY = terrainPoint(cs, cl, p).y;
      for (let j = 0; j < clusterSizes[c]; j++) {
        const s2 = (((cs + (RND2() - 0.5) * 6) % L) + L) % L;
        const lateral2 = cl + (RND2() - 0.5) * 8;
        terrainPoint(s2, lateral2, p);
        p.y = baseY + (RND2() - 0.5) * 0.8 + 0.2;
        e.set(RND2() * Math.PI, RND2() * Math.PI, RND2() * Math.PI);
        q.setFromEuler(e);
        const sx = 0.6 + RND2() * 0.7; // 半径 0.6~1.3 ⇒ 直径 1.2~2.6m
        sc.set(sx, 0.45 + RND2() * 0.5, sx * (0.7 + RND2() * 0.5));
        m.compose(p, q, sc);
        rocks.setMatrixAt(ri++, m);
      }
    }
    rocks.instanceMatrix.needsUpdate = true;
    rocks.computeBoundingSphere();
    group.add(rocks);

    /* ── 灌木（|x|∈[13,28]，~500，1 DC）──────────────────────────────── */
    const shrubGeo = new THREE.IcosahedronGeometry(0.5, 0);
    this.geometries.push(shrubGeo);
    const shrubMat = new THREE.MeshStandardMaterial({ color: 0x51603f, roughness: 0.95 });
    this.materials.push(shrubMat);
    const SHRUB_COUNT = 500;
    const shrubs = new THREE.InstancedMesh(shrubGeo, shrubMat, SHRUB_COUNT);
    shrubs.name = 'shrubs';
    shrubs.castShadow = false;
    shrubs.receiveShadow = false;
    for (let i = 0; i < SHRUB_COUNT; i++) {
      const s = RND2() * L;
      const side = RND2() < 0.5 ? -1 : 1;
      const lateral = side * (13 + RND2() * 15);
      terrainPoint(s, lateral, p);
      p.y += 0.22;
      e.set(0, RND2() * Math.PI * 2, 0);
      q.setFromEuler(e);
      const sx = 0.7 + RND2() * 0.9;
      sc.set(sx, 0.6 + RND2() * 0.6, sx * (0.7 + RND2() * 0.5));
      m.compose(p, q, sc);
      shrubs.setMatrixAt(i, m);
    }
    shrubs.instanceMatrix.needsUpdate = true;
    shrubs.computeBoundingSphere();
    group.add(shrubs);

    /* ── 草簇（|x|∈[12,20]，~800，1 DC）──────────────────────────────── */
    const grassGeo = new THREE.ConeGeometry(0.22, 0.5, 4, 1, true);
    grassGeo.translate(0, 0.25, 0); // 底面对齐地面
    this.geometries.push(grassGeo);
    const grassMat = new THREE.MeshStandardMaterial({ color: 0x8a8a54, roughness: 0.95 });
    this.materials.push(grassMat);
    const GRASS_COUNT = 800;
    const grass = new THREE.InstancedMesh(grassGeo, grassMat, GRASS_COUNT);
    grass.name = 'grass-tufts';
    grass.castShadow = false;
    grass.receiveShadow = false;
    for (let i = 0; i < GRASS_COUNT; i++) {
      const s = RND2() * L;
      const side = RND2() < 0.5 ? -1 : 1;
      const lateral = side * (12 + RND2() * 8);
      terrainPoint(s, lateral, p);
      p.y -= 0.02;
      e.set(0, RND2() * Math.PI * 2, 0);
      q.setFromEuler(e);
      const gs = 0.7 + RND2() * 0.7;
      sc.set(gs, gs * (0.8 + RND2() * 0.5), gs);
      m.compose(p, q, sc);
      grass.setMatrixAt(i, m);
    }
    grass.instanceMatrix.needsUpdate = true;
    grass.computeBoundingSphere();
    group.add(grass);

    /* ── 里程牌（每 1000m）+ 弯道提示牌（高曲率 8 处）────────────────── */
    this.buildMarkers(group, rnd);

    /* ── 起点建筑群（石砌看台 / 维修墙 / 双塔）+ 远景废墟 ─────────────── */
    const ashlar = createAshlarTexture();
    // UV 已按实际边长换算成米 ⇒ 贴图 repeat 保持 1（见 scaleBoxUv / ASHLAR_TILE_M）
    ashlar.repeat.set(1, 1);
    this.textures.push(ashlar);
    const stone = stoneMaterial(ashlar);
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
