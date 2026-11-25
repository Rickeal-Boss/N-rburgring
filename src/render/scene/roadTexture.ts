/**
 * 路面/地表程序化贴图 —— 从旧仓 `src/render/scene/Road.ts` **原样迁出**（R27/R28 观感基线）。
 *
 * 迁移纪律：三带配色（`#bdb3a4` / `#413f3d`）、缝宽 4.5px、缝色 `rgba(18,17,16,0.72)`、
 * 逐块明暗抖动 ±14（alpha 0.2）、2.4m 条石周期、1024×880 画布 —— 逐字沿用，**一个数值都不改**。
 * 石板密度是验收红线（「与旧仓一致」），改这里等于改整条路的观感。
 *
 * 唯一的语义变化：原 `roadTexture()` 是 Road 类的私有函数，现改为**具名导出**，
 * 供 `render/Track.ts` 沿纽北中心线放样时调用。
 */
import * as THREE from 'three';
import { TRACK } from '../../config/physics';
import { canvasTexture, makeCanvas, paintNoise } from '../../util/canvasTex';
import { makeLcg } from '../../util/math';

/** 地表细节贴图（土/砾石噪点，近白灰度 → 只提供细节，色相由 material.color 决定） */
export function createSoilTexture(): THREE.CanvasTexture {
  const size = 256;
  const [canvas, ctx] = makeCanvas(size, size);
  ctx.fillStyle = '#f2eee8';
  ctx.fillRect(0, 0, size, size);
  const random = makeLcg(918273);
  for (let i = 0; i < 2600; i++) {
    const g = Math.floor(140 + random() * 110);
    ctx.fillStyle = `rgba(${g},${g - 4},${g - 10},${(0.08 + random() * 0.22).toFixed(3)})`;
    const r = 0.6 + random() * 2.6;
    ctx.beginPath();
    ctx.ellipse(random() * size, random() * size, r, r * (0.5 + random() * 0.8), 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // 稀疏深色裂缝/干纹，提供 6m 尺度的可读纹理
  for (let i = 0; i < 26; i++) {
    ctx.strokeStyle = `rgba(96,86,76,${(0.10 + random() * 0.14).toFixed(3)})`;
    ctx.lineWidth = 0.6 + random() * 0.9;
    ctx.beginPath();
    const x = random() * size;
    const y = random() * size;
    ctx.moveTo(x, y);
    ctx.lineTo(x + (random() - 0.5) * 40, y + (random() - 0.5) * 40);
    ctx.stroke();
  }
  const tex = canvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/**
 * 石板铺装贴图（R27 三带 + R28 加强拼缝，逐字沿用旧仓 Road.ts）。
 *
 * 三带：横向三等分 —— 中央 0.333W 车行带 `#413f3d`，两侧各 0.333W 边带 `#bdb3a4`。
 * 尺度：1024px = 路宽 14m ⇒ 73.1px/m；纵向 880px = 一个 repeat 周期，由调用方
 * `v = s/12`（12m）定为 73.3px/m。两向密度一致 ⇒ 2.4m 条石 ≈ 176px 正方形。
 * 干石材哑光：roughness 0.9 均匀、不用 roughnessMap（铁律 34：水平面镜反射教训）。
 */
export function roadTexture(anisotropy: number): THREE.CanvasTexture {
  const size = 1024;
  const height = 880;
  const [canvas, ctx] = makeCanvas(size, height);
  // 三带底色：两侧浅边带先铺满，中央深车行带压上（V §7.2）
  const band = Math.round(size / 3);
  ctx.fillStyle = '#bdb3a4';
  ctx.fillRect(0, 0, size, height);
  ctx.fillStyle = '#413f3d';
  ctx.fillRect(band, 0, size - 2 * band, height);
  paintNoise(ctx, size, height, 60000, 0.22);

  const pxPerM = size / TRACK.roadWidth;
  const tile = pxPerM * 2.4; // 2.4m 条石
  const random = makeLcg(4471);

  // 逐块条石的明暗抖动（±11%，低于白石的 ±13% —— 铺装细节对比 4.7 更弱）
  for (let y = 0; y < height; y += tile) {
    for (let x = -tile; x < size + tile; x += tile) {
      const g = Math.floor(-14 + random() * 28);
      ctx.fillStyle = `rgba(${128 + g},${128 + g},${128 + g},0.2)`;
      ctx.fillRect(x, y, tile, tile);
    }
  }
  // 灰缝：错缝砌（每行错半块）——G10 加强：更宽更深的缝，石块分割线要读得出来
  ctx.lineWidth = 4.5;
  ctx.strokeStyle = 'rgba(18,17,16,0.72)';
  for (let row = 0, y = 0; y <= height; y += tile, row += 1) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y);
    ctx.stroke();
    for (let x = (row % 2 ? tile / 2 : 0) - tile; x < size + tile; x += tile) {
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + tile);
      ctx.stroke();
    }
  }

  const tex = canvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = anisotropy;
  return tex;
}
