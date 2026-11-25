# 纽博格林北环 · 自由驾驶

Vite + TypeScript + three.js 程序化三维赛道。**20.83 km 纽博格林北环走向**，自由驾驶 + 圈速计时；
无刹停玩法、无失败判定、无计分。

- 赛道：106 个手工路点经闭合 Catmull–Rom 插值 + 等弧长重采样，全长 **20 831.6 m**，
  最小曲率半径 28.6 m，最大坡度 < 18%，含 Hohe Acht 高点 / Fuchsröhre 下坡 / Karussell 台地横倾。
- 画面：石板铺装、白石路缘、土路肩、护栏、树木/岩石/废墟全部程序化；沿用原项目的石材贴图、
  车漆、天空/雾/光照/后处理与音效体系。
- 车辆：仅尊界 V800 高精度模型（程序化车身 + GLB 车轮装配）。
- 玩法：W/S 油门刹车、A/D 转向、Space 手刹、C 切机位、R 回赛道、Esc 暂停；
  过起终线计圈，记录本圈/最佳/三段分段，最佳成绩存 localStorage。

> 非官方粉丝作品。本项目与 Nürburgring / Nürburgring 1927 GmbH & Co. OHG 及其关联方
> **无任何隶属、授权或合作关系**；赛道为按公开走向手工编排的示意复刻，非测绘数据，
> 不含 GPS/OSM/DEM 数据。车辆为程序化示意模型，与实车存在差异。

## 运行

```bash
npm install
npm run dev      # 开发
npm run build    # tsc --noEmit && vite build
npm run preview  # 预览构建产物
npm test         # vitest
```

## 资产口径

运行时 `dist/` 不加载任何外部资源（无 CDN / 外链图片 / 模型 / 音频 / 字体）；几何、环境贴图、
赛道贴图、植被与建筑均为程序化生成，音效由 WebAudio 合成。车辆装配使用仓库内 GLB 车轮/车身件，
座舱 7 张表面贴图为第三方宣传图衍生裁片，登记见 [docs/ASSETS.md](docs/ASSETS.md) 第 9 节。

## 目录

```
src/track/nordschleife.ts   中心线/坐标架/closestS（纯数据）
src/render/Track.ts         路面/路缘/路肩/护栏/起终线
src/render/Landscape.ts     横向剖面地形
src/render/Scenery.ts       树/岩石/公里牌/起点建筑群
src/core/Drive.ts           驾驶模型（自行车模型 + 抓地钳 + 手刹漂移）
src/core/LapTimer.ts        圈速/分段/最佳
src/core/Game.ts            装配与帧循环
```
