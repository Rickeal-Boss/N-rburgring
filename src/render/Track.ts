/**
 * 纽博格林北环 · 路面放样（沿中心线 s 的 ribbon 生成器）
 *
 * 断面（局部坐标：x 横向、y 离路面，见 src/track/nordschleife.ts）：
 *   |x| ≤ 7        石板铺装（三带贴图，u=0..1，v=s/12 ⇒ 与旧仓 2.4m 条石同密度）
 *   7 < |x| ≤ 8.4  白石路缘（抬高 0.03）
 *   8.4 < |x| ≤ 11.6 土路肩（soil 贴图，向外压低 0.35）
 *   |x| = 11.2     护栏（立柱 InstancedMesh 每 8m + 连续波形梁 ribbon）
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
import { getTrack } from '../track/nordschleife';
import { mergeSafe } from '../util/geo';
import { canvasTexture, makeCanvas, textTexture } from '../util/canvasTex';
import { createSoilTexture, roadTexture } from './scene/roadTexture';

/** 路缘石板白（R27_PALETTE.stoneWhite：旧仓 castle 石材族同色） */
const KERB_WHITE = 0xe5dcd9;
/** 护栏金属灰 */
const RAIL_GREY = 0x8a8f96;
/** 石材基色（龙门架） */
const STONE_GREY = 0xb9b1a6;

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
    this.textures.push(roadTex);
    this.materials.push(
      new THREE.MeshStandardMaterial({
        map: roadTex,
        roughness: 0.9,
        metalness: 0.04,
        envMapIntensity: 0.15
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
    this.geometries.push(roadGeo);
    const road = new THREE.Mesh(roadGeo, this.materials[0]);
    road.name = 'road-surface';
    road.receiveShadow = true;
    this.group.add(road);

    /* ── 白石路缘（|x| ∈ [7, 8.4]，抬高 0.03）────────────────────────── */
    const kerbMat = new THREE.MeshStandardMaterial({ color: KERB_WHITE, roughness: 0.8 });
    this.materials.push(kerbMat);
    const kerbGeo = mergeSafe([
      buildRibbon(strip(-8.4, 0.03, -7, 0.03), 4, 4),
      buildRibbon(strip(7, 0.03, 8.4, 0.03), 4, 4)
    ]);
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
     * 横梁：x=±11.2 的竖直薄带（y 0.56~0.68，0.12 厚），DoubleSide 单面片。
     * 立柱：每 8m 一根，坐落在土路肩（11.2 处 ≈ −0.32）上、顶端探到横梁上沿 ——
     *   箱体高 1.05（地下 0.35 + 地上 0.70），故横梁 0.62 与立柱上段自然搭接。
     *   （规格给的 0.75 只覆盖地上段；此处按「埋入土路肩」的真实构造取 1.05，
     *    否则立柱顶 0.43 会与 0.62 的横梁脱空。） */
    const railMat = new THREE.MeshStandardMaterial({
      color: RAIL_GREY,
      roughness: 0.55,
      metalness: 0.65,
      side: THREE.DoubleSide
    });
    this.materials.push(railMat);
    const beamGeo = mergeSafe([
      buildRibbon(strip(-11.2, 0.56, -11.2, 0.68), 4, 4),
      buildRibbon(strip(11.2, 0.56, 11.2, 0.68), 4, 4)
    ]);
    this.geometries.push(beamGeo);
    const beam = new THREE.Mesh(beamGeo, railMat);
    beam.name = 'guardrail-beam';
    beam.receiveShadow = true;
    this.group.add(beam);

    const postGeo = new THREE.BoxGeometry(0.18, 1.05, 0.18);
    this.geometries.push(postGeo);
    const postCount = Math.floor(track.length / 8) * 2;
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
        p.set(
          f.center.x + f.right.x * side * 11.2 + f.up.x * -0.32,
          f.center.y + f.right.y * side * 11.2 + f.up.y * -0.32,
          f.center.z + f.right.z * side * 11.2 + f.up.z * -0.32
        );
        m.compose(p, q, one);
        posts.setMatrixAt(idx++, m);
      }
    }
    posts.instanceMatrix.needsUpdate = true;
    posts.computeBoundingSphere();
    this.group.add(posts);

    /* ── 起终线：2m 宽黑白条带 + 龙门架 ─────────────────────────────── */
    this.group.add(this.buildStartLine());
    this.group.add(this.buildGate());

    this.group.matrixAutoUpdate = false;
    this.group.updateMatrix();
    scene.add(this.group);
  }

  /**
   * 起终线条带（横跨 14m 路面，2m 宽，交替白石/深色格）。
   * 用**两环 ribbon**（s=0 → s=2）直接按中心线帧构造，而不是 PlaneGeometry + 四元数
   * ——赛道带横倾/坡度，基向量手推容易出错；ribbon 的绕序与路面完全同源，必朝上。
   */
  private buildStartLine(): THREE.Object3D {
    const track = getTrack();
    const [canvas, ctx] = makeCanvas(512, 64);
    const cells = 24;
    const w = canvas.width / cells;
    for (let i = 0; i < cells; i++) {
      for (let row = 0; row < 2; row++) {
        const dark = (i + row) % 2 === 0;
        ctx.fillStyle = dark ? '#2b2a28' : '#e5dcd9';
        ctx.fillRect(i * w, row * 32, w, 32);
      }
    }
    const tex = canvasTexture(canvas);
    this.textures.push(tex);
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, metalness: 0.03 });
    this.materials.push(mat);

    const HALF = 7;
    const LIFT = 0.012;
    const pos = new Float32Array(4 * 3);
    const uv = new Float32Array(4 * 2);
    const rows = [
      { s: 0, v: 0 },
      { s: 2, v: 1 }
    ];
    for (let r = 0; r < 2; r++) {
      const f = track.at(rows[r].s);
      for (let c = 0; c < 2; c++) {
        const x = c === 0 ? -HALF : HALF;
        const o = (r * 2 + c) * 3;
        pos[o] = f.center.x + f.right.x * x + f.up.x * LIFT;
        pos[o + 1] = f.center.y + f.right.y * x + f.up.y * LIFT;
        pos[o + 2] = f.center.z + f.right.z * x + f.up.z * LIFT;
        const t = (r * 2 + c) * 2;
        uv[t] = c;
        uv[t + 1] = rows[r].v;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex([0, 2, 1, 1, 2, 3]);
    geo.computeVertexNormals();
    this.geometries.push(geo);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'start-line';
    mesh.receiveShadow = true;
    return mesh;
  }

  /** 龙门架（跨 14m：石柱 0.9m 见方 + 横梁 1.2m + 「NORDSCHLEIFE」字牌） */
  private buildGate(): THREE.Object3D {
    const track = getTrack();
    const group = new THREE.Group();
    group.name = 'start-gate';

    const stoneMat = new THREE.MeshStandardMaterial({ color: STONE_GREY, roughness: 0.85 });
    this.materials.push(stoneMat);
    const pillarGeo = new THREE.BoxGeometry(0.9, 6.2, 0.9);
    const beamGeo = new THREE.BoxGeometry(16.6, 1.2, 0.9);
    this.geometries.push(pillarGeo, beamGeo);
    for (const side of [-1, 1]) {
      const pillar = new THREE.Mesh(pillarGeo, stoneMat);
      pillar.position.set(side * 7.45, 3.1, 0);
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
    const signTex = textTexture(['NORDSCHLEIFE'], '#1b1d20', '#f1dcae', 1024, 160);
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

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const mt of this.materials) mt.dispose();
    for (const t of this.textures) t.dispose();
    this.group.removeFromParent();
  }
}
