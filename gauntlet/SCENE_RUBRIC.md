# 全场景盲评细则（Source-Blind Scenic Driving Comparison）

你只能读取分配给你的 `Q*/A.png`、`Q*/B.png` 和本细则。图片来源、文件名含义、实现代码、构建说明、历史评审结果一律不提供，也不得去查找。禁止读取包目录之外的任何文件、源代码、私钥文件；禁止联网、启动浏览器、与其他评审交流。

每对图片是同一类镜头（追尾视角 / 驾驶舱视角 / 高处远景，及不同季节、时段、天气）的两张 1920x1080 截图。一张可能来自一款已发布的风景驾驶游戏，另一张来自仿作。**只评画面，不猜身份来给分。**

## 每对图片

1. **胜者**：`A`、`B` 或 `tie`。按画面整体视觉质量判断。
2. **分项打分**（A、B 各 0-5，整数）：
   - `composition` 构图与景深层次（近/中/远景、地平线、视线引导）
   - `terrain` 地形形态（山体轮廓、起伏连续性、坡面是否平面化/多边形感）
   - `road` 道路（与地形贴合、路肩/边坡过渡、材质、标线）
   - `vegetation` 植被（种类、比例、密度分布、剪影、近远过渡）
   - `ground` 地表材质与接地（草地/土/雪的连续性，植物与地面接触）
   - `atmosphere` 大气与空间深度（空气透视、雾、天空）
   - `lighting` 光照与曝光（明暗结构、阴影、色温、动态范围）
   - `vehicle` 车辆/驾驶舱（造型、材质、与场景融合）；画面无车时 `N/A`
   - `cleanliness` 画面洁净度（锯齿、闪烁伪影、穿模、拉伸、空洞、明显瑕疵）
3. **可比性记录**：分别说明两图在机位、时段/天气、季节、场景类型、车辆/HUD 上是否可比。不可比的维度只标该维度 `N/A`，**不得**因此豁免明显的材质、几何、光照缺陷。若两图在同一位置有相同的深色不透明矩形，那是统一遮挡的 HUD，不评分。
4. **差距**：是否仍存在明显可见的质量差距（`material_gap: true/false`）；指出较弱一方的**单一最大差距**：所在图像区域 + 具体可执行的视觉目标（例如“画面下 1/3 的路肩是浅色平面多边形，应为连续草地且与路面有过渡带”）。

## 全部图片看完后

5. 列出跨所有图片**反复出现、影响最大的 3 个差距**，按严重程度排序，每条说明：哪一方、哪些 Q、哪个画面区域、具体目标。
6. 质量结论锁定后，**可选**猜测每对中哪张来自已发布游戏（`identity_guess`），猜测不得修改任何质量结论。

## 输出

把结果写成一个 JSON 文件（路径由任务指定），结构：

```json
{
  "judge": "<你的评审代号>",
  "pairs": [
    {"id": "Q01", "winner": "A|B|tie",
     "scores": {"A": {"composition":0,"terrain":0,"road":0,"vegetation":0,"ground":0,"atmosphere":0,"lighting":0,"vehicle":0,"cleanliness":0},
                "B": {"composition":0,"terrain":0,"road":0,"vegetation":0,"ground":0,"atmosphere":0,"lighting":0,"vehicle":0,"cleanliness":0}},
     "comparability": {"camera":"...","time_weather":"...","season":"...","scene":"...","vehicle_hud":"..."},
     "reasons": "具体到画面区域的观察",
     "material_gap": true,
     "biggest_gap": {"weaker": "A|B", "region": "...", "target": "..."},
     "identity_guess": "A|B|unsure"}
  ],
  "top_recurring_gaps": [
    {"rank": 1, "weaker_side_pattern": "...", "pairs": ["Q01"], "region": "...", "target": "..."}
  ]
}
```

`N/A` 分项写字符串 `"N/A"`。只写指定的输出文件，然后结束。
