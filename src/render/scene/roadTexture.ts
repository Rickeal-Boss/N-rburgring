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

  /* ── V3 沥青磨损/裂缝/修补（加法层，不动上面任何既有数值）─────────────
   * 只在既有画布上叠绘，零新增 mesh/材质/DC（贴图烘焙）。
   * 尺度：1024px=14m 横向（pxPerM≈73.1）、880px=12m 纵向（73.3）——2.4m 条石 ≈ 176px。 */
  const crackRng = makeLcg(0xa5c30d); // 独立种子，避免扰动既有条石明暗抖动序列
  // 裂缝：细黑裂纹，低频分布（每 12m 贴图周期约 3 条），带分叉，边缘留 margin 保证平铺无缝
  ctx.lineCap = 'round';
  const crackCount = 3;
  for (let c = 0; c < crackCount; c++) {
    let x = 70 + crackRng() * (size - 140);
    let y = 70 + crackRng() * (height - 140);
    let dir = crackRng() * Math.PI * 2;
    ctx.strokeStyle = `rgba(20,18,15,${(0.42 + crackRng() * 0.22).toFixed(3)})`;
    ctx.lineWidth = 1.1 + crackRng() * 1.3;
    ctx.beginPath();
    ctx.moveTo(x, y);
    const segs = 5 + Math.floor(crackRng() * 5);
    for (let sIdx = 0; sIdx < segs; sIdx++) {
      dir += (crackRng() - 0.5) * 0.9; // 随机游走拐弯
      const len = 13 + crackRng() * 24;
      x += Math.cos(dir) * len;
      y += Math.sin(dir) * len;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
    // 分叉支线（约半数裂缝带一叉）
    if (crackRng() < 0.6) {
      const bx = x;
      const by = y;
      let bdir = dir + (crackRng() - 0.5) * 1.7;
      let bxx = bx;
      let byy = by;
      ctx.strokeStyle = `rgba(22,20,16,${(0.3 + crackRng() * 0.2).toFixed(3)})`;
      ctx.lineWidth = 0.7 + crackRng() * 0.7;
      ctx.beginPath();
      ctx.moveTo(bx, by);
      for (let b = 0; b < 3; b++) {
        bdir += (crackRng() - 0.5) * 0.8;
        const blen = 7 + crackRng() * 13;
        bxx += Math.cos(bdir) * blen;
        byy += Math.sin(bdir) * blen;
        ctx.lineTo(bxx, byy);
      }
      ctx.stroke();
    }
  }

  // 修补补丁：深色矩形沥青块（不同明度），带边界缝与内部噪点 —— 低频（每周期约 2-3 块）
  const patchRng = makeLcg(0x9b7de1);
  const patchCount = 3;
  for (let p = 0; p < patchCount; p++) {
    const pw = (1.3 + patchRng() * 1.2) * pxPerM; // 1.3~2.5m 宽
    const ph = (1.5 + patchRng() * 1.9) * pxPerM; // 1.5~3.4m 长
    const px0 = 60 + patchRng() * (size - 120 - pw);
    const py0 = 60 + patchRng() * (height - 120 - ph);
    // 补丁基色：比周边略深、色相偏冷灰（新旧沥青明度差），半透明以柔和融入
    const shade = Math.floor(58 + patchRng() * 26);
    ctx.fillStyle = `rgba(${shade},${shade - 2},${shade - 4},${(0.32 + patchRng() * 0.16).toFixed(3)})`;
    ctx.fillRect(px0, py0, pw, ph);
    // 边界缝（补丁周边一圈暗边，读得出补丁轮廓）
    ctx.strokeStyle = 'rgba(16,15,14,0.5)';
    ctx.lineWidth = 1.8;
    ctx.strokeRect(px0, py0, pw, ph);
    // 补丁内细微噪点（不同明度沥青质感）
    const pr = makeLcg(0x5c1 + p * 97);
    for (let i = 0; i < 42; i++) {
      const g = Math.floor(72 + pr() * 44);
      ctx.fillStyle = `rgba(${g},${g - 2},${g - 4},${(0.06 + pr() * 0.11).toFixed(3)})`;
      ctx.fillRect(px0 + pr() * pw, py0 + pr() * ph, 2, 2);
    }
  }

  const tex = canvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = anisotropy;
  return tex;
}
