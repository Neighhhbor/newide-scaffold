# F 方向评测

这个目录放 NewIDE 的 F 方向初步评测管线。当前阶段不自建完整数据集，先直接使用 SWE-EVO 作为数据源；`newide-scaffold` 只记录固定子集和评测产物，不复制完整 SWE-EVO 数据。

## 埋点：结果层最低要求

与 `src/telemetry/埋点清单.md` §0 对齐——本目录服务**先出分**：

| 必达                                      | 说明                                                              |
| ----------------------------------------- | ----------------------------------------------------------------- |
| `run-meta.json` / `dataset-manifest.json` | `run_id`、subset、mode、instance 列表可复现                       |
| `predictions.jsonl`                       | 交给 harness 的答案                                               |
| `summary.json`                            | 评测摘要；接入 harness 后应含 resolved/applied/f2p/p2p 等 L1 字段 |

| 推荐非阻塞                  | 说明                                      |
| --------------------------- | ----------------------------------------- |
| `telemetry.jsonl`           | 联调与归因；**没有也能先出 summary 分数** |
| Proxy / memory-cycle 细事件 | 经济性或 §1 消融时再要求                  |

`stub` 验管线，`oracle` 验判卷（**不等于** NewIDE 能力），`real` 才用于能力向出分。全量 §2/§3/§4 埋点见清单归因层，不作为本目录冒烟验收项。

## 数据集子集

- `v0-smoke`：最小冒烟子集，用来确认评测链路能跑通。
- `v0-dev`：早期开发子集，用来在扩大规模前做稳定迭代。

子集元数据在 `eval/datasets/` 下。每个文件记录来源版本、来源 JSONL、筛选规则、环境要求和固定的 instance id 列表。完整 SWE-EVO JSONL 路径由 `eval/manifest.json` 声明。

## 预测模式

- `stub`：默认基线，生成一个固定的假 patch，只用来验管线。
- `oracle`：回放 SWE-EVO 金标 patch，只用来检查 harness 和数据链路。
- `gold`：`oracle` 的兼容别名，不建议新命令继续使用。
- `real`：使用真实 patch。可通过 `--patch-file` 直接传入，也可从后端
  `summary.json` 的 `worktree_path`（或显式 `--worktree-path`）自动执行
  `git diff` 收集。

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

从后端运行结果自动收集 patch，并直接交给 SWE-EVO：

```powershell
pnpm eval:instance -- --instance-id <instance-id> --mode real --backend-summary .newide/runs/<backend-run>/summary.json --skip-scaffold --run-harness
```

联调时可加 `--harness-dry-run`，只生成 `predictions.jsonl`、OpenHands trajectory
和 harness 命令，不启动 Docker。也可以用 `--worktree-path <dir>` 跳过
`summary.json` 解析。

自动收集使用临时 Git index，相对数据集实例的 `base_commit` 生成 binary diff；
它会包含已修改、已删除和未跟踪（但未被 `.gitignore` 忽略）的文件，同时不会改动
后端 worktree 的真实 Git index。worktree 必须位于 Git 仓库中，并且仓库中能解析
该 `base_commit`。

## 怎么理解这套系统

人话版流程是：

1. NewIDE 先交答案，生成 `predictions.jsonl`。
2. SWE-EVO harness 负责判卷，判断 patch 是否能应用、是否解决问题、有没有 P2P 回归。
3. F 方向评测层把数据集、答案、判卷结果和 telemetry 收到同一个 run 目录里，方便复现和解释。

所以 `stub` 用来看管线，`oracle` 用来看判卷系统，`real` 才用于看 NewIDE 的真实能力。
