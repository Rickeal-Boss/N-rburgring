/**
 * 开始菜单（D1 极简版）：标题 + 一行定位 + 操作说明 + 开始按钮。
 *
 * D2 会做正式版（音频开关 / 车漆 / 最佳圈预览 …）。本版只保证：编译通过、
 * 点得动、点了能开。复用 `ui/styles.css` 的 .panel / .menu-title / .menu-sub /
 * .menu-rules / .btn.primary，不新增样式。
 */
import { blurIfInside, byId, el, setVisible } from './dom';

export class Menu {
  private readonly root: HTMLElement;

  constructor(onStart: () => void) {
    this.root = byId('menu');
    this.root.innerHTML = '';

    const panel = el('div', 'panel menu-panel');
    const title = el('div', 'menu-title', 'NORDSCHLEIFE');
    const sub = el('div', 'menu-sub', '纽博格林北环 · 20.832 km · 自由驾驶');
    const rules = el('div', 'menu-rules');
    rules.innerHTML = [
      '<b>W / S</b> 油门 · 刹车（停稳后 S = 倒车）',
      '<b>A / D</b> 转向',
      '<b>Space</b> 手刹（甩尾）',
      '<b>C</b> 切换机位（追随 / 机盖 / 车内 / 侧面）',
      '<b>R</b> 回到赛道 · <b>Esc</b> 暂停并回到菜单',
      '',
      '沿路肩可短暂越界，压到护栏会被弹回。'
    ].join('<br />');

    const row = el('div', 'btn-row');
    const btn = el('button', 'btn primary', '开始驾驶');
    row.append(btn);
    panel.append(title, sub, rules, row);
    this.root.append(panel);

    btn.addEventListener('click', () => {
      blurIfInside(this.root);
      onStart();
    });
  }

  show(visible: boolean): void {
    setVisible(this.root, visible);
    if (!visible) blurIfInside(this.root);
  }
}
