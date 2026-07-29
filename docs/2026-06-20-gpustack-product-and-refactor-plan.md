# GPUStack 对比分析与 AMUIN AI STACK 改造计划

日期：2026-06-20

## 1. 背景

本次调研对象为开源项目 GPUStack：

- GitHub 仓库：https://github.com/gpustack/gpustack
- 官网：https://gpustack.ai
- 定位：开源 GPU 集群管理器，用于配置和编排 vLLM、SGLang、TensorRT-LLM 等推理引擎，面向多集群、高性能 AI 模型部署。

调研目标：

1. 评估 GPUStack 与 AMUIN AI STACK 的雷同性。
2. 判断 GPUStack 已存在的情况下，本项目是否仍有继续开发意义。
3. 提炼可借鉴的技术路径。
4. 制定本项目下一阶段改造目标和计划。

## 2. 时间线结论

GPUStack 明显早于本项目公开出现。

关键时间：

- GPUStack 仓库创建时间：2024-05-11T03:41:58Z。
- GPUStack 最早 commit：`feat: init commit`，作者时间 2024-04-25T02:51:32Z，提交时间 2024-05-12T15:21:54Z。
- GPUStack 至少在 2024-08-08 已发布 `0.1.1` release。
- GPUStack 最新调研时 release：`v2.2.0`，发布时间 2026-06-18T15:54:18Z。
- AMUIN AI STACK 本地仓库初始提交：2026-06-15 11:46:48 +0000。
- AMUIN AI STACK 主要 Electron、SQLite、容器模板实现集中在 2026-06-16 到 2026-06-17。

结论：

- GPUStack 作为公开项目早于 AMUIN AI STACK 约两年。
- GPUStack 最新版本更新时间晚于 AMUIN AI STACK 当前本地早期版本。
- 如果对外叙事接近“GPU 集群管理 / MaaS 平台 / 多集群推理调度”，会与 GPUStack 形成高重合。

## 3. 雷同性评估

### 3.1 产品方向相似度：高

相似点：

- 都面向 GPU 上的 AI 模型部署和推理服务。
- 都涉及模型下载、运行时启动、模型部署、OpenAI-compatible API。
- 都使用或支持 vLLM、TensorRT-LLM、Docker、NVIDIA runtime、HuggingFace、ModelScope 等生态组件。
- 都有“下载模型 -> 部署模型 -> 暴露 API”的用户路径。

估计相似度：60%-70%。

### 3.2 技术架构相似度：中低

GPUStack：

- Python 3.10-3.12。
- FastAPI。
- SQLModel / SQLAlchemy / Alembic。
- server + worker agent。
- scheduler、policy、candidate selector、worker filter、score chain。
- Kubernetes SDK、Helm chart。
- Prometheus / Grafana。
- Auth、API Key、组织、用户、多租户能力。
- 支持多集群、多 worker、多运行时、多硬件。

AMUIN AI STACK：

- Electron 桌面应用。
- Node.js / TypeScript API。
- Vue 3 + Vite 前端。
- SQLite。
- 本地 Docker / Docker Compose。
- 固定运行时模板：vLLM、TensorRT-LLM、PyTorch Audio。
- 本机模型目录审计、下载任务、容器生命周期、OpenAI proxy。

估计相似度：25%-40%。

### 3.3 源码实现雷同性：低

没有发现直接源码复制证据。两边：

- 语言不同。
- 目录结构不同。
- 依赖体系不同。
- 核心控制面不同。
- worker 概念不同。
- 调度深度不同。

共同点更多来自行业标准组合，而不是代码实现雷同。

## 4. 产品差异判断

### 4.1 GPUStack 是什么

GPUStack 是 GPU 集群级 MaaS / 推理基础设施平台。

核心用户：

- 平台工程师。
- IT 管理员。
- 企业 AI Infra 团队。
- 需要管理多机器、多集群、多团队、多模型副本的组织。

核心价值：

- 多集群 GPU 管理。
- worker agent 管理。
- 模型实例调度。
- 运行时自动选择和参数优化。
- 监控、认证、访问控制、用量统计。
- 生产级模型服务平台。

### 4.2 AMUIN AI STACK 应该是什么

AMUIN AI STACK 应定位为：

> 面向 DGX Spark / 本地 AI 工作站的桌面化 AI 模型工作台：可下载、可审计、可部署、可解释、可恢复。

核心用户：

- DGX Spark 用户。
- 本地工作站用户。
- 私有单机环境开发者。
- 希望快速把模型跑起来的个人和小团队。

核心价值：

- 桌面化本地体验。
- 本机 Docker / NVIDIA runtime 可视化管理。
- 模型下载、文件审计、运行时兼容提示。
- 固定、可解释、可手动控制的运行时模板。
- OpenAI-compatible 本地网关。
- 出错后给可执行修复动作。

## 5. 是否仍有继续开发意义

结论：有继续开发意义，但不能做 GPUStack 的轻量复刻。

### 5.1 不值得继续投入的方向

以下方向 GPUStack 已经更成熟，AMUIN AI STACK 不应正面竞争：

- 多集群 GPU 管理。
- worker agent 注册和心跳。
- 企业级组织、用户、RBAC。
- 多租户 API Key 计量体系。
- Kubernetes operator / Helm 生产部署。
- 云 GPU provisioning。
- Prometheus / Grafana 生产监控套件。
- 复杂调度器、负载均衡、模型副本管理。

### 5.2 值得继续投入的方向

AMUIN AI STACK 应继续投入：

1. 本地模型工作台。
2. DGX Spark-first 运行时模板。
3. 模型文件审计和下载管理。
4. 运行时兼容性专家系统。
5. 桌面化 Docker/GPU/端口/日志诊断。
6. 本地 OpenAI-compatible 网关。
7. PyTorch Audio / ASR / TTS / OpenAI Realtime 本地工具链。
8. 失败修复体验。

一句话战略：

> GPUStack 做生产级 GPU 集群平台；AMUIN AI STACK 做 DGX Spark / 本地工作站桌面控制台。

## 6. 可借鉴 GPUStack 的技术路径

原则：

> 学习 GPUStack 的底层工程可靠性，不学习它的产品边界。

### 6.1 模型下载

GPUStack 值得借鉴：

- 使用 HuggingFace / ModelScope 官方 SDK 获取文件列表和文件大小。
- 支持单文件、pattern、extra file 下载。
- 按 repo 加软锁，避免并发踩缓存。
- 维护 cache_dir 和 local_dir。
- 识别 `.incomplete`、临时目录、lock 文件。
- 删除或取消模型时清理不完整文件。
- 使用任务池控制并发下载。

AMUIN 当前状态：

- `apps/api/src/downloadManager.ts` 调用 shell 脚本。
- `ops/scripts/hf-download.sh` 和 `ops/scripts/ms-download.sh` 已有 `.temp` staging 和 `.download-complete` marker。
- `taskProgress.ts` 通过目录大小和日志解析估计进度。

改造方向：

- 保留 Docker 下载容器。
- API 层升级为下载编排器。
- 下载前获取文件列表、总大小和必要文件。
- 增加 repo 下载锁。
- 支持取消后清理 `.temp` / incomplete。
- 支持 API 重启后的 interrupted 检测。

### 6.2 模型文件状态

GPUStack 值得借鉴：

- 把 model 和 model file 状态拆开。
- `ModelFile` 可以有 downloading、ready、error、deleting 等状态。
- 存 resolved paths、source、cleanup_on_delete。
- 文件删除和 incomplete 清理是独立流程。

AMUIN 当前状态：

- 主要通过扫描 `models/` 目录生成 `ModelRecord`。
- 状态更多来自任务和磁盘 marker。

改造方向：

- 新增 `ModelFileRecord`。
- 将下载任务、模型源、实际文件路径、状态、大小绑定起来。
- 删除模型时同时处理缓存、临时目录、marker 和任务残留。

### 6.3 运行时计划

GPUStack 值得借鉴：

- 运行时启动前先生成 workload / container plan。
- 将 image、env、mounts、ports、resources、command、args、restart policy 结构化。
- 再交给底层 runtime/deployer 执行。

AMUIN 当前状态：

- `deploymentManager.ts` 和 `containerTasks.ts` 直接拼 Docker / Compose 命令。
- vLLM、TensorRT-LLM、PyTorch Audio 逻辑分散。

改造方向：

- 新增 `RuntimePlan`。
- 所有运行时先生成 plan，再渲染为 Docker CLI 或 Compose。
- UI 可以预览 plan。
- 失败时能定位在 pull、create、start、health 的具体阶段。

### 6.4 模型兼容性评估

GPUStack 值得借鉴：

- evaluator 按步骤评估模型输入、metadata、environment、runtime version。
- scheduler 进一步结合 worker、GPU、模型实例做候选评估。
- 输出 compatibility messages 和 scheduling messages。

AMUIN 当前状态：

- `modelFormatStrategies.ts` 已经是 data-driven 策略。
- 当前偏文件名、config、marker 启发式。

改造方向：

- 做本地版兼容性专家系统，不做集群调度。
- 增加文件完整性、运行时支持、硬件资源、参数建议。
- 输出明确解释：为什么能跑、为什么不能跑、需要转换什么、推荐怎么跑。

### 6.5 任务和故障恢复

GPUStack 值得借鉴：

- worker watch model instances。
- 状态同步。
- 错误实例自动重试。
- 日志持久化。
- 运行时健康检查。

AMUIN 当前状态：

- `taskRunner.ts` 已支持 pause / resume / cancel。
- 任务日志是原始 stdout/stderr。
- `taskProgress.ts` 做进度富化。

改造方向：

- 任务增加结构化 JSONL 事件。
- 区分阶段：preflight、pull image、download files、start container、health check。
- API 启动时 reconcile 旧任务。
- 失败时生成 `failure_reason` 和 `repair_actions`。

## 7. 改造总目标

把 AMUIN AI STACK 从：

> 能跑通模型下载与容器部署的本地工具。

升级为：

> 面向 DGX Spark / 本地 AI 工作站的桌面化 AI 模型工作台：可下载、可审计、可部署、可解释、可恢复。

核心不做多集群调度，而是做好本机体验：

- 模型文件状态清楚。
- 运行时计划透明。
- 部署失败能修。
- 参数建议可信。
- OpenAI API 一键可用。

## 8. 产品目标

1. 本地优先。
2. DGX Spark 优先。
3. 可解释部署。
4. 可恢复工作流。
5. 保持轻量。

展开说明：

- 所有能力围绕本机 Docker、NVIDIA runtime、模型目录、端口、日志和桌面权限设计。
- 内置 DGX Spark 推荐模型、vLLM / TensorRT-LLM / PyTorch Audio 模板、显存策略、端口策略、NVIDIA 镜像建议。
- 用户选择模型后，系统必须说明模型格式、适合运行时、兼容理由、缺失文件、推荐参数和本机资源是否足够。
- 下载中断、镜像拉取失败、端口冲突、显存不足、容器启动失败，都要给出下一步修复动作。
- 不加入多租户、集群 scheduler、云 GPU 管理、企业 RBAC。

## 9. 技术改造目标

### 9.1 目标一：模型下载系统升级

当前状态：

- `downloadManager.ts` 调 shell 脚本下载。
- 脚本已有 `.temp` 和 `.download-complete`。

目标：

- 新增 `ModelFile` 状态层。
- 下载前获取文件列表、总大小、必要文件。
- 支持 HuggingFace / ModelScope 的 include / exclude pattern。
- 同一 repo 下载加锁。
- 支持取消后清理 `.temp` / incomplete 文件。
- API 重启后识别 interrupted 下载。
- UI 展示真实文件级进度。

优先级：最高。

### 9.2 目标二：模型审计与兼容性专家系统

当前状态：

- `modelFormatStrategies.ts` 已有格式策略，但偏启发式。

目标：

- 审计模型文件完整性：config、tokenizer、weights、特殊音频文件。
- 审计模型能力：chat、embedding、vision、asr、tts。
- 审计运行时兼容性：vLLM、TensorRT-LLM、PyTorch Audio、LM Studio 外部。
- 审计硬件：GPU 显存、GPU 数、driver、Docker runtime。
- 生成可解释结果：`compatible` / `possible` / `needs_conversion` / `unsupported`。
- 生成推荐参数：上下文长度、GPU 显存比例、tensor parallel、batch/token 上限。

优先级：最高。

### 9.3 目标三：RuntimePlan 抽象

当前状态：

- `deploymentManager.ts` 和 `containerTasks.ts` 拼 Docker / Compose 命令。

目标：

- 新增统一 `RuntimePlan`：
  - runtime
  - image
  - container name
  - env
  - ports
  - mounts
  - GPU flags
  - command args
  - health check
  - restart policy
  - cleanup policy
- vLLM / TensorRT-LLM / PyTorch Audio 都先生成 plan。
- UI 可预览 plan。
- 后端再把 plan 渲染成 Docker CLI 或 Compose。
- 运行失败时能根据 plan 定位具体阶段。

优先级：高。

### 9.4 目标四：任务系统与故障恢复

当前状态：

- `taskRunner.ts` 已有任务执行、暂停、恢复、取消。
- `taskProgress.ts` 有进度解析。

目标：

- 新增任务事件日志：JSONL 结构化事件。
- 区分阶段：preflight、pull image、download files、start container、health check。
- API 启动时 reconcile 旧任务。
- 失败时生成 `failure_reason` 和 `repair_actions`。
- 支持“清理并重试”“换端口重试”“降低显存参数重试”。

优先级：高。

### 9.5 目标五：本地系统诊断增强

当前状态：

- `systemInspector.ts` 能查 Docker、GPU、端口、系统信息。

目标：

- 增加 NVIDIA Container Toolkit 检查。
- 增加 Docker socket 权限检查。
- 增加 CUDA / driver / runtime 版本兼容提示。
- 增加模型目录磁盘空间预估。
- 增加端口冲突解释和修复建议。
- 增加 DGX Spark 设备识别和专属 profile。

优先级：中高。

## 10. 分阶段实施计划

### Phase 1：下载系统可靠化

目标：先把模型下载做稳。

交付：

- 新增 `ModelFileRecord` 类型和 SQLite 表。
- 下载任务写入 model file 状态。
- 下载前获取 HF / ModelScope 文件列表与总大小。
- 增加 repo 下载锁。
- 取消任务时清理 `.temp`。
- API 重启后识别下载中断。
- UI 显示文件数、总大小、当前状态、可重试动作。

验收标准：

- 同一个模型不能重复并发下载。
- 下载中断后可恢复或清理重试。
- 进度不再只依赖 log 百分比。
- 删除模型时能清理临时文件和缓存残留。

### Phase 2：模型审计 2.0

目标：让系统真正能回答“这个模型能不能跑”。

交付：

- 重构审计结果结构。
- 增加文件完整性检查。
- 增加 config / tokenizer / weights 校验。
- 增加能力识别：chat、embedding、vision、asr、tts。
- 增加本机 GPU 显存匹配。
- 输出运行时推荐和理由。
- UI 展示“推荐 / 可尝试 / 不支持 / 需转换”。

验收标准：

- HF checkpoint、GGUF、TRT engine、Whisper / FunASR / CosyVoice 能明确区分。
- 缺 tokenizer / config / weights 时能明确提示。
- 显存不足时不直接部署，而是给建议。

### Phase 3：RuntimePlan 与部署透明化

目标：部署前可预览，部署后可追踪。

交付：

- 新增 `RuntimePlan` 模块。
- vLLM、TensorRT-LLM、PyTorch Audio 都通过 plan 生成。
- 部署接口返回 plan。
- UI 增加“运行计划预览”。
- Docker 命令由 plan 渲染，不再散落拼接。
- 健康检查绑定 plan。

验收标准：

- 同一个模型部署前能看到镜像、端口、挂载、参数。
- 失败时知道失败在 pull、create、start、health 哪一步。
- vLLM 参数修改不会影响 TRT / PyTorch 逻辑。

### Phase 4：故障恢复与修复动作

目标：从“看日志”升级到“能修”。

交付：

- 结构化任务事件。
- 常见错误分类：
  - Docker 不可用。
  - 端口占用。
  - 镜像拉取失败。
  - 模型文件缺失。
  - 显存不足。
  - vLLM 参数不兼容。
  - health check 超时。
- 每类错误给 repair actions。
- UI 增加一键修复入口。

验收标准：

- 失败任务必须有明确原因。
- 至少 5 类常见错误有修复动作。
- 用户不需要直接读完整 log 才知道下一步。

### Phase 5：DGX Spark 专属体验

目标：拉开与 GPUStack 的产品差异。

交付：

- DGX Spark profile。
- 推荐模型清单。
- 推荐运行时参数。
- TensorRT-LLM validated profile。
- 本机 OpenAI API 网关增强。
- Audio / ASR / TTS 本地体验增强。

验收标准：

- DGX Spark 用户打开应用后能直接看到适合当前机器的模型和运行建议。
- 常见模型能一键下载、一键部署、一键调用。
- 产品叙事明确区别于 GPUStack：本地桌面工作台，不是集群管理平台。

## 11. 不做清单

为了避免产品漂移和 GPUStack 正面重叠，明确不做：

- 多集群调度。
- worker agent 注册体系。
- 企业组织 / RBAC。
- Kubernetes operator。
- 云 GPU provisioning。
- Prometheus / Grafana 生产监控套件。
- 多租户计费 / 用量平台。

## 12. 近期优先任务

建议马上开工的三个任务：

1. ModelFile 状态层 + 下载锁。
2. 模型审计 2.0 结构设计。
3. RuntimePlan 类型与 vLLM plan 改造。

这三个完成后，项目底层质量会明显提升，同时仍然保持本地工作台定位。

## 13. 参考文件

本地关键文件：

- `apps/api/src/downloadManager.ts`
- `ops/scripts/hf-download.sh`
- `ops/scripts/ms-download.sh`
- `apps/api/src/taskRunner.ts`
- `apps/api/src/taskProgress.ts`
- `apps/api/src/modelRegistry.ts`
- `apps/api/src/modelFormatStrategies.ts`
- `apps/api/src/containerTasks.ts`
- `apps/api/src/deploymentManager.ts`
- `apps/api/src/systemInspector.ts`

GPUStack 参考：

- https://github.com/gpustack/gpustack
- `gpustack/worker/downloaders.py`
- `gpustack/worker/model_file_manager.py`
- `gpustack/worker/backends/vllm.py`
- `gpustack/scheduler/scheduler.py`
- `gpustack/scheduler/evaluator.py`
- `gpustack/worker/serve_manager.py`
- `pyproject.toml`
- `README.md`

## 8. 执行进度

更新时间：2026-06-21

已完成：

- 下载可靠性：新增模型文件状态、下载锁、取消清理、任务文件汇总；Hugging Face 下载启动时尽量写入远端 planned manifest，远端请求抽为共享 `modelManifest` 模块并带 5 秒超时；任务刷新时扫描最终目录和 `.temp` 目录，同步文件级 planned/downloading/downloaded/failed/canceled 状态，并在前端任务列表和任务事件摘要显示文件级进度；加载模型页面支持部署前 RuntimePlan 预览。
- 模型审计：新增本地文件完整性、运行时推荐、GPU 显存估算；显存不足时阻止直接部署并返回解释和修复建议。
- 运行时计划：新增 `RuntimePlan`，部署前结构化生成 env、command、base_url、health_url 和 prepare/pull/start/health 阶段；部署任务元数据保存运行计划摘要，并通过命令阶段标记实时写入阶段状态；vLLM/PyTorch/TensorRT-LLM 启动命令显式暴露 pull/start 进度，前端任务阶段随实际执行推进。
- 健康检查闭环：部署命令成功后先等待 runtime health endpoint，通过后才写入 active deployment；任务成功状态延后到健康检查通过之后，健康失败会把部署任务标记为 failed；已用本机 `omnicoder-9b` + vLLM 做真实端到端验证，prepare/pull/start 正常推进，health 阶段因 vLLM KV cache 可用显存不足失败，系统未写入 active deployment 并返回 health 诊断。
- 任务诊断与修复：新增任务诊断规则、阶段定位、修复动作接口，覆盖 Docker、端口、镜像拉取、模型文件、GPU 显存、vLLM 参数和健康检查失败；诊断阶段已对齐 RuntimePlan 的 prepare/pull/start/health，镜像拉取失败归到 pull，端口/GPU/参数启动失败归到 start；端口占用场景的 `change_port` 已从指导动作升级为可执行动作，会写入运行时发布端口配置；镜像拉取失败场景的 `change_image` 已升级为可执行动作，会写入运行时镜像配置并被后续 pull/test/deploy 使用；容器配置读写已规范化 image/components，避免修复动作写坏配置；端到端验证修复了输出阶段回调异常兜底、任务 metadata 序列化、失败任务 RuntimePlan 阶段归一化问题。
- 前端可见性：任务监控展示诊断、修复按钮、运行计划阶段标签；任务日志面板展示结构化事件摘要和原始日志；加载模型页可预览 RuntimePlan 阶段、地址与命令摘要；端口与镜像修复动作可在页面内输入、校验并提交。
- 测试护栏：新增 API `node:test` 契约测试，覆盖任务诊断阶段、镜像失败修复动作、修复路由、RuntimePlan 命令、endpoint 与阶段、下载文件状态采集、远端 manifest 过滤、模型审计与来源解析；修复路由覆盖 `change_port` 与 `change_image` 参数校验和配置写入；RuntimePlan 覆盖配置镜像生效；测试数据库支持 `AI_STACK_DB_PATH` 临时隔离。

验证：

- `apps/api`: `npm test` 通过，`npm run typecheck` 通过。
- `apps/frontend`: `npm run build` 通过；仅保留 Vite chunk size 警告。

下一步建议：

- 为健康检查失败后的 `restart_runtime` 增加复检反馈，或将部署参数重置做成前端快捷动作。
- 后续可针对 vLLM `No available memory for the cache blocks` 增加更精确的日志采集，把容器日志中的显存/缓存失败映射为参数调优建议。
