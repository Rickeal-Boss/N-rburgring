/**
 * 圈速计时（纯状态：无 three / 无 DOM / 无 Game 依赖，Node 可直接步进复算）
 *
 * 语义（与 docs/NR_D2_SPEC.md §1 一致）：
 *  · **正向过线**才算圈：`prevS > L−LINE_WINDOW && s < LINE_WINDOW && speed > 0`，
 *    且本圈**正向累计里程 ≥ 0.9L** —— 两条同时满足才 `lap++`。
 *    反着开过线（`prevS` 小、`s` 大）永远不触发，倒车刷圈不可行。
 *  · 第一次过线只**启动**计时（`running=true`），不算完成一圈；R 复位后同理
 *    （本圈作废 → 下一次过线重新起算）。
 *  · 分段在 L/3、2L/3 各记一次（只认正向跨点，且单步位移 < 300m 防传送误判）；
 *    存的是**该段用时**（S1/S2/S3），不是累计值。
 *  · 最佳圈 + 最佳分段一起持久化到 `localStorage[key]`，读写全 try/catch
 *    （隐私模式/Node 无 localStorage 时静默降级为「仅内存 best」）。
 *  · 时间来源只有累计 `dtMs`（不读 Date），因此测试可完全确定化。
 */
import type { Nordschleife } from '../track/nordschleife';

export interface LapSplit {
  s1: number | null;
  s2: number | null;
  s3: number | null;
}

export interface LapState {
  /** 已完成圈数 */
  lap: number;
  /** 是否已过线开始计时 */
  running: boolean;
  /** 本圈已用 ms */
  currentMs: number;
  lastMs: number | null;
  bestMs: number | null;
  splits: LapSplit;
  bestSplits: LapSplit | null;
  /** 本圈当前相对最佳（负 = 快）；无最佳或未起算时为 null */
  deltaMs: number | null;
}

/** 过线判定的窗口（米）：起点在 −40m，一帧最多 ~1.2m，80m 足够宽且不易误判 */
export const LINE_WINDOW = 80;
/** 成圈所需的最小正向里程比例（防原地/倒车刷圈） */
export const MIN_LAP_FRACTION = 0.9;
/** 单步最大合理位移（m）：超过视为传送（R 复位 / QA `#s=`），不参与跨点判定 */
const MAX_STEP_M = 300;

/** mm:ss.mmm（HUD / toast 共用，避免两处格式漂移） */
export function formatLapTime(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '--:--.---';
  const total = Math.max(0, Math.round(ms));
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const milli = total % 1000;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${milli
    .toString()
    .padStart(3, '0')}`;
}

/** 带符号差值文本（+01.234 / −00.456，用于 Δ 显示） */
export function formatDelta(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '';
  const sign = ms < 0 ? '−' : '+';
  const abs = Math.abs(Math.round(ms));
  const m = Math.floor(abs / 60000);
  const s = Math.floor((abs % 60000) / 1000);
  const milli = abs % 1000;
  const body =
    m > 0
      ? `${m}:${s.toString().padStart(2, '0')}.${milli.toString().padStart(3, '0')}`
      : `${s.toString().padStart(2, '0')}.${milli.toString().padStart(3, '0')}`;
  return sign + body;
}

interface StoredBest {
  bestMs: number;
  bestSplits: LapSplit | null;
}

/** localStorage 最小接口（Node/隐私模式取不到时返回 null，调用方零分支） */
interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

function resolveStorage(): StorageLike | null {
  try {
    const s = (globalThis as { localStorage?: StorageLike }).localStorage;
    return s ?? null;
  } catch {
    return null;
  }
}

/** 把角度差折算到 (−L/2, L/2]（赛道闭合） */
function wrapDelta(ds: number, L: number): number {
  let d = ds % L;
  if (d > L / 2) d -= L;
  else if (d < -L / 2) d += L;
  return d;
}

const emptySplit = (): LapSplit => ({ s1: null, s2: null, s3: null });

export class LapTimer {
  private readonly length: number;
  private readonly key: string;
  private readonly storage: StorageLike | null;
  /** L/3、2L/3 分段点 */
  private readonly mark1: number;
  private readonly mark2: number;

  /** 上一步弧长（NaN = 待基线化） */
  private prevS = Number.NaN;
  /** 本圈正向累计里程（m） */
  private travelled = 0;
  private running = false;
  private currentMs = 0;
  private lastMs: number | null = null;
  private lapCount = 0;
  private splits: LapSplit = emptySplit();
  private bestMs: number | null = null;
  private bestSplits: LapSplit | null = null;
  private hit1 = false;
  private hit2 = false;
  private mark1Ms = 0;
  private mark2Ms = 0;

  constructor(track: Nordschleife, storageKey = 'nr.bestLap') {
    this.length = track.length;
    this.key = storageKey;
    this.mark1 = this.length / 3;
    this.mark2 = (this.length * 2) / 3;
    this.storage = resolveStorage();
    this.load();
  }

  /** 最佳圈（ms），无则 null —— HUD/菜单共用 */
  get best(): number | null {
    return this.bestMs;
  }

  /**
   * 每物理步调用。
   * @param s 当前沿路弧长（m，0..L）
   * @param speedMs 有符号纵向速度（>0 = 前进）
   * @param dtMs 本步时长（ms）
   * @returns 'lap' 完成一圈 / 'best' 刷新最佳 / 'sector' 跨分段点 / null
   */
  step(s: number, speedMs: number, dtMs: number): 'lap' | 'sector' | 'best' | null {
    if (!Number.isFinite(s)) return null;
    const L = this.length;
    if (!Number.isFinite(this.prevS)) {
      this.prevS = s;
      return null;
    }
    const prev = this.prevS;
    this.prevS = s;
    const ds = wrapDelta(s - prev, L);
    // 正向单步（传送/R 复位产生的跳变不算）
    const forward = ds > 0 && ds < MAX_STEP_M;

    if (this.running) {
      this.currentMs += Number.isFinite(dtMs) && dtMs > 0 ? dtMs : 0;
      if (forward) this.travelled += ds;
    }

    let event: 'lap' | 'sector' | 'best' | null = null;

    // ── 分段（只认正向跨点，各记一次）─────────────────────────────────
    if (this.running && forward) {
      if (!this.hit1 && prev < this.mark1 && s >= this.mark1) {
        this.hit1 = true;
        this.mark1Ms = this.currentMs;
        this.splits.s1 = this.currentMs;
        event = 'sector';
      } else if (!this.hit2 && prev < this.mark2 && s >= this.mark2) {
        this.hit2 = true;
        this.mark2Ms = this.currentMs;
        this.splits.s2 = this.currentMs - this.mark1Ms;
        event = 'sector';
      }
    }

    // ── 过线（起终线在 s=0）───────────────────────────────────────────
    const crossed = prev > L - LINE_WINDOW && s < LINE_WINDOW && speedMs > 0 && forward;
    if (crossed) {
      const completed = this.running && this.travelled >= L * MIN_LAP_FRACTION;
      if (completed) {
        const total = this.currentMs;
        this.lastMs = total;
        // S3 = 全程 − 到 2L/3 的累计；若从未跨 2L/3（异常圈）用 0 兜底
        this.splits.s3 = this.hit2 ? Math.max(0, total - this.mark2Ms) : null;
        this.lapCount += 1;
        const isBest = this.bestMs === null || total < this.bestMs;
        if (isBest) {
          this.bestMs = total;
          this.bestSplits = { ...this.splits };
          this.persist();
        }
        event = isBest ? 'best' : 'lap';
      }
      // 起算新圈（首次过线 / R 复位后过线都走这里，只启动不计圈）
      this.running = true;
      this.currentMs = 0;
      this.travelled = 0;
      this.splits = emptySplit();
      this.hit1 = false;
      this.hit2 = false;
      this.mark1Ms = 0;
      this.mark2Ms = 0;
    }

    return event;
  }

  state(): LapState {
    return {
      lap: this.lapCount,
      running: this.running,
      currentMs: this.currentMs,
      lastMs: this.lastMs,
      bestMs: this.bestMs,
      splits: { ...this.splits },
      bestSplits: this.bestSplits ? { ...this.bestSplits } : null,
      deltaMs: this.delta()
    };
  }

  /** R 复位：清本圈（计时/里程/分段），最佳保留 */
  resetLap(): void {
    this.prevS = Number.NaN;
    this.travelled = 0;
    this.running = false;
    this.currentMs = 0;
    this.splits = emptySplit();
    this.hit1 = false;
    this.hit2 = false;
    this.mark1Ms = 0;
    this.mark2Ms = 0;
  }

  /** 清最佳（含持久化） */
  resetAll(): void {
    this.resetLap();
    this.lastMs = null;
    this.lapCount = 0;
    this.bestMs = null;
    this.bestSplits = null;
    try {
      this.storage?.removeItem?.(this.key);
    } catch {
      /* 存储不可用则忽略 */
    }
  }

  /** 本圈相对最佳：按里程进度折算最佳圈时间（负 = 快） */
  private delta(): number | null {
    if (!this.running || this.bestMs === null) return null;
    const progress = Math.min(1, Math.max(0, this.travelled / this.length));
    return this.currentMs - this.bestMs * progress;
  }

  private load(): void {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(this.key);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<StoredBest>;
      const ms = parsed.bestMs;
      if (typeof ms === 'number' && Number.isFinite(ms) && ms > 0) this.bestMs = ms;
      const sp = parsed.bestSplits as Partial<LapSplit> | null | undefined;
      if (sp && typeof sp === 'object') {
        this.bestSplits = {
          s1: typeof sp.s1 === 'number' ? sp.s1 : null,
          s2: typeof sp.s2 === 'number' ? sp.s2 : null,
          s3: typeof sp.s3 === 'number' ? sp.s3 : null
        };
      }
    } catch {
      /* 损坏数据当作没有成绩 */
    }
  }

  private persist(): void {
    if (!this.storage || this.bestMs === null) return;
    try {
      const payload: StoredBest = { bestMs: this.bestMs, bestSplits: this.bestSplits };
      this.storage.setItem(this.key, JSON.stringify(payload));
    } catch {
      /* 配额/隐私模式：静默降级为内存 best */
    }
  }
}
