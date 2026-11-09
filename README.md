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
4. ~~已知会失败的测试~~：2026-11-09 起全量测试通过，见下文。

### 第一阶段盲评迭代 r6–r17（2026-11-06/07）：整体退步

r6–r17 每轮 10 个固定镜头、3 位全新盲评，按 0–5 绝对分与官方截图比较。逐轮均分（我方/官方）：r6 2.94/3.77 … r14 3.36/3.95，r15 3.48/3.99，r16 2.96/3.84，r17 2.91/3.81；30/30 判定始终 `material_gap: true`。

事后审计发现这套绝对分不可靠，结论需要修正：

- **评审噪声大于改动效果。** 同一张截图在不同轮次得分不同：cockpit_overcast 在 r13/r14 分别为 2.74/3.59，cockpit_noon 在 r15/r16 分别为 3.59/2.59。r14、r15 的“高分”来自评审组差异，并非画面变好。
- **r17 比 r5（迭代前）更差。** 强制二选一盲评中，r5 胜 22/30。r17 丢失了山坡上连片的树林，cockpit_noon 左侧山坡出现大块无纹理的灰带；只有 chase_summer_noon 的开阔远景更好（3/3）。
- **轮次不规范。** r12、r16 的代码在上一轮盲评结果出来前就已落盘；r17 的源码 hash 只覆盖两个文件。

### 第二阶段 r18–r25（2026-11-08/09）：强制二选一把关

方法：

- **冻结快照拍图**：`gauntlet/scene-round.sh <round> <上一轮目录>` 先把当轮源码打成 `src.tar.gz` 并记录 hash，再构建独立的 `dist/`，经 `vite preview` 拍 10 个镜头。拍图期间改源码不会混入。
- **进展判定**：3 位全新评审在 A/B 之间二选一，官方图作为目标 R（`gauntlet/PROGRESS_RUBRIC.md`），只评有变化的镜头。接受需要 ≥ 20/30 票；≤ 14 票回退源码；15–19 票视为无法判定，需要拆分改动。
- **校准**：每轮场景包混入冻结的 r17 截图（`gauntlet/rounds/calibration`），用来监测评审组漂移。r18–r24 期间 chase_summer_noon 的校准分保持在 2.81–2.96。
- **留出镜头**：`gauntlet/shots.json` 新增 `holdout_a…f`（其他 seed/km），实现者调参时不看，用 `gauntlet/holdout-round.sh` 拍摄。

| 轮次 | 改动 | 二选一（新/旧） | 决定 |
|---|---|---:|---|
| r18 | 恢复山坡树林；土方顺接自然地面；去掉灰色陡坎 | 21 / 9 | 接受 |
| r19 | 路肩、高矮混合的干/绿草丛、野花、路侧灌木与蕨类 | 24 / 6 | 接受 |
| r20 | 草丛过渡变缓、缩短草带、地形坡面着色 | 10 / 20 | 回退 |
| r21 | 以相机为中心的远处草地层（`pasture.js`）；修正夜间草地发亮 | 26 / 4 | 接受 |
| r22 | 冬季路面与雪堤 + 森林重写 | 16 / 14 | 拆分：保留冬季（3/3），回退森林 |
| r23 | S 形弯道路线 | 9 / 21 | 回退（远景、湖面、山谷纵深丢失） |
| r24 | 路侧植物层（`verge.js`、`tussock.js`）；分段路侧设施：木栏 / 下坡与桥头波形护栏 / 干砌石墙（`roadside.js`、`furniture.js`）；近路不再长高大针叶树；冬季埋没牧草 | 29 / 1 | 接受 |
| r25 | 第二版路线方案 | 未判定 | 已拍图，盲评中止；路线保持 r24 版本 |

与官方截图的场景评分仍是 **0/30 胜**（r24：我方 3.10，官方 4.09），**未达到官方效果**。r24 盲评指出的剩余差距：

1. **地形与构图**：缺少层层叠叠的山丘、田地与森林相间的地块，以及更有纵深的远景；路线仍偏直。
2. **整洁度**：草丛间距过于均匀、成行；灌木偏暗且成斑块；石墙纹理重复；护栏看起来像一条细亮线。
3. **近景草**：密度和体积感仍不及官方。

### 最终代码 = r24 + 运行时修复（未经盲评）

r24 之后为修复审查发现的运行时缺陷做了以下改动，只做过构建、全量测试和冒烟截图，没有经过盲评：

- 花朵的 CPU 剔除距离与 shader 淡出距离统一使用同一个范围，避免远处花朵突然消失。
- 冬季被埋没的蕨类和路侧植物同时从地面接触贴图中移除；季节切换时重建贴图。
- 基础灌木避开石墙段，与 `verge.js` 的规则一致。
- `ground-contact-audit.mjs`、`rigcheck.mjs` 统计新增的 `pasture` 类别。
- 删除 `roadmesh.fenceMaterial` 这个仅供测试使用的别名，改用 `furnitureMaterials`。

测试：多处断言源码文本、默认值或 golden hash 的测试已删除或改成行为检查。桥梁测试改为从生成的路线中查找桥，不再写死 km。Node 22 下全量 `gauntlet/*.test.mjs` 共 452 个，全部通过。

已知风险：植物接触记录上限仍为 16 384，所有 seed 的真实上界尚未证明。

证据：每轮的源码快照、hash、截图、盲评 JSON、揭盲 key 和汇总都在 `gauntlet/rounds/`（约 1.8 GB，已加入 git ignore，不提交）。

### 无 GPU 机器上的截图
```sh
PLAYWRIGHT_BROWSERS_PATH=~/.local/ms-playwright npx playwright install chromium
# 一轮完整盲评素材（冻结快照 + 10 个镜头 + 场景包 + 与上一轮的二选一包），需 Node >= 22.15：
gauntlet/scene-round.sh r26 gauntlet/rounds/r24
gauntlet/holdout-round.sh r26 r24          # 6 个留出镜头
# 每位评审只读取自己那份包，写出 judge-*.json，然后：
python3 gauntlet/aggregate-scene-blind.py gauntlet/rounds/r26/progress.private-key.json judge-*.json
```

- 速度：`cpu-capture.mjs` 在加载阶段跳过重复的主场景绘制，但保留完整 streaming/asset residency，最终仍渲染并读回一张 1920×1080 帧。SwiftShader 实测单张约 101–111 秒，两路并行时约 125–158 秒/张，10 张约 13 分钟；旧的 45–75 分钟估计已过时。Lavapipe（Vulkan）在 headless 下拿不到 WebGL2。
- 浏览器目录：本机的 `~/.cache/ms-playwright` 曾两次被不明进程清空，所以浏览器装到 `~/.local/ms-playwright`。
