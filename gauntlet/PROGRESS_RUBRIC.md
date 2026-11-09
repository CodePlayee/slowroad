# 进展强制选择细则（Source-Blind Progress Check）

你只能读取分配给你的 `RUBRIC.md` 与每个 `Q*/` 目录下的 `A.png`、`B.png`、`R.png`。不得读取目录之外的任何文件、源代码或私钥；禁止联网、启动浏览器、与其他评审交流。

每个 `Q*` 里，`R.png` 是目标：一款已发布风景驾驶游戏的截图。`A.png` 和 `B.png` 是同一仿作的两个版本，机位设置相同；若道路走向或地形在两版间有变化，两图的具体景物也会不同，此时比较的就是各自整体的视觉水准。R 的地点、机位、时段可能与 A/B 不同，这不是你要评的。

**任务**：判断 A、B 哪个在视觉质量上更接近 R 所代表的水准。必须二选一，不允许平局；差异很小时也要选，并把 `confidence` 记为 `low`。逐张查看全部图片后再作答，只评画面。

## 每个 Q

1. `closer`：`A` 或 `B`。
2. `confidence`：`high`（一眼可见）、`medium`、`low`（要仔细比才看得出）。
3. `dimensions`：下列每项写 `A`、`B` 或 `same`：`composition`、`terrain`、`road`、`vegetation`、`ground`、`atmosphere`、`lighting`、`cleanliness`。
4. `changed`：A、B 之间最明显的画面差异，指明图像区域。
5. `regression`：被选中的一方相比另一方变差的地方，没有写空字符串。

## 全部看完后

`next_gap`：相对 R，这个仿作目前最大的单一差距（指明画面区域和具体视觉目标）。

## 输出

把结果写成一个 JSON 文件（路径由任务指定），然后结束：

```json
{
  "judge": "<你的代号>",
  "pairs": [
    {"id": "Q01", "closer": "A", "confidence": "high",
     "dimensions": {"composition": "same", "terrain": "A", "road": "same", "vegetation": "B", "ground": "A", "atmosphere": "same", "lighting": "same", "cleanliness": "same"},
     "changed": "...", "regression": ""}
  ],
  "next_gap": {"region": "...", "target": "..."}
}
```
