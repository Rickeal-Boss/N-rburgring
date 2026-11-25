# N-rburgring 改造规格（v1）

> 由 `Ultimate-Design-V800`（R167 / 712ba23）复制改造。目标：**去刹停玩法 → 自由驾驶巡游 + 圈速计时**，
> 道路改为纽博格林北环走向，地图放大到 20.83 km；只保留 V800 高精度车模；程序化建筑降密度。
> 画面观感（石材/车漆/光照/雾/天空/后处理/音效音色）沿用旧仓。

## 0. 已定基线

- 工作副本：`C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/nrburgring/`
- 中心线：`src/track/nordschleife.ts`（**已完成**，9 个几何测试全绿）
  - 20 831.6 m 闭合环，min radius 28.6 m，max grade < 18%，横倾由曲率驱动（左弯左低）
  - API：`getTrack()` / `at(s)` / `toWorld(x,y,s)` / `closestS(x,z)` / `locate(x,y,z)` / `headingAt(s)`
  - ⚠ `at()` 返回**复用对象**，需要跨调用保留时必须展开拷贝
- 车模：只保留 `src/assets/cars/v800/**` + `src/model/**` 的 V800 链路。
- 旧仓锁定手感数值（沿用）：`config/physics.ts` 的 `VEHICLE` / `DRIVE`；转向曲线与
  「灵魂 12」（maxYawRate 0.9 / refSpeedMs 5.5 / corneringStiffness 92000·88000 /
  yawInertia 11000 / tyreMu 0.92 / driftGripFloor 0.32 / aligningStiffness 9200 /
  gripDecayTau 0.22 / gripRecoverTau 0.45）。

## 1. 删除清单（玩法层整体下线）

```
src/core/StateMachine.ts      src/core/FreeDrive.ts      src/core/cityFootprints.ts
src/physics/World.ts          src/physics/Vehicle.ts     src/physics/BrakeModel.ts
src/ui/Result.ts              src/ui/Sliders.ts
src/render/scene/castle.ts    src/render/scene/castleDetail.ts
src/render/scene/castleKit.ts src/render/scene/r27Layout.ts
src/render/scene/r28Layout.ts src/render/scene/Terrain.ts
src/render/scene/Road.ts（保留 roadTexture → 迁到 roadTexture.ts）
tests/ 下除 track_geometry.test.ts 外的旧玩法用例整批删除
package.json 的 cannon-es 依赖
src/model/R7Adapter.ts / createR7Model.ts / YangwangAdapter.ts / parts/r7* / parts/yangwang*
src/config/vehicles.ts 收窄为单车 v800（VehicleId 可保留但只导出 v800）
```

## 2. 新增/重写

| 文件 | 职责 |
|---|---|
| `src/render/scene/roadTexture.ts` | 从旧 Road.ts 原样迁出 `roadTexture()` + `createSoilTexture()`（材质观感唯一来源） |
| `src/render/Track.ts` | 沿中心线放样：石板路面（半宽 7m，u 0..1，v=s/12）、白石路缘（1.4m）、土路肩（3.2m）、护栏（x=±11.2，立柱 InstancedMesh） |
| `src/render/Landscape.ts` | 横向剖面带（±1400m，12~16 列）+ 远地面；草地/泥土贴图；跟随路面高程平滑过渡 |
| `src/render/Scenery.ts` | 低密度点缀：树（InstancedMesh，间距 22~30m，双侧）、岩石、公里牌、起点建筑群（石砌看台/龙门架/维修墙） |
| `src/core/Drive.ts` | 玩家驾驶模型（见 §3） |
| `src/core/LapTimer.ts` | 圈速/分段/最佳（localStorage） |
| `src/ui/Hud.ts` | 速度、圈时、最佳、圈数、分段、小地图、提示 |
| `src/ui/Menu.ts` | 标题 + 开始 + 操作说明（重写为极简） |
| `src/core/Game.ts` | 新装配：renderer/postfx/env/lighting/contactShadow/car/camera/track/hud/loop |

## 3. 驾驶模型（拟真度 = 旧仓，操作 = 仿 AC）

- 输入：W/S 油门/刹车，A/D 转向，Space 手刹，C 切机位，R 回赛道，Esc 暂停。
- 世界系 2D 刚体 + 自行车模型：位置 `(x,z)`、航向 `ψ`、速度 `v`。
  - 纵向：`F = motor - drag - roll - brake`，`motor` 用恒扭矩→恒功率（390kW / 3300kg / 效率 0.92），
    最高 200 km/h；制动 `≤1.1g`（ABS），倒车 -8 km/h。
  - 横向：`yawRate = v·tan(δ)/L`，钳制 `|v·yawRate| ≤ μg`（μ=0.92）；超限时削 yaw + 轻微削速（推头）。
  - 手刹：后轴抓地降到 `driftGripFloor`，允许甩尾；`gripDecayTau/recoverTau` 控制恢复。
  - 转向：速度敏感（低速 34°、高速 6°），一阶滞后 `yawResponseTau`，回正 `steerReturnRatio=0.7`。
  - 姿态：车体 y 跟随路面；pitch 由加速度 + 路面坡度，roll 由横向加速度 + bank；复用 R156-R158 二阶悬挂/轮跳。
- 边界：`|lateral| > halfWidth + 0.9` 触发护栏碰撞：法向推回、切向保速（×0.82）、
  火花 + 相机 shake + 音效；不允许穿出。路肩（1.4~10m）允许行驶，抓地 ×0.86。
- 起点：`s = length - 40`，朝 +s；倒计时 3-2-1 后计时开始（第一次过线启动圈）。
- 复位 R：回到最近 `s` 的中线，速度 0，不重置圈时。

## 4. 圈速

- 起终线 `s=0`；过线判定：上一物理步 `s > L-80` 且当前 `s < 80` 且沿 +s 方向。
- 首圈从第一次过线开始；圈数 +1；记录 `last` / `best`（localStorage `nr.bestLap`）。
- 分段：`s = L/3, 2L/3`，显示 S1/S2/S3 与最佳差（Δ，红/绿按中国习惯：慢=红？——
  本项目用「快=绿、慢=红」的赛车通用语义，HUD 图例写明）。
- 小地图：Canvas 2D 画中心线折线（一次性离屏），北向上，车点位 + 起终线标记。

## 5. 相机 / 音效

- `CameraRig`：删除 `BOUNDS/corridorHalfWidth` 依赖；`chase` 改 `local: true`（车尾后方，
  offset 构图沿用旧值），hood/cabin/side/orbit 保留；`cycleViews = chase/hood/cabin/side`。
- `addShake` / `addFovPunch` 保留（撞护栏用）。
- `Sfx`：`updateEngine(speedKmh, powered)` / `updateWind` / `updateSqueal` 保留；
  删除 brakeClick/snap/thermal 相关调用；撞击用 `impact`。

## 6. 观感红线（禁改）

- `Renderer.ts` 的 toneMapping/exposure 0.88、`Lighting.ts` 的 sun 1.5/hemi 0.6/fill 0.42/rim 0.5/VSM、
  `Environment.ts` 的天空/雾/PMREM 柔光板参数、`Postfx.ts` 的 bloom/blur 参数、`vehiclePaint` 车漆参数。
- 石板贴图的三带配色/缝宽/条石 2.4m 周期、`createSoilTexture` 的土色。
- 车模几何/材质/内饰/贴图不动。

## 7. 验收

1. `npm run build`（tsc strict + vite）零报错；`npx vitest run` 全绿（新测试 ≥ 20 用例）。
2. 三机位截图（chase / hood / castle 远眺改为高处俯瞰）：路面石板密度与旧仓一致、无 Z  fighting、
   无护栏断裂、无地形穿插、远处雾过渡自然。
3. `#perfhud` 真机（核显）chase 视角 ≥ 50 FPS，DC ≤ 180，tri ≤ 400k。
4. 20.83 km 一圈可完整跑完，圈时/最佳/分段正确；护栏碰撞不穿模；R 复位可用。

## 8. 已知坑

- `at()` 复用对象；`closestS` 全程扫 700 次距离，逐帧可用，构建期 8 万顶点请按 `s` 直接放样。
- 长条几何必须沿弧长逐段生成，不能只放一个中心。
- 路面 ribbon 的三角绕序必须朝上（右手系：中心线 +s 前进，横向 +x 向右）。
- 护栏/树木用 InstancedMesh，单个 mesh 一个 draw call。
- 地形剖面带在弯心内侧可能自交：横向列宽 > 弯心半径时要收缩列宽（Karussell R≈50m，
  内侧列 ≤ 40m；本规格取 ±8/24/60/120/220/420/800/1400，内侧 16m 起，安全）。
