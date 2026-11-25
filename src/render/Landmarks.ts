/**
 * 地标建筑（程序化白石城堡）—— 把旧仓 `castleKit` 的**大门 / 塔群 / 主殿**按
 * `(s, lateral)` 请回纽北 20.83km 环线，作为**低密度观景地标**。
 *
 * ── 为什么是「移植」不是「重写」──────────────────────────────────────────
 * 旧仓 `brake-v800/src/render/scene/castleKit.ts`（+ `castleDetail` / `r27Layout` /
 * `r28Layout`）是一整套按 FBX 精测 + 参考图双析做出来的哥特白石构件库，全部
 * BufferGeometry、零外部资产、确定性随机。新仓 D1/D2 为去玩法把它删了，只剩
 * 树/岩石/废墟。本文件只做**组装 + 摆放**：几何一律由 `castleKit` 现成函数产出
 * （`makeGate` / `makeTowerGroup` / `makeMainHall`），**不复制任何 FBX/PNG**。
 *
 * ── 几何坐标口径（移植时最容易踩的一条）──────────────────────────────────
 * castleKit 的三个 maker **产绝对世界坐标**：
 *   · 大门 / 塔群：锚在 `GATE.z = −358.5`（门楼中心 z），底面 y=0、x 关于 0 对称；
 *   · 主殿：锚在 `MAIN_HALL.z = −1300`（立面 z），底面 y=0、x 关于 0 对称。
 * 所以摆放前必须先把几何归一到「局部原点 = 路面/地面中心」：`translate(0, 0, −zAnchor)`。
 * **y 绝不做 bbox 归一** —— 大门自带一块 y −70..0 的崖体承托板，按 bbox min 归一会把
 * 整座门楼抬到 70m 高空（见 `outsideCrop` 注释，这块板本身也按越界件丢掉）。
 *
 * ── 朝向语义（与旧仓 applyFrame 一致）───────────────────────────────────
 * 旧仓世界系「车沿 −z 行驶、车头 = −Z」，城门/主殿前脸朝 +z = 来车方向。本仓 track
 * 帧的局部 +Z 是前进方向，所以要让新局部坐标系里「局部 −Z = 前进方向」（⇒ 建筑前脸
 * 朝来车），基向量取 `(−rightH, upH, −tangent)`（det 仍 +1，纯旋转不是镜像；
 * `rightH/upH` 是本文件自建的水平正交基，**不用 `frame.up`** —— 见 `frameMatrix` 注释）。
 * 三栋建筑的前脸都落在局部 +Z。`yaw` 是**帧之后再绕局部 Y 的偏转**（只有主殿用）。
 *
 * ── 材质与 DC ──────────────────────────────────────────────────────────
 * `StoneBuckets` 五族 → 四个材质 + 火焰（映射见 `FAMILY_OF`）：
 *   ashlar（白石，ashlar 石砌贴图）/ gold（鎏金 metal .85）/ dark（近黑洞口内壁）/
 *   flame（MeshBasic 自发光）。
 * castleKit 还会往桶上挂 wall/grey/pave/roof/marble/wood/glass/door/agedGold 等变体桶
 * （旧仓由 castle.ts 的 `absorb()` 逐个提交 = 每桶 +1 DC）。地标只需要「低密度观景」
 * 精度，故按语义折进上面四族（见 `FAMILY_OF` 的取舍理由）。
 *
 * 全场 5 个 mesh（为什么是 5 见构造函数里的 DC 推导）：
 *   ashlar 近景（castShadow=true）/ ashlar 远景 / gold / dark / flame
 *   ⇒ 整帧 **+9 DC**（本管线每个可见 mesh 在整帧口径记 2 个 call）。
 *
 * ── 预算纪律 ───────────────────────────────────────────────────────────
 * 实测（tools 探针，`#assembled` 口径）：大门 ×2（高配）11,328 + 塔群复合体 ×3（低配）
 * 25,584 + 主殿 ×1（低配）11,300 + 火焰 392 ⇒ **+58,604 tri**（`mergeSafe` 后实计
 * 56,472 tri，差值是合并时三角化口径；以 `sceneStats` 的 56,472 为准）。
 * 远景一律 `setDetailLevel(true)` 降装饰密度（**只降密度、不改几何尺寸**，castleKit
 * 铁律 33），近景大门走高配；`tier === 'low'` 时近景也降。
 */
import * as THREE from 'three';
import { getTrack } from '../track/nordschleife';
import { mergeSafe } from '../util/geo';
import { terrainPoint } from './Landscape';
import { createAshlarTexture } from './scene/ashlarTexture';
import { makeGate, makeMainHall, makeTowerGroup, setDetailLevel } from './scene/castleKit';
import type { StoneBuckets } from './scene/castleKit';
import { GATE, MAIN_HALL } from './scene/r28Layout';

/* ═══════════════════ 材质族（4 族 + 火焰 = ≤5 DC/组） ═══════════════════ */

type Family = 'ashlar' | 'gold' | 'dark' | 'flame';

/**
 * castleKit 各桶 → 本文件材质族。
 * · wall / grey / pave / roof / marble：都是「石质、比主体暗一档」。本轮三栋建筑里
 *   这四类合计只有 **216 tri**（塔群的 grey 变体），为把整帧 DC 压进 +10 预算，
 *   全部并入 ashlar（同贴图同石质，只差明度；216 tri 上的明度差肉眼不可辨）。
 *   ⚠ 若以后要恢复 wall 独立材质，先算 DC：多一个族 = 整帧 +2 DC（见下方「为什么 5 个 mesh」）。
 * · agedGold：做旧金 ⇒ 并入 gold；
 * · glass / wood / door：窗洞背板 / 门洞木梁 / 折叠门扇都在**近黑洞口内**，
 *   远处读不出材质差别 ⇒ 并入 dark（省 2 个 DC，且不引入透射/木纹贴图）；
 * · 未登记键兜底 ashlar（宁可读成白石，也不静默丢几何）。
 */
const FAMILY_OF: Readonly<Record<string, Family>> = {
  ashlar: 'ashlar',
  wall: 'ashlar',
  grey: 'ashlar',
  pave: 'ashlar',
  roof: 'ashlar',
  marble: 'ashlar',
  gold: 'gold',
  agedGold: 'gold',
  dark: 'dark',
  glass: 'dark',
  wood: 'dark',
  door: 'dark',
  flame: 'flame'
};

const FAMILIES: readonly Family[] = ['ashlar', 'gold', 'dark', 'flame'];

function emptyFamilies(): Record<Family, THREE.BufferGeometry[]> {
  return { ashlar: [], gold: [], dark: [], flame: [] };
}

/* ═══════════════════ 摆放表 ═══════════════════ */

/** 地标种类：gate = 单座门楼；castle = 门楼 + 塔群复合体；hall = 主殿 */
type LandmarkKind = 'gate' | 'castle' | 'hall';

export interface Placement {
  kind: LandmarkKind;
  /** 弧长（m） */
  s: number;
  /**
   * 横向偏移（m）。**正值 = 行进方向的左侧**，0 = 门洞跨路。
   *
   * ⚠ 为什么不是「右」：本仓 `TrackFrame.right` 的公式是 `(t.z, 0, −t.x)` = `up × t`，
   * 而右手系的「右」应是 `t × up`（两者反号）⇒ 该字段名与几何语义相反，实际指向左手侧。
   * 实证：s=4930 / 17430 / 19300 的 lateral>0 件在 chase 机位截图上全部出现在**画面左岸**
   * （`.qa/nr/d3/castle1_far.png` / `castle2_far.png` / `hall_far.png`）。
   * 这里照抄同一套横向定义（与 `terrainPoint` 同源），只把符号含义写清楚；
   * 三条塔群用了 +70 / −70 / +70 左右交替，观感上两岸都有地标。
   */
  lateral: number;
  /** 等比缩放 */
  scale: number;
  /** 帧之后绕局部 Y 的额外偏转（rad）；0 = 建筑前脸朝来车（旧仓 applyFrame 语义） */
  yaw: number;
  /** 底面再下沉量（m，负值把台基埋进地形，避免斜坡上悬空） */
  sink: number;
  /** 是否投影（只有近景大门给 true；远景件投影只白烧 shadow pass） */
  castShadow: boolean;
}

/**
 * 摆放真源（要调位置只改这张表）。
 *
 * **大门 ×2（lateral 0）**：`makeGate()` 实高 55m、半宽 17.5m、门洞净宽 20m > 路面
 * 14.8m ⇒ 门洞跨路不侵路面。底面取**路面**（`frame.center`，即 Track.ts 路面带的
 * y=0 列），再下沉 0.9m ⇒ 两侧塔墩（|x| 10..17.5，已在路肩外缘 11.6 之外）埋进地形，
 * 门洞下沿被路面盖住。s=2400 / 13200 两处曲率实测 0.0000（直道）、横向 ±18m 地形
 * 高差 ≤0.04m（tools 探针实测）⇒ 35m 宽门楼既不会被弯道甩进路面，塔墩也不会半悬空。
 *
 * **塔群 ×3（castle）**：`makeGate()` + `makeTowerGroup()` 组成「门楼 + 钟楼 98m +
 * 铃塔 ×2 86m + 细尖塔 ×2 66m + 翼墙」的完整城堡剪影。塔群基座 y=40 是**咬合门楼
 * 体量顶 44m** 的，单独摆会悬空 40m ⇒ 必须与门楼一起摆。塔群原宽 ±97.4m（含外侧
 * 幕墙），按 `WING_CROP_X` 裁到 ±56.9m；摆到 lateral ±70 ⇒ 内缘距中线 13.1m >
 * 路肩外缘 11.6m，不侵路面/路肩。scale 0.9 ⇒ 高 93m、半宽 51m、内缘 19m 余量更大。
 *
 * **主殿 ×1**：`makeMainHall()` 立面宽 210 / 冠高 130 / 进深 76。lateral 150（探针
 * 实测地形比路面低 4.0m ⇒ 用 `terrainY` 落地）。**yaw = +π/2** 把前脸转向路心
 * （lateral>0 时路在局部 +X 方向：局部 +X = −rightH = t×up = 行进方向的右手侧），
 * 否则 210m 立面只能侧着看、正门大拱门读不出来；转 90° 后立面沿赛道铺开
 * （沿 s 跨 ±105m）、横向只占「前脸凸出 37m / 后身 77m」⇒ 实测内缘 112.9m，远离路面。
 */
const PLACEMENTS: readonly Placement[] = [
  // ── 大门 ×2（近景，跨路，高配 + castShadow）
  { kind: 'gate', s: 2400, lateral: 0, scale: 1, yaw: 0, sink: -0.9, castShadow: true },
  { kind: 'gate', s: 13200, lateral: 0, scale: 1, yaw: 0, sink: -0.9, castShadow: true },
  // ── 城堡塔群 ×3（远景，低配，不投影）
  { kind: 'castle', s: 5200, lateral: 70, scale: 0.9, yaw: 0, sink: -0.6, castShadow: false },
  { kind: 'castle', s: 9800, lateral: -70, scale: 0.9, yaw: 0, sink: -0.6, castShadow: false },
  { kind: 'castle', s: 17800, lateral: 70, scale: 1.0, yaw: 0, sink: -0.6, castShadow: false },
  // ── 主殿 ×1（远景，低配，不投影；前脸转向路心）
  { kind: 'hall', s: 19500, lateral: 150, scale: 1, yaw: Math.PI / 2, sink: -1.2, castShadow: false }
];

/**
 * 越界件裁剪阈值（|x|，m）。`TOWER_GROUP.wing.xEnd = 55` 是翼墙设计外缘，但
 * `makeTowerGroup` 之后还有一段「画幅 1/3 之外也得有东西」的外延幕墙/角塔一路铺到
 * 97.4m —— 作独立地标时那圈墙毫无用处（内缘会横穿路面）。判据取「部件 bbox 完全
 * 落在 ±WING_CROP_X 内」，**只整件丢、不按顶点裁**（切开外壳件会留单面薄壳）。
 * 同一条判据顺手丢掉大门那块 |x|≤72 的崖体承托板（y −70..0；本仓地形无峡谷）。
 * ⚠ 主殿**不得**套用（立面设计宽就是 210m）。
 */
const WING_CROP_X = 57;

/* ═══════════════════ 组装 ═══════════════════ */

export class Landmarks {
  private readonly group = new THREE.Group();
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly textures: THREE.Texture[] = [];

  /** @param lowDetail 低质量档：近景大门也降装饰密度（几何尺寸逐位不变） */
  constructor(scene: THREE.Scene, lowDetail = false) {
    this.group.name = 'landmarks';

    // 近景组（castShadow=true）/ 远景组分开合批：castShadow 只能逐 mesh 给
    const near = emptyFamilies();
    const far = emptyFamilies();

    for (const p of PLACEMENTS) {
      // 远景走低配。setDetailLevel 是 castleKit 的模块级开关 ⇒ 必须在 **build 之前**置位
      setDetailLevel(lowDetail || !p.castShadow);
      this.buildPlacement(p, p.castShadow ? near : far);
    }
    setDetailLevel(false); // 归还默认档，别的模块再调 castleKit 不会拿到低配

    /* ── 材质 ────────────────────────────────────────────────────────────
     * ashlar 石砌贴图：新仓 D2 的 `scene/ashlarTexture`（256²，4 砖宽 × 6 皮 ⇒
     * **4m × 4m 一个周期**）。castleKit 的 `planarUV` 把 u,v 写成
     * 「米 / STONE_TILE_METERS[kind]」（ashlar 1.2 / wall 2.4 …），所以纹理 repeat
     * 要取 `tile / 4` 才能让砌块回到 4m 世界周期：ashlar 1.2/4 = **0.3**。
     * wall 已并入 ashlar（见 FAMILY_OF），那部分 UV 按 2.4 算 ⇒ 砌块会小一半，
     * 但那只占 216 tri，肉眼不可辨。 */
    const ashlarTex = createAshlarTexture();
    ashlarTex.repeat.set(1.2 / 4, 1.2 / 4);
    this.textures.push(ashlarTex);

    const mats: Record<Family, THREE.Material> = {
      ashlar: new THREE.MeshStandardMaterial({
        map: ashlarTex,
        color: 0xe5dcd9,
        roughness: 0.9,
        metalness: 0.04,
        envMapIntensity: 0.35
      }),
      gold: new THREE.MeshStandardMaterial({ color: 0xa2771d, roughness: 0.34, metalness: 0.85 }),
      dark: new THREE.MeshStandardMaterial({ color: 0x1a1714, roughness: 1, metalness: 0 }),
      // 火焰：UnrealBloom threshold .72 只吃线性亮度 > .72 的像素，0xffb020 单独用线性
      // 亮度 ≈ .52 不出辉光 ⇒ 按旧仓口径（brake-v800 castle.ts 的 ×2.4）乘 2.2
      flame: new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffb020).multiplyScalar(2.2) })
    };
    for (const f of FAMILIES) this.materials.push(mats[f]);

    const submit = (name: string, fam: Family, parts: THREE.BufferGeometry[], castShadow: boolean): void => {
      if (parts.length === 0) return;
      const geo = mergeSafe(parts);
      this.geometries.push(geo);
      const mesh = new THREE.Mesh(geo, mats[fam]);
      mesh.name = `landmark-${name}`;
      mesh.castShadow = castShadow;
      mesh.receiveShadow = fam !== 'flame';
      // 地标单 mesh bbox 跨 200m+（塔群与主殿分散在 20km 环线上），视锥剔除必然失效 ⇒
      // 直接关掉，省下每帧的 bbox 变换。
      mesh.frustumCulled = false;
      this.group.add(mesh);
    };

    /* ── 为什么是 5 个 mesh（DC 口径）──────────────────────────────────────
     * 实测（同机位开/关地标的整帧差，`.qa/nr/d3/ab.json`）：本管线**每个可见 mesh
     * 在整帧口径里记 2 个 draw call**（D2 的 91 DC 也是这个口径，含阴影/postfx 全屏
     * pass），8 mesh 的旧配实测 **+15 DC**，超了 +10 预算。
     * ⇒ 收敛到 5 个 mesh：
     *   ① ashlar（近景大门，castShadow=true —— 门楼横跨路面的投影是这个地标唯一的
     *      "落地感"来源，保留）；② ashlar-far（塔群 + 主殿）；③ gold（近+远合批）；
     *   ④ dark（近+远合批）；⑤ flame（近+远合批，自发光不投影 —— 投影会把火光投成黑块）。
     * 只有 ① 投影：gold/dark 的券线与洞口在门楼体量的影子里本来就重叠，
     * 去掉它们的投影在观感上无差（实测截图对比见 .qa/nr/d3/）。
     * 整帧代价 = 4×2 + 1 = **+9 DC**。 */
    submit('ashlar', 'ashlar', near.ashlar, true);
    submit('ashlar-far', 'ashlar', far.ashlar, false);
    submit('gold', 'gold', [...near.gold, ...far.gold], false);
    submit('dark', 'dark', [...near.dark, ...far.dark], false);
    submit('flame', 'flame', [...near.flame, ...far.flame], false);

    scene.add(this.group);
  }

  /** `castleKit` 桶 → 归一化 → 换到赛道帧 → 折进材质族 */
  private buildPlacement(p: Placement, out: Record<Family, THREE.BufferGeometry[]>): void {
    const builders: StoneBuckets[] = [];
    if (p.kind === 'hall') {
      builders.push(makeMainHall());
    } else {
      builders.push(makeGate());
      // 塔群坐在门楼体量上（基座 y=40 咬合 massTop=44）⇒ 必须与门楼一起摆
      if (p.kind === 'castle') builders.push(makeTowerGroup());
    }

    // 局部原点 = 建筑中心（x 已对称）。y 不归一：三个 maker 的「地面」都正好 y=0
    const zAnchor = p.kind === 'hall' ? MAIN_HALL.z : GATE.z;
    const m = this.frameMatrix(p).multiply(new THREE.Matrix4().makeTranslation(0, 0, -zAnchor));
    // 主殿立面设计宽 210m ⇒ 不套越界裁剪
    const crop = p.kind !== 'hall';

    for (const b of builders) {
      const rec = b as unknown as Record<string, THREE.BufferGeometry[]>;
      for (const key of Object.keys(rec)) {
        const arr = rec[key];
        if (!arr) continue;
        const fam = FAMILY_OF[key] ?? 'ashlar';
        for (const g of arr) {
          if (crop && this.outsideCrop(g)) continue;
          g.applyMatrix4(m);
          out[fam].push(g);
        }
      }
    }
  }

  /** 越界件判定（见 `WING_CROP_X`）：整件丢弃，不按顶点裁 */
  private outsideCrop(g: THREE.BufferGeometry): boolean {
    g.computeBoundingBox();
    const bb = g.boundingBox;
    if (!bb) return false;
    return bb.max.x > WING_CROP_X || bb.min.x < -WING_CROP_X;
  }

  /**
   * 赛道帧 → 世界矩阵（局部 −Z = 前进方向，局部 +Y = 竖直，局部 +X 指向路心一侧）。
   *
   * ⚠ **不用 `frame.up`**：`nordschleife.ts` 的帧 up 少了一项
   * （`uy = dz*rxv` 缺 `− dx*rzv`，正确写法是 t×r），实测 s=13200 处
   * `up = (0.610, 0.790, −0.057)`、`t·u = 0.607` ⇒ 与切线不垂直、与竖直夹角 37.8°；
   * 其余取样点 0.1°~5.6°（偏差量 ∝ |dy·rzv| / |dz·rxv|，坡度噪声越大越歪）。
   * 路面带不吃 up（列 y=0）所以看不出来，但拿它做建筑基向量会把 55m 门楼拧歪 37°。
   * 本文件改用**自建正交基**（只用切线）：`rightH = ( tz, 0, −tx )` 归一（水平且与 t
   * 严格垂直），`upH = t × rightH`。t / rightH / upH 三者两两正交且单位 ⇒ 纯旋转。
   * 这条也顺手屏蔽了横倾（bank）：建筑永远竖直，比跟着路面倾斜更符合地标语义。
   *
   * 基向量取 `(−rightH, upH, −t)`（det = +1）：track 帧本身右手系，整体取反仍右手 ⇒
   * 纯旋转、不镜像。局部 −Z = 前进方向 ⇒ 建筑前脸（局部 +Z）朝来车。
   * 落地：跨路大门用**路面**高度（`frame.center`），其余用 `terrainPoint` 贴地形。
   */
  private frameMatrix(p: Placement): THREE.Matrix4 {
    const f = getTrack().at(p.s);
    const t = new THREE.Vector3(f.tangent.x, f.tangent.y, f.tangent.z).normalize();
    // 水平右向 = 旧仓 right 公式去掉 y 分量（(tz, 0, −tx)），与 t 严格垂直
    const rightH = new THREE.Vector3(t.z, 0, -t.x);
    if (rightH.lengthSq() < 1e-9) rightH.set(0, 0, -1); // 纯垂直路段不存在，兜底
    rightH.normalize();
    const upH = new THREE.Vector3().crossVectors(t, rightH).normalize();

    const q = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(rightH.clone().negate(), upH, t.clone().negate())
    );
    if (p.yaw !== 0) {
      q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.yaw));
    }

    const pos = new THREE.Vector3();
    if (p.kind === 'gate') {
      // 门洞跨路 ⇒ 底面必须是路面（road surface = frame.center；Track.ts buildRibbon 的 y=0 列）
      pos.set(
        f.center.x + rightH.x * p.lateral,
        f.center.y,
        f.center.z + rightH.z * p.lateral
      );
    } else {
      terrainPoint(p.s, p.lateral, pos);
    }
    pos.y += p.sink;

    return new THREE.Matrix4().compose(pos, q, new THREE.Vector3(p.scale, p.scale, p.scale));
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const g of this.geometries) g.dispose();
    for (const mt of this.materials) mt.dispose();
    for (const t of this.textures) t.dispose();
  }

  /** QA 探针：地标 mesh 清单 */
  get meshes(): readonly THREE.Mesh[] {
    return this.group.children.filter((c): c is THREE.Mesh => (c as THREE.Mesh).isMesh);
  }
}

/** 导出摆放表快照（单测/探针按它断言「不侵路面」等硬约束） */
export const LANDMARK_PLACEMENTS: readonly Placement[] = PLACEMENTS;
