# F 方向评测

这个目录放 NewIDE 的 F 方向初步评测管线。当前阶段不自建完整数据集，先直接使用 SWE-EVO 作为数据源；`newide-scaffold` 只记录固定子集和评测产物，不复制完整 SWE-EVO 数据。

## 数据集子集

- `v0-smoke`：最小冒烟子集，用来确认评测链路能跑通。
- `v0-dev`：早期开发子集，用来在扩大规模前做稳定迭代。

子集元数据在 `eval/datasets/` 下。每个文件记录来源版本、来源 JSONL、筛选规则、环境要求和固定的 instance id 列表。完整 SWE-EVO JSONL 路径由 `eval/manifest.json` 声明。

## 预测模式

- `stub`：默认基线，生成一个固定的假 patch，只用来验管线。
- `oracle`：回放 SWE-EVO 金标 patch，只用来检查 harness 和数据链路。
- `gold`：`oracle` 的兼容别名，不建议新命令继续使用。
- `real`：使用调用方通过 `--patch-file` 传入的真实 patch。

注意：`oracle` / `gold` 是“拿标准答案去判卷”，不能当作 NewIDE 能力指标。真正看能力时应使用 `real`，或者后续接入 NewIDE 实际生成的 patch。

## 一次评测会留下什么

每个 run 目录至少应该包含：

- `dataset-manifest.json`：这次评测用了哪个数据集、哪些实例。
- `run-meta.json`：运行配置，如 prediction mode、模型名、ablation。
- `predictions.jsonl`：NewIDE 提交给 harness 的答案。
- `telemetry.jsonl`：F 方向埋点。
- `summary.json`：评测摘要。

如果这次已经接入 SWE-EVO harness，还会把 harness report 导入到 `summary.json` 和 `telemetry.jsonl` 中。

## 常用命令

生成单个实例的预测：

```powershell
pnpm eval:instance -- --instance-id conan-io__conan_2.0.14_2.0.15 --mode stub
```

跑固定冒烟子集：

```powershell
pnpm eval:smoke -- --subset v0-smoke --mode stub
```

跑金标冒烟，也就是用 SWE-EVO 标准答案验证评测链路：

```powershell
pnpm eval:smoke -- --subset v0-smoke --mode oracle --skip-scaffold --run-id oracle_smoke
```

把 NewIDE 的 `predictions.jsonl` 转成 SWE-EVO 当前脚本能吃的 harness 输入：

```powershell
pnpm eval:sweevo-harness -- --predictions .newide/eval/<run>/predictions.jsonl --run-id <run> --dry-run
```

去掉 `--dry-run` 后会真正调用 SWE-EVO harness。真实执行需要本机 SWE-EVO 环境和 Docker 可用。

## 怎么理解这套系统

人话版流程是：

1. NewIDE 先交答案，生成 `predictions.jsonl`。
2. SWE-EVO harness 负责判卷，判断 patch 是否能应用、是否解决问题、有没有 P2P 回归。
3. F 方向评测层把数据集、答案、判卷结果和 telemetry 收到同一个 run 目录里，方便复现和解释。

所以 `stub` 用来看管线，`oracle` 用来看判卷系统，`real` 才用于看 NewIDE 的真实能力。
