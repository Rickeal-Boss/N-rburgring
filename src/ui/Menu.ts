/**
 * 菜单 / 暂停浮层（D2 正式版，同一 `#menu` 容器两套面板）
 *
 *  · 首屏：标题「Gellhorn Raceway」/ 副标题「自由驾驶 · 圈速挑战」/ 车辆「鼎奢 V680」/
 *    开始按钮 / 操作说明 / 底部免责声明（非官方粉丝作品）。
 *  · Esc → 暂停浮层：继续 / 回到起终线 / 静音。浮层**靠上对齐**且背景只做轻压暗
 *    （不整屏模糊），保证车与 HUD 圈时在暂停时仍看得见 —— 验收口径「暂停不遮车」。
 *
 * 不引外部字体/图片；所有样式复用 `ui/styles.css` 的 `--cream / --panel / --line`。
 * 回调由 Game 注入（本类不持有 Game，避免双向依赖）。
 */
import { blurIfInside, byId, el, setVisible } from './dom';
import { formatLapTime } from '../core/LapTimer';
import type { TrackMode } from '../track/nordschleife';

export interface MenuCallbacks {
  /** 首屏「开始驾驶」：复位到起终线 + 3-2-1 倒计时 */
  onStart: () => void;
  /** 暂停浮层「继续」 */
  onResume: () => void;
  /** 暂停浮层「回到起终线」 */
  onRestart: () => void;
  /** 暂停浮层「静音 / 取消静音」，返回切换后的静音态 */
  onToggleMute: () => boolean;
  /** 首屏赛道选择：切换北环 / 南环（Game 侧做 dispose/重建） */
  onSelectTrack: (mode: TrackMode) => void;
}

/** 赛道选择按钮文案（含里程，与 HUD 小地图标签口径一致） */
const TRACK_BTN_LABEL: Record<TrackMode, string> = {
  nordschleife: 'Gellhorn Raceway · 20.8 km',
  suedschleife: 'Gellhorn South · 7.7 km'
};
/** 赛道信息行（首屏规则末行，随当前赛道动态显示） */
const TRACK_INFO_LINE: Record<TrackMode, string> = {
  nordschleife: '20.832 km · 73 个弯 · 正向过线才计圈',
  suedschleife: '7.7 km · 27 弯 · 正向过线才计圈'
};

export class Menu {
  private readonly root: HTMLElement;
  private readonly startPanel: HTMLElement;
  private readonly pausePanel: HTMLElement;
  private readonly bestLine: HTMLElement;
  private readonly muteBtn: HTMLElement;
  private readonly nrBtn: HTMLElement;
  private readonly suedBtn: HTMLElement;
  /** 首屏规则末行（赛道里程/弯数，随当前赛道动态显示） */
  private readonly trackInfo: HTMLElement;

  constructor(cb: MenuCallbacks, currentMode: TrackMode = 'nordschleife') {
    this.root = byId('menu');
    this.root.innerHTML = '';
    this.root.classList.add('menu-root');

    /* ── 首屏 ───────────────────────────────────────────────────────── */
    const start = el('div', 'panel menu-panel');
    start.append(
      el('div', 'menu-kicker', 'GELLHORN INTERNATIONAL RACEWAY'),
      el('div', 'menu-title', 'Gellhorn Raceway'),
      el('div', 'menu-sub', '自由驾驶 · 圈速挑战')
    );
    const vehicle = el('div', 'menu-vehicle');
    vehicle.append(el('span', 'mv-key', '车辆'), el('span', 'mv-val', '鼎奢 V680'));
    this.bestLine = el('div', 'menu-best mono', '最佳圈 --:--.---');
    start.append(vehicle, this.bestLine);

    // 赛道选择（北环 / 南环；高亮 = 当前激活，复用 .btn.primary / .btn.ghost 双态）
    const trackSel = el('div', 'btn-row btn-row-sub');
    this.nrBtn = el('button', 'btn primary', TRACK_BTN_LABEL.nordschleife);
    this.suedBtn = el('button', 'btn ghost', TRACK_BTN_LABEL.suedschleife);
    trackSel.append(this.nrBtn, this.suedBtn);
    start.append(trackSel);

    const rules = el('div', 'menu-rules');
    rules.innerHTML = [
      '<b>W / S</b> 油门 · 刹车（停稳后 S = 倒车）',
      '<b>A / D</b> 转向 · <b>Space</b> 手刹甩尾',
      '<b>C</b> 切换机位（追随 / 机盖 / 车内 / 侧面）',
      '<b>R</b> 回到赛道（本圈作废） · <b>Esc</b> 暂停',
      ''
    ].join('<br />');
    // 末行赛道信息（里程/弯数）单独成元素，setTrack 时按当前赛道动态改写
    this.trackInfo = el('div', 'menu-track-info mono', TRACK_INFO_LINE.nordschleife);
    rules.append(this.trackInfo);
    start.append(rules);

    const row = el('div', 'btn-row');
    const startBtn = el('button', 'btn primary', '开始驾驶');
    row.append(startBtn);
    start.append(row);
    start.append(
      el(
        'div',
        'menu-disclaimer',
        '非官方粉丝作品：与 Rockstar Games / GTA 系列及任何汽车品牌无关联，不含授权素材。'
      )
    );

    /* ── 暂停浮层 ───────────────────────────────────────────────────── */
    const pause = el('div', 'panel pause-panel hidden');
    pause.append(
      el('div', 'pause-title', '已暂停'),
      el('div', 'pause-sub', '圈时与物理已冻结 · 渲染继续')
    );
    const pauseRow1 = el('div', 'btn-row');
    const resumeBtn = el('button', 'btn primary', '继续驾驶');
    pauseRow1.append(resumeBtn);
    const pauseRow2 = el('div', 'btn-row btn-row-sub');
    const restartBtn = el('button', 'btn ghost', '回到起终线');
    this.muteBtn = el('button', 'btn ghost', '静音');
    pauseRow2.append(restartBtn, this.muteBtn);
    pause.append(pauseRow1, pauseRow2);
    pause.append(el('div', 'pause-hint', 'Esc 继续驾驶 · 暂停期间物理与圈时均冻结'));

    this.startPanel = start;
    this.pausePanel = pause;
    this.root.append(start, pause);

    // ── 事件 ──────────────────────────────────────────────────────────
    startBtn.addEventListener('click', () => {
      blurIfInside(this.root);
      cb.onStart();
    });
    resumeBtn.addEventListener('click', () => {
      blurIfInside(this.root);
      cb.onResume();
    });
    restartBtn.addEventListener('click', () => {
      blurIfInside(this.root);
      cb.onRestart();
    });
    this.muteBtn.addEventListener('click', () => {
      const muted = cb.onToggleMute();
      this.muteBtn.textContent = muted ? '取消静音' : '静音';
    });
    this.nrBtn.addEventListener('click', () => {
      blurIfInside(this.root);
      cb.onSelectTrack('nordschleife');
    });
    this.suedBtn.addEventListener('click', () => {
      blurIfInside(this.root);
      cb.onSelectTrack('suedschleife');
    });

    // 按初始赛道设置高亮 + 文案
    this.setTrack(currentMode);
  }

  /**
   * 更新赛道高亮（.btn.primary = 当前激活）+ 首屏动态文案（里程/弯数）。
   * 由 Game 在构造与 selectTrack 时调用；点击按钮本身也走 onSelectTrack → Game。
   */
  setTrack(mode: TrackMode): void {
    const sued = mode === 'suedschleife';
    this.nrBtn.className = sued ? 'btn ghost' : 'btn primary';
    this.suedBtn.className = sued ? 'btn primary' : 'btn ghost';
    this.trackInfo.textContent = TRACK_INFO_LINE[mode];
  }

  /** 首屏（开始菜单） */
  showStart(bestMs: number | null): void {
    this.bestLine.textContent = `最佳圈 ${formatLapTime(bestMs)}`;
    setVisible(this.startPanel, true);
    setVisible(this.pausePanel, false);
    this.root.classList.remove('pause-mode');
    setVisible(this.root, true);
  }

  /** 暂停浮层（不遮车：靠上对齐 + 轻压暗，见 styles.css） */
  showPause(muted: boolean): void {
    this.muteBtn.textContent = muted ? '取消静音' : '静音';
    setVisible(this.startPanel, false);
    setVisible(this.pausePanel, true);
    this.root.classList.add('pause-mode');
    setVisible(this.root, true);
  }

  hide(): void {
    setVisible(this.root, false);
    blurIfInside(this.root);
  }
}
