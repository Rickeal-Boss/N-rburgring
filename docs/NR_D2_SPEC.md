# D2 规格：圈速计时 + HUD/小地图 + 菜单 + 音频

> 前置：D1 已交付可驾驶骨架（Track/Landscape/Scenery/Drive/Game）。本轮只做玩法层与 UI，不改观感参数。

## 1. `src/core/LapTimer.ts`

```ts
export interface LapSplit { s1: number | null; s2: number | null; s3: number | null }
export interface LapState {
  lap: number;            // 已完成圈数
  running: boolean;       // 是否已过线开始计时
  currentMs: number;      // 本圈已用
  lastMs: number | null;
  bestMs: number | null;
  splits: LapSplit;       // 本圈分段
  bestSplits: LapSplit | null;
  deltaMs: number | null; // 本圈当前相对最佳（负=快）
}
export class LapTimer {
  constructor(track: Nordschleife, storageKey = 'nr.bestLap');
  /** 每物理步调用；返回事件（过线/分段/新最佳） */
  step(s: number, speedMs: number, dtMs: number): 'lap' | 'sector' | 'best' | null;
  state(): LapState;
  resetLap(): void;       // R 复位：清本圈，保留最佳
  resetAll(): void;       // 清最佳
}
```
- 过线：`prevS > L-80 && s < 80 && speedMs > 0`，且本圈行驶距离 ≥ L*0.9（防倒车刷圈）。
- 分段：s 跨 `L/3`、`2L/3` 记录；最佳分段随最佳圈一起存。
- 持久化：`localStorage[storageKey]` 存 `{bestMs, bestSplits}`；读写 try/catch。
- 时间用累计 `dtMs`，不依赖 Date（可测试）。

## 2. `src/ui/Hud.ts`（重写）

DOM 结构（`#hud` 内）：
```
.hud-top-left   LAP n  ·  LAST m:ss.mmm
.hud-top-center 本圈 m:ss.mmm  +Δm:ss.mmm（快=绿 #6ee7a8 / 慢=红 #ef6b6b）
.hud-top-right  BEST m:ss.mmm  S1/S2/S3（无成绩显示 --:--.---）
.hud-map        180×180 canvas（北向上，中心线折线，起终线短横，车点 + 朝向三角）
.hud-speed      182 km/h（等宽大字号）
.hud-hint       W/S 油门刹车 · A/D 转向 · Space 手刹 · C 机位 · R 复位 · Esc 暂停（8s 后淡出）
```
- 风格沿用旧仓 `ui/styles.css` 的奶油金/深色玻璃（`--cream #f1dcae`、`rgba(18,14,12,.72)`、细金边）。
- 小地图：构造时把 5208 点抽稀到 ~700 点画到离屏 canvas，每帧只 blit + 画车点；
  `x/z → canvas` 按 track.bounds 等比缩放，留 8px 边距。
- 更新频率：文本 10Hz（每 100ms），小地图 30Hz；避免每帧 DOM 写入。
- 提供 `showToast(msg, isWarn?, ms?)`、`setPaused(bool)`、`flashBest()`。

## 3. `src/ui/Menu.ts`（重写）

- 首屏：标题「纽博格林北环」+ 副标题「自由驾驶 · 圈速挑战」+ 车辆「尊界 V800」+
  「开始驾驶」按钮 + 操作说明 + 底部免责声明（非官方粉丝作品，与 Nürburgring 权利方无关联）。
- 开始 → 隐藏 `#menu`，调用 `game.start()`。
- Esc → 暂停浮层：继续 / 回到起终线 / 关闭音频；暂停时 `Loop` 继续渲染但 dt=0。
- 不引入外部字体/图片。

## 4. 音频（`src/audio/Sfx.ts` 已有，只接线）

- 每帧：`updateEngine(speedKmh, throttle>0)`、`updateWind(min(speed/70,1))`、
  `updateSqueal(slipAmount, speedMs)`；撞击 → `impact(strength)`；UI → `uiClick()`。
- 删除 `brakeClick/snap/success/fail/thermal` 调用（方法可留在类里，不接线）。
- `unlock()` 在首次点击开始时调用（浏览器自动播放策略）。

## 5. Game 接线

- `start()`：倒计时 3-2-1（`countdownBeep`），结束后 `drive.enabled=true`、`lap.running` 由首次过线启动。
- 每 tick：`drive.step(step, input)` → `const ev = lap.step(drive.s, drive.speed, step*1000)`；
  `ev==='best'` → `hud.flashBest()` + `sfx.success()`。
- frame：`hud.update(lap.state(), drive.speedKmh, drive.s)`（内部节流）。
- R：`drive.resetToTrack(); lap.resetLap(); hud.showToast('已复位')`。
- 暂停：`paused` 时 tick 直接 return（不推进物理/计时），仍渲染。
- `#autodrive` 钩子：沿中心线自动油门/转向（QA 跑整圈 + 圈速回归），
  `#perfhud` 沿用旧 main.ts。

## 6. 测试（新增 ≥ 9 用例）

- `tests/lap_timer.test.ts`：正向过线 +1；倒车过线不计；本圈里程不足不判；最佳/分段持久化（内存桩）；
  分段跨点各记一次；resetLap 保留最佳。
- `tests/drive_model.test.ts`：0-100km/h 4.5~6.5s；100-0 制动距离 33~45m；满舵低速转弯半径 4~6m；
  横向加速度 ≤ 1.05g；护栏钳位 |lateral| ≤ 10.7；R 复位后 lateral≈0。
- `tests/track_geometry.test.ts` 保持 9 绿。
- 全量 `npx vitest run` 0 failed；`npm run build` 0 错。

## 7. 验收

- 完整跑一圈（`#autodrive` 加速到 60km/h 匀速），圈时 ≈ 20.8km / 平均速度，无负圈时/跳圈。
- 三机位截图：HUD 不遮挡车、圈时/最佳/小地图可读；窄屏 1280×720 不溢出。
- 核显 chase ≥50FPS，DC 增量 ≤ 6（HUD 全 DOM，不引入 3D 开销）。
