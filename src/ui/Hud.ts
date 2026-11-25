/**
 * HUD（D1 临时版）：速度 + 沿路进度（s / 总长）+ 挡位 + 计时占位。
 *
 * D2 会替换为正式版（圈时/最佳/分段/小地图）。本版只保证：
 *   · 编译通过、开得了、看得见速度；
 *   · 复用 `ui/styles.css` 既有 .hud-left/.hud-speed/.hud-mid/.toast 版式，
 *     不新增视觉语言（避免 D2 换 HUD 时样式推倒重来）。
 * 全部节点在构造期建一次，update 只写 textContent（零 DOM 结构变更、零分配）。
 */
import { byId, el } from './dom';

export interface HudState {
  /** 速度 km/h（绝对值） */
  speedKmh: number;
  /** 沿路弧长 m */
  s: number;
  /** 总长 m */
  total: number;
  /** 挡位 D/R/N */
  gear: string;
  /** 计时占位文本（mm:ss.mmm） */
  clock: string;
}

export class Hud {
  private readonly root: HTMLElement;
  private readonly speedEl: HTMLElement;
  private readonly gearEl: HTMLElement;
  private readonly posEl: HTMLElement;
  private readonly clockEl: HTMLElement;
  private readonly toastEl: HTMLElement;
  private toastTimer = 0;

  constructor() {
    this.root = byId('hud');
    this.root.innerHTML = '';
    const left = el('div', 'hud-left');
    this.speedEl = el('div', 'hud-speed mono', '0');
    const unit = el('div', 'hud-unit', 'km/h');
    this.gearEl = el('div', 'hud-gear mono', 'N');
    left.append(this.speedEl, unit, this.gearEl);

    const mid = el('div', 'hud-mid');
    this.clockEl = el('div', 'mono', '00:00.000');
    this.posEl = el('div', 'mono', '0 / 20832 m');
    mid.append(this.clockEl, this.posEl);

    this.toastEl = el('div', 'toast hidden');
    this.root.append(left, mid, this.toastEl);
  }

  setVisible(visible: boolean): void {
    this.root.classList.toggle('hidden', !visible);
  }

  update(state: HudState): void {
    this.speedEl.textContent = `${Math.round(state.speedKmh)}`;
    if (this.gearEl.textContent !== state.gear) {
      this.gearEl.textContent = state.gear;
      this.gearEl.classList.toggle('reverse', state.gear === 'R');
    }
    this.posEl.textContent = `${Math.round(state.s)} / ${Math.round(state.total)} m`;
    this.clockEl.textContent = state.clock;
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
}
