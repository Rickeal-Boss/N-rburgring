/**
 * HUD（D2 正式版）：圈数 / 上圈 / 本圈大时钟 + Δ / 最佳 + S1-S2-S3 / 小地图 / 速度 / 提示
 *
 * 性能纪律（验收口径：chase 核显 ≥50FPS、DC 增量 ≤6）：
 *   · 全 DOM，零 3D 开销（不新增 sprite / canvas 贴图 / 后处理）；
 *   · 文本 **10Hz**（每 100ms 且只在字符串变化时写 textContent）；
 *   · 小地图 **30Hz**，且折线只在构造期画一次到离屏 canvas，每帧只 blit + 车点三角；
 *   · 节点全部构造期建好，运行期零 DOM 结构变更、零闭包分配。
 *
 * 小地图口径（北向上）：
 *   世界 x → canvas 右、世界 z（北）→ canvas 上；等比缩放（按 bounds 长边）、四周留 8px。
 *   中心线抽稀到 ~700 点（track.count≈5208，stride 7）——180px 画布下再密也看不出来。
 */
import { byId, el } from './dom';
import { getTrack } from '../track/nordschleife';
import { formatDelta, formatLapTime, type LapState } from '../core/LapTimer';

/** 文本刷新间隔 ms */
const TEXT_INTERVAL = 100;
/** 小地图刷新间隔 ms */
const MAP_INTERVAL = 1000 / 30;
const MAP_SIZE = 180;
const MAP_PAD = 8;
const MAP_POINTS = 700;
/** 操作提示淡出延时 ms */
const HINT_MS = 8000;

export class Hud {
  private readonly root: HTMLElement;
  private readonly lapEl: HTMLElement;
  private readonly lastEl: HTMLElement;
  private readonly curEl: HTMLElement;
  private readonly deltaEl: HTMLElement;
  private readonly bestEl: HTMLElement;
  private readonly splitEls: [HTMLElement, HTMLElement, HTMLElement];
  private readonly speedEl: HTMLElement;
  private readonly gearEl: HTMLElement;
  private readonly hintEl: HTMLElement;
  private readonly toastEl: HTMLElement;
  private readonly countEl: HTMLElement;
  private readonly splitBox: HTMLElement;

  private readonly mapCanvas: HTMLCanvasElement;
  private readonly mapCtx: CanvasRenderingContext2D;
  private readonly mapBase: HTMLCanvasElement;
  private readonly mapScale: number;
  private readonly mapOriginX: number;
  private readonly mapOriginZ: number;
  private readonly mapMinX: number;
  private readonly mapMinZ: number;

  private visible = false;
  private lastTextAt = 0;
  private lastMapAt = 0;
  private toastTimer = 0;
  private hintTimer = 0;
  private flashBestTimer = 0;
  private flashSectorTimer = 0;
  private readonly text = {
    lap: '',
    last: '',
    cur: '',
    delta: '',
    best: '',
    s1: '',
    s2: '',
    s3: '',
    speed: '',
    gear: ''
  };

  constructor() {
    this.root = byId('hud');
    this.root.innerHTML = '';
    this.root.classList.add('hud-root');

    /* ── 左上：圈数 / 上圈 ───────────────────────────────────────────── */
    const topLeft = el('div', 'hud-top-left');
    this.lapEl = el('div', 'hud-lap mono', 'LAP 1');
    this.lastEl = el('div', 'hud-last mono', 'LAST --:--.---');
    topLeft.append(this.lapEl, this.lastEl);

    /* ── 顶部中：本圈大时钟 + Δ ─────────────────────────────────────── */
    const topCenter = el('div', 'hud-top-center');
    this.curEl = el('div', 'hud-cur mono', '00:00.000');
    this.deltaEl = el('div', 'hud-delta mono', '');
    topCenter.append(this.curEl, this.deltaEl);

    /* ── 右上：最佳 + 三段 ──────────────────────────────────────────── */
    const topRight = el('div', 'hud-top-right');
    this.bestEl = el('div', 'hud-best mono', 'BEST --:--.---');
    this.splitBox = el('div', 'hud-splits');
    const s1 = el('div', 'hud-split mono', 'S1 --:--.---');
    const s2 = el('div', 'hud-split mono', 'S2 --:--.---');
    const s3 = el('div', 'hud-split mono', 'S3 --:--.---');
    this.splitEls = [s1, s2, s3];
    this.splitBox.append(s1, s2, s3);
    topRight.append(this.bestEl, this.splitBox);

    /* ── 小地图（右下） ─────────────────────────────────────────────── */
    const mapWrap = el('div', 'hud-map');
    mapWrap.append(el('div', 'hud-map-label', 'NORDSCHLEIFE · 20.832 km'));
    this.mapCanvas = document.createElement('canvas');
    this.mapCanvas.width = MAP_SIZE;
    this.mapCanvas.height = MAP_SIZE;
    this.mapCanvas.className = 'hud-map-canvas';
    const ctx = this.mapCanvas.getContext('2d');
    if (!ctx) throw new Error('HUD minimap: 2D context unavailable');
    this.mapCtx = ctx;
    mapWrap.append(this.mapCanvas);

    /* ── 左下：速度 + 挡位 ──────────────────────────────────────────── */
    const speedBox = el('div', 'hud-speed-box');
    this.speedEl = el('div', 'hud-speed mono', '0');
    const unit = el('div', 'hud-unit', 'km/h');
    this.gearEl = el('div', 'hud-gear mono', 'N');
    speedBox.append(this.speedEl, unit, this.gearEl);

    /* ── 提示 / toast / 倒计时 ─────────────────────────────────────── */
    this.hintEl = el(
      'div',
      'hud-hint',
      'W/S 油门刹车 · A/D 转向 · Space 手刹 · C 机位 · R 复位 · Esc 暂停'
    );
    this.toastEl = el('div', 'toast hidden');
    this.countEl = el('div', 'hud-count hidden');

    this.root.append(topLeft, topCenter, topRight, mapWrap, speedBox, this.hintEl, this.toastEl, this.countEl);

    // 小地图等比映射参数（构造期算一次）
    const b = getTrack().bounds;
    const spanX = Math.max(1, b.maxX - b.minX);
    const spanZ = Math.max(1, b.maxZ - b.minZ);
    this.mapScale = (MAP_SIZE - MAP_PAD * 2) / Math.max(spanX, spanZ);
    this.mapOriginX = (MAP_SIZE - spanX * this.mapScale) / 2;
    this.mapOriginZ = (MAP_SIZE - spanZ * this.mapScale) / 2;
    this.mapMinX = b.minX;
    this.mapMinZ = b.minZ;
    this.mapBase = this.buildMapBase();
  }

  /* ══ 对外 API ═══════════════════════════════════════════════════════════ */

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.root.classList.toggle('hidden', !visible);
    if (visible) {
      // 提示 8s 后淡出（每次进入驾驶重新计时）
      this.hintEl.classList.remove('fade');
      if (this.hintTimer) window.clearTimeout(this.hintTimer);
      this.hintTimer = window.setTimeout(() => {
        this.hintEl.classList.add('fade');
        this.hintTimer = 0;
      }, HINT_MS);
      this.lastTextAt = 0;
      this.lastMapAt = 0;
    } else if (this.hintTimer) {
      window.clearTimeout(this.hintTimer);
      this.hintTimer = 0;
    }
  }

  /** 暂停态：仅做视觉降权（HUD 仍可见，方便看冻结的圈时） */
  setPaused(paused: boolean): void {
    this.root.classList.toggle('paused', paused);
  }

  /** 倒计时文本（'3' / '2' / '1' / 'GO!'）；传 null 隐藏 */
  setCountdown(text: string | null): void {
    if (text === null) {
      this.countEl.classList.add('hidden');
      this.countEl.classList.remove('go');
      return;
    }
    this.countEl.textContent = text;
    this.countEl.classList.remove('hidden');
    this.countEl.classList.toggle('go', text === 'GO!');
  }

  /**
   * 每渲染帧调用（内部节流）。
   * @param lap LapTimer.state()
   * @param speedKmh 速度（km/h，绝对值）
   * @param s 沿路弧长（m）
   * @param heading 航向 rad（小地图车头朝向）
   * @param gear 挡位 D/R/N
   */
  update(lap: LapState, speedKmh: number, s: number, heading: number, gear: string): void {
    if (!this.visible) return;
    const now = performance.now();
    if (now - this.lastTextAt >= TEXT_INTERVAL) {
      this.lastTextAt = now;
      this.updateText(lap, speedKmh, gear);
    }
    if (now - this.lastMapAt >= MAP_INTERVAL) {
      this.lastMapAt = now;
      this.drawMap(s, heading);
    }
  }

  showToast(text: string, alert = false, ms = 1800): void {
    this.toastEl.textContent = text;
    this.toastEl.classList.remove('hidden');
    this.toastEl.classList.toggle('alert', alert);
    if (this.toastTimer) window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toastEl.classList.add('hidden');
      this.toastTimer = 0;
    }, ms);
  }

  hideToast(): void {
    if (this.toastTimer) window.clearTimeout(this.toastTimer);
    this.toastTimer = 0;
    this.toastEl.classList.add('hidden');
  }

  /** 刷新最佳圈：右上角金光脉冲 1.3s */
  flashBest(): void {
    this.bestEl.classList.remove('flash');
    // 强制重排以重启 CSS 动画（同一帧内连续两次破纪录也能看到）
    void this.bestEl.offsetWidth;
    this.bestEl.classList.add('flash');
    if (this.flashBestTimer) window.clearTimeout(this.flashBestTimer);
    this.flashBestTimer = window.setTimeout(() => {
      this.bestEl.classList.remove('flash');
      this.flashBestTimer = 0;
    }, 1300);
  }

  /** 跨分段：分段条 0.9s 高亮 */
  flashSector(): void {
    this.splitBox.classList.remove('flash');
    void this.splitBox.offsetWidth;
    this.splitBox.classList.add('flash');
    if (this.flashSectorTimer) window.clearTimeout(this.flashSectorTimer);
    this.flashSectorTimer = window.setTimeout(() => {
      this.splitBox.classList.remove('flash');
      this.flashSectorTimer = 0;
    }, 900);
  }

  /* ══ 内部 ═══════════════════════════════════════════════════════════════ */

  /** 文本 10Hz：只在内容变化时写 DOM */
  private updateText(lap: LapState, speedKmh: number, gear: string): void {
    const t = this.text;
    const lapText = `LAP ${lap.lap + 1}`;
    if (t.lap !== lapText) {
      t.lap = lapText;
      this.lapEl.textContent = lapText;
    }
    const lastText = `LAST ${formatLapTime(lap.lastMs)}`;
    if (t.last !== lastText) {
      t.last = lastText;
      this.lastEl.textContent = lastText;
    }
    const curText = formatLapTime(lap.running ? lap.currentMs : 0);
    if (t.cur !== curText) {
      t.cur = curText;
      this.curEl.textContent = curText;
    }
    const deltaText = formatDelta(lap.deltaMs);
    if (t.delta !== deltaText) {
      t.delta = deltaText;
      this.deltaEl.textContent = deltaText;
      this.deltaEl.classList.toggle('fast', lap.deltaMs !== null && lap.deltaMs < 0);
      this.deltaEl.classList.toggle('slow', lap.deltaMs !== null && lap.deltaMs >= 0);
    }
    const bestText = `BEST ${formatLapTime(lap.bestMs)}`;
    if (t.best !== bestText) {
      t.best = bestText;
      this.bestEl.textContent = bestText;
    }
    const sp = lap.splits;
    const best = lap.bestSplits;
    const splitTexts = [
      `S1 ${formatLapTime(sp.s1)}`,
      `S2 ${formatLapTime(sp.s2)}`,
      `S3 ${formatLapTime(sp.s3)}`
    ];
    // 本圈还没跑到的分段，显示该段历史最佳（bestSplits），便于对照
    const keys: (keyof typeof t)[] = ['s1', 's2', 's3'];
    for (let i = 0; i < 3; i++) {
      const own = [sp.s1, sp.s2, sp.s3][i];
      const ref = best ? [best.s1, best.s2, best.s3][i] : null;
      const text = own === null && ref !== null ? `${splitTexts[i].slice(0, 2)} ${formatLapTime(ref)}` : splitTexts[i];
      if (t[keys[i]] !== text) {
        t[keys[i]] = text;
        this.splitEls[i].textContent = text;
        this.splitEls[i].classList.toggle('ghost', own === null);
      }
    }
    const speedText = `${Math.round(speedKmh)}`;
    if (t.speed !== speedText) {
      t.speed = speedText;
      this.speedEl.textContent = speedText;
    }
    if (t.gear !== gear) {
      t.gear = gear;
      this.gearEl.textContent = gear;
      this.gearEl.classList.toggle('reverse', gear === 'R');
    }
  }

  /** 离屏底图：中心线折线 + 起终线短横（构造期一次） */
  private buildMapBase(): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = MAP_SIZE;
    canvas.height = MAP_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return canvas;

    // 底：近不透明深玻璃（压住车下路面，保证折线在任何背景上都可读）
    ctx.fillStyle = 'rgba(10,7,6,0.82)';
    ctx.fillRect(0, 0, MAP_SIZE, MAP_SIZE);

    const track = getTrack();
    const stride = Math.max(1, Math.floor(track.count / MAP_POINTS));
    ctx.beginPath();
    for (let i = 0; i <= track.count; i += stride) {
      const idx = (i % track.count) * 3;
      const x = this.toMapX(track.center[idx]);
      const y = this.toMapY(track.center[idx + 2]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.strokeStyle = 'rgba(241,220,174,0.68)';
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // 起终线：沿 right 方向 14m 的短横（世界 → 画布同构：dy 取反）
    const f = track.at(0);
    const cx = this.toMapX(f.center.x);
    const cy = this.toMapY(f.center.z);
    const rx = f.right.x * 7 * this.mapScale;
    const ry = -f.right.z * 7 * this.mapScale;
    ctx.beginPath();
    ctx.moveTo(cx - rx, cy - ry);
    ctx.lineTo(cx + rx, cy + ry);
    ctx.strokeStyle = '#f1dcae';
    ctx.lineWidth = 2;
    ctx.stroke();
    return canvas;
  }

  private toMapX(x: number): number {
    return this.mapOriginX + (x - this.mapMinX) * this.mapScale;
  }

  private toMapY(z: number): number {
    return MAP_SIZE - this.mapOriginZ - (z - this.mapMinZ) * this.mapScale;
  }

  /** 每帧（30Hz）：blit 底图 + 车点三角 */
  private drawMap(s: number, heading: number): void {
    const ctx = this.mapCtx;
    ctx.clearRect(0, 0, MAP_SIZE, MAP_SIZE);
    ctx.drawImage(this.mapBase, 0, 0);
    const f = getTrack().at(s);
    const cx = this.toMapX(f.center.x);
    const cy = this.toMapY(f.center.z);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(heading); // 北向上：heading=0 指上；+heading 顺时针（画布 y 向下）
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.lineTo(4.4, 5);
    ctx.lineTo(0, 2.6);
    ctx.lineTo(-4.4, 5);
    ctx.closePath();
    ctx.fillStyle = '#ffd98a';
    ctx.fill();
    ctx.strokeStyle = 'rgba(12,8,6,0.85)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }
}
