/**
 * 车辆档位（纽北改造：只保留尊界 V800 单车）
 *
 * 旧仓 R15–R95 的三车档位（v800 / r7 / yangwang）已随车模链路一起下线：
 * 本作只跑 V800，`VehicleId` 收窄为字面量 `'v800'`，`resolveVehicleId()` 恒返回
 * `'v800'`（URL `#vehicle=` / localStorage 历史值一律忽略，不报错、不阻塞启动）。
 *
 * 保留 `VehicleProfile` 的字段形状（含 `brakeBreakable` / `brakeTempGainScale`）是为了
 * 不把「档位 → 装配/物理」的接口在 D1 就拆散；这两个字段在自由驾驶里不再被消费，
 * D2 若接圈速/耐久再决定是否清理。
 */
export type VehicleId = 'v800';

/** 单个内饰机位（**装配局部坐标**，与 CameraRig MODES 的 local 偏移同口径） */
export interface InteriorViewPose {
  /** 眼点 [x, y, z] */
  eye: [number, number, number];
  /** 注视点 [x, y, z] */
  target: [number, number, number];
}

/**
 * 车模装配层注入的三个内饰视角（CarLike.interiorViews?）。
 * V800 不提供 → CameraRig 退回内置 cabin 偏移；类型保留供结构型访问。
 */
export type InteriorViews = Record<'driver' | 'passenger' | 'rear', InteriorViewPose>;

export interface VehicleProfile {
  id: VehicleId;
  /** 菜单/HUD 展示名 */
  name: string;
  /** 菜单副标题（一句话定位） */
  subtitle: string;
  /** 踏板是否可能机械断裂（自由驾驶不再消费） */
  brakeBreakable: boolean;
  /** 制动盘升温倍率（自由驾驶不再消费） */
  brakeTempGainScale: number;
  massKg: number;
  maxSpeedKmh: number;
  lengthM: number;
  widthM: number;
  heightM: number;
  /** 视距/机位微调（可选；未设则 1） */
  cameraScale?: number;
}

export const VEHICLE_PROFILES: Record<VehicleId, VehicleProfile> = {
  v800: {
    id: 'v800',
    name: '尊界V800',
    subtitle: '行政旗舰 MPV · 390kW 双电机 · 计算质量 3300kg',
    brakeBreakable: true,
    brakeTempGainScale: 0.75,
    massKg: 3300,
    maxSpeedKmh: 200,
    lengthM: 5.495,
    widthM: 2.006,
    heightM: 1.85,
    cameraScale: 1
  }
};

export const VEHICLE_IDS: VehicleId[] = ['v800'];

/** 当前生效车型：本作恒为 v800（签名保留，消费方不必改调用形状） */
export function resolveVehicleId(): VehicleId {
  return 'v800';
}

export function getVehicleProfile(_id: VehicleId = 'v800'): VehicleProfile {
  return VEHICLE_PROFILES.v800;
}

/** 写入选择（单车后为空操作，保留出口避免 Menu/HUD 分支残留） */
export function setActiveVehicle(_id: VehicleId): void {
  /* 单车：无跨会话选择需要持久化 */
}
