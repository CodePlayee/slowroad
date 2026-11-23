# Slowroad

Open world scenic driving built with Vite and Three.js. The scene includes
procedural terrain and roads, bridges and water, streamed vegetation, seasonal
atmosphere, and a locally bundled Tesla Model Y vehicle asset.

## Requirements

Node.js ≥ 22.15 (`package.json` `engines`). The gauntlet tests load `src/`
through `module.registerHooks`, which Node 20 lacks: under Node 20.18 44 of
the 48 test files fail to load, while `vite build` still completes with a
version warning. Check `node --version` first; on some machines a login shell
puts an older Node ahead of 22 on `PATH`.

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
# Per-frame cost by subsystem, draw calls and triangles (needs a running dev server):
PLAYWRIGHT_BROWSERS_PATH=~/.local/ms-playwright node gauntlet/frame-bench.mjs --url http://127.0.0.1:5188 --out /tmp/bench.json
```

The `gauntlet/` directory contains deterministic runtime checks and capture
tools. Generated captures and benchmark rounds are ignored by Git; no test
reads them, so the full suite runs on a fresh checkout.

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

### 第二阶段 r18–r26b（2026-11-08/09、11-15）：强制二选一把关

方法：

- **冻结快照拍图**：`gauntlet/scene-round.sh <round> <上一轮目录>` 先把当轮源码打成 `src.tar.gz` 并记录 hash，再构建独立的 `dist/`，经 `vite preview` 拍 10 个镜头。拍图期间改源码不会混入。
- **进展判定**：3 位全新评审在 A/B 之间二选一，官方图作为目标 R（`gauntlet/PROGRESS_RUBRIC.md`），只评有变化的镜头。接受需要 ≥ 20/30 票；≤ 14 票回退源码；15–19 票视为无法判定，需要拆分改动。
- **校准**：每轮场景包混入冻结的 r17 截图（`gauntlet/rounds/calibration`），用来监测评审组漂移。r18–r24 期间 chase_summer_noon 的校准分保持在 2.81–2.96；r25–r26b（11-15）为 2.41–2.74，同一张图低约 0.3，跨日期比较场景分要先扣掉这个偏移。
- **留出镜头**：`gauntlet/shots.json` 新增 `holdout_a…f`（其他 seed/km），实现者调参时不看，用 `gauntlet/holdout-round.sh` 拍摄。r25 起每轮同时判定代表镜头和留出镜头，两组都通过才接受；留出镜头的阈值同为 2/3（18 票中 ≥ 12 接受，≤ 8 回退）。

| 轮次 | 改动 | 二选一（新/旧） | 决定 |
|---|---|---:|---|
| r18 | 恢复山坡树林；土方顺接自然地面；去掉灰色陡坎 | 21 / 9 | 接受 |
| r19 | 路肩、高矮混合的干/绿草丛、野花、路侧灌木与蕨类 | 24 / 6 | 接受 |
| r20 | 草丛过渡变缓、缩短草带、地形坡面着色 | 10 / 20 | 回退 |
| r21 | 以相机为中心的远处草地层（`pasture.js`）；修正夜间草地发亮 | 26 / 4 | 接受 |
| r22 | 冬季路面与雪堤 + 森林重写 | 16 / 14 | 拆分：保留冬季（3/3），回退森林 |
| r23 | S 形弯道路线 | 9 / 21 | 回退（远景、湖面、山谷纵深丢失） |
| r24 | 路侧植物层（`verge.js`、`tussock.js`）；分段路侧设施：木栏 / 下坡与桥头波形护栏 / 干砌石墙（`roadside.js`、`furniture.js`）；近路不再长高大针叶树；冬季埋没牧草 | 29 / 1 | 接受 |
| r25 | 第二版路线：沿等高线的弯道（`route.js` `_meander`） | 22 / 8；留出 11 / 7 | 不接受：留出镜头未达 2/3，多条留出路线反而变直；路线保持 r24 |
| r26 | 中景田块拼布（`terrain.js` `fieldParcel`，4 种田块色调）+ 树篱线 + 修剪条纹 + 中景林冠着色 | 15 / 15；留出 7 / 11 | 回退：chase_golden 3/3 认可田块，但硬边田块和树篱线被一致看成贴图接缝（holdout_b 3/3 高置信） |
| r26b | r26 拆分：只保留田块色调，边缘 18 m 柔和过渡 | 9 / 18；留出 12 / 6 | 回退：接缝消失，但评审在所有代表镜头都看不出差别，票数等同随机 |

与官方截图的场景评分仍远低于官方，**未达到官方效果**：r24–r26b 四轮我方 2.93–3.20、官方 3.97–4.12，每轮最多 2/30 胜，且胜局都来自官方图自身的问题（驾驶舱、纯白天空）。r24–r26b 评审一致指出的剩余差距：

1. **中远景地形与构图**：缺少层层叠叠的山丘、成片连续的林冠与明亮田块相间的拼布，以及随距离渐变的空气透视；路线仍偏直。r26/r26b 表明只在地表着色上画田块不够：硬边像接缝，软边又看不出来。下一步需要让田界有实体（树篱或林带实例），或者做更大尺度的地形与森林改动。
2. **整洁度**：草丛间距过于均匀、成行；灌木偏暗且成斑块；石墙纹理重复；护栏看起来像一条细亮线。
3. **近景草**：密度和体积感仍不及官方。

### r24b 基线（r24 + 运行时修复 + 仓库清理）

r24 之后的改动没有单独做二选一盲评。它们作为 r24b 基线拍过全部 16 个镜头：与 r24 相比，只有 forest_dense（0.78% 像素）和 season_winter（8.87% 像素，差值都不超过 8 级）有变化，其余镜头的变化不到 0.1%。改动如下：

- 花朵的 CPU 剔除距离与 shader 淡出距离统一使用同一个范围，避免远处花朵突然消失。
- 冬季被埋没的蕨类和路侧植物同时从地面接触贴图中移除；季节切换时重建贴图。
- 基础灌木避开石墙段，与 `verge.js` 的规则一致。
- `ground-contact-audit.mjs`、`rigcheck.mjs` 统计新增的 `pasture` 类别。
- 删除 `roadmesh.fenceMaterial` 这个仅供测试使用的别名，改用 `furnitureMaterials`。
- 仓库清理（2026-11-15）：车辆的 Draco 解码改用 three 自带的 glTF 解码器（`DRACO_GLTF_CONFIG`，由 Vite 随应用输出），删除重复的 `public/draco/`；删除未被引用的 `public/models/car-concept.glb`（11.8 MB）、`public/textures/leafy-grass.jpg`、`meadow-opacity-r31.*` 及其署名；删除根目录的 `_probe*.mjs`、`_dump.mjs` 调试脚本；在 `gauntlet/PLAN.md` 补全 rig 契约，去掉对不存在的 `gauntlet/RIG.md` 的引用。

测试：多处断言源码文本、默认值或 golden hash 的测试已删除或改成行为检查。桥梁测试改为从生成的路线中查找桥，不再写死 km。r24b 时 Node 22 下全量 `gauntlet/*.test.mjs` 共 452 个，全部通过。

已知风险：植物接触记录上限仍为 16 384，所有 seed 的真实上界尚未证明。

证据：每轮的源码快照、hash、截图、盲评 JSON、揭盲 key 和汇总都在 `gauntlet/rounds/`（约 2.6 GB，已加入 git ignore，不提交）；`gauntlet/rounds/LOG.md` 记录每轮的票数和评审意见。

### 2026-11-16 运行时修复（r24b 之后；未经盲评）

针对查看时发现的四个问题，分四个并行切片在独立 worktree 里修复后合并。合并后在 5 个代表镜头上与 r24b 比较：除车身姿态（悬挂）和随车身轻微变化的驾驶舱视角外逐像素一致；chase_golden 远处另有一小段桥头路面变化。

- **切换相机不再冻屏**（`src/main.js`、`src/camera/cameras.js`）：切换视角原先走 `beginTransition()`，一直停帧到新焦点的植被就绪（本机 1.4 s 到 30 s 以上）；切到 cine/vista 还要在主线程同步生成树木分布（最多 437 ms）。现在切换视角不停帧；cine/vista 的树冠数据在任何模式下都用 worker 预取，避让结果在每帧 1 ms 预算内提前算好。合并后实测 8 次切换停帧 0 帧，切换调用 1.6–14 ms。瞬移、改 seed/km 和 `__rig.snap()` 仍然停帧到就绪。
- **路边草地提前就绪**（`src/vegetation/` 下的 `system.js`、`populationPool.js`、`population.js`、`population.worker.js`、`grassField.js`、`flowerField.js`）：根因是只有 1 个生成 worker，一块 32 m 路边草要 0.3–0.95 s，按车速每秒需要约 3 块，队列长期积压约 200 个任务。现在按 CPU 核数开 1–3 个 worker、共享优先队列（灌木和树不占最后一个空闲 worker）；生成前先剔除路带外的候选点（每块快 21%，结果逐条相同）；worker 用 MessageChannel 让出；草按相机到达的先后排队；`frame()` 不再第二次调用 `veg.update`，改为 `veg.refreshVisibility()`。行驶中才出现的草和花在 0.8 s 内淡入，暂停、抓图和停帧期间立即完整显示。合并后实测（seed 7 km 6–7.5，时间缩放 0.25）：视野内草块突然出现 13→0，缺草帧 42%→0，生成队列 87→2。
- **悬挂**（新增 `src/vehicle/suspension.js`；`vehicle.js`、`wheels.js`，参数在 `params.js` 的 `VEHICLE.suspension`）：车身是四角弹簧阻尼上的刚体，带防倾杆和限位块；垂向、俯仰、侧倾固有频率 1.3/1.5/2.0 Hz，阻尼比 0.38/0.44/0.49。输入是每个车轮下的路面（含 2.2% 路拱）、纵向加速度（刹车点头、加速下蹲）、横向加速度（向弯外侧倾 4.5°/g）和约 2 mm 的路面纹理；按 1/240 s 固定子步积分，与帧率无关。车轮贴地，在轮拱里上下行程；车灯和驾驶舱视点随车身运动，但驾驶舱去掉了路拱造成的静态倾斜。`snapTo` 直接置于该位置、该车速下的稳态，抓图仍然确定。自动驾驶的目标车速改为连续（前瞻 255 m，按 1.5 m/s² 计划减速），加加速度限制在 2.5 m/s³；原来约每 0.33 s 在 −5 和 +3.2 m/s² 之间切换一次，正好落在俯仰固有频率附近。
- **桥头路面**（`src/road/route.js`）：桥梁引道代码在路面上留下了尖峰（seed 12 km 1.55 的 18 cm 鼓包，seed 7 km 10.54 的 11% 坡度突变），有了悬挂后车会撞限位甚至离地。现在引道只会被抬向高于路面的桥面，所有折点都圆滑成竖曲线：108 km/h 下竖向加速度不超过 0.2 g，7.5% 坡度上限和桥面净空不变。seeds 7/12/31 全线最大竖向加速度从 1.83/1.68/2.08 g 降到 0.20/0.17/0.13 g，限位碰撞归零；路面只在桥头引道变化，最多 0.72 m。路线构建耗时变为每个 seed 2–59 ms（原 3–10 ms）。
- **性能**（`src/vegetation/instanceCulling.js`、`cullingGroup.js`、`forestField.js`，`src/water/water.js`，`src/terrain/terrain.worker.js`，`src/vehicle/asset.js`）：同一材质的树木 impostor 合并为一次实例化绘制；剔除器在同一帧内不再重复检查，平面测试内联；世界矩阵只在组移动时下传；水面单遍绘制，车玻璃拆成先背面、后正面两份，不再每帧重查着色器程序。`gauntlet/frame-bench.mjs`（1280×720，5 个机位，与 HEAD 交替各两轮）：draw call 减少 52–58%（chase 725→349）；静止帧主线程 CPU 减少 33–43%（chase 16.3→9.7 ms），其中提交渲染减少 50–62%；行驶帧 CPU 只减少 4–16%，因为草现在真的生成出来了，要剔除的实例更多。三角形数不变（5.6–6.8 M，约 77% 是草）。

测试：Node 22 下全量 486 个测试通过（新增切换视角、悬挂、路面竖曲线、多 worker 生成和实例合并等测试），构建成功；vista_wide 和 chase_summer_noon 重复抓图逐字节相同。

尚未处理：

- 行驶时最大的 CPU 开销是草的逐实例剔除（本机约 8–9 ms/帧）。
- GPU 侧最大的抓手是远处草的 LOD，但会改变画面，需要盲评。
- 草块记录以对象数组从 worker 传回主线程，每块反序列化约 7–15 ms（本机）；改成端到端的列式 typed array 可以省掉。
- 这批改动没有做盲评。

### 2026-11-22 行驶与道路修复（未经盲评）

针对实车查看反馈的左右晃动、弯道折线与部分路段的草地突然出现，分别在独立 worktree 实现，再合入当前代码：

- **车身横摆与侧倾**（新增 `src/vehicle/handling.js`）：折线中心线的单节点曲率尖峰原先直接驱动悬挂、转向与车头朝向，车身约每秒左右摆一次。现在由带轮胎松弛长度的单车模型计算车的实际轨迹与侧向力，驾驶员控制以路线前馈加车道偏移反馈、手部滞后实现；悬挂侧倾取实际轮胎侧向力，路面纹理左右轮迹部分相关。三个 seed 各行驶 10 km：在旧折线路线上，横滚摆动标准差 0.28–0.31°→0.048–0.061°，每帧最大 yaw-rate 跳变 8.8–9.4→0.16–0.17°/s；与下述平滑道路合用时，车道偏移保持在 ±0.13 m 内。`snapTo`、驾驶舱与四轮贴地契约保持。
- **道路弯道折线**（`src/road/route.js`）：原先每 22 m 的规划点之间用直线重采样，半数 5.5 m 节点的转角为 0、折点最大 6°。现在用穿过规划点的 C2 样条按弧长重采样，并在 `at()` 中以五次 Hermite 给出相互一致的连续位置、切向和曲率；`nearest()` 投影到实际曲线。五个种子下节点转角最大 1.53°、相邻节点转角变化最大 0.20°、最大曲率从 9.5e-3 降到 4.84e-3 m⁻¹；与原路线横向偏差 p99 0.27 m，km 12 沿路漂移约 +1.4–1.8 m。道路、桥梁、地形开挖与路边植物使用同一曲线。固定镜头的道路和植被构图会有变化，尚未盲评。
- **道路前方草与灌木预取**（`src/vegetation/system.js`、`forestField.js`、`src/terrain/terrain.js`、`src/core/noise.js`）：剩余弹出主要是灌木/路边草丛；在生成队列积压时，220 m 可见的灌木却低优先级且规划得太晚。现在按各层进入视野的时间统一排序，沿路线预取未来 5 秒内眼睛将看到的草、牧草和灌木，仅在地形已规划的范围内增加任务；迟到灌木也淡入。`gnoise` 的梯度改为逐位等价的 8 方向查表，草块生成 p50 466→172 ms。在种子 7/12/31 的约 3.2 km 行驶测试中，0.5 倍时间流速下基线分别有 49/61/12 次可见弹出，修复后均为 0；在负载相近的 1 倍及 2 倍交替运行中也为 0。该结果依赖本机 CPU 负载，静态抓图与基线逐字节相同。

集成检查：Node 22 下全量 508 个测试通过，构建成功；seed 12 km 6.4–7.4 在 0.5 倍时间流速、轮换四种机位时，记录到的草地首次可见突变为 0。交叉审查发现三次高度插值会在节点之间超出原有坡度/桥面净空约束，因此高度与坡度保留原先受约束的线性插值，只平滑水平中心线，并增加节点之间的回归采样检查。

上述性能与截图证据来自软件渲染及确定性仿真，不能代替用户 GPU 机器上的主观体验；弯道构图和车辆姿态发生变化，尚未通过项目的盲评闸门。

### 无 GPU 机器上的截图
```sh
PLAYWRIGHT_BROWSERS_PATH=~/.local/ms-playwright npx playwright install chromium
# 一轮完整盲评素材（冻结快照 + 10 个镜头 + 场景包 + 与上一轮的二选一包），需 Node >= 22.15：
gauntlet/scene-round.sh r27 gauntlet/rounds/r24b
gauntlet/holdout-round.sh r27 r24b          # 6 个留出镜头
# 每位评审只读取自己那份包，写出 judge-*.json，然后：
python3 gauntlet/aggregate-scene-blind.py gauntlet/rounds/r27/progress.private-key.json judge-*.json
```

- 速度：`cpu-capture.mjs` 在加载阶段跳过重复的主场景绘制，但保留完整 streaming/asset residency，最终仍渲染并读回一张 1920×1080 帧。SwiftShader 耗时随机器不同：原机单张约 101–111 秒（两路并行 125–158 秒/张）；2026-11-15 在另一台机器上单张约 241 秒，两路并行 221–296 秒/张，一轮 10 个代表镜头加 6 个留出镜头约 36 分钟。Lavapipe（Vulkan）在 headless 下拿不到 WebGL2。
- 浏览器目录：本机的 `~/.cache/ms-playwright` 曾两次被不明进程清空，所以浏览器装到 `~/.local/ms-playwright`。
