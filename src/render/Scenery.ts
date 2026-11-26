/**
 * 纽北 · 低密度点缀（树 / 岩石 / 里程牌 / 起点建筑群 / 远景废墟）
 *
 * 密度纪律（P0）：树、岩石、里程牌全部 InstancedMesh，单类 1 个 draw call；
 * 远景一律 castShadow=false（只剩起点建筑群近景投影）。总数：
 *   树 ~2600（每侧 16m 交错，|x| ∈ [16,55]，D2 由 24m 加密）、岩石 300 + 碎石带 640、
 *   里程牌 21、弯道提示牌 8、起点建筑 6 件、远景废墟 8 组（合并成 1 个 mesh）。
 *
 * 落地真源：全部用 `terrainPoint()`（Landscape.ts 导出）取高程 —— 与地形网格顶点
 * 逐点同源，改剖面不会让树浮空/埋土。
 *
 * 石材（D2）：起点建筑群/废墟改用程序化 **ashlar 石砌贴图**（`scene/ashlarTexture`）。
 * 原先复用土路肩的 soil 噪点图，放大到 60m 墙 / 14m 塔身时已看不出砌块（读成纯色）。
 *
 * V3 有针对性增强（零新增 mesh/材质/DC，全部并入既有 InstancedMesh / 合并网格）：
 *   1) 起点建筑群近景：塔楼/维修墙加**窗洞/门洞**（顶点色压暗薄板，乘 ashlar 贴图读作凹口）；
 *   2) Brünnchen 观赛点：看台前缘加**观赛栏杆 + 旗杆/红横幅**（并入废墟网格，顶点色区分）；
 *   3) 路肩碎石带：|x|∈[11.6,16] 散点 640 小岩屑（并入 rocks InstancedMesh，独立 LCG 不扰动原布局）。
 *   弯道提示牌箭头/数字：因「单类 1 InstancedMesh 共享同一几何 + 禁新增 mesh/材质」无法逐牌
 *   区分左右弯方向，宁精勿滥，**V3 跳过**（牌面维持既有 plateMat 纯色板）。
 */
import * as THREE from 'three';
import { getTrack, getCurrentMode, selectApexes } from '../track/nordschleife';
import { mergeSafe } from '../util/geo';
import { makeLcg } from '../util/math';
import { canvasTexture, makeCanvas } from '../util/canvasTex';
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

/**
 * 弯道提示牌 chevron 纹理 —— 128²，暖白底 + 黑色「<」折线箭头指向**纹理左侧**。
 *
 * 方向约定（与 buildMarkers 的摆放配合，勿改）：BoxGeometry +Z 面前脸 UV 的 U 沿本地
 * +X，牌面绕 Y 转 (heading+π) 后本地 +X = 来车观察者看到的**右侧**（已验算），故纹理
 * 左侧（U=0，本地 −X）= 观察者左侧。左弯牌（curvature>0）箭头指纹理左 = 指示左弯；
 * 右弯牌由实例矩阵绕本地 Z 翻 π 复用本图，箭头翻到观察者右侧。
 */
function createChevronTexture(): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(128, 128);
  // 暖白底（与里程牌 plateMat 0xe8e2d6 同族观感，略提亮读作干净白板）
  ctx.fillStyle = '#f4f1ea';
  ctx.fillRect(0, 0, 128, 128);
  // 黑色「<」：尖端在左中，上/下臂收于右，附一条中轴（柄）明确指向
  ctx.strokeStyle = '#1b1d20'; // 与 Track 的 GELLHORN 字色一致
  ctx.lineWidth = 20;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(32, 64); // 尖端（左中）
  ctx.lineTo(98, 64); // 中轴 → 右
  ctx.moveTo(100, 24); // 上臂端
  ctx.lineTo(32, 64); // 汇聚尖端
  ctx.lineTo(100, 104); // 下臂端
  ctx.stroke();
  const tex = canvasTexture(canvas); // 已设 SRGBColorSpace
  tex.anisotropy = 4;
  return tex;
}

/* ── V14 起点直道氛围：广告牌 + 发车信号灯架 ────────────────────────────────
 * 铁律：任何可碰撞地面物体 |lateral| ≥ 13（drive 走廊半宽 11.106 + 1.9 余量）。
 * 广告牌全部 ≥13（13.5/15）；发车灯架立柱 ±11.5（跨路结构，内缘 11.325 > 11.106
 * clip-free，横梁 23m）——既有龙门架 ±7.45 仍留走廊内，V6 遗留项待后续修复。 */

/** V14 广告牌 4 块（交错两侧）：[s, lateral, 顶点色明度] —— 正侧 +13.5（看台 +17 内侧）、
 *  负侧 −15（维修墙 −13.5 之后、树线 16 之前）。同材质同纹理，明度区分 4 块。 */
const START_BOARDS: ReadonlyArray<readonly [number, number, number]> = [
  [25, 13.5, 0.86],
  [55, -15, 0.94],
  [85, 13.5, 1.0],
  [115, -15, 0.9]
];

/** V14 发车信号灯架：s=−10（龙门架 s=0 前 10m），立柱 ±11.5（**drive 走廊半宽 11.106 之外**，
 *  穿模红线铁律：|lateral| ≥ 13 才 clip-free，但灯架需跨路 ⇒ 立柱取 11.5（内缘 11.325 > 11.106，
 *  车体够不到；横梁随之加长到 23m）。5 盏红灯悬于梁下 y≈5.425（远高于车高 1.5m，无平面穿模）。
 *  ⚠ 既有龙门架（Track.ts buildGate，立柱 ±7.45）**仍落在走廊内**——V6 已登记"门柱穿模"遗留项，
 *  本轮不扩病（V14 新结构 clip-free），该遗留项单独待后续修复。 */
const START_LIGHT_S = -10;
const START_LIGHT_LATERAL = 11.5;
const START_LIGHT_BEAM_Y = 6.0;

/**
 * V14 广告牌横幅贴图 —— 256×128 程序化双色横幅：上部品牌色带 + 下部米白底 +
 * 中间深色字条（白色抽象「赞助商」字块）。4 块共享 1 张，明度靠顶点色微调区分。
 */
function createBannerTexture(): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(256, 128);
  // 上部品牌色带（深蓝，racing 品牌观感）
  ctx.fillStyle = '#1f4e8c';
  ctx.fillRect(0, 0, 256, 40);
  // 品牌带下缘白色分隔线
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 38, 256, 4);
  // 下部米白底
  ctx.fillStyle = '#efe9dc';
  ctx.fillRect(0, 42, 256, 86);
  // 中间深色字条（赞助商名条）
  ctx.fillStyle = '#20242a';
  ctx.fillRect(0, 62, 256, 26);
  // 字条上白色抽象文字块（多段，读作品牌名）
  ctx.fillStyle = '#f4f1ea';
  ctx.fillRect(18, 68, 40, 14);
  ctx.fillRect(72, 68, 56, 14);
  ctx.fillRect(142, 68, 44, 14);
  ctx.fillRect(200, 68, 22, 14);
  // 底缘细白线收边
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 124, 256, 4);
  const tex = canvasTexture(canvas);
  tex.anisotropy = 4;
  return tex;
}

/**
 * V23 维修区柏油道贴图 —— 1536×192 程序化（零外部资源）：深灰柏油底 + 细噪点
 * （makeLcg 确定性）+ 4 个白色车位框（跨每间车库宽 15m）+ "PIT" 白字 + "60" 限速
 * 白圆黑字 + 入/出口白色箭头（chevron）。
 *
 * 贴图轴向与 quad 的 UV 对齐：u = (s−40)/75（沿弧长，s=40→u=0 画布左）、
 * v = latInner→latOuter 0→1（近路面 → 近车库）。CanvasTexture flipY 默认 true ⇒
 * v=1（车库侧）映射画布**顶部**、v=0（路面侧）映射画布**底部**。
 *
 * 文字读正向（司机在 lateral≈0 看 −right 侧维修道，司机面西时 view-right=+s）：
 *   P 首字母在司机 view-left = −s = 低 u = 画布左 ⇒ 画"PIT"正序（P 左 T 右）；
 *   字母顶朝 view-up = 远离司机 = 车库侧 = v=1 = 画布顶 ⇒ 正常竖排（顶朝上）。
 *   即画布上画**正序正竖**的 "PIT" 即读正、非镜像、非倒置。
 *
 * 米制拉伸补偿：1 画布 u 像素 = 75/1536 m、1 画布 v 像素 = 5.4/192 m ⇒ 横向 0.576 缩放，
 * 使文字/圆形在路面上呈正确比例（否则被横向拉伸 1.74×）。
 */
function createPitLaneTexture(): THREE.CanvasTexture {
  const W = 1536;
  const H = 192;
  const [canvas, ctx] = makeCanvas(W, H);
  const S0 = 40;
  const S1 = 115;
  const LANE_W = 5.4; // |−17 − (−11.6)| = 5.4m 横向
  // 柏油基色（深灰）
  ctx.fillStyle = '#3a3a3a';
  ctx.fillRect(0, 0, W, H);
  // 细噪点（确定性 LCG，独立种子不扰动既有 rnd/RND2..4 布局）
  const rnd = makeLcg(0x7e3a11);
  for (let i = 0; i < 3200; i++) {
    const g = Math.floor(44 + rnd() * 56);
    ctx.fillStyle = `rgba(${g},${g},${g},${(0.1 + rnd() * 0.26).toFixed(3)})`;
    const sz = 1 + rnd() * 2.2;
    ctx.fillRect(rnd() * W, rnd() * H, sz, sz);
  }
  const uToPx = (u: number): number => u * W;
  const vToPy = (v: number): number => (1 - v) * H; // flipY: v=1→画布顶、v=0→画布底
  const UX = W / (S1 - S0); // px/m 沿 s
  const VY = H / LANE_W; // px/m 横向
  const XSCALE = UX / VY; // ≈0.576：横向补偿使地面文字/圆形读正
  const WHITE = '#e8e6e0';
  // 车位框（4 间车库前）：跨车库宽 15m（u∈[(gs±7.5−40)/75]），v 0.15..0.85，白线 3px
  const GARAGE_S = [52.5, 69.5, 86.5, 103.5];
  ctx.strokeStyle = WHITE;
  ctx.lineWidth = 3;
  for (const gs of GARAGE_S) {
    const x0 = uToPx((gs - 7.5 - S0) / (S1 - S0));
    const x1 = uToPx((gs + 7.5 - S0) / (S1 - S0));
    const y0 = vToPy(0.85); // v=0.85 → 画布 y（顶）
    const y1 = vToPy(0.15); // v=0.15 → 画布 y（底）
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  }
  // "PIT" 白字（bold）：入口 s≈43.75（u≈0.05），v 中部
  ctx.save();
  ctx.translate(uToPx(0.05), vToPy(0.5));
  ctx.scale(XSCALE, 1);
  ctx.fillStyle = WHITE;
  ctx.font = 'bold 34px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('PIT', 0, 0);
  ctx.restore();
  // "60" 限速：白圆 + 黑字，入口 s≈41.3（u≈0.017），白圆路面呈圆（ry 反补偿）
  const cx60 = uToPx(0.017);
  const cy60 = vToPy(0.5);
  const rx60 = 18;
  const ry60 = rx60 / XSCALE;
  ctx.fillStyle = WHITE;
  ctx.beginPath();
  ctx.ellipse(cx60, cy60, rx60, ry60, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.save();
  ctx.translate(cx60, cy60);
  ctx.scale(XSCALE, 1);
  ctx.fillStyle = '#111214';
  ctx.font = 'bold 20px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('60', 0, 0);
  ctx.restore();
  // 入/出口白色箭头（chevron，指向 +s = +u = 画布右；司机读作沿维修道向前）
  const drawChevron = (cx: number, cy: number): void => {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(XSCALE, 1);
    ctx.strokeStyle = WHITE;
    ctx.lineWidth = 12;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(28, 0); // 尖端（指向 +u/画布右）
    ctx.lineTo(-24, -24);
    ctx.moveTo(28, 0);
    ctx.lineTo(-24, 24);
    ctx.stroke();
    ctx.restore();
  };
  drawChevron(uToPx(0.1), vToPy(0.5)); // 入口：s≈47.5
  drawChevron(uToPx(0.965), vToPy(0.5)); // 出口：s≈112.4
  const tex = canvasTexture(canvas);
  tex.anisotropy = 8;
  return tex;
}

/**
 * V31 弯道旁草地赞助商喷字贴图 —— 512×128 程序化（零外部资源）：**透明底** +
 * 白色粗体大号 "GELLHORN" 居中。喷在草地上，透明处 alpha=0 露草地，读作
 * 纽北标志性的「弯道旁草地赞助商喷字」（草地喷漆观感）。
 *
 * makeCanvas 初始为透明（alpha=0，无填充）⇒ 无需 clearRect，直接画字即可。
 * CanvasTexture flipY=true ⇒ v=1（近路面侧）映射画布**顶**、v=0（远草地侧）映射画布**底**；
 * u 沿弧长（u=(s−(apex−15))/30）⇒ 画布左→右 = 低 u→高 u = s 增加方向。
 * 轻描 shadowBlur 读作喷漆边缘雾化；字号 72px，仅当超宽时 measureText 自适应缩放防裁切。
 */
function createGroundAdTexture(): THREE.CanvasTexture {
  const W = 512;
  const H = 128;
  const [canvas, ctx] = makeCanvas(W, H);
  // 画布初始透明（alpha=0）⇒ 透明处露草地；不 fillRect 打底（与 V23 柏油底不同）。
  ctx.font = 'bold 72px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // 防御：11 字符 × 72px ≈ 550px > 512 会裁切，measureText 自适应缩到画布内（保最大字号）
  const tw = ctx.measureText('GELLHORN').width;
  if (tw > W - 16) {
    ctx.font = `bold ${Math.floor((72 * (W - 16)) / tw)}px Arial, sans-serif`;
  }
  ctx.fillStyle = '#f5f5f0'; // 暖白喷漆（米白，与里程牌 plateMat 同族观感）
  ctx.shadowColor = '#f5f5f0';
  ctx.shadowBlur = 8; // 边缘雾化，读作草地喷漆
  ctx.globalAlpha = 0.85;
  ctx.fillText('GELLHORN', W / 2, H / 2);
  ctx.globalAlpha = 1;
  ctx.shadowBlur = 0;
  const tex = canvasTexture(canvas);
  tex.anisotropy = 8;
  return tex;
}

/**
 * 横幅面板专用摆放：BoxGeometry 保留**默认 UV**（0..1/面，横幅贴图整幅映射），
 * 不做 ashlar 米制缩放（boxAt 的 scaleBoxUv 按砖缝尺度会把横幅裁出字条、只露上半）。
 * 其余与 boxAt 同源（赛道局部系 + terrainPoint 落地）。
 */
function panelAt(
  w: number,
  h: number,
  d: number,
  s: number,
  lateral: number,
  yOff: number
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
  geo.applyMatrix4(new THREE.Matrix4().compose(p, q, new THREE.Vector3(1, 1, 1)));
  return geo;
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

/**
 * 给几何体写入**顶点色**（配合 material.vertexColors=true 用）。
 * 顶点色与材质 map/color 相乘：白 (1,1,1) 不变色，暗值把贴图压暗读作「凹口/洞」。
 * 必须在 mergeSafe 前给**每个**被合并几何体都写（否则 mergeGeometries 属性集不一致报错）。
 */
function paintGeo(geo: THREE.BufferGeometry, r: number, g: number, b: number): THREE.BufferGeometry {
  const n = geo.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = r;
    arr[i * 3 + 1] = g;
    arr[i * 3 + 2] = b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
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
    // V3 路肩碎石带：|x|∈[11.6,16]（路面半宽 7m 之外、树线 16m 之内）散点小岩屑。
    // 并入既有 rocks InstancedMesh（只加实例数，**零新增 mesh/材质/DC**）。用独立 LCG RND4
    // —— 不扰动 rnd / RND2 序列，原 300 散石/巨石簇/灌木/草簇布局逐点不变。
    const RND4 = makeLcg(0x9c4f21);
    // V29 维修道脚印植被/碎石过滤：lateral 为负表示维修道在赛道左侧。
    // 维修道脚印区即 s∈(39,116)、lateral∈(-17.2,-11.5)；落入该区的实例缩放置零。
    // 仅作用于负侧且落在该区间内的实例，RND 调用次数不变（只置零缩放，不跳过 RND）。
    const inPitLane = (s: number, lateral: number) => s > 39 && s < 116 && lateral < -11.5 && lateral > -17.2;
    const GRAVEL_COUNT = 640;
    const rockCount = SCATTER_BASE + clusterRocks + GRAVEL_COUNT;
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
    // V3 路肩碎石带：压扁 dodeca 小颗粒（半径 0.06~0.26m），大半埋土只露小半 ——
    // 远看是路肩一圈碎屑颗粒、不喧宾；近看有质感的岩屑带（与 7m 路面边缘、16m 树线衔接）。
    for (let i = 0; i < GRAVEL_COUNT; i++) {
      const s = RND4() * L;
      const side = RND4() < 0.5 ? -1 : 1;
      const lateral = side * (11.6 + RND4() * 4.4);
      terrainPoint(s, lateral, p);
      p.y += 0.02; // 大半埋土，只露上半（碎石贴地、不浮空）
      e.set(RND4() * Math.PI, RND4() * Math.PI, RND4() * Math.PI);
      q.setFromEuler(e);
      const sx = 0.06 + RND4() * 0.2;
      sc.set(sx, 0.04 + RND4() * 0.12, sx * (0.7 + RND4() * 0.6));
      if (inPitLane(s, lateral)) sc.set(0, 0, 0);
      m.compose(p, q, sc);
      rocks.setMatrixAt(ri++, m);
    }
    rocks.instanceMatrix.needsUpdate = true;
    rocks.computeBoundingSphere();
    group.add(rocks);

    /* ── 灌木（|x|∈[13,28]，~500，1 DC）+ V2 花丛 ──────────────────────
     * V2 植被多样性再一档：在**既有 shrubs InstancedMesh** 内用 instanceColor
     * 分出「花丛」（粉/白/黄/紫，约 28%，略小）与灌木绿 —— 零新增 DC。
     * instanceColor 与 material.color 相乘 ⇒ 材质色改纯白，绿/花色全部走
     * instanceColor；用独立 LCG RND3（不扰动 RND2 序列，草簇/散石布局不变）。 */
    const shrubGeo = new THREE.IcosahedronGeometry(0.5, 0);
    this.geometries.push(shrubGeo);
    const shrubMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 });
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
      if (inPitLane(s, lateral)) sc.set(0, 0, 0);
      m.compose(p, q, sc);
      shrubs.setMatrixAt(i, m);
    }
    // 花丛色：粉/白/黄/紫；灌木绿：HSL 微抖动
    const RND3 = makeLcg(0x1f3a5c);
    const FLOWER_HEX = [0xe58bb0, 0xf2efe6, 0xe8c04a, 0xa98bc0];
    for (let i = 0; i < SHRUB_COUNT; i++) {
      if (RND3() < 0.28) {
        col.setHex(FLOWER_HEX[Math.floor(RND3() * FLOWER_HEX.length) % FLOWER_HEX.length]);
      } else {
        col.setHex(0x51603f); // 灌木绿：保持原观感，避免整片色相偏移
      }
      shrubs.setColorAt(i, col);
    }
    shrubs.instanceMatrix.needsUpdate = true;
    if (shrubs.instanceColor) shrubs.instanceColor.needsUpdate = true;
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
      if (inPitLane(s, lateral)) sc.set(0, 0, 0);
      m.compose(p, q, sc);
      grass.setMatrixAt(i, m);
    }
    grass.instanceMatrix.needsUpdate = true;
    grass.computeBoundingSphere();
    group.add(grass);

    /* ── 里程牌（每 1000m）+ 弯道提示牌（高曲率 8 处）────────────────── */
    this.buildMarkers(group);

    /* ── 起点建筑群（石砌看台 / 维修墙 / 双塔）+ 远景废墟 ─────────────── */
    const ashlar = createAshlarTexture();
    // UV 已按实际边长换算成米 ⇒ 贴图 repeat 保持 1（见 scaleBoxUv / ASHLAR_TILE_M）
    ashlar.repeat.set(1, 1);
    this.textures.push(ashlar);
    const stone = stoneMaterial(ashlar);
    stone.vertexColors = true; // V3：窗/门洞/旗/横幅用顶点色叠加（乘 ashlar 贴图），零新增材质
    this.materials.push(stone);

    // 起点建筑群：近景投影（castShadow=true）
    // V3 近景增强：主体白色顶点色（不变色），窗洞/门洞压暗 (0.10,0.09,0.08) ⇒ 乘贴图读作深凹口。
    // 全部并入同一合并网格（仍 1 mesh 1 DC），零新增 mesh/材质。
    const startParts: THREE.BufferGeometry[] = [
      // 石砌看台：3 级台阶（22m 长，每级 2.4m 深、累计高 0.8/1.6/2.4）
      ...Array.from({ length: 3 }, (_, k) => paintGeo(boxAt(2.4, 0.8 * (k + 1), 22, 70, 17 + k * 2.4, 0), 1, 1, 1)),
      // V27 起点看台顶棚（雨棚）：覆盖后两级 + 后立柱（并入 startParts，0 新增 DC/材质）
      paintGeo(boxAt(5.0, 0.15, 23, 70, 21.8, 3.6), 0.82, 0.80, 0.76),       // 顶棚板
      paintGeo(boxAt(0.08, 0.5, 23, 70, 19.4, 3.6), 0.6, 0.58, 0.55),        // 前檐封边
      paintGeo(boxAt(0.12, 3.6, 0.12, 64, 24.2, 0), 0.22, 0.2, 0.18),         // 后立柱
      paintGeo(boxAt(0.12, 3.6, 0.12, 76, 24.2, 0), 0.22, 0.2, 0.18),
      // 维修墙：60m 长 × 1.2m 高（对侧）
      paintGeo(boxAt(0.4, 1.2, 60, 70, -13.5, 0), 1, 1, 1),
      // 两座塔楼主体 8×14×8（对侧与同侧各一，避开看台）
      paintGeo(boxAt(8, 14, 8, 30, 27, 0), 1, 1, 1),
      paintGeo(boxAt(8, 14, 8, 130, -26, 0), 1, 1, 1)
    ];
    // 塔楼窗洞：朝赛道面 2 列 × 2 行（1.3×1.7m，0.1 厚薄板凸出墙面 0.05m）
    for (const [ts, tlat] of [
      [30, 27],
      [130, -26]
    ] as ReadonlyArray<readonly [number, number]>) {
      // 塔身宽 8 ⇒ 朝赛道面在 tlat∓4；窗中心再外移 0.06（薄板贴面、不穿模）
      const face = tlat > 0 ? tlat - 4 - 0.06 : tlat + 4 + 0.06;
      for (const ws of [ts - 1.4, ts + 1.4]) {
        for (const wy of [4.6, 7.8]) {
          startParts.push(paintGeo(boxAt(0.1, 1.7, 1.3, ws, face, wy), 0.1, 0.09, 0.08));
        }
      }
      // 塔底门洞：1.6 宽 × 2.3 高
      startParts.push(paintGeo(boxAt(0.1, 2.3, 1.6, ts, face, 0.05), 0.1, 0.09, 0.08));
    }
    // 维修墙检修窗：4 处暗面板（沿 60m 墙，凸出朝赛道面 0.05m；墙厚 0.4 ⇒ 面在 −13.3）
    for (const ps of [48, 58, 82, 92]) {
      startParts.push(paintGeo(boxAt(0.1, 0.85, 2.6, ps, -13.5 + 0.26, 0.1), 0.1, 0.09, 0.08));
    }
    // V14 起点直道氛围（非发光结构并入 startGeo —— stone 材质 + 顶点色压暗，零新增 mesh/材质/DC）：
    // ① 广告牌立柱：4 块牌 × 2 根（0.12 见方 × 2.2m，压暗读作深色金属柱，牌面两端内侧 0.1m）；
    for (const [bs, blat] of START_BOARDS) {
      for (const off of [-1.9, 1.9]) {
        startParts.push(paintGeo(boxAt(0.12, 2.2, 0.12, bs + off, blat, 0), 0.16, 0.15, 0.14));
      }
    }
    // ② 发车灯架立柱 ×2（0.35 见方 × 6.2m）+ 黑色横梁（23m 跨到 ±11.5 立柱，y≈6.0）——
    //    顶点色 0.07 近黑，乘 ashlar 读作黑金属/黑梁。立柱 11.5 在走廊外（clip-free）。
    startParts.push(paintGeo(boxAt(0.35, 6.2, 0.35, START_LIGHT_S, START_LIGHT_LATERAL, 0), 0.07, 0.07, 0.07));
    startParts.push(paintGeo(boxAt(0.35, 6.2, 0.35, START_LIGHT_S, -START_LIGHT_LATERAL, 0), 0.07, 0.07, 0.07));
    startParts.push(paintGeo(boxAt(23, 0.35, 0.35, START_LIGHT_S, 0, START_LIGHT_BEAM_Y - 0.175), 0.07, 0.07, 0.07));
    // V18 维修区车库：4 间排式车库（s 45..111，lateral −17..−25，与维修墙同侧、广告牌之后）。
    // 全部并入 startParts（stone + 顶点色）→ startGeo 合并网格，0 新增 mesh/材质/DC。
    // 穿模红线（铁律）：可碰撞地面物体内缘 > 11.106 —— 车库前脸 −17、门洞外缘 −16.9、
    // 檐口外缘 −16.8，均 |lateral| ≥ 14（> 11.106）clip-free。
    // 每间 = 1 主盒（8 深 × 7 高 × 15 宽，中心 −21 ⇒ 前脸 −17 / 背面 −25）
    //       + 1 门洞暗面板（0.2 厚 × 5.5 高 × 5 宽，中心 −17.0 ⇒ 外缘 −16.9，凸出前脸 0.1m 读作黑洞）
    //       + 2 檐口压顶（s 两端各一，8.4 宽 × 0.4 高 × 0.5 深，坐顶 7m，暖灰读作压顶）。
    // 注：下发中心 −17.1 会让面板外缘与主盒前脸（−17.0）共面 → z-fight；改 −17.0 达"凸出 0.1m"。
    const GARAGE_S = [52.5, 69.5, 86.5, 103.5];
    const GARAGE_LAT = -21;
    for (const gs of GARAGE_S) {
      startParts.push(paintGeo(boxAt(8, 7, 15, gs, GARAGE_LAT, 0), 1, 1, 1));
      startParts.push(paintGeo(boxAt(0.2, 5.5, 5, gs, -17.0, 0), 0.08, 0.08, 0.07));
      for (const off of [-7.5, 7.5]) {
        startParts.push(paintGeo(boxAt(8.4, 0.4, 0.5, gs + off, GARAGE_LAT, 7), 0.9, 0.88, 0.84));
      }
    }
    const startGeo = mergeSafe(startParts);
    this.geometries.push(startGeo);
    const startMesh = new THREE.Mesh(startGeo, stone);
    startMesh.name = 'start-buildings';
    startMesh.castShadow = true;
    startMesh.receiveShadow = true;
    group.add(startMesh);
    // V14 起点直道氛围：广告牌面板（+1 mesh/+1 材质/+1 纹理）+ 发车灯 5 盏（+1 mesh/+1 材质）
    this.buildStartBoards(group);
    this.buildStartLights(group);
    // V19 起点看台观众（出生即见，s=70 正对 spawn s=−24..0）：+1 crowd InstancedMesh/+1 材质/+0 纹理（1 DC）
    this.buildStartCrowd(group);
    // V23 维修区柏油道（V18 车库前）：+1 mesh/+1 材质/+1 贴图（1 DC，38 tri）
    this.buildPitLane(group);

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

    // 远景废墟/拱门：每 2500m 一组（3~5 box），全组合并成 1 个 mesh、不投影。
    // V3：主体一律白色顶点色（与 startGeo 共用 stone.vertexColors，保持原观感）。
    const ruinParts: THREE.BufferGeometry[] = [];
    const groups = Math.min(8, Math.floor(L / 2500));
    for (let g = 0; g < groups; g++) {
      const s = g * 2500 + 400;
      const side = g % 2 === 0 ? 1 : -1;
      const lateral = side * (60 + ((g * 37) % 50));
      // 两根立柱 + 过梁 + 一段残墙
      ruinParts.push(paintGeo(boxAt(1.2, 5.5, 1.2, s, lateral, 0), 1, 1, 1));
      ruinParts.push(paintGeo(boxAt(1.2, 5.5, 1.2, s + 5, lateral, 0), 1, 1, 1));
      ruinParts.push(paintGeo(boxAt(1.4, 1.0, 6.6, s + 2.5, lateral, 5.5), 1, 1, 1));
      ruinParts.push(paintGeo(boxAt(1.0, 3.0, 4.0, s - 4, lateral + side * 3, 0), 1, 1, 1));
    }
    // 观赛点看台：北环 Brünnchen（18250）/ Aremberg（6400）/ Schwalbenschwanz（19700）、
    // 南环 Müllenbach（3505）。V11 参数化 buildGrandstand（看台+旗杆+观众），V13 扩到 3 北环观赛点。
    if (L > 15000) {
      // V32 Brünnchen 桥（s=18000 谷底）：横跨赛道石桥，车从桥下穿过（读作纽北标志性
      // 赛道穿越结构）。全部并入 ruinParts（stone + 顶点色），0 新增 mesh/材质/DC/贴图。
      this.buildBrunnchenBridge(ruinParts);
      // V34 北环直道隧道（s=13525）：横跨赛道封闭穿越结构，车从隧道内穿过（与 V32 桥
      // 「从桥下过」不同——隧道是「穿隧道内」：两侧墙 + 顶梁形成封闭感）。全部并入
      // ruinParts（stone + 顶点色），0 新增 mesh/材质/DC/贴图。只北环（L>15000 门控）。
      this.buildNorthTunnel(ruinParts);
      this.buildGrandstand(group, ruinParts, rnd, 18250);
      this.buildGrandstand(group, ruinParts, rnd, 6400);
      this.buildGrandstand(group, ruinParts, rnd, 19700);
    } else if (L < 15000) {
      this.buildGrandstand(group, ruinParts, rnd, 3505);
    }
    // V30 弯道外侧草地观众：apex 外侧（护栏后）散布人群，读作「弯道旁草地挤满观众」。
    // 独立种子、lateral ∈ [15,18] > 11.106 ⇒ 护栏后草地 clip-free（+1 DC/+1 材质/+0 贴图）。
    this.buildCornerCrowd(group);
    // V33 弯心 apex 板：弯道内侧（弯心侧）红/黄 marker 板，与 V30 观众/V31 喷绘同弯配套。
    // 板 lateral 内侧 12.5、内缘 12.2 > 11.106 ⇒ 护栏后草地 clip-free（+1 DC/+1 材质/+0 贴图）。
    this.buildCornerApexBoards(group);
    // V31 弯道旁草地赞助商喷字：apex 外侧草地大号「GELLHORN」喷字，与 V30 观众同弯配套
    // （喷绘 lateral ∈ [13,15.5] 在观众 [15,18] 内侧）。+1 mesh/+1 材质/+1 贴图（1 DC）。
    this.buildGroundAds(group);
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

  /** 观赛点看台：3 级升阶 + 栏杆/旗杆/横幅（并入 ruinParts）+ 观众人群（InstancedMesh）。
   *  参数化 sCenter（北环 Brünnchen 18250 / 南环 Müllenbach 3505），V10 门控后各自专属，
   *  消除 V2/V3/V9 的三段重复。观众小盒 0.26×0.5×0.26 + instanceColor 衣色（+1 DC/+1 材质）。 */
  private buildGrandstand(
    group: THREE.Group,
    ruinParts: THREE.BufferGeometry[],
    rnd: () => number,
    sCenter: number
  ): void {
    const track = getTrack();
    for (let k = 0; k < 3; k++) {
      ruinParts.push(paintGeo(boxAt(2.0, 1.0 * (k + 1), 16, sCenter, 18 + k * 2.0, 0), 1, 1, 1));
    }
    const railX = 16.2; // 看台首级前缘（lateral 18−1=17）再朝赛道收 0.8m
    for (const ps of [sCenter - 14, sCenter, sCenter + 14]) {
      ruinParts.push(paintGeo(boxAt(0.07, 0.95, 0.07, ps, railX, 0), 0.22, 0.2, 0.18));
    }
    ruinParts.push(paintGeo(boxAt(0.06, 0.06, 30, sCenter, railX, 0.88), 0.22, 0.2, 0.18));
    for (const fs of [sCenter - 10, sCenter + 18]) {
      ruinParts.push(paintGeo(boxAt(0.09, 4.2, 0.09, fs, 15.8, 0), 0.22, 0.2, 0.18)); // 旗杆
      ruinParts.push(paintGeo(boxAt(0.05, 0.9, 1.6, fs, 15.8, 3.3), 0.76, 0.09, 0.09)); // 红横幅
    }
    // V27 看台顶棚（雨棚）：覆盖后两级 + 后立柱（并入 ruinParts，0 新增 DC/材质）
    ruinParts.push(paintGeo(boxAt(5.0, 0.15, 17, sCenter, 22, 4.3), 0.82, 0.80, 0.76));      // 顶棚板（沿 right 宽 5、up 厚 0.15、沿 tangent 长 17）
    ruinParts.push(paintGeo(boxAt(0.08, 0.5, 17, sCenter, 19.6, 4.3), 0.6, 0.58, 0.55));    // 前檐封边（薄竖板，读作檐口压顶）
    ruinParts.push(paintGeo(boxAt(0.12, 4.3, 0.12, sCenter - 6, 24.4, 0), 0.22, 0.2, 0.18)); // 后立柱
    ruinParts.push(paintGeo(boxAt(0.12, 4.3, 0.12, sCenter + 6, 24.4, 0), 0.22, 0.2, 0.18));
    // 观众：小盒底贴台阶顶（顶 = terrainPoint.y + k+1），身半高 0.25；22% 空位、30% 双人
    const crowdSpots: { s: number; lateral: number; y: number; hue: number }[] = [];
    for (let k = 0; k < 3; k++) {
      const stepLateral = 18 + k * 2;
      const stepTop = k + 1;
      for (let s = sCenter - 13; s <= sCenter + 13; s += 2.6) {
        if (rnd() < 0.22) continue;
        const n = rnd() < 0.3 ? 2 : 1;
        for (let j = 0; j < n; j++) {
          const ss = s + (rnd() - 0.5) * 1.2;
          const ll = stepLateral + (rnd() - 0.5) * 0.8;
          const p = terrainPoint(ss, ll, new THREE.Vector3());
          crowdSpots.push({ s: ss, lateral: ll, y: p.y + stepTop + 0.25, hue: rnd() });
        }
      }
    }
    if (crowdSpots.length > 0) {
      const crowdGeo = new THREE.BoxGeometry(0.26, 0.5, 0.26);
      this.geometries.push(crowdGeo);
      const crowdMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
      this.materials.push(crowdMat);
      const crowd = new THREE.InstancedMesh(crowdGeo, crowdMat, crowdSpots.length);
      crowd.name = 'grandstand-crowd';
      crowd.castShadow = false;
      crowd.receiveShadow = false;
      const cq = new THREE.Quaternion();
      const cp = new THREE.Vector3();
      const cs = new THREE.Vector3(1, 1, 1);
      const cm = new THREE.Matrix4();
      const cc = new THREE.Color();
      for (let i = 0; i < crowdSpots.length; i++) {
        const spot = crowdSpots[i];
        const f = track.at(spot.s);
        cq.setFromAxisAngle(
          new THREE.Vector3(0, 1, 0),
          Math.atan2(f.tangent.x, f.tangent.z) + (spot.hue - 0.5) * 0.8
        );
        terrainPoint(spot.s, spot.lateral, cp);
        cp.y = spot.y;
        cm.compose(cp, cq, cs);
        crowd.setMatrixAt(i, cm);
        crowd.setColorAt(i, cc.setHSL(spot.hue, 0.45 + 0.3 * spot.hue, 0.3 + 0.35 * ((spot.hue * 7) % 1)));
      }
      crowd.instanceMatrix.needsUpdate = true;
      if (crowd.instanceColor) crowd.instanceColor.needsUpdate = true;
      crowd.computeBoundingSphere();
      group.add(crowd);
    }
  }

  /** V32 Brünnchen 桥（s=18000 谷底）：横跨赛道的石桥，车从桥下穿过（读作纽北标志性的
   *  Brünnchen 谷底赛道穿越结构，车过桥洞）。全部并入 ruinParts（stone + 顶点色），
   *  0 新增 mesh/材质/DC/贴图。
   *
   *  落点（主理人探针已确认，勿改）：s=18000 Brünnchen 谷底 —— bank=0.00°、curv≈−0.00017
   *  近直道、center.y=−8.1、观赛点 18250 前 250m。无冲突：V28 龙门架（7670/4995）远离；
   *  V30 观众/喷绘在弯道 apex（18000 无 apex）；V24 广告墙块 43(17980)/块 44(18020) 之间
   *  空隙（17986–18020）——桥 s 17997..18003，与两端广告墙纵向差 ≥15m > 11m。
   *
   *  穿模红线（铁律）：
   *  - 桥面 y5.2m 悬空（车 1.4m 从下过、桥面底距赛道面 ~5m）⇒ 零碰撞；
   *  - 桥墩内缘 11.6（lateral ±12、墩厚 0.8 ⇒ 12−0.4=11.6）、桥台内缘 11.6
   *    （lateral ±12.2、厚 1.2 ⇒ 12.2−0.6=11.6），均 > 11.106（走廊半宽 10.1+车半宽 1.006）
   *    ⇒ clip-free；
   *  - 全部横向部件（桥面/桥墩/栏杆/桥台）在 lateral ±11.6~12.2 之外或悬空 y5.2m；
   *  - 桥与 V24 广告墙（s 17980/18020）纵向差 ≥11m 无重叠；与观赛点（18250）距 250m 无重叠。
   *
   *  铁律#11（at 复用防覆写）：center/right/up/tangent 先从 track.at(18000) 拷出局部变量，
   *  再调 terrainPoint（其内部再调 at 会覆写 f）——桥墩/桥台依赖 terrainPoint，故先拷出。
   *
   *  桥面是**悬空横跨**（非落地），不能用 boxAt（boxAt 落地）——用 Matrix4.compose 手动放置；
   *  桥面/桥墩/栏杆/桥台均用 makeBasis(right, up, tangent) 朝向（横跨赛道结构）。
   *  接地铁律：桥墩/桥台用 terrainPoint(s, ±lat) 全向量 + up 偏移（勿字面式 center+right*lat+up*y）。
   *  零 RND（全确定性）：不调 makeLcg、不触既有 rnd/RND2..4 ⇒ 植被/碎石/观众布局逐点不变。 */
  private buildBrunnchenBridge(ruinParts: THREE.BufferGeometry[]): void {
    const track = getTrack();
    const S = 18000;
    const f = track.at(S);
    // 拷出（at 返回复用对象，terrainPoint 内部再调 at 会覆写 f —— 铁律#11）
    const cx = f.center.x, cy = f.center.y, cz = f.center.z;
    const rx = f.right.x, ry = f.right.y, rz = f.right.z;
    const ux = f.up.x, uy = f.up.y, uz = f.up.z;
    const tx = f.tangent.x, ty = f.tangent.y, tz = f.tangent.z;
    const right = new THREE.Vector3(rx, ry, rz);
    const up = new THREE.Vector3(ux, uy, uz);
    const tangent = new THREE.Vector3(tx, ty, tz);
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, tangent));
    const one = new THREE.Vector3(1, 1, 1);
    const DECK_UP = 5.2; // 桥面中心抬升（沿 up）
    const DECK_W = 24; // 桥面宽（沿 right）
    const DECK_T = 0.4; // 桥面厚（沿 up）
    const DECK_L = 6; // 桥面长（沿 tangent）
    const STONE: readonly [number, number, number] = [0.62, 0.6, 0.57]; // 灰石
    const RAIL: readonly [number, number, number] = [0.3, 0.28, 0.25]; // 深灰栏杆

    // 桥面中心（悬空横跨赛道，center.y=−8.1 谷底 ⇒ 桥面中心 y≈−2.9）
    const deckC = new THREE.Vector3(cx + ux * DECK_UP, cy + uy * DECK_UP, cz + uz * DECK_UP);
    const deckBottomY = deckC.y - uy * (DECK_T / 2); // 桥面底面世界 y（≈ cy+5.0）

    // ① 桥面（24 宽 × 0.4 厚 × 6 长）：悬空，手动放置（非 boxAt —— boxAt 落地）
    const deck = new THREE.BoxGeometry(DECK_W, DECK_T, DECK_L);
    scaleBoxUv(deck, DECK_W, DECK_T, DECK_L);
    deck.applyMatrix4(new THREE.Matrix4().compose(deckC, q, one));
    ruinParts.push(paintGeo(deck, STONE[0], STONE[1], STONE[2]));

    // ② 桥墩 ×2（lateral ±12、墩厚 0.8 ⇒ 内缘 11.6 > 11.106）：terrainPoint 落地 + up*(H/2)
    //    H = 桥面底 y − 地形 y（bank≈0° ⇒ uy≈1，沿 up 近似世界竖直，桥墩顶对齐桥面底）
    const pierBase = new THREE.Vector3();
    for (const side of [-1, 1]) {
      const lat = side * 12;
      terrainPoint(S, lat, pierBase);
      const pierH = deckBottomY - pierBase.y;
      const pierC = new THREE.Vector3(
        pierBase.x + ux * (pierH / 2),
        pierBase.y + uy * (pierH / 2),
        pierBase.z + uz * (pierH / 2)
      );
      const pier = new THREE.BoxGeometry(0.8, pierH, DECK_L);
      scaleBoxUv(pier, 0.8, pierH, DECK_L);
      pier.applyMatrix4(new THREE.Matrix4().compose(pierC, q, one));
      ruinParts.push(paintGeo(pier, STONE[0], STONE[1], STONE[2]));
    }

    // ③ 桥栏杆 ×2（薄板高 0.5，桥面两端内侧 lateral ±11.6，y = 桥面顶 + 0.25）：悬空，手动放置
    for (const side of [-1, 1]) {
      const lat = side * 11.6;
      const railC = new THREE.Vector3(
        deckC.x + rx * lat + ux * (DECK_T / 2 + 0.25),
        deckC.y + ry * lat + uy * (DECK_T / 2 + 0.25),
        deckC.z + rz * lat + uz * (DECK_T / 2 + 0.25)
      );
      const rail = new THREE.BoxGeometry(0.08, 0.5, DECK_L);
      scaleBoxUv(rail, 0.08, 0.5, DECK_L);
      rail.applyMatrix4(new THREE.Matrix4().compose(railC, q, one));
      ruinParts.push(paintGeo(rail, RAIL[0], RAIL[1], RAIL[2]));
    }

    // ④ 桥台 ×2（两端支撑基座，lateral ±12.2、厚 1.2 ⇒ 内缘 11.6 > 11.106）：terrainPoint 落地
    const abutBase = new THREE.Vector3();
    for (const side of [-1, 1]) {
      const lat = side * 12.2;
      terrainPoint(S, lat, abutBase);
      const abutC = new THREE.Vector3(
        abutBase.x + ux * 0.4,
        abutBase.y + uy * 0.4,
        abutBase.z + uz * 0.4
      );
      const abut = new THREE.BoxGeometry(1.2, 0.8, DECK_L);
      scaleBoxUv(abut, 1.2, 0.8, DECK_L);
      abut.applyMatrix4(new THREE.Matrix4().compose(abutC, q, one));
      ruinParts.push(paintGeo(abut, STONE[0], STONE[1], STONE[2]));
    }
  }

  /** V34 北环直道隧道（s=13525）：横跨赛道的封闭穿越结构，车从隧道内穿过（读作纽北
   *  隧道，与 V32 桥「从桥下过」不同——隧道是「穿隧道内」：两侧墙 + 顶梁形成封闭感）。
   *  全部并入 ruinParts（stone + 顶点色），0 新增 mesh/材质/DC/贴图。
   *
   *  落点（主理人探针已确认，勿改）：s=13525 北环直道 —— bank=0.00°、curv≈0.00000、
   *  center.y=7.2、属 1670m 连续直道段 [12690,14360]。该段全程 |curv|<0.002 ⇒ 无弯道
   *  apex（无 V30-33 弯道设施、无 V16/21/22 弯道设施）；离观赛点 6400/18250/19700 均
   *  ≥4700m；离 V24 广告墙段起点 16100 有 ≥2500m；离 V28 龙门架 7670/4995 均 ≥3000m；
   *  离 V14 起点区（s<600）≥12000m。全部无冲突。只北环（L>15000 门控），南环不做隧道。
   *
   *  穿模红线（铁律）：
   *  - 顶梁 y5.2m 悬空（车 1.4m 从下过、净空 ~3.8m）⇒ 零碰撞；
   *  - 侧墙内缘 11.3（lateral ±11.5、厚 0.4 ⇒ 11.5−0.2=11.3）、洞口内缘 11.3
   *    （lateral ±11.9、厚 1.2 ⇒ 11.9−0.6=11.3），均 > 11.106（走廊半宽 10.1+车半宽 1.006）
   *    ⇒ clip-free；
   *  - 全部横向部件（顶梁/侧墙/洞口/压顶）在 lateral ±11.5~11.9 之外或悬空 y5.2m；
   *  - 隧道 s=13515..13535（20m），与 V24 广告墙（起点 16100）差 ≥2500m、与观赛点
   *    （6400/18250/19700）差 ≥4700m，无重叠。
   *
   *  铁律#11（at 复用防覆写）：center/right/up/tangent 先从 track.at(13525) 拷出局部变量，
   *  再调 terrainPoint（其内部再调 at 会覆写 f）——侧墙/洞口依赖 terrainPoint，故先拷出。
   *
   *  顶梁/压顶是**悬空横跨**（非落地），不能用 boxAt（boxAt 落地）——用 Matrix4.compose
   *  手动放置；均用 makeBasis(right, up, tangent) 朝向（横跨赛道结构）。
   *  接地铁律：侧墙/洞口用 terrainPoint(s, ±lat) 全向量 + up 偏移（勿字面式
   *  center+right*lat+up*y）。此处 y=7.2 非高架，但统一用 terrainPoint 正确。
   *  零 RND（全确定性）：不调 makeLcg、不触既有 rnd/RND2..4 ⇒ 植被/碎石/观众布局逐点不变。 */
  private buildNorthTunnel(ruinParts: THREE.BufferGeometry[]): void {
    const track = getTrack();
    const S = 13525;
    const HALF_L = 10; // 隧道半长（沿 tangent，s=13515..13535，共 20m）
    const f = track.at(S);
    // 拷出（at 返回复用对象，terrainPoint 内部再调 at 会覆写 f —— 铁律#11）
    const cx = f.center.x, cy = f.center.y, cz = f.center.z;
    const rx = f.right.x, ry = f.right.y, rz = f.right.z;
    const ux = f.up.x, uy = f.up.y, uz = f.up.z;
    const tx = f.tangent.x, ty = f.tangent.y, tz = f.tangent.z;
    const right = new THREE.Vector3(rx, ry, rz);
    const up = new THREE.Vector3(ux, uy, uz);
    const tangent = new THREE.Vector3(tx, ty, tz);
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, tangent));
    const one = new THREE.Vector3(1, 1, 1);
    const BEAM_UP = 5.2; // 顶梁中心抬升（沿 up）⇒ 底 y≈cy+5.0，净空 ~3.8m
    const BEAM_W = 24; // 顶梁宽（沿 right，横跨 ±12）
    const BEAM_T = 0.4; // 顶梁厚（沿 up）
    const BEAM_L = 2 * HALF_L; // 顶梁长（沿 tangent，20m）
    const WALL_LAT = 11.5; // 侧墙 lateral（厚 0.4 ⇒ 内缘 11.3 > 11.106）
    const WALL_T = 0.4; // 侧墙厚（沿 right）
    const PORTAL_LAT = 11.9; // 洞口拱框 lateral（厚 1.2 ⇒ 内缘 11.3 > 11.106）
    const PORTAL_T = 1.2; // 拱框厚（沿 right）
    const PORTAL_H = 3.2; // 拱框高（沿 up，落地 + up*1.6）
    const PORTAL_D = 1.2; // 拱框深（沿 tangent）
    const LINTEL_H = 1.2; // 压顶高（沿 up）
    const STONE: readonly [number, number, number] = [0.62, 0.6, 0.57]; // 灰石
    const DARK: readonly [number, number, number] = [0.3, 0.28, 0.25]; // 深灰（洞口）

    // 顶梁中心（悬空横跨赛道，center.y=7.2 ⇒ 顶梁中心 y≈12.4、底 y≈12.2、净空 ~3.8m）
    const beamC = new THREE.Vector3(cx + ux * BEAM_UP, cy + uy * BEAM_UP, cz + uz * BEAM_UP);
    const beamBottomY = beamC.y - uy * (BEAM_T / 2); // 顶梁底面世界 y（≈ cy+5.0）

    // ① 顶梁（24 宽 × 0.4 厚 × 20 长）：悬空横跨，手动放置（非 boxAt —— boxAt 落地）
    const beam = new THREE.BoxGeometry(BEAM_W, BEAM_T, BEAM_L);
    scaleBoxUv(beam, BEAM_W, BEAM_T, BEAM_L);
    beam.applyMatrix4(new THREE.Matrix4().compose(beamC, q, one));
    ruinParts.push(paintGeo(beam, STONE[0], STONE[1], STONE[2]));

    // ② 侧墙 ×2（lateral ±11.5、厚 0.4 ⇒ 内缘 11.3 > 11.106）：terrainPoint 落地 + up*(H/2)
    //    H = 顶梁底 y − 地形 y（bank≈0° ⇒ uy≈1，侧墙顶对齐顶梁底）
    const wallBase = new THREE.Vector3();
    for (const side of [-1, 1]) {
      const lat = side * WALL_LAT;
      terrainPoint(S, lat, wallBase);
      const wallH = beamBottomY - wallBase.y;
      const wallC = new THREE.Vector3(
        wallBase.x + ux * (wallH / 2),
        wallBase.y + uy * (wallH / 2),
        wallBase.z + uz * (wallH / 2)
      );
      const wall = new THREE.BoxGeometry(WALL_T, wallH, BEAM_L);
      scaleBoxUv(wall, WALL_T, wallH, BEAM_L);
      wall.applyMatrix4(new THREE.Matrix4().compose(wallC, q, one));
      ruinParts.push(paintGeo(wall, STONE[0], STONE[1], STONE[2]));
    }

    // ③ 洞口拱框 ×4（两端 s=13525±10 × 两侧 lateral ±11.9，厚 1.2 ⇒ 内缘 11.3 > 11.106）：
    //    terrainPoint 落地 + up*1.6（读作隧道入口门柱，深灰）
    const portalBase = new THREE.Vector3();
    for (const end of [-1, 1]) {
      for (const side of [-1, 1]) {
        const lat = side * PORTAL_LAT;
        terrainPoint(S + end * HALF_L, lat, portalBase);
        const portalC = new THREE.Vector3(
          portalBase.x + ux * (PORTAL_H / 2),
          portalBase.y + uy * (PORTAL_H / 2),
          portalBase.z + uz * (PORTAL_H / 2)
        );
        const portal = new THREE.BoxGeometry(PORTAL_T, PORTAL_H, PORTAL_D);
        scaleBoxUv(portal, PORTAL_T, PORTAL_H, PORTAL_D);
        portal.applyMatrix4(new THREE.Matrix4().compose(portalC, q, one));
        ruinParts.push(paintGeo(portal, DARK[0], DARK[1], DARK[2]));
      }
    }

    // ④ 端部压顶 ×2（洞口上方横梁，portal 楣）：24 宽 × 1.2 高 × 1.2 深，悬空手动放置，
    //    y = 顶梁底 − 0.6（压顶顶对齐顶梁底，与顶梁同高段）。两端 s=13525±10。
    for (const end of [-1, 1]) {
      const lintelC = new THREE.Vector3(
        cx + tx * (end * HALF_L) + ux * (BEAM_UP - BEAM_T / 2 - LINTEL_H / 2),
        cy + ty * (end * HALF_L) + uy * (BEAM_UP - BEAM_T / 2 - LINTEL_H / 2),
        cz + tz * (end * HALF_L) + uz * (BEAM_UP - BEAM_T / 2 - LINTEL_H / 2)
      );
      const lintel = new THREE.BoxGeometry(BEAM_W, LINTEL_H, PORTAL_D);
      scaleBoxUv(lintel, BEAM_W, LINTEL_H, PORTAL_D);
      lintel.applyMatrix4(new THREE.Matrix4().compose(lintelC, q, one));
      ruinParts.push(paintGeo(lintel, STONE[0], STONE[1], STONE[2]));
    }
  }

  /** V30 弯道外侧草地观众：在弯道 apex 外侧（护栏后）散布观众人群，读作纽北标志性场景
   *  「弯道旁草地挤满观众」。复用 V19 观众模式（小盒 0.26×0.5×0.26 InstancedMesh + instanceColor 衣色），
   *  零新增贴图。→ +1 crowd InstancedMesh / +1 材质 / +0 纹理（1 DC）。
   *
   *  apex 选择走 selectApexes（全设施同源）：沿全弧长采样（步长 10m）收集 |curv|>0.006
   *  候选 {s, c}，按 |c| 降序取前 8、且与已选 apex 间距 >700m（北环 6 / 南环 6，符合密度）。
   *  南环 curvature 序列与北环不同，apex 数少（≈4），无需 L>15000 门控。
   *
   *  穿模红线（铁律）：观众 lateral ∈ [15,18] > 11.106（走廊半宽 railLimit 10.1 + 车半宽 1.006）
   *  ⇒ 护栏后草地、clip-free；与轮胎墙(12.4)/制动牌(12.8)/岗亭(14.5) 天然避让（均 ≤14.5 < 15）；
   *  龙门架/广告墙在直道、弯道 apex 不同 s，无冲突。castShadow/receiveShadow=false（装饰小盒不投影）。
   *  独立种子 0x3a6e9b 不扰既有 rnd/RND2..4（植被/碎石/看台观众布局逐点不变）。
   *  at() 复用防覆写（铁律#11）：实例化时 tangent 先拷出，terrainPoint（其内部再调 at）前完成。 */
  private buildCornerCrowd(group: THREE.Group): void {
    const track = getTrack();
    // 1) apex 收集：|curv|>0.006（曲率半径 <167m 才算急弯），保留带符号 c 以算外侧。
    //    步长 10m 与 buildBrakeMarks（Track.ts L1048）完全一致 ⇒ 观众与刹车痕/砾石带/
    //    轮胎墙/制动牌/横幅同弯配套（读作「观众在刹车弯道旁」）。
    const apexes = selectApexes(getCurrentMode());
    if (apexes.length === 0) return;
    // 2) 观众布局（独立 LCG：方法内创建一次、循环内连续调用，不扰既有 rnd/RND2..4）
    const RND = makeLcg(0x3a6e9b);
    const crowdSpots: { s: number; lateral: number; y: number; hue: number }[] = [];
    for (const apex of apexes) {
      const outside = apex.c > 0 ? 1 : -1; // curv>0 左弯 ⇒ 外侧 +right；curv<0 ⇒ 外侧 −right
      const n = 10 + Math.floor(RND() * 9); // 每 apex 10-18 人
      for (let i = 0; i < n; i++) {
        const ss = apex.s + (RND() - 0.5) * 50; // apex±25m 沿弧长
        const lateral = outside * (15 + RND() * 3); // 外侧 15-18m
        const p = terrainPoint(ss, lateral, new THREE.Vector3());
        p.y += 0.25; // 小盒半高 0.25，底贴草地
        crowdSpots.push({ s: ss, lateral, y: p.y, hue: RND() });
      }
    }
    // 3) 实例化（完全复刻 V19 观众创建块）
    if (crowdSpots.length === 0) return;
    const crowdGeo = new THREE.BoxGeometry(0.26, 0.5, 0.26);
    this.geometries.push(crowdGeo);
    const crowdMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
    this.materials.push(crowdMat);
    const crowd = new THREE.InstancedMesh(crowdGeo, crowdMat, crowdSpots.length);
    crowd.name = 'corner-crowd';
    crowd.castShadow = false;
    crowd.receiveShadow = false;
    const cq = new THREE.Quaternion();
    const cp = new THREE.Vector3();
    const cs = new THREE.Vector3(1, 1, 1);
    const cm = new THREE.Matrix4();
    const cc = new THREE.Color();
    for (let i = 0; i < crowdSpots.length; i++) {
      const spot = crowdSpots[i];
      const f = track.at(spot.s);
      const tx = f.tangent.x; // 拷出（at() 复用防覆写：terrainPoint 内部再调 at）
      const tz = f.tangent.z;
      cq.setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        Math.atan2(tx, tz) + (spot.hue - 0.5) * 0.8
      );
      terrainPoint(spot.s, spot.lateral, cp);
      cp.y = spot.y;
      cm.compose(cp, cq, cs);
      crowd.setMatrixAt(i, cm);
      crowd.setColorAt(i, cc.setHSL(spot.hue, 0.45 + 0.3 * spot.hue, 0.3 + 0.35 * ((spot.hue * 7) % 1)));
    }
    crowd.instanceMatrix.needsUpdate = true;
    if (crowd.instanceColor) crowd.instanceColor.needsUpdate = true;
    crowd.computeBoundingSphere();
    group.add(crowd);
  }

  /** V33 弯心 apex 板：在每个弯道**弯心（apex）内侧**立一块红/黄 marker 板，读作真实赛道
   *  弯道内侧的 apex 指示板（驾驶员入弯看到板面标弯心）。
   *  → +1 mesh / +1 材质 / +0 贴图（1 DC，所有 apex 板合并到 1 个 BufferGeometry）。
   *
   *  apex 选择与 buildCornerCrowd/buildGroundAds **完全同源**（沿 s=300..L−300 步长 10 采样
   *  收集 |curv|>0.006 候选，按 |c| 降序取前 8、间距 >700），保证 apex 板与观众/喷绘/
   *  轮胎墙/制动牌同弯配套。南环 curvature 序列不同、apex 数少（≈4），无 L>15000 门控。
   *
   *  穿模红线（铁律）：板 lateral 内侧 12.5、宽（right）0.6 ⇒ 内缘 12.5−0.3=12.2 > 11.106
   *  （走廊半宽 10.1 + 车半宽 1.006）⇒ 护栏后草地 clip-free。板在弯道**内侧**（弯心侧，
   *  inside=−outside），内侧无设施（轮胎墙 12.4/制动牌 12.8/喷绘 13-15.5/岗亭 14.5 全在
   *  **外侧**）⇒ 天然避让。⚠ 板必须放**内侧**（inside=−outside），非外侧（外侧与轮胎墙/
   *  喷绘冲突）。
   *
   *  接地铁律：板用 terrainPoint(s, lat) 全向量 + up 偏移（勿字面式 center+right*lat+
   *  up*(worldY)，高架段会悬空）。板高 0.5、底贴地 ⇒ 板中心 up*0.25。
   *
   *  铁律#11（at 复用防覆写）：right/up/tangent 先从 track.at(apex.s) 拷出局部变量，
   *  再调 terrainPoint（其内部再调 at）⇒ 防覆写。
   *
   *  零 RND（全确定性）：红/黄交替用索引 i%2，不调 makeLcg、不触既有 rnd/RND2..4
   *  ⇒ 植被/碎石/观众/喷绘布局逐点不变。 */
  private buildCornerApexBoards(group: THREE.Group): void {
    const track = getTrack();
    // 1) apex 收集（与 buildCornerCrowd/buildGroundAds 完全同源）：|curv|>0.006（曲率半径
    //    <167m 才算急弯），保留带符号 c 以算内侧。步长 10m 与 buildBrakeMarks 完全一致。
    const apexes = selectApexes(getCurrentMode());
    if (apexes.length === 0) return;
    // 2) 每 apex 1 块板（弯道内侧弯心），合并到 1 个 BufferGeometry
    const parts: THREE.BufferGeometry[] = [];
    const one = new THREE.Vector3(1, 1, 1);
    for (let i = 0; i < apexes.length; i++) {
      const apex = apexes[i];
      // 内侧 = −外侧 = 弯心侧：c>0 左弯弯心在 −right ⇒ inside=−1；c<0 右弯弯心在 +right ⇒ inside=+1
      const inside = apex.c > 0 ? -1 : 1;
      const lat = inside * 12.5; // 板 lateral 内侧 12.5，内缘 12.5−0.3=12.2 > 11.106 clip-free
      const s = apex.s;
      const f = track.at(s);
      // 拷出 right/up/tangent（at() 返回复用对象，terrainPoint 内部再调 at 会覆写 f —— 铁律#11）
      const rx = f.right.x, ry = f.right.y, rz = f.right.z;
      const ux = f.up.x, uy = f.up.y, uz = f.up.z;
      const tx = f.tangent.x, ty = f.tangent.y, tz = f.tangent.z;
      const right = new THREE.Vector3(rx, ry, rz);
      const up = new THREE.Vector3(ux, uy, uz);
      const tangent = new THREE.Vector3(tx, ty, tz);
      const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, tangent));
      // 板几何：宽 0.6（沿 right）、高 0.5（沿 up）、厚 0.1（沿 tangent）——板面为 ±z 面，
      // 来车从 −tangent 方向看到板面（驾驶员入弯看到板面标弯心）。
      const geo = new THREE.BoxGeometry(0.6, 0.5, 0.1);
      // 放置：terrainPoint + up*0.25（板中心，半高 0.25 ⇒ 板底贴地；接地铁律：全向量 + up 偏移）
      const p = terrainPoint(s, lat, new THREE.Vector3());
      p.x += ux * 0.25;
      p.y += uy * 0.25;
      p.z += uz * 0.25;
      geo.applyMatrix4(new THREE.Matrix4().compose(p, q, one));
      // 顶点色：红/黄交替（i 为 apex 索引，i%2 确定性，零 RND）——读作 marker 板。
      const col = i % 2 === 0 ? [0.85, 0.12, 0.1] : [0.9, 0.7, 0.1];
      paintGeo(geo, col[0], col[1], col[2]);
      parts.push(geo);
    }
    if (parts.length === 0) return;
    // 3) 合并 + mesh（+1 DC/+1 材质/0 贴图）：所有 apex 板 1 个 mesh，顶点色红/黄。
    const geo = mergeSafe(parts);
    this.geometries.push(geo);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.85 });
    this.materials.push(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'apex-boards';
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    group.add(mesh);
  }

  /** V31 弯道旁草地赞助商喷字：在弯道 apex 外侧草地喷大号 "GELLHORN" 字样，
   *  读作纽北标志性的「弯道旁草地赞助商喷字」，与 V30 弯道外侧观众同弯配套
   *  （喷绘在观众前：喷绘 lateral ∈ [13,15.5]、观众 ∈ [15,18]）。
   *  → +1 mesh / +1 材质 / +1 贴图（1 DC，所有 apex 合并到 1 个 BufferGeometry）。
   *
   *  apex 选择与 buildCornerCrowd **完全同源**（沿 s=300..L−300 步长 10 采样收集 |curv|>0.006
   *  候选，按 |c| 降序取前 8、间距 >700），保证喷绘与观众/刹车痕/轮胎墙/制动牌同弯配套。
   *  南环 curvature 序列不同、apex 数少（≈4），无 L>15000 门控。
   *
   *  穿模红线（铁律）：喷绘 lateral ∈ [13,15.5] > 11.106（走廊半宽 10.1 + 车半宽 1.006）；
   *  贴地平面抬升 up*0.03、无 3D 碰撞 ⇒ 零穿模。避让：制动牌（apex−100/−50/−25，lateral 12.8）
   *  在喷绘区（apex±15）外；岗亭（apex+30，14.5）在 +15 外；轮胎墙（12.4，跨 apex±1.9）在喷绘
   *  前可共存；观众（15-18）在喷绘后。
   *
   *  铁律#11（长条几何）：喷绘 30m 长沿弯道，**顶点级沿弧长弯曲**（复用 V23 buildPitLane 技术：
   *  每 3m 采样顶点级 terrainPoint + up*0.03）——只挪中心会横穿曲线。
   *
   *  绕序（铁律）：递增列序 [latMin, latMax]（lateral 数值增）⇒ 法线朝上（同 V23 [LAT_OUTER,
   *  LAT_INNER] 递增，勿回退）。外侧方向随弯向（outside = c>0?1:−1）：
   *  - outside=+1：col0=latNear=13（v=1，近路面）、col1=latFar=15.5（v=0，远草地）；
   *  - outside=−1：col0=latFar=−15.5（v=0，远草地）、col1=latNear=−13（v=1，近路面）——
   *    交换 col 序保递增（否则 [−13,−15.5] 递减会给**向下**法线、路面被背面剔除），
   *    v 语义仍保持「近路面→1 / 远草地→0」，文字顶恒朝远离路面侧。
   *
   *  零 RND（喷绘内容/位置全确定性）：不调 makeLcg、不触既有 rnd/RND2..4 ⇒ 重大回归防线。
   *  at() 复用防覆写（铁律#11）：每环 up 先拷出，terrainPoint（其内部再调 at）前完成。 */
  private buildGroundAds(group: THREE.Group): void {
    const track = getTrack();
    // 1) apex 收集（与 buildCornerCrowd 完全同源）：|curv|>0.006、按 |c| 降序取前 8、间距 >700
    const apexes = selectApexes(getCurrentMode());
    if (apexes.length === 0) return;
    // 2) 合并所有 apex 的 quad 到 1 个 BufferGeometry（+1 DC）：pos/uv/idx 动态收集，base 按顶点数偏移
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const p = new THREE.Vector3();
    let base = 0;
    for (const apex of apexes) {
      const outside = apex.c > 0 ? 1 : -1; // curv>0 左弯 ⇒ 外侧 +right；curv<0 ⇒ 外侧 −right
      const latNear = outside * 13.0; // 近路面（护栏后 0.9m）
      const latFar = outside * 15.5; // 远草地（观众 [15,18] 内侧，喷绘在观众前）
      // 递增列序（法线朝上）：col0=latMin、col1=latMax。
      // v 语义「近路面→0 / 远草地→1」——与 V23 buildPitLane（近路面 v=0）完全一致，
      // 保证贴地文字读向与 V23 PIT 相同（读正）。u/v 相对世界固定（u=tangent、v=lateral），
      // 与位于赛道左/右侧无关；⚠ 勿改为「近路面→1」（与 V23 相反 ⇒ 字上下颠倒）。
      const latMin = Math.min(latNear, latFar);
      const latMax = Math.max(latNear, latFar);
      const vMin = latMin === latNear ? 0 : 1;
      const vMax = latMax === latNear ? 0 : 1;
      // sList：apex−15 到 apex+15，每 3m 采样 + 尾点（仿 V23 buildPitLane L982-984）
      const sList: number[] = [];
      for (let s = apex.s - 15; s < apex.s + 15; s += 3) sList.push(s);
      sList.push(apex.s + 15);
      const rings = sList.length;
      const cols = 2;
      for (let i = 0; i < rings; i++) {
        const s = sList[i];
        const f = track.at(s);
        // at() 返回复用对象：up 必须在 terrainPoint（其内部再调 at）前拷出，防被覆写（铁律#11）
        const upx = f.up.x;
        const upy = f.up.y;
        const upz = f.up.z;
        const u = (s - (apex.s - 15)) / 30; // 沿弧长 0..1
        for (let c = 0; c < cols; c++) {
          const lat = c === 0 ? latMin : latMax;
          terrainPoint(s, lat, p);
          p.x += upx * 0.03; // 抬升 0.03 防与草地 z-fight（贴地平面、无 3D 碰撞 ⇒ 零穿模）
          p.y += upy * 0.03;
          p.z += upz * 0.03;
          pos.push(p.x, p.y, p.z);
          uv.push(u, c === 0 ? vMin : vMax);
        }
      }
      // 索引（仿 V23 L1013-1016）：base 按当前顶点数偏移（每 apex rings*cols 顶点）
      for (let i = 0; i < rings - 1; i++) {
        const b = base + i * cols;
        idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
      }
      base += rings * cols;
    }
    // 3) 纹理（透明底 + 白色 "GELLHORN"，喷在草地上透明处露草地）
    const tex = createGroundAdTexture();
    this.textures.push(tex);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: tex,
      transparent: true,
      roughness: 0.9,
      metalness: 0.02,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      depthWrite: false // 透明贴花：不写深度，防 z-fight 且不遮挡后方植被
    });
    this.materials.push(mat);
    // 4) 几何 + mesh
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    this.geometries.push(geo);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'ground-ads';
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  /** V19 起点看台观众（出生即见：spawn s=−24..0 正对 s=70 起点看台）。
   *  复刻 V9/V11 弯道观赛点观众模式（小盒 0.26×0.5×0.26 + instanceColor 衣色），
   *  但参数固定到起点看台 3 级台阶：级中心 lateral = 17/19.4/21.8（2.4m 深）、
   *  级顶 = 0.8/1.6/2.4、沿 s 59..81（看台 22m 长，留 1m 边 ⇒ 落位钳 [60,80]）、
   *  每 2.6m 一格、22% 空位、30% 双人。
   *  → +1 crowd InstancedMesh / +1 材质 / +0 纹理（1 DC，小盒 12 tri × 27 ≈ 324 tri）。
   *  观众 lateral 钳 ≥17 > 11.106 ⇒ clip-free；不投影不接收阴影（V9 同款）。
   *  独立 LCG（START_CROWD_RND）不扰动主 rnd 序列 —— 既有弯道观赛点/树/石布局逐点不变。 */
  private buildStartCrowd(group: THREE.Group): void {
    const track = getTrack();
    const SC = makeLcg(0x7a5c31); // 独立种子：确定性可复现，且不影响既有 rnd / RND2..4 布局
    const crowdSpots: { s: number; lateral: number; y: number; hue: number }[] = [];
    for (let k = 0; k < 3; k++) {
      const stepLateral = 17 + k * 2.4; // 级中心（k=0/1/2 → 17/19.4/21.8）
      const stepTop = 0.8 * (k + 1); // 级顶高（0.8/1.6/2.4）
      for (let s = 70 - 11; s <= 70 + 11; s += 2.6) {
        if (SC() < 0.22) continue;
        const n = SC() < 0.3 ? 2 : 1;
        for (let j = 0; j < n; j++) {
          const ss = Math.min(80, Math.max(60, s + (SC() - 0.5) * 1.2)); // 留 1m 边，不入 59/81 端缘
          const ll = Math.max(17, stepLateral + (SC() - 0.5) * 0.8); // 钳 ≥17 保 clip-free
          const p = terrainPoint(ss, ll, new THREE.Vector3());
          crowdSpots.push({ s: ss, lateral: ll, y: p.y + stepTop + 0.25, hue: SC() });
        }
      }
    }
    if (crowdSpots.length > 0) {
      const crowdGeo = new THREE.BoxGeometry(0.26, 0.5, 0.26);
      this.geometries.push(crowdGeo);
      const crowdMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
      this.materials.push(crowdMat);
      const crowd = new THREE.InstancedMesh(crowdGeo, crowdMat, crowdSpots.length);
      crowd.name = 'start-grandstand-crowd';
      crowd.castShadow = false;
      crowd.receiveShadow = false;
      const cq = new THREE.Quaternion();
      const cp = new THREE.Vector3();
      const cs = new THREE.Vector3(1, 1, 1);
      const cm = new THREE.Matrix4();
      const cc = new THREE.Color();
      for (let i = 0; i < crowdSpots.length; i++) {
        const spot = crowdSpots[i];
        const f = track.at(spot.s);
        cq.setFromAxisAngle(
          new THREE.Vector3(0, 1, 0),
          Math.atan2(f.tangent.x, f.tangent.z) + (spot.hue - 0.5) * 0.8
        );
        terrainPoint(spot.s, spot.lateral, cp);
        cp.y = spot.y;
        cm.compose(cp, cq, cs);
        crowd.setMatrixAt(i, cm);
        crowd.setColorAt(i, cc.setHSL(spot.hue, 0.45 + 0.3 * spot.hue, 0.3 + 0.35 * ((spot.hue * 7) % 1)));
      }
      crowd.instanceMatrix.needsUpdate = true;
      if (crowd.instanceColor) crowd.instanceColor.needsUpdate = true;
      crowd.computeBoundingSphere();
      group.add(crowd);
    }
  }

  /** V23 维修区柏油道（V18 车库前 s 40..115，lateral −11.6..−17.0）。
   *  quad strip + 程序化贴图 → +1 mesh / +1 材质 / +1 贴图（1 DC），19 段 × 2 = 38 tri。
   *  贴地：顶点 = terrainPoint(s,lateral) + up*0.02（|lateral|≤24 走廊平坦，防与草地 z-fight）。
   *  绕序与 buildRibbon 同源朝上：列序 **[latOuter, latInner]**（递增 lateral）⇒ 法线 =
   *  cross(tangent, right) = up 朝上（⚠ 若按任务书字面 (inner,outer) 序会给**向下**法线，
   *  路面会被背面剔除 —— 故取递增列序，UV 的 v 仍为 inner=0 / outer=1 不变）。
   *  零立柱/凸起 ⇒ 无穿模（车在 railLimit −10.1 内，够不到 −11.6 之外）；
   *  castShadow=false / receiveShadow=true；不改 V14-V22 既有 builder。 */
  private buildPitLane(group: THREE.Group): void {
    const track = getTrack();
    const S0 = 40;
    const S1 = 115;
    const LAT_INNER = -11.6; // 路肩外缘（近路面）
    const LAT_OUTER = -17.0; // 车库前脸（近车库，避免与车库盒重叠）
    // s 每 4m 采样 + 尾点 115（≈19 段 ⇒ 20 环）
    const sList: number[] = [];
    for (let s = S0; s < S1; s += 4) sList.push(s);
    sList.push(S1);
    const rings = sList.length;
    const cols = 2; // col0=latOuter(v=1)、col1=latInner(v=0)（递增 lateral ⇒ 法线朝上）
    const pos = new Float32Array(rings * cols * 3);
    const uv = new Float32Array(rings * cols * 2);
    const idx: number[] = [];
    const p = new THREE.Vector3();
    for (let i = 0; i < rings; i++) {
      const s = sList[i];
      const f = track.at(s);
      // at() 返回复用对象：up 必须在 terrainPoint（其内部再调 at）前拷出，防被覆写
      const upx = f.up.x;
      const upy = f.up.y;
      const upz = f.up.z;
      for (let c = 0; c < cols; c++) {
        const lat = c === 0 ? LAT_OUTER : LAT_INNER;
        terrainPoint(s, lat, p);
        p.x += upx * 0.02;
        p.y += upy * 0.02;
        p.z += upz * 0.02;
        const o = (i * cols + c) * 3;
        pos[o] = p.x;
        pos[o + 1] = p.y;
        pos[o + 2] = p.z;
        const t = (i * cols + c) * 2;
        uv[t] = (s - S0) / (S1 - S0);
        uv[t + 1] = c === 0 ? 1 : 0; // v: latOuter=1、latInner=0
      }
    }
    for (let i = 0; i < rings - 1; i++) {
      const base = i * cols;
      idx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    this.geometries.push(geo);
    const tex = createPitLaneTexture();
    this.textures.push(tex);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: tex,
      roughness: 0.9,
      metalness: 0.02
    });
    this.materials.push(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'pit-lane';
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  /** 里程牌（21 根）+ 弯道提示牌（8 处，曲率最大的采样点） */
  private buildMarkers(group: THREE.Group): void {
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

    // 弯道提示牌：最高曲率急弯。旧法沿 s 扫描取 |curv|>0.018 常凑不满 8，while 兜底
    // 把牌落在任意直道（curv≈0），chevron 方向无意义。改为：收集全部 |curv|>0.006
    // 候选（曲率半径 <167m 才算急弯），按 |curv| 降序取前 8、间距 >700，**不强凑数量**
    // （牌数 = 实际急弯数，北环 ≈6 / 南环 ≈4），保证每块牌立在真实弯道且方向有效。
    const curveS: number[] = [];
    const curveCand: { s: number; c: number }[] = [];
    for (let s = 300; s < L - 300; s += 10) {
      const f = track.at(s);
      const c = Math.abs(f.curvature);
      if (c > 0.006) curveCand.push({ s, c });
    }
    curveCand.sort((a, b) => b.c - a.c);
    for (const { s } of curveCand) {
      if (curveS.length >= 8) break;
      if (curveS.every((v) => Math.abs(v - s) > 700)) curveS.push(s);
    }
    // 防御：极端直道赛道（候选 0）时均匀放 4 块兜底，避免 InstancedMesh 空
    if (curveS.length === 0) {
      for (let s = 500; s < L - 500 && curveS.length < 4; s += 1200) curveS.push(s);
    }
    const cPostGeo = new THREE.BoxGeometry(0.14, 1.9, 0.14);
    const cPlateGeo = new THREE.BoxGeometry(0.9, 0.9, 0.06);
    this.geometries.push(cPostGeo, cPlateGeo);
    // 弯道牌专用 chevron 材质：不污染共享 plateMat/postMat（里程牌 plates/posts 仍用它们）
    const chevronTex = createChevronTexture();
    this.textures.push(chevronTex);
    const chevronMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: chevronTex,
      roughness: 0.7,
      metalness: 0.1
    });
    this.materials.push(chevronMat);
    const cPosts = new THREE.InstancedMesh(cPostGeo, postMat, curveS.length);
    const cPlates = new THREE.InstancedMesh(cPlateGeo, chevronMat, curveS.length);
    cPosts.name = 'curve-sign-posts';
    cPlates.name = 'curve-sign-plates';
    cPosts.castShadow = false;
    cPlates.castShadow = false;
    // 左弯牌绕牌面本地法线（本地 Z）翻 π：把 chevron 从观察者右侧翻到左侧。
    // 牌面绕 Y 转 (heading+π) 后，牌本地 +X = 观察者（来车）看到的**左侧**
    // （验算：车朝北 +Z 时牌本地 +X → 世界 −X=西=驾驶员左；与 nordschleife
    //  right=up×tangent 自洽）。纹理箭头画在本地 −X（观察者右侧）= 默认指示**右弯**；
    // 故左弯（curvature>0）需翻 π。绕本地轴旋转必须**右乘**（q 先应用、再在 q 的
    // 局部坐标里转）；左乘会把牌面转出竖直平面。复用同一四元数（8 处只构造一次）。
    const FLIP_Z = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI);
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
      // 左弯（curvature>0）：牌面翻 π 让箭头指观察者左侧（弯道内侧）；柱子用原始 q（对称方柱不受影响）
      if (f.curvature > 0) q.multiply(FLIP_Z);
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

  /** V14 广告牌面板：4 块横幅板（同材质同纹理 + 顶点色明度区分 4 块），立柱已并入 startGeo。
   *  → +1 mesh / +1 材质 / +1 纹理（横幅 canvasTexture，程序化、零外部资源）。 */
  private buildStartBoards(group: THREE.Group): void {
    const bannerTex = createBannerTexture();
    this.textures.push(bannerTex);
    const bannerMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: bannerTex,
      roughness: 0.72,
      metalness: 0.05,
      vertexColors: true // 顶点色乘贴图，微调 4 块明度
    });
    this.materials.push(bannerMat);
    const panels: THREE.BufferGeometry[] = [];
    // 面板：0.1 厚 × 1.8 高 × 4 宽，底离地 0.4（柱腿 0..0.4 露出），面板朝赛道中心（法线 ±lateral）
    for (const [s, lateral, bright] of START_BOARDS) {
      panels.push(paintGeo(panelAt(0.1, 1.8, 4, s, lateral, 0.4), bright, bright, bright));
    }
    const bannerGeo = mergeSafe(panels);
    this.geometries.push(bannerGeo);
    const bannerMesh = new THREE.Mesh(bannerGeo, bannerMat);
    bannerMesh.name = 'start-boards';
    bannerMesh.castShadow = true; // 与起点建筑群同投影（小板，阴影开销可忽略）
    bannerMesh.receiveShadow = true;
    group.add(bannerMesh);
  }

  /** V14 发车信号灯：5 盏红灯（0.35 见方立方体，emissive 红）挂黑色横梁下、均布跨路面。
   *  立柱/横梁已并入 startGeo → 此处仅 +1 mesh / +1 材质（零新增纹理）。 */
  private buildStartLights(group: THREE.Group): void {
    const lightMat = new THREE.MeshStandardMaterial({
      color: 0xcc2222,
      emissive: 0xcc2222,
      emissiveIntensity: 1.2,
      roughness: 0.4,
      metalness: 0.2
    });
    this.materials.push(lightMat);
    const lights: THREE.BufferGeometry[] = [];
    // 5 盏均布横跨路面中央 10m（±5, ±2.5, 0），灯中心 y≈5.6（横梁底 5.825 下沿）
    for (const lat of [-5, -2.5, 0, 2.5, 5]) {
      lights.push(boxAt(0.35, 0.35, 0.35, START_LIGHT_S, lat, 5.425));
    }
    const lightGeo = mergeSafe(lights);
    this.geometries.push(lightGeo);
    const lightMesh = new THREE.Mesh(lightGeo, lightMat);
    lightMesh.name = 'start-lights';
    lightMesh.castShadow = false;
    lightMesh.receiveShadow = false;
    group.add(lightMesh);
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const g of this.geometries) g.dispose();
    for (const mt of this.materials) mt.dispose();
    for (const t of this.textures) t.dispose();
  }
}
