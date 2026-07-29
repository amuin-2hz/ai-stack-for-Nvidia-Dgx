# GPUStack 与 AMUIN AI STACK 前端体验对比及改造方案

日期：2026-06-21

## 1. 调研目标

本次调研聚焦前端页面体验，不再重复底层架构对比。评估维度：

1. 友好性：新用户是否能理解页面和下一步动作。
2. 易用性：核心流程是否短、顺、少歧义。
3. 设计感：视觉是否统一、专业、克制、有品牌感。
4. 差异化：是否符合 AMUIN AI STACK 的本地桌面工作台定位。

参考对象：

- GPUStack 官方 Quickstart。
- GPUStack 官方 UI 截图：Catalog、Deploy、Running、Playground。
- GPUStack 官网和用户指南。
- AMUIN AI STACK 当前 Vue 前端：`apps/frontend/src/App.vue`、`styles.css`、`composables/useApp.ts`、locales。

## 2. 总体结论

GPUStack 的前端更像成熟企业控制台：清爽、克制、路径明确。

AMUIN AI STACK 的前端更像功能型本地工作台：信息量大、控制力强，但认知负担偏高。

对比结论：

| 维度 | GPUStack | AMUIN AI STACK |
|---|---|---|
| 友好性 | 中高，界面干净，但术语偏平台/集群 | 中等，中文友好、功能直接，但页面信息偏密 |
| 易用性 | 高，Catalog -> Deploy -> Running -> Playground 路径清楚 | 中等，模型库/容器/部署/加载/任务分散 |
| 设计感 | 高，企业级 SaaS 控制台感强 | 中等偏上，有品牌和暗色模式，但层级略乱 |
| 专家可控性 | 中高，很多复杂度被平台托管 | 高，Docker、端口、参数、日志暴露充分 |
| 本地工作台感 | 中等，更偏平台 | 高，更贴近本机操作 |

结论：

> AMUIN 不应照搬 GPUStack 企业平台界面，但应学习它的流程清晰度、导航分组、模型目录体验和 Playground 闭环。

## 3. GPUStack 前端优点

### 3.1 核心路径清晰

GPUStack Quickstart 的前端路径非常线性：

1. 进入 `Catalog`。
2. 搜索模型。
3. 选择模型。
4. 兼容性检查通过。
5. 点击 `Save` 部署。
6. 状态变为 `Running`。
7. 进入 `Playground - Chat` 试用。
8. 需要 API 时进入 `API Keys`。

用户不需要先理解容器、端口、运行时、任务日志等底层概念。

### 3.2 Catalog 是强主入口

GPUStack 的 Catalog 截图体现了几个优点：

- 左侧导航清晰分组。
- 主区域先搜索、筛选，再展示模型卡片。
- 模型卡片显示能力标签、上下文、license、参数规模。
- 用户从“找模型”自然进入“部署模型”。

这比让用户先进入容器页或部署页更自然。

### 3.3 设计风格专业克制

GPUStack 的 UI 特征：

- 白底为主。
- 边距、分割线、卡片都比较克制。
- 信息密度较高但不压迫。
- 视觉上偏企业 SaaS 控制台。
- 导航命名贴近平台对象：Dashboard、Catalog、Deployments、Workers、GPUs、API Keys。

### 3.4 Playground 完成闭环

GPUStack 将模型部署后的下一步明确指向 Playground。用户可以马上验证模型是否可用。

这点非常重要：模型部署类产品如果没有“试用闭环”，用户会觉得流程停在了技术状态，而不是结果。

## 4. AMUIN 当前前端优势

AMUIN 不是全面落后，当前前端有一些 GPUStack 不强调的本地工作台优势：

1. 中文体验直接。
2. Electron / 本机控制台定位明确。
3. Docker、端口、LAN、本地路径、日志、任务都能直接看到。
4. vLLM / TensorRT-LLM / PyTorch Audio 参数暴露更细。
5. 已有暗色模式。
6. 已有品牌 hero 和本地设备状态。
7. 已有任务事件、运行计划预览、修复动作雏形。
8. 更适合“我就在这台机器上调模型”的用户。

这些能力应该保留，但需要重新组织成更顺的主流程。

## 5. AMUIN 当前主要问题

### 5.1 导航概念重叠

当前导航包括：

- 仪表盘
- 模型库
- 容器管理
- 部署服务
- 加载模型
- 任务
- 设置

问题：

- `部署服务` 和 `加载模型` 容易混淆。
- `容器管理` 是底层概念，对新用户过早暴露。
- 用户不知道第一次使用应该从哪个页面开始。

### 5.2 首屏信息过密

当前 Dashboard 放了：

- 主机状态。
- 资源监控。
- 活动监控。
- 容器状态。
- 已发布模型。
- 最近任务。
- 接口列表。
- LAN / API 地址。

这些信息都有价值，但首屏扫起来累。对于本地工作台，首屏应更像“下一步行动台”，而不是完整监控大屏。

### 5.3 模型发布流程不够一条路

用户当前需要理解：

1. 导入/下载模型。
2. 查看模型是否 ready。
3. 查看容器是否存在。
4. 启动或测试容器。
5. 到加载模型页选模型和容器。
6. 配参数。
7. 预览计划。
8. 开始部署。
9. 看任务日志。
10. 找 API 地址。

流程能力强，但路径偏长。

### 5.4 底层参数暴露过早

当前加载模型页直接暴露：

- OpenAI 模型名。
- 上下文长度。
- GPU 显存比例。
- 最大并发序列。
- tensor parallel。
- KV cache dtype。
- swap space。
- TensorRT-LLM batch/token/TP/PP 等参数。

这些对专家有用，但对首次部署用户不友好。

### 5.5 设计语言略混合

当前视觉上混合了：

- 品牌 hero。
- glass card。
- 仪表盘。
- 运维控制台。
- 模型库。
- 任务日志。

单个模块可用，但整体缺少一个明确的产品骨架。

## 6. 前端改造原则

### 6.1 不做 GPUStack 复刻

不追求：

- 企业平台感。
- 多集群控制台。
- 用户/组织/API Key/RBAC 主导的信息架构。
- Prometheus/Grafana 式运维大屏。

### 6.2 学习 GPUStack 的流程清晰度

要学习：

- Catalog 主入口。
- 模型卡片能力标签。
- 一键部署路径。
- 状态清晰。
- 部署后 Playground 验证。

### 6.3 坚持本地工作台定位

AMUIN 前端应该强化：

- 本机状态。
- 本地模型文件。
- 本机 Docker / NVIDIA runtime。
- 本地路径和日志。
- 一键修复。
- DGX Spark profile。
- 无需集群概念。

## 7. 目标信息架构

建议重构为以下导航：

1. `首页`
2. `模型库`
3. `发布模型`
4. `运行中`
5. `Playground`
6. `系统诊断`
7. `任务`
8. `设置`

其中：

- `模型库` 是主入口。
- `发布模型` 是向导式部署入口。
- `运行中` 展示当前服务和 API 地址。
- `Playground` 负责试用和复制调用示例。
- `系统诊断` 承接原 Dashboard 中偏底层的 CPU/GPU/Docker/端口信息。
- `任务` 保留给专家查看日志和修复。

可以隐藏或降级：

- `容器管理` 改为 `运行环境`，放到系统诊断或高级入口。
- `加载模型` 与 `部署服务` 合并为 `发布模型`。

## 8. 页面级改造方案

### 8.1 首页

目标：

让用户知道当前机器能不能用，以及下一步做什么。

保留：

- 当前主机是否就绪。
- GPU / Docker / NVIDIA runtime 状态。
- 已运行模型数量。
- 最近任务。
- 本地 API 地址。

新增：

- 主操作按钮：
  - 导入模型。
  - 发布模型。
  - 打开 Playground。
- 当前推荐动作：
  - 未下载模型：提示导入模型。
  - 有 ready 模型但未发布：提示发布模型。
  - 有运行模型：提示进入 Playground。

下沉：

- 详细 CPU/Memory/Storage/端口列表移到系统诊断。

### 8.2 模型库

目标：

成为 AMUIN 的核心入口，类似 GPUStack Catalog，但更本地化。

模型卡片显示：

- 模型名。
- 来源：HuggingFace / ModelScope / Local。
- 路径。
- 格式：HF checkpoint / GGUF / TRT engine / Audio。
- 能力：Chat / Embedding / Vision / ASR / TTS。
- 文件完整性。
- 推荐运行时。
- 兼容状态。
- 大小和文件数。

主按钮：

- `发布`
- `详情`
- `打开目录`

次按钮：

- `删除`
- `重新审计`
- `继续下载`

新增筛选：

- 能力筛选。
- 格式筛选。
- 状态筛选。
- 推荐运行时筛选。

### 8.3 模型详情抽屉

目标：

用户点模型后，不直接进入复杂部署页，而是先看到可解释审计结果。

内容：

- 文件审计。
- 兼容性结论。
- 推荐运行时。
- 推荐参数。
- 缺失文件。
- 显存/磁盘是否足够。
- 最近任务。
- 发布按钮。

状态文案：

- 推荐。
- 可尝试。
- 需要转换。
- 不支持。

### 8.4 发布模型

目标：

从专家表单改成向导式流程。

步骤：

1. 选择模型。
2. 查看兼容性和推荐运行时。
3. 选择运行时。
4. 确认 API 名称和端口。
5. 展开高级设置可调整参数。
6. 预览运行计划。
7. 发布。

默认视图只显示：

- 模型。
- 推荐运行时。
- API 名称。
- 端口/API 地址。
- 发布按钮。

高级设置折叠：

- vLLM 上下文长度。
- GPU 显存比例。
- 最大并发。
- tensor parallel。
- TensorRT-LLM 高级参数。

### 8.5 运行中

目标：

替代部分 `部署服务` 和 Dashboard 中的已发布模型区域。

展示：

- 当前运行模型。
- 运行时。
- 端口。
- API 地址。
- 健康状态。
- 启动时间。
- 占用资源。
- 停止/重启/查看日志。

突出：

- 复制 `/v1/models`。
- 复制 `/v1/chat/completions`。
- 打开 Playground。

### 8.6 Playground

目标：

补上 GPUStack 做得很好的“部署后试用闭环”。

首期支持：

- Chat 测试。
- Embedding 测试。
- Audio 测试占位或二期实现。

功能：

- 选择已发布模型。
- 输入消息。
- 流式输出。
- 显示延迟、token 数、错误。
- 一键复制 curl 示例。
- 一键复制 OpenAI SDK 示例。

### 8.7 系统诊断

目标：

承接当前 Dashboard 和容器管理中的底层信息，但不打扰普通用户。

内容：

- 主机信息。
- GPU。
- Docker。
- NVIDIA runtime。
- 端口。
- 存储。
- 模型目录。
- LAN 绑定。
- 运行环境容器。

动作：

- 拉取镜像。
- 启动测试。
- 查看日志。
- 修复端口。
- 检查 Docker socket。

### 8.8 任务

目标：

保留专家级可观测性，并提升故障修复体验。

展示：

- 任务阶段。
- 结构化事件。
- 原始日志。
- 失败原因。
- 修复动作。

优先改造：

- 列表更紧凑。
- 错误任务高亮。
- 修复动作按钮更清楚。

## 9. 视觉设计改造方向

### 9.1 降低卡片堆叠感

当前大量 `glass-card` 让页面显得所有东西都一样重要。

建议：

- 页面主区域减少卡片嵌套。
- 重复对象才用卡片：模型卡、运行实例、任务项。
- Dashboard/系统诊断用分区和表格，不每块都做重卡片。

### 9.2 建立信息层级

建议层级：

1. 页面标题和主操作。
2. 当前状态。
3. 推荐下一步。
4. 详细信息。
5. 日志和底层参数。

### 9.3 保持本地科技感但更克制

保留：

- 品牌色。
- 暗色模式。
- 本地设备感。

收敛：

- 过多 glass 效果。
- 过密卡片阴影。
- 大面积监控布局。

### 9.4 标签系统统一

模型、任务、运行时状态标签应统一颜色语义：

- green：ready/running/compatible。
- blue：recommended/info。
- gold：possible/needs review。
- red：failed/unsupported。
- purple：TensorRT-LLM/advanced。
- cyan：vLLM。

## 10. 易用性改造优先级

### P0：主流程重排

1. 模型库成为主入口。
2. `部署服务` + `加载模型` 合并为 `发布模型`。
3. 容器管理降级为高级运行环境。

### P1：一键发布向导

1. 模型选择。
2. 兼容性摘要。
3. 推荐运行时。
4. 高级参数折叠。
5. 预览计划。
6. 发布。

### P1：Playground

1. Chat 测试。
2. 复制 API 调用。
3. 展示响应错误。

### P2：Dashboard 降噪

1. 改成行动导向首页。
2. 详细诊断移到系统诊断。

### P2：模型详情抽屉

1. 审计结果可解释。
2. 发布入口。
3. 修复建议。

### P3：视觉统一

1. 卡片样式收敛。
2. 标签颜色规范。
3. 表格/列表密度优化。

## 11. 推荐实施阶段

### Phase UI-1：信息架构重排

交付：

- 导航改名和分组。
- 首页降噪。
- 模型库作为主入口。
- 容器管理入口降级。

验收：

- 新用户打开后能明确知道下一步。
- 模型下载、发布、试用路径能在 3 个主入口内完成。

### Phase UI-2：模型库与详情抽屉

交付：

- 新模型卡片。
- 模型详情抽屉。
- 兼容性摘要。
- 发布入口。

验收：

- 用户可以从一个模型卡片理解这个模型能不能跑。

### Phase UI-3：发布向导

交付：

- 合并部署/加载流程。
- 默认参数简化。
- 高级参数折叠。
- 运行计划预览保留。

验收：

- ready 模型可以从模型库一路发布，不需要先理解容器页。

### Phase UI-4：Playground

交付：

- Chat Playground。
- 已发布模型选择。
- curl / SDK 示例。

验收：

- 发布成功后能马上验证模型。

### Phase UI-5：诊断与任务体验优化

交付：

- 系统诊断页。
- 任务事件和修复动作优化。
- 日志更易读。

验收：

- 出错时用户能知道原因和下一步。

## 12. 不建议照搬 GPUStack 的地方

不建议照搬：

- 企业级多租户导航。
- Clusters / Workers / GPUs 作为主导航。
- API Keys / Usage / Billing 主导界面。
- 白标企业平台叙事。
- 多集群管理页面。

AMUIN 应保持：

- 本地桌面。
- DGX Spark。
- 单机工作站。
- 可解释运行时。
- 本机路径、日志、Docker 控制。

## 13. 近期可开工任务

建议马上开工：

1. 导航重命名与页面归并草案。
2. 模型库卡片重设计。
3. 模型详情抽屉。
4. 发布向导第一版。
5. Playground Chat 第一版。

对应本地文件：

- `apps/frontend/src/App.vue`
- `apps/frontend/src/composables/useApp.ts`
- `apps/frontend/src/styles.css`
- `apps/frontend/src/locales/zh-CN.ts`
- `apps/frontend/src/locales/en-US.ts`
- `apps/frontend/src/types.ts`

## 14. 参考资料

GPUStack：

- https://github.com/gpustack/gpustack
- https://gpustack.ai
- https://raw.githubusercontent.com/gpustack/gpustack/main/docs/quickstart.md
- https://raw.githubusercontent.com/gpustack/gpustack/main/docs/assets/quick-start/quick-start-qwen3.png
- https://raw.githubusercontent.com/gpustack/gpustack/main/docs/assets/quick-start/model-running.png
- https://raw.githubusercontent.com/gpustack/gpustack/main/docs/assets/quick-start/quick-chat.png

AMUIN：

- `apps/frontend/src/App.vue`
- `apps/frontend/src/styles.css`
- `apps/frontend/src/composables/useApp.ts`

