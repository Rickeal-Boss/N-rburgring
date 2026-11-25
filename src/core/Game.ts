/**
 * 顶层装配（D1 极简版）：场景 + 赛道 + 地形 + 点缀 + V800 + 相机 + 驾驶 + HUD。
 *
 * 相对旧仓（2261 行 / 刹停玩法）的职责收缩：
 *   · 删掉会话状态机 / 踏板力滑条 / 刹车热衰减 / 断裂冗余 / 撞击翻滚 / 结算面板；
 *   · 保留且**观感零改**：Renderer / Lighting / Environment / ContactShadow / Postfx
 *     / vehiclePaint（本文件只按原参数调用，不改其中任何数值）；
 *   · 驾驶完全交给 core/Drive.ts（纯状态），本文件只做「位姿写回 + 相机 + 音效 + FX + HUD」。
 *
 * 车头朝向（关键，改前先读）：工厂车模在 body 上恒定 `rotation.y = π`（spec 坐标系车头
 * +Z），因此 `root.rotation.y = heading + π` 才能让车头对齐前进方向。CameraRig 的
 * 局部机位偏移是按「root 局部 −Z = 车头」标定的（旧仓同口径）⇒ 直接把
 * `car.root.quaternion` 交给 rig 即可，offset 数值一个都不用改。
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
import { Landscape } from '../render/Landscape';
import { Scenery } from '../render/Scenery';
import { Track } from '../render/Track';
import { getTrack } from '../track/nordschleife';
import { clamp, lerp } from '../util/math';
import { Hud } from '../ui/Hud';
import { Menu } from '../ui/Menu';
import { Drive, type DriveInput } from './Drive';
import { Loop } from './Loop';

const PHYSICS_HZ = 120;
/** C 键循环机位（D1：追随/机盖/车内/侧面；orbit 仅供菜单） */
const CYCLE_VIEWS: readonly CameraMode[] = ['chase', 'hood', 'cabin', 'side'];
/** 车模基准偏航（spec 车头 +Z，body 恒定 rotY(π)） */
const MODEL_BASE_YAW = Math.PI;
/** 加载屏最长等待外部壳的时间（超时即放行，绝不把用户卡在 loading） */
const SHELL_GATE_MAX_MS = 6000;

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
  private readonly hudState = { speedKmh: 0, s: 0, total: 0, gear: 'N', clock: '00:00.000' };

  private started = false;
  private running = false;
  private time = 0;
  private lapClock = 0;
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

    // 赛道 / 地形 / 点缀（全部程序化，零外部资源）
    this.trackScene = new Track(this.scene, this.renderer.capabilities.getMaxAnisotropy());
    this.landscape = new Landscape(this.scene);
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

    this.menu = new Menu(() => this.startRun());
    this.hud.setVisible(false);
    this.menu.show(true);
    this.rig.setMode('orbit');

    window.addEventListener('resize', this.onResize);
    window.addEventListener('orientationchange', this.onOrientation);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);

    // 车先摆到起点（菜单 orbit 相机围着它转）
    this.syncCarPose(0);
    this.prevX = this.drive.state.x;
    this.prevY = this.drive.state.y;
    this.prevZ = this.drive.state.z;
    this.prevHeading = this.drive.state.heading;
    this.car.setHeadlights(true);

    this.loop = new Loop(
      { tick: (step) => this.tick(step), frame: (dt, alpha) => this.frame(dt, alpha) },
      PHYSICS_HZ
    );
    // 加载期 GPU 预热（收益项，失败不影响启动）
    if (!import.meta.env.DEV || !window.location.hash.includes('noprewarm')) this.prewarm();
    this.loop.start();
  }

  /* ══ 运行控制 ═══════════════════════════════════════════════════════════ */

  private startRun(): void {
    this.sfx.unlock();
    this.sfx.uiClick();
    if (!this.started) {
      this.started = true;
      this.drive.resetToStart();
      if (this.teleportS !== undefined) this.drive.teleportTo(Number(this.teleportS));
      this.lapClock = 0;
      this.cycleIndex = 0;
      this.fx.clear();
      this.rig.setMode('chase');
      this.prevX = this.drive.state.x;
      this.prevY = this.drive.state.y;
      this.prevZ = this.drive.state.z;
      this.prevHeading = this.drive.state.heading;
      this.hud.showToast('W/S 油门刹车 · A/D 转向 · Space 手刹 · C 机位 · R 复位', false, 3600);
    }
    this.menu.show(false);
    this.hud.setVisible(true);
    this.running = true;
    this.car.setHeadlights(true);
  }

  /** Esc：暂停回菜单（车停在原地，计时冻结；再点开始是继续，不重置） */
  private pause(): void {
    if (!this.running) return;
    this.running = false;
    this.keys.clear();
    this.input.throttle = 0;
    this.input.brake = 0;
    this.input.steer = 0;
    this.input.handbrake = false;
    this.menu.show(true);
    this.hud.setVisible(false);
    this.sfx.updateEngine(0, false);
    this.sfx.updateWind(0);
    this.sfx.updateSqueal(0, 0);
  }

  private keyDown(e: KeyboardEvent): void {
    const code = e.code;
    if (code === 'Escape') {
      this.pause();
      return;
    }
    if (!this.running) return;
    if (code === 'KeyC') {
      this.cycleCamera();
      e.preventDefault();
      return;
    }
    if (code === 'KeyR') {
      this.drive.resetToTrack();
      this.prevX = this.drive.state.x;
      this.prevY = this.drive.state.y;
      this.prevZ = this.drive.state.z;
      this.prevHeading = this.drive.state.heading;
      this.hud.showToast('已回到赛道', false, 1200);
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

  /** 固定步长 1/120s：只推驾驶模型（位姿写回放渲染帧做插值） */
  private tick(step: number): void {
    if (!this.running) return;
    const st = this.drive.state;
    this.prevX = st.x;
    this.prevY = st.y;
    this.prevZ = st.z;
    this.prevHeading = st.heading;
    this.drive.step(step, this.input);
    this.lapClock += step;
  }

  private frame(dt: number, alpha: number): void {
    this.time += dt;
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

    const absSpeed = Math.abs(st.speed);
    const speedKmh = absSpeed * MS_TO_KMH;
    const braking = this.input.brake > 0 && st.speed > 0.2;
    const reverse = st.speed < -0.2;

    // ---- 车体视觉 ----
    this.car.body.rotation.x = st.pitch;
    this.car.body.rotation.z = st.roll;
    this.car.spinWheels(st.speed * dt, dt);
    this.car.setSteer(st.steer);
    this.car.setBrakeLights(braking || this.input.handbrake ? 8 : 1.6);
    this.car.updateCluster(speedKmh, 0, Math.abs(st.accel) / 9.81, reverse ? 'R' : 'D');
    this.car.update(this.rig.camera, dt);

    // ---- 灯光 / 接地阴影 / 环境 ----
    const focus = this.car.root.position;
    this.lighting.update(focus);
    this.contactShadow.update(this.car.body);

    // ---- 相机 ----
    this.rig.update(dt, focus, this.running ? absSpeed : 0, this.car.root.quaternion);
    this.applyTopCam();
    this.env.update(this.rig.camera.position);
    this.car.updateSteeringGate?.(this.rig.camera);
    this.applyVisibility?.({ interior: isInteriorMode(this.rig.mode) });

    // ---- 音效 ----
    this.sfx.updateEngine(speedKmh, this.input.throttle > 0 && this.running);
    this.sfx.updateWind(absSpeed / (200 / MS_TO_KMH));
    this.sfx.updateSqueal(this.input.handbrake && absSpeed > 3 ? 0.55 : 0, absSpeed);

    // ---- 特效（烟/刹车痕；低档内部自动关闭）----
    const fx = this.fxInput;
    fx.carRoot = this.car.root;
    fx.brakeIntensity = braking ? 0.7 : 0;
    fx.speedMs = absSpeed;
    fx.braking = braking;
    this.fx.update(dt, fx);

    // ---- 后处理（动态模糊默认关；开启才按真实渲染跳距给强度）----
    const blurOn = isMotionBlurEnabled();
    const blur = blurOn ? Math.min(0.18, ((absSpeed * dt) / 0.925) * 0.12) : 0;
    this.postfx.setSpeedBlur(blur, blurOn ? dt : 0, blurOn);
    this.postfx.setFlash(0);

    // ---- HUD ----
    const tel = this.drive.telemetry;
    const hs = this.hudState;
    hs.speedKmh = tel.speedKmh;
    hs.s = tel.s;
    hs.total = getTrack().length;
    hs.gear = tel.gear;
    hs.clock = formatClock(this.lapClock);
    this.hud.update(hs);

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

  /** 位姿写回（root 承载 heading+π + 世界位置；body 只承载基准 π 与视觉俯仰/侧倾） */
  private applyPose(x: number, y: number, z: number, heading: number): void {
    this.car.root.position.set(x, y, z);
    this.car.root.rotation.set(0, heading + MODEL_BASE_YAW, 0);
    if (this.car.body.rotation.y !== MODEL_BASE_YAW) this.car.body.rotation.y = MODEL_BASE_YAW;
  }

  private syncCarPose(alpha: number): void {
    const st = this.drive.state;
    this.applyPose(st.x, st.y, st.z, st.heading);
    this.car.body.rotation.x = st.pitch;
    this.car.body.rotation.z = st.roll;
    void alpha;
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
    this.scenery.dispose();
    this.car.dispose();
    this.renderer.dispose();
  }
}

/** mm:ss.mmm */
function formatClock(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.floor((s - Math.floor(s)) * 1000);
  return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}.${ms
    .toString()
    .padStart(3, '0')}`;
}
