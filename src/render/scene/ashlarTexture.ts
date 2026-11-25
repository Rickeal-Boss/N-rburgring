/**
 * 石砌（ashlar）贴图 —— 256²，错缝砖 + 灰缝 + ±10% 明暗抖动
 *
 * 为什么单独做：起点看台/塔楼/远景废墟原先复用了**土路肩**的 soil 贴图
 * （createSoilTexture，本是给路面外 3.2m 土带用的近白色噪点图）。贴在 60m 长的
 * 维修墙与 14m 高的塔身上时，颗粒尺度对不上（放大成纯色），石砌结构完全读不出来。
 *
 * 本贴图口径（D2 任务书）：底 #b9b1a6 / 缝 #4a4642 / 每块砖明暗 ±10%。
 * 尺寸 256px、横向 4 块砖（64px/块）、纵向 6 皮（约 42.7px/皮），错缝半块。
 * 每块砖内再叠 3% 的细噪点，避免大面积纯色（放大到塔身高度时尤其明显）。
 * 可平铺：跨边界的砖在另一侧补画一块，repeat 无接缝。
 *
 * 只给 `Scenery.ts` 的起点建筑群与废墟用（stoneMaterial）；路面/路缘/土路肩
 * 仍走各自的贴图，不共用（尺度纪律：一张图一个米级周期）。
 */
import * as THREE from 'three';
import { canvasTexture, makeCanvas } from '../../util/canvasTex';
import { makeLcg } from '../../util/math';

const SIZE = 256;
const COURSES = 6;
const BRICK_W = 64;
/** 灰缝宽度 px（砖体按缝内缩） */
const JOINT = 3;

/** 砖基色 #b9b1a6 */
const BASE: readonly [number, number, number] = [185, 177, 166];

export function createAshlarTexture(): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(SIZE, SIZE);
  const rnd = makeLcg(20480832);

  // 底：灰缝色（砖块之间露出来的就是它）
  ctx.fillStyle = '#4a4642';
  ctx.fillRect(0, 0, SIZE, SIZE);

  const courseH = SIZE / COURSES;

  /** 画一块砖（并在跨右边界时左侧补画，保证可平铺） */
  const brick = (x: number, y: number, w: number, h: number): void => {
    // ±10% 明暗抖动
    const k = 0.9 + rnd() * 0.2;
    const r = Math.round(BASE[0] * k);
    const g = Math.round(BASE[1] * k);
    const b = Math.round(BASE[2] * k);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(x, y, w, h);
    // 上缘高光 / 下缘阴影（1px，给平面石砌一点浮雕感）
    ctx.fillStyle = `rgba(255,255,255,${(0.06 + rnd() * 0.05).toFixed(3)})`;
    ctx.fillRect(x, y, w, 1);
    ctx.fillStyle = `rgba(0,0,0,${(0.1 + rnd() * 0.06).toFixed(3)})`;
    ctx.fillRect(x, y + h - 1, w, 1);
  };

  for (let row = 0; row < COURSES; row++) {
    const y = row * courseH;
    const h = courseH - JOINT;
    // 错缝：奇数皮整体横移半块
    const offset = row % 2 === 0 ? 0 : -BRICK_W / 2;
    for (let x = offset; x < SIZE; x += BRICK_W) {
      const w = BRICK_W - JOINT;
      brick(x, y, w, h);
      if (x + w > SIZE) brick(x - SIZE, y, w, h); // 跨右边界 → 左边缘补一块
      if (x < 0) brick(x + SIZE, y, w, h); // 跨左边界（错缝行首块）
    }
  }

  // 细颗粒：3% 强度的明暗点，抵消「放大成纯色」
  for (let i = 0; i < 5200; i++) {
    const dark = rnd() < 0.5;
    const alpha = (dark ? 0.03 + rnd() * 0.05 : 0.02 + rnd() * 0.05).toFixed(3);
    ctx.fillStyle = dark ? `rgba(0,0,0,${alpha})` : `rgba(255,255,255,${alpha})`;
    const s = 0.6 + rnd() * 1.6;
    ctx.fillRect(rnd() * SIZE, rnd() * SIZE, s, s);
  }

  const tex = canvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}
