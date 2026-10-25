# Slowroad

Open world scenic driving built with Vite and Three.js. The scene includes
procedural terrain and roads, bridges and water, streamed vegetation, seasonal
atmosphere, and a locally bundled Tesla Model Y vehicle asset.

## Requirements

Node.js ≥ 22.15. Vite 8 needs ≥ 20.19, and the gauntlet tests use
`module.registerHooks`; on Node 20.18 the build fails and most tests cannot
load.

## Run locally

```sh
npm install
npm run dev
```

Open <http://127.0.0.1:5188/>.

## Validate

```sh
npm run build
node --test gauntlet/*.test.mjs
```

The `gauntlet/` directory contains deterministic runtime checks and capture
tools. Generated captures and benchmark rounds are ignored by Git.
`gauntlet/surface-sampler.test.mjs` reads
`gauntlet/rounds/ground-contact-audit/ground-contact.json`, which is generated
by `gauntlet/ground-contact-audit.mjs` and is ignored by Git, so that one test
fails on a fresh checkout.

## 交接（2026-10-25，Slow Roads 视觉对齐迭代）

### 目标与方法
目标是让画面向 Slow Roads 官方截图（`refs/slowroads/official/sr_01..24.jpg`）对齐。每一轮的流程是：

1. 用当前代码拍 10 个固定镜头（`gauntlet/shots.json`）：chase_summer_noon、chase_golden、chase_dawn、chase_night、cockpit_noon、cockpit_overcast、vista_wide、forest_dense、season_autumn、season_winter。
2. 和对应的官方图匿名配成 A/B 对。
3. 交给 3 个互不知情、每轮都换新的评审代理，按 `gauntlet/SCENE_RUBRIC.md` 打分。
4. 揭盲后汇总，找出最大差距，再派优化代理去改。

工具：
- `gauntlet/cpu-capture.mjs`：无 GPU 机器上的截图工具。
- `gauntlet/package-scene-blind.py`：匿名打包，HUD 两侧同样遮罩。
- `gauntlet/aggregate-scene-blind.py`：揭盲汇总。

原始评审 JSON 和揭盲 key 在 `gauntlet/verdicts/scene-blind/<round>/`。

### 结果
每轮 10 对 × 3 位评审，共 30 次判定；均分为 0–5 分，取 9 个维度的平均。

| 轮次 | 我们胜 / 平 | 我们均分 | 参考均分 | 差距最大的维度（参考 − 我们） |
|---|---|---|---|---|
| r1b 基线 | 0 / 1 | 2.41 | 4.01 | 地形 2.27、地表 2.07、构图 2.03、道路 1.77 |
| r2 | 0 / 0 | 2.77 | 3.97 | 地形 2.37、构图 1.87、地表 1.63 |
| r3 | 2 / 0 | 2.68 | 3.95 | 地形 2.47、构图 1.70、植被 1.43 |
| r4 | 0 / 0 | 2.72 | 4.04 | 地形 2.37、构图 1.87、地表 1.60 |

- r1 截图曾有 alpha 反预乘伪影，已用 r1b 替代。修复后用户看到的画面与截图一致。
- 道路、画面洁净度、光照、车辆的差距已明显缩小，车辆一项已与参考持平；r3 的两个驾驶舱镜头各被一位评审判我方胜。
- **地形和构图一直没有缩小**。评审的描述始终是“地形平、看不到远景、两侧树墙”。

### 本轮改动（按区域）
- **画布**：`src/main.js` 改为自建 `alpha:false` 的 WebGL2 context。three r185 强制使用 alpha 缓冲，A2C 植被和羽化路肩写入的 alpha<1 会让页面背景透出来。
- **道路与路肩**：`src/road/roadmesh.js`、`src/terrain/terrain.js` 的路距带。
  - 去掉层叠半透明条纹，改为窄土边加草地渐变。
  - 加入沥青骨料和轮迹。
  - 冬季积雪改为世界空间各向同性采样。
  - 浮点 hash 改为整数 `SURFACE_HASH_GLSL`，远离原点时不再失精。
  - 高频项都按像素尺度淡出。
- **地表**：`terrain.js` 和新增的 `src/terrain/meadowField.js`。
  - 草皮有多尺度色斑和沿风向的倒伏条带。草卡片 `grassField.js` 采样同一个场。
  - 林下有地被和光斑。
  - 雪地有风成雪丘。
- **树冠**：`src/vegetation/forestField.js`。
  - 椭球自遮挡；夜间呈冷色剪影；黄昏逆光有边缘光；冬季冠顶积雪；秋色按叶团成块。
  - 车灯分支使用去色前的反照率，修复了夜间灰白灌木。
- **路侧开口**：`src/vegetation/biome.js` 的 `roadsideOpening`。左右两侧各自独立的百米级开口，seed 7 路线上至少一侧打开的路段占 39%。
- **路线**：`src/road/route.js`。
  - 奖励山腰路，惩罚谷底走廊；防止路线绕回；挖方上限 2.5 m。
  - 修复桥头引道坡度。
  - 统计脚本：`gauntlet/landform-audit.mjs`。
- **高度场**：`src/terrain/heightfield.js` 的 `_roll`，加入 0–130 m、间距约 1.7 km 的丘陵，河谷 140 m 以内不抬升。
- **远山**：新增 `src/terrain/farRidge.js`，地形和植被共用。多排山脊从 1200 m 开始抬升；`fog.js`、`atmosphere/params.js` 的远景雾曲线可配置。
- **桥**：`src/bridge/bridge.js`。
  - 矮墙加钢栏杆、端柱、楔形墩头。
  - 板梁底面和横隔梁。
  - 混凝土程序化材质：浇筑面、接缝、污渍、水位线。
  - 桥下的明暗按场景灯光计算。
  - 新增 `gauntlet/bridge.test.mjs`。
- **水**：`src/water/*`。
  - 修正菲涅耳计算中视图空间与世界空间法线混用。
  - 加 9% 天光下限。
  - 桥下地面不再按路肩处理（`terrain/mesh-data.js`）。
- **车辆**：`src/vehicle/*`。
  - 尾灯和头灯自发光。
  - 车灯投影光照图，带距离衰减和路面落点衰减。
  - 驾驶舱整车以眼点为中心放大 1.45 倍，修复近平面裁剪出的黑三角。
  - 后视镜画出解析的后方场景。
  - 内饰材质去掉错误的金属度。
- **相机**：`src/camera/*`。
  - cine/vista 加树冠避让（`CanopyIndex`）。
  - chase 机位约 4 m 高、12° 俯视，偏向下坡一侧；文档在 `gauntlet/CAMERA_DRIFT.md`。

### 未经视觉验证的改动
r4 盲评之后合入了两批改动，还没有完整复拍和盲评：
- 第 3 批副本：夜间灌木修复、cine 树冠避让。r5 只拍完 2 张就被中止，图没有盲评。
- 第 4 批副本：chase 新机位、`_roll` 丘陵、路线参数 `gradeWeight 6500`、`riverAheadScale 13`。

收尾时只用最终代码拍了 1 张 `chase_summer_noon` 作冒烟检查：完整驻留，无报错。新机位如设计生效：相机更高、略微俯视，车更小，地平线上移，画面中地面占比增大。但这一位置的左侧是上坡草坡，右侧是树，远处只有很淡的山影，与 sr_01 的开阔谷景仍有明显差距。下一轮应先完整复拍 10 张并盲评，再判断这两批改动是否有效。

### 已知问题与下一步
1. **构图仍是第一差距。** 数值分析表明，追车画面里能看到的远景主要被近路树带（约占画面 22%）和 150 m 以内的地面（约 34%）挡住；单靠加大地形振幅没有效果。下一步：
   - 降低近路林带密度，让坡面露出大片草地；
   - 让路线更偏向谷肩或高处；
   - 评估 chase 相机进树冠的风险（新机位下 60 个站里有 3 个）。
2. **`gauntlet/shots.json` 里的桥和水镜头已失效。** 改路线后，原 km 附近已经没有桥或水。建议（seed 7）：
   - bridge_approach / bridge_side 改为 3.35 / 3.49；
   - bridge_second 改为 15.58；
   - water_river 改为 2.30；
   - vista_ridges（seed 31）改为 4.95。
3. **路线对参数非常敏感。** seed 58 出现一座 5 跨 116 m 的桥；seed 7 最深挖方从 24.8 m 增加到 45.6 m。路线构建时间约 550–900 ms。
4. **已知会失败的测试。** `surface-sampler` 缺少生成数据，见上文。

### 无 GPU 机器上的截图
```sh
PLAYWRIGHT_BROWSERS_PATH=~/.local/ms-playwright npx playwright install chromium
npm run dev   # 另开终端
PLAYWRIGHT_BROWSERS_PATH=~/.local/ms-playwright node gauntlet/cpu-capture.mjs /tmp/round chase_summer_noon chase_golden
python3 gauntlet/package-scene-blind.py /tmp/round /tmp/round-blind
# 每位评审只读取 /tmp/round-blind/ 并写出 judge-*.json，然后：
python3 gauntlet/aggregate-scene-blind.py /tmp/round-blind.private-key.json judge-*.json
```

- 速度：SwiftShader 软件渲染，8 核上每张 45–75 分钟，两路并行拍 10 张约 4 小时。Lavapipe（Vulkan）在 headless 下拿不到 WebGL2。
- 浏览器目录：本机的 `~/.cache/ms-playwright` 曾两次被不明进程清空，所以浏览器装到 `~/.local/ms-playwright`。
