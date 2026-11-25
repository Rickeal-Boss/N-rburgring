/**
 * 顶层装配（D2）：场景 + 赛道 + 地形 + 点缀 + V800 + 相机 + 驾驶 + 圈速 + HUD/菜单。
 *
 * 状态机（唯一真源 `phase`）：
 *
 *   menu ──开始──▶ countdown(3→2→1) ──GO──▶ running ⇄ paused
 *     ▲                                        │        │
 *     └──────────── Esc 回菜单？否 ─────────────┘        │
 *                          「回到起终线」→ countdown ◀───┘
 *
 *   · `countdown`：物理/计时全冻结（`tick` 直接 return），只剩相机与渲染在跑；
 *     3/2/1 各一声 `countdownBeep(false)`，GO 一声 `countdownBeep(true)`。
 *   · `paused`：同样冻结 tick，但**继续渲染**（撞车演出/动效不跳帧），HUD 仍可见。
 *   · 计时起点不是「GO」，而是**第一次正向过起终线**（LapTimer 自己启动），
 *     这样 `#s=` 传送开局也不会凭空多出一段圈时。
 *
 * 观感零改：Renderer / Lighting / Environment / ContactShadow / Postfx / vehiclePaint
 * 全部按 D1 原参数调用，本文件不碰其中任何数值。
 *
 * 车头朝向（关键，改前先读）：工厂车模在 body 上恒定 `rotation.y = π`（spec 坐标系车头
 * +Z），因此 `root.rotation.y = heading + π` 才能让车头对齐前进方向。CameraRig 的局部
 * 机位偏移是按「root 局部 −Z = 车头」标定的（旧仓同口径）⇒ 直接把 `car.root.quaternion`
 * 交给 rig 即可，offset 数值一个都不用改。
 */
import * as THREE from 'three';
import { Sfx, vibrate } from '../audio/Sfx';
import { MS_TO_KMH } from '../config/physics';
import { getVehicleProfile, resolveVehicleId, type InteriorViews } from '../config/vehicles';
import { resolveAssemblyPaintId } from '../config/vehiclePaint';
import { isMotionBlurEnabled } from '../config/motionBlur';
import { AdaptiveQuality, type QualitySettings } from '../config/quality';
import { readShellStatus, SHELL_NO_SHELL_STATES } from '../config/r51Perf';
import { FxSystems, impactSparkParams, type FxFrameInput } from '../fx';
import { CameraRig, isInteriorMode, type CameraMode } from '../render/CameraRig';
import { Postfx } from '../render/Postfx';
import { createRenderer } from '../render/Renderer';
import { createV800CarAdapter, type CarLike } from '../model/V800Adapter';
import { ContactShadow } from '../render/scene/ContactShadow';
import { Environment } from '../render/scene/Environment';
import { Lighting } from '../render/scene/Lighting';
import { FarHills } from '../render/FarHills';
import { Landscape } from '../render/Landscape';
import { Scenery } from '../render/Scenery';
import { Track } from '../render/Track';
import { getTrack } from '../track/nordschleife';
import { clamp, lerp } from '../util/math';
import { Hud } from '../ui/Hud';
import { Menu } from '../ui/Menu';
import { autopilotInput } from './AutoPilot';
import { Drive, type DriveInput } from './Drive';
import { formatLapTime, LapTimer, type LapState } from './LapTimer';
import { Loop } from './Loop';

const PHYSICS_HZ = 120;
/** C 键循环机位（D2：追随/机盖/车内/侧面；orbit 仅供菜单） */
const CYCLE_VIEWS: readonly CameraMode[] = ['chase', 'hood', 'cabin', 'side'];
/** 车模基准偏航（spec 车头 +Z，body 恒定 rotY(π)） */
const MODEL_BASE_YAW = Math.PI;
/** 加载屏最长等待外部壳的时间（超时即放行，绝不把用户卡在 loading） */
const SHELL_GATE_MAX_MS = 6000;
/** 倒计时时长 s */
const COUNTDOWN_S = 3;
/** 圈时 HUD 快照刷新间隔 s（文案 10Hz，与 Hud 内部节流同源） */
const LAP_VIEW_INTERVAL = 0.1;

type Phase = 'menu' | 'countdown' | 'running' | 'paused';

const EMPTY_LAP_STATE: LapState = {
  lap: 0,
  running: false,
  currentMs: 0,
  lastMs: null,
  bestMs: null,
  splits: { s1: null, s2: null, s3: null },
  bestSplits: null,
  deltaMs: null
};

export class Game {
  private readonly scene = new THREE.Scene();
  private readonly renderer: THREE.WebGLRenderer;
  private readonly rig: CameraRig;
  private readonly postfx: Postfx;
  private readonly env: Environment;
  private readonly lighting: Lighting;
  private readonly contactShadow: ContactShadow;
  private readonly trackScene: Track;
  private readonly landscape: Landscape;
  private readonly farHills: FarHills;
  private readonly scenery: Scenery;
  private readonly car: CarLike;
  private readonly profile = getVehicleProfile(resolveVehicleId());
  private readonly tier: QualitySettings['tier'];
  private readonly fx: FxSystems;
  private readonly sfx = new Sfx();
  private readonly hud = new Hud();
  private readonly menu: Menu;
  private readonly loop: Loop;
  private readonly qualityGovernor: AdaptiveQuality;
  private readonly drive = new Drive();
  private readonly lap = new LapTimer(getTrack());

  /** 复用载荷（零每帧分配） */
  private readonly fxInput: FxFrameInput = {
    carRoot: null as unknown as THREE.Object3D,
    brakeIntensity: 0,
    speedMs: 0,
    braking: false
  };
  private readonly input: DriveInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  private readonly keys = new Set<string>();
  /** 适配器可选入口（CarLike 上未声明，按结构读取；V800 恒有） */
  private readonly applyVisibility:
    | ((state: { interior: boolean }) => void)
    | undefined;

  /** HUD 用的圈时快照（10Hz 刷新，避免每帧 state() 分配） */
  private lapView: LapState = EMPTY_LAP_STATE;
  private lapViewAt = -1;

  private phase: Phase = 'menu';
  private countdownLeft = 0;
  private countdownShown = 0;
  /** GO 字样隐藏时刻（time 口径，0 = 无） */
  private goHideAt = 0;
  private started = false;
  private time = 0;
  /** 上一物理步位姿快照（alpha 插值，防「每帧 tick 数化」抖动） */
  private prevX = 0;
  private prevY = 0;
  private prevZ = 0;
  private prevHeading = 0;
  private cycleIndex = 0;
  private readonly startedAt = performance.now();
  private loadGateDone = false;
  private onReadyCallback: (() => void) | null = null;
  /** QA 仅 DEV：下一帧 postfx.render 之后回吐 canvas dataURL（截图探针用，零常驻开销） */
  private captureCb: ((url: string) => void) | null = null;
  /** QA：`#autostart` 直达驾驶；`#view=<mode>` 指定机位；`#topcam=h,dist` 高处俯瞰 */
  private readonly autoStart = window.location.hash.includes('autostart');
  /** QA：`#autodrive` 自动驾驶跑圈（生产构建同样可用，默认零开销） */
  private readonly autoDrive = window.location.hash.includes('autodrive');
  private readonly viewHash = /[#&]view=([a-zA-Z]+)/.exec(window.location.hash)?.[1] as CameraMode | undefined;
  private readonly topCam = /[#&]topcam=([\d.]+),([\d.]+)/.exec(window.location.hash);
  /** QA：`#s=<米>` 直接把车放到指定弧长（截图/分段目检用） */
  private readonly teleportS = /[#&]s=([\d.]+)/.exec(window.location.hash)?.[1];

  private readonly onResize = (): void => this.resize();
  private readonly onOrientation = (): void => {
    window.setTimeout(() => this.resize(), 250);
  };
  private readonly onKeyDown = (e: KeyboardEvent): void => this.keyDown(e);
  private readonly onKeyUp = (e: KeyboardEvent): void => this.keyUp(e);
  /** 窗口失焦：清空按键，防「切出去再回来油门还踩着」 */
  private readonly onBlur = (): void => {
    this.keys.clear();
    this.readInput();
  };

  constructor(container: HTMLElement, quality: QualitySettings, onFirstFrame: () => void) {
    this.onReadyCallback = onFirstFrame;
    this.renderer = createRenderer(container, quality);
    this.tier = quality.tier;
    this.qualityGovernor = new AdaptiveQuality(quality);
    this.rig = new CameraRig(window.innerWidth / window.innerHeight);
    this.env = new Environment(this.scene, this.renderer, quality.envMapSize);
    this.lighting = new Lighting(this.scene, quality, this.env.sunDirection);
    this.contactShadow = new ContactShadow(this.scene);

    // 赛道 / 地形 / 点缀 / 远山（全部程序化，零外部资源）
    this.trackScene = new Track(this.scene, this.renderer.capabilities.getMaxAnisotropy());
    this.landscape = new Landscape(this.scene);
    this.farHills = new FarHills(this.scene);
    this.scenery = new Scenery(this.scene);

    // 车（只保留 V800：外部壳异步挂载，加载屏由 pollLoadGate 控制）
    this.car = createV800CarAdapter(this.tier, resolveAssemblyPaintId(this.profile.id) ?? undefined);
    this.scene.add(this.car.root);
    this.fx = new FxSystems(this.scene, quality.tier);
    this.postfx = new Postfx(this.renderer, this.scene, this.rig.camera, quality);

    // 相机初始注入（V800 无内饰三机位 → 内置 cabin 偏移）
    const interiorViews = (this.car as CarLike & { interiorViews?: InteriorViews }).interiorViews ?? null;
    this.applyVisibility = (
      this.car as CarLike & { applyVisibility?: (state: { interior: boolean }) => void }
    ).applyVisibility;
    this.rig.setInteriorViews(interiorViews);
    this.rig.setViewScale(this.profile.cameraScale ?? 1);

    // 驾驶回调：撞击（震屏/FOV punch/音效/火花）与车身姿态（簧下轮跳）
    this.drive.onImpact = (strength, x, y, z) => this.onImpact(strength, x, y, z);
    this.drive.onBodyPose = (roll, pitch) => this.car.applyWheelSuspension?.(roll, pitch);

    this.menu = new Menu({
      onStart: () => this.startRun(),
      onResume: () => this.resume(),
      onRestart: () => this.restartFromLine(),
      onToggleMute: () => this.toggleMute()
    });
    this.hud.setVisible(false);
    this.menu.showStart(this.lap.best);
    this.rig.setMode('orbit');

    window.addEventListener('resize', this.onResize);
    window.addEventListener('orientationchange', this.onOrientation);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);

    // 车先摆到起点（菜单 orbit 相机围着它转）
    this.snapPrevPose();
    this.car.setHeadlights(true);

    // QA 圈时探针（仅 DEV：headless 读不到私有字段）
    if (import.meta.env.DEV) {
      (window as unknown as { __lap?: () => LapState }).__lap = () => this.lap.state();
    }

    this.loop = new Loop(
      { tick: (step) => this.tick(step), frame: (dt, alpha) => this.frame(dt, alpha) },
      PHYSICS_HZ
    );
    // 加载期 GPU 预热（收益项，失败不影响启动）
    if (!import.meta.env.DEV || !window.location.hash.includes('noprewarm')) this.prewarm();
    this.loop.start();
  }

  /* ══ 运行控制 ═══════════════════════════════════════════════════════════ */

  /** 首屏「开始驾驶」：复位到起终线 → 3-2-1 → GO（already started 时等价于继续） */
  private startRun(): void {
    this.sfx.unlock();
    this.sfx.uiClick();
    if (!this.started) {
      this.started = true;
      this.drive.resetToStart();
      if (this.teleportS !== undefined) this.drive.teleportTo(Number(this.teleportS));
      this.lap.resetLap();
      this.cycleIndex = 0;
      this.fx.clear();
      this.rig.setMode(this.viewHash && CYCLE_VIEWS.includes(this.viewHash) ? this.viewHash : 'chase');
      this.snapPrevPose();
    }
    this.menu.hide();
    this.hud.setVisible(true);
    this.hud.setPaused(false);
    this.car.setHeadlights(true);
    this.beginCountdown();
  }

  private beginCountdown(): void {
    this.phase = 'countdown';
    this.countdownLeft = COUNTDOWN_S;
    // 已经显示并播过「3」⇒ 记录当前档位，避免下一帧 ceil 仍是 3 时重复 beep
    this.countdownShown = COUNTDOWN_S;
    this.lapView = this.lap.state();
    this.hud.setCountdown(String(COUNTDOWN_S));
    this.clearInput();
    this.sfx.countdownBeep(false);
  }

  /** Esc：暂停（running → paused）/ 继续（paused → running） */
  private pause(): void {
    if (this.phase !== 'running') return;
    this.phase = 'paused';
    this.clearInput();
    this.menu.showPause(this.sfx.isMuted);
    this.hud.setPaused(true);
    this.sfx.updateEngine(0, false);
    this.sfx.updateWind(0);
    this.sfx.updateSqueal(0, 0);
  }

  private resume(): void {
    if (this.phase !== 'paused') return;
    this.phase = 'running';
    this.menu.hide();
    this.hud.setPaused(false);
    this.sfx.uiClick();
  }

  /** 暂停浮层「回到起终线」：本圈作废 + 车回起点 + 重新倒计时 */
  private restartFromLine(): void {
    this.sfx.uiClick();
    this.drive.resetToStart();
    this.lap.resetLap();
    this.fx.clear();
    this.snapPrevPose();
    this.menu.hide();
    this.hud.setVisible(true);
    this.hud.setPaused(false);
    this.hud.showToast('已回到起终线', false, 1600);
    this.beginCountdown();
  }

  private toggleMute(): boolean {
    const muted = this.sfx.setMuted(!this.sfx.isMuted);
    if (!muted) this.sfx.uiClick();
    return muted;
  }

  private clearInput(): void {
    this.keys.clear();
    this.input.throttle = 0;
    this.input.brake = 0;
    this.input.steer = 0;
    this.input.handbrake = false;
  }

  private keyDown(e: KeyboardEvent): void {
    const code = e.code;
    if (code === 'Escape') {
      if (this.phase === 'running') this.pause();
      else if (this.phase === 'paused') this.resume();
      e.preventDefault();
      return;
    }
    if (this.phase !== 'running') return;
    if (code === 'KeyC') {
      this.cycleCamera();
      e.preventDefault();
      return;
    }
    if (code === 'KeyR') {
      this.drive.resetToTrack();
      this.lap.resetLap();
      this.lapView = this.lap.state();
      this.snapPrevPose();
      this.hud.showToast('已复位（本圈作废）', false, 1600);
      e.preventDefault();
      return;
    }
    if (code === 'Space' || code.startsWith('Arrow')) e.preventDefault();
    this.keys.add(code);
    this.readInput();
  }

  private keyUp(e: KeyboardEvent): void {
    this.keys.delete(e.code);
    this.readInput();
  }

  private readInput(): void {
    const k = this.keys;
    this.input.throttle = k.has('KeyW') || k.has('ArrowUp') ? 1 : 0;
    this.input.brake = k.has('KeyS') || k.has('ArrowDown') ? 1 : 0;
    this.input.steer =
      (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0) - (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0);
    this.input.handbrake = k.has('Space');
  }

  private cycleCamera(): void {
    this.cycleIndex = (this.cycleIndex + 1) % CYCLE_VIEWS.length;
    this.rig.setMode(CYCLE_VIEWS[this.cycleIndex]);
    this.sfx.uiClick();
  }

  /* ══ 物理 / 渲染 ═══════════════════════════════════════════════════════ */

  /** 固定步长 1/120s：只推驾驶模型 + 圈速（位姿写回放渲染帧做插值） */
  private tick(step: number): void {
    if (this.phase !== 'running') return;
    const st = this.drive.state;
    this.prevX = st.x;
    this.prevY = st.y;
    this.prevZ = st.z;
    this.prevHeading = st.heading;

    if (this.autoDrive) autopilotInput(st, this.input);
    this.drive.step(step, this.input);

    const ev = this.lap.step(this.drive.state.s, this.drive.state.speed, step * 1000);
    if (ev === null) return;
    const view = this.lap.state();
    this.lapView = view;
    if (ev === 'sector') {
      this.hud.flashSector();
    } else if (ev === 'best') {
      this.hud.flashBest();
      this.sfx.success();
      this.hud.showToast(`新最快圈 ${formatLapTime(view.bestMs)}`, false, 3000);
    } else {
      this.sfx.uiClick();
      this.hud.showToast(`第 ${view.lap} 圈 ${formatLapTime(view.lastMs)}`, false, 2600);
    }
  }

  private frame(dt: number, alpha: number): void {
    this.time += dt;
    this.updatePhaseTimers(dt);

    const st = this.drive.state;
    const a = clamp(alpha, 0, 1);
    // 航向 wrap 感知插值；位移/航向跳变（复位、首帧）直接吸附
    let dh = st.heading - this.prevHeading;
    if (dh > Math.PI) dh -= Math.PI * 2;
    else if (dh < -Math.PI) dh += Math.PI * 2;
    const jx = st.x - this.prevX;
    const jz = st.z - this.prevZ;
    if (jx * jx + jz * jz > 25 || Math.abs(dh) > 0.5) {
      this.prevX = st.x;
      this.prevY = st.y;
      this.prevZ = st.z;
      this.prevHeading = st.heading;
      dh = 0;
    }
    this.applyPose(
      lerp(this.prevX, st.x, a),
      lerp(this.prevY, st.y, a),
      lerp(this.prevZ, st.z, a),
      this.prevHeading + dh * a
    );

    const driving = this.phase === 'running';
    const absSpeed = Math.abs(st.speed);
    const speedKmh = absSpeed * MS_TO_KMH;
    const braking = driving && this.input.brake > 0 && st.speed > 0.2;
    const reverse = st.speed < -0.2;

    // ---- 车体视觉 ----
    this.car.body.rotation.x = st.pitch;
    this.car.body.rotation.z = st.roll;
    this.car.spinWheels(st.speed * dt, dt);
    this.car.setSteer(st.steer);
    this.car.setBrakeLights(braking || (driving && this.input.handbrake) ? 8 : 1.6);
    this.car.updateCluster(speedKmh, 0, Math.abs(st.accel) / 9.81, reverse ? 'R' : 'D');
    this.car.update(this.rig.camera, dt);

    // ---- 灯光 / 接地阴影 / 环境 ----
    const focus = this.car.root.position;
    this.lighting.update(focus);
    this.contactShadow.update(this.car.body);

    // ---- 相机 ----
    this.rig.update(dt, focus, driving ? absSpeed : 0, this.car.root.quaternion);
    this.applyTopCam();
    this.env.update(this.rig.camera.position);
    this.car.updateSteeringGate?.(this.rig.camera);
    this.applyVisibility?.({ interior: isInteriorMode(this.rig.mode) });

    // ---- 音效（暂停/倒计时静音链条：engine 只在跑起来后给油）----
    this.sfx.updateEngine(speedKmh, driving && this.input.throttle > 0);
    this.sfx.updateWind(Math.min(absSpeed / (70 / MS_TO_KMH), 1));
    this.sfx.updateSqueal(driving && this.input.handbrake && absSpeed > 3 ? 0.55 : 0, absSpeed);

    // ---- 特效（烟/刹车痕；低档内部自动关闭）----
    const fx = this.fxInput;
    fx.carRoot = this.car.root;
    // 强度按**实际踏板量**给（D1 键盘 0/1 口径下等价于 0.7；自动驾驶/半踩时不再满屏白烟）
    fx.brakeIntensity = braking ? 0.7 * clamp(this.input.brake, 0, 1) : 0;
    fx.speedMs = absSpeed;
    fx.braking = braking;
    this.fx.update(dt, fx);

    // ---- 后处理（动态模糊默认关；开启才按真实渲染跳距给强度）----
    const blurOn = isMotionBlurEnabled();
    const blur = blurOn ? Math.min(0.18, ((absSpeed * dt) / 0.925) * 0.12) : 0;
    this.postfx.setSpeedBlur(blur, blurOn ? dt : 0, blurOn);
    this.postfx.setFlash(0);

    // ---- HUD（快照 10Hz，正文案节流在 Hud 内部）----
    const tele = this.drive.telemetry;
    if (this.time - this.lapViewAt >= LAP_VIEW_INTERVAL) {
      this.lapViewAt = this.time;
      this.lapView = this.lap.state();
    }
    this.hud.update(this.lapView, tele.speedKmh, tele.s, st.heading, tele.gear);

    // ---- 渲染 ----
    this.postfx.render();
    const capture = this.captureCb;
    if (capture) {
      this.captureCb = null;
      capture(this.renderer.domElement.toDataURL('image/png'));
    }
    this.pollLoadGate();

    // ---- 自适应画质（迟滞在 AdaptiveQuality 内，本文件不改参数）----
    const dr = this.qualityGovernor.update(dt);
    if (dr !== 0) {
      this.renderer.setPixelRatio(this.qualityGovernor.pixelRatio);
      this.postfx.setPixelRatio(this.qualityGovernor.pixelRatio);
    }
  }

  /** 倒计时推进 + GO 字样回收（与渲染帧同频，物理仍冻结） */
  private updatePhaseTimers(dt: number): void {
    if (this.phase === 'countdown') {
      this.countdownLeft -= dt;
      const n = Math.ceil(this.countdownLeft);
      if (n > 0 && n !== this.countdownShown) {
        this.countdownShown = n;
        this.hud.setCountdown(String(n));
        this.sfx.countdownBeep(false);
      }
      if (this.countdownLeft <= 0) {
        this.phase = 'running';
        this.hud.setCountdown('GO!');
        this.sfx.countdownBeep(true);
        this.goHideAt = this.time + 0.9;
      }
    } else if (this.goHideAt > 0 && this.time >= this.goHideAt) {
      this.goHideAt = 0;
      this.hud.setCountdown(null);
    }
  }

  /** 位姿写回（root 承载 heading+π + 世界位置；body 只承载基准 π 与视觉俯仰/侧倾） */
  private applyPose(x: number, y: number, z: number, heading: number): void {
    this.car.root.position.set(x, y, z);
    this.car.root.rotation.set(0, heading + MODEL_BASE_YAW, 0);
    if (this.car.body.rotation.y !== MODEL_BASE_YAW) this.car.body.rotation.y = MODEL_BASE_YAW;
  }

  /** 插值快照清零（复位/传送后第一帧直接吸附，不出现横移） */
  private snapPrevPose(): void {
    const st = this.drive.state;
    this.prevX = st.x;
    this.prevY = st.y;
    this.prevZ = st.z;
    this.prevHeading = st.heading;
    this.applyPose(st.x, st.y, st.z, st.heading);
    this.car.body.rotation.x = st.pitch;
    this.car.body.rotation.z = st.roll;
  }

  /** QA：`#topcam=高度,水平距离` 高处俯瞰（截图用，不进正常玩法） */
  private applyTopCam(): void {
    if (!this.topCam) return;
    const h = Number(this.topCam[1]);
    const d = Number(this.topCam[2]);
    const p = this.car.root.position;
    this.rig.camera.position.set(p.x - d * 0.7, p.y + h, p.z - d * 0.7);
    this.rig.camera.lookAt(p.x, p.y, p.z);
  }

  private onImpact(strength: number, x: number, y: number, z: number): void {
    if (this.phase !== 'running') return;
    this.sfx.impact(Math.max(0.12, 0.5 * strength));
    this.rig.addShake(0.25 * strength);
    this.rig.addFovPunch(0.25 * strength);
    vibrate([30, 20, 60]);
    const spark = impactSparkParams('wall', strength);
    if (spark) this.fx.burstSparks(new THREE.Vector3(x, y, z), spark);
    this.hud.showToast('撞到护栏！', true, 1200);
  }

  /* ══ 加载 / 预热 / 生命周期 ════════════════════════════════════════════ */

  /** 加载屏放行：首帧已渲染 且（外部壳就绪 / 失败 / 停用 / 6s 超时） */
  private pollLoadGate(): void {
    if (this.loadGateDone) return;
    const status = readShellStatus(this.profile.id);
    const failed = status !== null && SHELL_NO_SHELL_STATES.includes(status);
    const ready = status === 'ready' && this.hasMountedShell();
    const timedOut = performance.now() - this.startedAt > SHELL_GATE_MAX_MS;
    if (!ready && !failed && !timedOut) return;
    this.loadGateDone = true;
    if (ready) {
      // 壳首次进主 pass 的 program/贴图首传留在加载屏内（旧仓 R51-A 同语义）
      try {
        this.renderer.compile(this.scene, this.rig.camera);
      } catch (e) {
        if (import.meta.env.DEV) console.warn('[load] 壳 program 预热失败（已忽略）:', e);
      }
    }
    requestAnimationFrame(() => {
      this.onReadyCallback?.();
      this.onReadyCallback = null;
      if (this.autoStart && !this.started) this.startRun();
      if (this.viewHash && CYCLE_VIEWS.includes(this.viewHash)) {
        this.rig.setMode(this.viewHash);
        this.cycleIndex = CYCLE_VIEWS.indexOf(this.viewHash);
      }
    });
  }

  /** 外部壳「已挂树」硬证据（只读标记，不瘦身、不重排场景树） */
  private hasMountedShell(): boolean {
    const found = { yes: false };
    this.car.root.traverse((o) => {
      if (found.yes) return;
      const m = o as THREE.Mesh;
      if (m.isMesh && (m.userData as { r44External?: boolean }).r44External === true) found.yes = true;
    });
    return found.yes;
  }

  /** 加载期 GPU 预热：全场景离屏 8×8 渲染把 geometry/贴图首传 + program 编译吃掉 */
  private prewarm(): void {
    try {
      const t0 = performance.now();
      this.renderer.compile(this.scene, this.rig.camera);
      const cam = new THREE.PerspectiveCamera(120, 1, 1, 30000);
      const b = getTrack().bounds;
      const cx = (b.minX + b.maxX) / 2;
      const cz = (b.minZ + b.maxZ) / 2;
      cam.position.set(cx, 6200, cz);
      cam.lookAt(cx, 0, cz);
      const rt = new THREE.WebGLRenderTarget(8, 8);
      this.renderer.setRenderTarget(rt);
      this.renderer.render(this.scene, cam);
      this.renderer.setRenderTarget(null);
      rt.dispose();
      this.postfx.prewarm();
      if (import.meta.env.DEV) {
        console.info(`[load] GPU 预热 ${(performance.now() - t0).toFixed(0)}ms`);
      }
    } catch (e) {
      console.warn('[load] GPU 预热失败（已忽略，退回惰性上传）：', e);
    }
  }

  /**
   * QA 截图出口（仅 DEV 调用）：在**本帧渲染完成后**回吐 canvas dataURL。
   * 这样无需给 renderer 开 preserveDrawingBuffer（那会影响所有帧的观感/性能）。
   */
  requestCapture(cb: (url: string) => void): void {
    this.captureCb = cb;
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setPixelRatio(this.qualityGovernor.pixelRatio);
    this.renderer.setSize(w, h);
    this.rig.resize(w / h);
    this.postfx.setPixelRatio(this.qualityGovernor.pixelRatio);
    this.postfx.resize(w, h);
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('orientationchange', this.onOrientation);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.loop.dispose();
    this.sfx.dispose();
    this.fx.dispose();
    this.postfx.dispose();
    this.contactShadow.dispose();
    this.trackScene.dispose();
    this.landscape.dispose();
    this.farHills.dispose();
    this.scenery.dispose();
    this.car.dispose();
    this.renderer.dispose();
  }
}
