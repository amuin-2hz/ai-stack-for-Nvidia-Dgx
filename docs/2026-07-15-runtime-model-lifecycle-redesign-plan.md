# 运行环境、模型发布与共享服务生命周期改造计划

日期：2026-07-15  
状态：待实施  
范围：Node/TypeScript API、Vue 前端、Docker/Compose 运行时、OpenAI 兼容网关  
目标产品：面向 DGX Spark / 本地 AI 工作站的容器原生模型工作台

## 1. 决策摘要

本轮改造不继续沿用“先在运行时页面启动容器，再到模型发布页面加载模型”的双入口设计。

目标规则如下：

1. **模型发布是启动模型能力的唯一普通用户入口。**
2. **运行环境是模板，不是运行中的业务对象。** vLLM、TensorRT-LLM、PyTorch 基础环境只负责镜像、兼容性验证和默认参数。
3. **独立模型以 Deployment Instance 运行。** 每个实例有独立容器、内部端口、模型绑定和生命周期。
4. **FunASR 等多模型能力以 Shared Service 运行。** 服务可常驻，但模型通过显式槽位加载、卸载和查询。
5. **“内置/自定义”只描述来源，不描述生命周期。** 自定义方案也必须被归类为独立实例模板或共享服务模板。
6. **前端不要求用户理解容器依赖。** 用户选择主模型，系统自动解析运行环境、辅助模型和影响范围。
7. **模型就绪必须以真实服务状态为准。** 容器启动、镜像测试通过、目录已挂载均不能等同于模型已经发布。

一句话交互目标：

> 选择模型，确认“加载并发布”，系统自动准备运行环境并把模型变成可调用服务。

## 2. 当前问题与代码基线

### 2.1 运行时页面启动的是空测试容器

当前 `apps/api/src/containerTasks.ts` 的 `createRuntimeStartTestTask()` 使用固定容器名、固定公开端口和 `sleep infinity` 启动系统运行时。

它验证镜像可以运行，但不加载模型，也不提供真实推理服务。该容器仍可能占用：

- `vllm-service` / `trtllm-service` / `pytorch-service` 固定名称；
- 系统运行时配置的默认公开端口；
- GPU runtime、IPC 和 Docker 生命周期资源。

### 2.2 模型发布已经存在另一套容器生命周期

当前 `apps/api/src/runtimePlan.ts` 对 vLLM 直接执行 `docker run`：

- 容器名为 `vllm_<model>`；
- 只挂载目标模型目录；
- 使用 deployment port；
- 通过 `/health` 和 `/v1/models` 判断是否加载成功。

这条路径与运行时页面的空容器没有父子关系，也没有可靠优先级。

### 2.3 PyTorch 基础环境被错误地放进模型发布候选

`deploy/templates/pytorch_env.py` 只提供：

- `/healthz`；
- `/runtime`；
- `/models` 目录列表。

它没有具体模型 adapter，也没有 OpenAI 推理端点，因此不能把“启动 PyTorch 环境”视为“发布某个模型”。

### 2.4 共享服务没有显式模型控制协议

当前 FunASR Gateway：

- 容器启动时不立即加载全部模型；
- 第一次转写请求调用 `_load_asr_model()`；
- 同一请求继续尝试 `_load_diarization_model()`；
- 前端选择现有容器时只会启动容器，不会显式加载模型或登记模型绑定。

因此界面无法准确回答：

- 服务是否运行；
- 哪个主模型已经加载；
- 哪些辅助模型已经加载；
- 卸载模型是否会影响其他功能；
- 当前模型能否被统一 `/v1` 网关发现。

### 2.5 当前状态名称混合了不同事实

目前界面可能同时出现：

- 镜像已拉取；
- 测试通过；
- 容器 missing；
- runtime 未使用；
- deployment not_started；
- 历史模型容器 stopped。

这些状态属于不同对象，不能继续压缩成一个“运行时是否就绪”标签。

## 3. 目标领域模型

### 3.1 Profile：运行模板

Profile 是不可运行的配置对象，用来描述系统如何创建真实服务。

建议字段：

```ts
type ProfileOrigin = "builtin" | "custom";
type ProfileKind = "dedicated-runtime" | "shared-service";
type ProfileReadiness = "not_installed" | "ready" | "validation_failed";

interface RuntimeProfile {
  id: string;
  title: string;
  origin: ProfileOrigin;
  kind: ProfileKind;
  image: string;
  capabilities: string[];
  compatible_formats: string[];
  readiness: ProfileReadiness;
  default_args: Record<string, unknown>;
  adapter: string;
}
```

Profile 不拥有 `running/stopped` 状态，也不拥有公开推理端口。

### 3.2 Deployment Instance：独立模型实例

Deployment Instance 表示一个真实运行的模型服务。

```ts
type DeploymentState =
  | "planned"
  | "preparing"
  | "starting"
  | "loading"
  | "ready"
  | "stopping"
  | "stopped"
  | "failed";

interface DeploymentInstance {
  id: string;
  profile_id: string;
  model_id: string;
  api_model: string;
  container_name: string;
  worker_port: number;
  worker_endpoint: string;
  state: DeploymentState;
  args: Record<string, unknown>;
  task_id?: string;
}
```

适用对象：

- vLLM 文本、视觉、embedding、reranker 模型；
- TensorRT-LLM 模型；
- Unlimited OCR、MinerU、LocateAnything 等一实例一工作负载的专用 Profile；
- 后续具备真实 adapter 的 PyTorch 模型服务。

### 3.3 Shared Service Instance：共享应用服务

Shared Service Instance 表示可以同时承载多个能力或模型角色的长期服务。

```ts
type SharedServiceState =
  | "starting"
  | "running"
  | "degraded"
  | "stopping"
  | "stopped"
  | "failed";

interface SharedServiceInstance {
  id: string;
  profile_id: string;
  container_name: string;
  endpoint: string;
  state: SharedServiceState;
  slots: ModelSlotBinding[];
}

interface ModelSlotBinding {
  slot: string;
  model_id: string | null;
  role: "primary" | "dependency";
  state: "unloaded" | "loading" | "ready" | "unloading" | "failed";
  required_by: string[];
}
```

第一批共享服务：

- FunASR Gateway；
- VibeVoice Gateway（完成 adapter 审计后决定是否进入第一批）；
- 后续确实需要复用同一进程和 GPU 上下文的业务流水线。

### 3.4 来源与运行方式分离

分类采用两个独立维度：

| 对象 | 来源 | 运行方式 | 目标归类 |
|---|---|---|---|
| vLLM | 内置 | 独立实例 | Dedicated Runtime Profile |
| TensorRT-LLM | 内置 | 独立实例 | Dedicated Runtime Profile |
| PyTorch Base | 内置 | 不直接发布 | Environment-only Profile |
| vLLM Embedding/Reranker | 自定义 | 独立实例 | Custom Dedicated Profile |
| OCR/MinerU/Locate | 自定义 | 独立实例 | Custom Dedicated Profile |
| FunASR Gateway | 自定义 | 共享服务 | Custom Shared Service Profile |
| `vllm_<model>` | 运行实例 | 独立实例 | Deployment Instance，不是 Profile |

“自定义”只作为卡片角标和筛选条件，不再成为运行时页面的一级分类。

## 4. 目标生命周期

### 4.1 普通模型发布

```text
选择模型
  -> 解析兼容 Profile
  -> 选择推荐 Profile
  -> 预检模型完整性、显存、镜像和端口
  -> 创建 Deployment Plan
  -> 创建独立容器
  -> 等待健康检查
  -> 验证 /v1/models 包含 api_model
  -> 登记 ready deployment
  -> 通过统一网关调用
```

### 4.2 共享模型加载

```text
选择主模型
  -> 解析共享服务 Profile
  -> 解析能力和依赖模型
  -> 展示本次加载清单与影响范围
  -> 确保 Shared Service Instance 运行
  -> 调用 adapter.load(slot, model)
  -> 等待 slot ready
  -> 登记 Model Slot Binding
  -> 注册统一模型路由
```

### 4.3 模型卸载

独立实例：停止并删除目标 deployment 容器，不影响其他实例。

共享服务：只卸载目标模型槽位；若有其他模型依赖该槽位，必须阻止卸载并返回依赖列表。停止整个共享服务必须使用单独的“停止服务”动作，并明确显示受影响模型。

### 4.4 用户动作约束

列表中的高亮、键盘导航或详情选择不得直接触发 GPU 重任务。

真正执行动作统一使用明确动词：

- `加载并发布`：创建或加载模型；
- `卸载模型`：释放模型权重或删除独立实例；
- `停止服务`：停止整个共享服务；
- `验证环境`：运行一次性环境检查；
- `保存默认参数`：只保存模板配置。

可在设置中增加“测试请求时自动加载模型”，默认关闭。

## 5. 路由与优先级规则

不允许继续依赖数据库排序和数组 `.find()` 形成隐式优先级。

目标规则：

1. 请求中的 `model` 必须解析为唯一 API Model Binding。
2. 用户显式选定的 deployment binding 优先。
3. 已经 `ready` 且 API 模型名完全匹配的实例可直接复用。
4. 同一 API 模型名绑定多个实例时返回 `409 ambiguous_model_binding`，由用户选择默认实例。
5. 没有运行实例时，只有开启自动加载策略才允许创建 deployment。
6. 自动加载必须复用与手动发布相同的 planner、锁、端口分配器和健康检查。
7. 自动选择运行环境时，优先使用模型 Registry 的推荐 Profile，不再在代理层硬编码 vLLM/TRT 顺序。
8. PyTorch Base 在没有具体 adapter 时不得成为可发布 Profile。

公开调用继续使用统一工作台网关。独立 worker port 作为内部实现细节，默认不要求普通用户配置。

## 6. 端口、容器名与并发控制

### 6.1 端口分配

新增统一 `PortAllocator`：

- 检查 Docker 所有容器的端口映射，包括 stopped 和非 deployment 容器；
- 检查系统监听端口；
- 检查数据库中的 ready/starting deployment；
- 检查 queued/running deployment task；
- 在创建任务前写入短期 reservation；
- deployment 完成或失败后释放 reservation；
- 同一进程内使用互斥锁，避免两个任务选择同一端口。

### 6.2 容器名

建议命名：

```text
amuin-deploy-<profile>-<model>-<short-id>
amuin-shared-<profile>
amuin-validate-<profile>-<task-id>
```

兼容期继续发现已有：

- `vllm_*`；
- `trtllm-service`；
- `pytorch-service`；
- `custom_*`。

新容器必须增加标签：

```text
amuin.object=deployment|shared-service|validation
amuin.profile=<profile-id>
amuin.deployment=<deployment-id>
amuin.model=<model-id>
amuin.api-model=<api-model>
```

### 6.3 冲突策略

- 不自动删除名称相似但没有 AMUIN 标签的用户容器；
- 不通过 `docker rm -f` 清理不属于目标 deployment ID 的容器；
- 端口冲突时先重新分配，无法分配再返回清晰错误；
- 显存不足时返回当前占用实例和可执行的卸载建议；
- 同一模型同一 Profile 的并发发布请求复用已有任务或返回 `409 deployment_in_progress`。

## 7. 共享服务 Adapter 协议

共享服务不能依赖控制面猜测其进程内状态。定义控制协议：

```text
GET    /runtime/capabilities
GET    /runtime/models
POST   /runtime/models/load
DELETE /runtime/models/:slot
GET    /runtime/health
```

建议响应：

```json
{
  "service": "funasr-gateway",
  "state": "running",
  "slots": [
    { "slot": "asr", "model": "sensevoicesmall", "state": "ready" },
    { "slot": "vad", "model": "fsmn-vad", "state": "ready" },
    { "slot": "diarization", "model": null, "state": "unloaded" }
  ]
}
```

### 7.1 FunASR 第一版槽位

| 槽位 | 角色 | 默认策略 |
|---|---|---|
| `asr` | 主模型 | 用户选择 ASR 模型后加载 |
| `vad` | 可选依赖 | 开启分段或模型要求时加载 |
| `punctuation` | 可选依赖 | 开启标点恢复时加载 |
| `diarization` | 可选能力 | 默认关闭，开启说话人分离时加载 |

第一版不要求支持任意模型热切换。可先支持：

- 同一槽位一次只绑定一个模型；
- 切换时先卸载旧模型，再加载新模型；
- 共享依赖使用引用计数；
- 进程不支持安全卸载时，adapter 返回 `restart_required`，由控制面展示影响并重启服务。

## 8. API 改造计划

### 8.1 新端点

```text
GET  /runtime-profiles
GET  /runtime-profiles/:id
POST /runtime-profiles/:id/pull
POST /runtime-profiles/:id/validate
PUT  /runtime-profiles/:id/defaults

GET  /shared-services
GET  /shared-services/:id
POST /shared-services/:id/start
POST /shared-services/:id/stop
GET  /shared-services/:id/models
POST /shared-services/:id/models/load
POST /shared-services/:id/models/unload

GET  /deployments
POST /deployments/plan
POST /deployments/start
POST /deployments/:id/stop
POST /deployments/:id/restart

GET  /model-bindings
PUT  /model-bindings/:api_model/default
```

### 8.2 兼容端点

迁移期间保留：

- `GET /containers`；
- `POST /containers/:key/start-test`；
- 当前 `/deployments` 响应。

兼容行为：

- `start-test` 内部改成调用 Profile validation，不再留下常驻空容器；
- `GET /containers` 增加 `object_kind`，前端逐步停止依赖 `runtime === custom` 推断类型；
- 旧 deployment 记录双读，新写入只使用 V2 对象模型；
- 完成前端迁移后再删除旧入口。

### 8.3 主要后端文件

优先改造：

- `apps/api/src/runtimePlan.ts`：从 service type 计划升级为 Profile/Instance 计划；
- `apps/api/src/deploymentManager.ts`：统一独立实例生命周期；
- `apps/api/src/deploymentHelpers.ts`：按标签发现真实实例；
- `apps/api/src/containerTasks.ts`：空容器启动改成一次性验证；
- `apps/api/src/containerPresets.ts`：演进为 Profile Registry；
- `apps/api/src/openaiProxy.ts`：使用唯一 Model Binding 路由；
- `apps/api/src/store.ts`、`db.ts`、`types.ts`：新增 Profile、Shared Service、Slot Binding 和 Port Reservation 数据；
- `apps/api/src/routes/deployments.ts`、`routes/containers.ts`：拆分职责并保留兼容层。

建议新增：

```text
apps/api/src/runtimeProfiles.ts
apps/api/src/portAllocator.ts
apps/api/src/modelBindings.ts
apps/api/src/sharedServiceManager.ts
apps/api/src/sharedServiceAdapters/
  types.ts
  funasr.ts
```

## 9. 前端信息架构

### 9.1 页面职责

| 页面 | 保留职责 | 移出职责 |
|---|---|---|
| 模型库 | 下载、审计、兼容性、进入发布 | 不直接管理容器 |
| 模型发布 | 选择模型、预检、加载并发布、管理已加载模型 | 不维护运行环境镜像 |
| 模型测试 | 调用 ready 模型，可选触发按需加载 | 不手动选择容器 |
| 运行时 | 管理 Profile 和 Shared Service | 不展示独立模型容器 |
| 任务 | 展示拉取、验证、启动、加载、卸载过程 | 不推断业务状态 |

### 9.2 运行时页面

当前“自定义运行时 / 系统默认容器”改为：

```text
运行时
├─ 推理引擎
│  ├─ vLLM                  内置 · 已验证
│  ├─ TensorRT-LLM          内置 · 已验证
│  ├─ PyTorch Base          内置 · 仅环境
│  └─ Custom Embedding      自定义 · 已验证
└─ 共享服务
   ├─ FunASR Gateway        自定义 · 运行中 · 2 个模型已加载
   └─ VibeVoice Gateway     自定义 · 已停止
```

推理引擎卡片操作：

- 拉取镜像；
- 验证环境；
- 默认参数；
- 查看版本；
- 编辑自定义 Profile。

共享服务卡片操作：

- 启动/停止服务；
- 查看已加载模型；
- 配置能力；
- 日志；
- 编辑服务 Profile。

独立 `vllm_<model>` 容器不再出现在运行时页面。

### 9.3 模型发布页面

主流程：

```text
┌ 已加载模型 ──────────────────────────────────────┐
│ OmniCoder 9B   独立实例 · vLLM       READY       │
│ SenseVoice     共享服务 · ASR 槽位    READY       │
└──────────────────────────────────────────────────┘

┌ 选择模型 ─────────────┐  ┌ 发布摘要 ─────────────┐
│ 模型信息               │  │ 模式：独立实例         │
│ 推荐 Profile           │  │ 容器、显存、依赖、影响 │
│ 能力选择               │  │ [加载并发布]           │
└───────────────────────┘  └───────────────────────┘
```

共享服务发布摘要必须列出：

- 目标服务；
- 主模型槽位；
- 自动加载的辅助模型；
- 是否需要重启共享服务；
- 将受影响的现有模型。

### 9.4 视觉设计边界

本轮不重新设计品牌视觉，继续使用当前蓝青色工作站控制台语言：

- 主操作蓝：`#3558E6`；
- 推理强调青：`#0AA7D8`；
- 浅色工作区：`#F5F9FC`；
- 深色工作区：`#091018`；
- 正常状态绿、警告金、失败红沿用 Ant Design 语义色。

字体继续使用 Inter/系统无衬线，容器名、端口、API 地址继续使用 JetBrains Mono/系统等宽字体。

本轮唯一强化的视觉签名是“模型绑定轨道”：在发布摘要和已加载模型卡片中，用一条短连接轨道表达：

```text
模型 -> Profile -> 独立实例
模型 -> Shared Service -> 模型槽位
```

轨道承担真实关系表达，不作为装饰；其余页面保持紧凑、克制，不新增无意义大卡片和动画。

### 9.5 前端主要文件

- `apps/frontend/src/pages/ServicesPage.vue`：改为推理引擎与共享服务；
- `apps/frontend/src/pages/LoadPage.vue`：统一“加载并发布”流程与影响摘要；
- `apps/frontend/src/composables/useServices.ts`：拆分 Profile 和 Shared Service 操作；
- `apps/frontend/src/composables/useLoad.ts`：统一 dedicated/shared planner；
- `apps/frontend/src/composables/useApp.ts`：删除通过名称和 `runtime === custom` 推断对象类型；
- `apps/frontend/src/types.ts`：增加 Profile、Shared Service、Slot Binding；
- `apps/frontend/src/locales/zh-CN.ts`、`en-US.ts`：统一术语；
- `apps/frontend/src/styles.css`：只增加对象关系和两类卡片布局所需样式。

## 10. 分阶段实施

### Phase 0：风险止血与术语修正

目标：在新模型完成前先消除误操作和资源冲突。

- [ ] vLLM/TRT/PyTorch 系统卡片的“启动”改成“验证环境”；
- [ ] validation 使用一次性容器，不占用长期端口，不留下固定容器；
- [ ] 暂停 PyTorch Base 的模型发布入口；
- [ ] 模型发布按钮统一为“加载并发布”；
- [ ] 自定义共享容器按钮改成“使用共享服务”；
- [ ] 发布预览显示会创建新实例还是复用共享服务；
- [ ] 端口分配至少纳入所有 Docker 容器映射检查；
- [ ] API Model 名重复时禁止继续发布。

验收：运行时页面验证 vLLM 后，不存在常驻 `vllm-service`，也不占用发布端口；随后发布单模型成功。

### Phase 1：Profile 与实例数据模型

目标：消除通过容器名和 `custom_` 前缀推断业务类型。

- [ ] 增加 Runtime Profile 数据结构；
- [ ] 增加 Profile origin/kind/readiness；
- [ ] 增加 Deployment Instance V2 字段；
- [ ] 增加 Shared Service 与 Slot Binding 表；
- [ ] 为新容器写入标准 AMUIN 标签；
- [ ] 实现 Docker 标签发现与旧容器兼容映射；
- [ ] 增加 Port Reservation；
- [ ] 增加数据库迁移与回滚脚本。

验收：API 能分别返回 Profile、独立实例、共享服务，且同一个容器不会同时出现在多个业务列表。

### Phase 2：独立实例生命周期统一

目标：vLLM 和 TRT 统一成一模型一实例。

- [ ] 重构 RuntimePlan 以 Profile 为输入；
- [ ] vLLM 使用新命名、标签和端口分配；
- [ ] TRT 移除固定 `svc_trtllm`/`trtllm-service` 单例语义；
- [ ] 统一 prepare/pull/start/load/health 阶段；
- [ ] ready 前必须验证 health 和模型列表；
- [ ] stop/restart/logs 只作用于指定 deployment ID；
- [ ] 并发发布同一模型时复用任务或返回冲突；
- [ ] OpenAI proxy 使用 Model Binding，不直接搜索第一个 deployment。

验收：可同时运行两个不同 vLLM 模型；停止其中一个不影响另一个；同名 API Model 不会产生不确定路由。

### Phase 3：FunASR 共享服务 Adapter

目标：实现“选择模型后加载进共享服务”。

- [ ] 在 FunASR Gateway 增加 capabilities/models/load/unload/health 控制接口；
- [ ] 把 ASR、VAD、标点、说话人分离拆成明确槽位；
- [ ] 默认只加载用户选择的主能力和必要依赖；
- [ ] 说话人分离默认关闭；
- [ ] 控制面增加 FunASR Adapter；
- [ ] Slot Binding 持久化并在服务重启后重新发现；
- [ ] 模型加载/卸载通过 Task 展示进度和日志；
- [ ] 共享依赖卸载前检查引用；
- [ ] 不支持热卸载时返回 restart_required 和影响清单。

验收：选择 SenseVoice 并点击“加载并发布”后，Gateway 自动启动、ASR 槽位显示 ready；未开启说话人分离时不加载 diarization 权重。

### Phase 4：前端信息架构切换

目标：页面结构准确表达对象模型。

- [ ] 运行时页改为“推理引擎 / 共享服务”；
- [ ] “自定义”改为来源角标和筛选条件；
- [ ] 独立模型容器从运行时页移除；
- [ ] 模型发布页展示 dedicated/shared 模式；
- [ ] 发布摘要展示资源、依赖和影响范围；
- [ ] 已加载模型卡片支持独立卸载和共享槽位卸载；
- [ ] 共享服务停止操作显示受影响模型；
- [ ] 模型测试页只显示 ready Model Binding；
- [ ] 空状态和错误状态提供下一步动作；
- [ ] 完成中英文术语一致性检查。

验收：新用户无需进入运行时页即可发布并测试模型；用户能从卡片明确判断卸载操作影响单模型还是整个共享服务。

### Phase 5：按需加载与兼容清理

目标：在手动发布稳定后恢复可控的自动加载。

- [ ] 增加全局“允许按需加载”设置，默认关闭；
- [ ] 自动加载复用统一 planner；
- [ ] 增加空闲卸载策略，默认关闭；
- [ ] 记录自动加载原因、调用来源和资源决策；
- [ ] 删除旧 `.find()` 路由优先级；
- [ ] 删除旧空容器 start-test 行为；
- [ ] 停止前端消费兼容 Container 推断字段；
- [ ] 更新 README、项目结构与部署测试报告。

验收：关闭按需加载时，调用未发布模型返回明确 404；开启后能创建唯一实例，并在同一任务/健康检查体系中完成加载。

## 11. 测试计划

### 11.1 单元测试

- Profile 分类：内置/自定义与 dedicated/shared 正交；
- RuntimePlan：容器名、标签、挂载、模型参数正确；
- PortAllocator：Docker、系统端口、task、reservation 冲突；
- Model Binding：唯一解析、重复冲突、默认实例；
- Slot dependency：必要依赖、可选依赖、引用计数；
- 状态机：非法状态跳转被拒绝；
- PyTorch Base：没有 adapter 时不可发布。

### 11.2 API 集成测试

- Profile validate 不留下容器和端口；
- vLLM 发布后 `/health` 与 `/v1/models` 通过才 ready；
- 两个 vLLM deployment 分配不同 worker port；
- 停止一个 deployment 不影响另一个；
- 同一 API Model 重复发布返回 409；
- FunASR load/unload 更新槽位状态；
- 停止共享服务返回受影响模型；
- 服务重启后能从 Docker 和 adapter 恢复真实状态。

### 11.3 前端验收

默认使用已经运行的 `http://127.0.0.1:8888`：

- 运行时页不出现空运行环境的“运行中”；
- Profile 显示已安装/已验证，而不是 running；
- Shared Service 显示服务状态和模型槽位；
- 模型发布预览准确显示 dedicated/shared；
- 发布过程显示 prepare/pull/start/load/health；
- 已加载模型显示真实 endpoint 和 API Model；
- 卸载独立实例后其他模型仍可调用；
- 共享服务影响确认内容准确；
- 中英文没有 Runtime/Container/Service 语义错位；
- 1214×768 和 1351×750 下无主要操作溢出。

### 11.4 真实模型验收矩阵

| 场景 | 模型 | 预期模式 | 关键验证 |
|---|---|---|---|
| 文本生成 | omnicoder-9b 或兼容小模型 | 独立 vLLM | `/v1/models`、chat、独立停止 |
| Embedding | qwen3-embedding-8b | 独立专用 Profile | `/v1/embeddings` |
| ASR | SenseVoice | FunASR 共享槽位 | ASR ready、diarization 默认未加载 |
| 说话人分离 | 本地 diarization 模型 | FunASR 共享槽位 | 显式启用后加载依赖 |
| PyTorch Base | 任意模型 | 不可直接发布 | UI/API 均明确阻止 |

## 12. 数据迁移与回滚

### 12.1 迁移原则

- 不删除现有模型目录；
- 不自动删除 stopped 历史容器；
- 不覆盖用户自定义 Compose/Dockerfile；
- 先读旧 deployment，再写 V2；
- 旧容器通过名称和标签映射为 legacy record；
- 用户确认后才清理遗留空运行时容器。

### 12.2 特性开关

建议增加：

```text
AI_STACK_LIFECYCLE_V2=true|false
AI_STACK_SHARED_MODEL_CONTROL=true|false
AI_STACK_AUTO_LOAD_MODELS=true|false
```

默认策略：

- 开发构建启用 Lifecycle V2；
- Shared Model Control 在 FunASR adapter 测试通过后启用；
- Auto Load 默认关闭。

### 12.3 回滚

- 数据库迁移只新增表/字段，不在第一版删除旧字段；
- V2 失败时可切回旧 deployment read path；
- 新容器使用独立名称和标签，不覆盖旧固定容器；
- 前端保留一次版本周期的兼容响应解析。

## 13. 不在本轮建设的内容

- 不建设多机调度、Kubernetes、worker agent；
- 不建设多租户、RBAC、计费和副本调度；
- 不建设 llama.cpp/GGUF 发布路线；
- 不让 PyTorch Base 自动猜测任意模型启动脚本；
- 不要求所有自定义服务第一版都支持热切换；
- 不为每个底层 worker 暴露必须由用户记忆的公开端口；
- 不重新设计整套品牌、导航和主题；
- 不用更多状态标签掩盖对象分类问题。

## 14. 完成定义

本计划完成需要同时满足：

- [ ] 普通用户只从模型发布或模型测试入口加载模型；
- [ ] 运行时页不再启动常驻空 vLLM/TRT/PyTorch 容器；
- [ ] 独立模型实例拥有可验证、可隔离的生命周期；
- [ ] FunASR 支持显式模型槽位加载与卸载；
- [ ] API Model 路由唯一、可解释、无偶然优先级；
- [ ] Profile、Deployment、Shared Service 状态来自真实系统；
- [ ] PyTorch Base 不再产生虚假“已发布”模型；
- [ ] 所有发布任务可在任务页看到阶段、日志和修复动作；
- [ ] 真实模型端到端验收通过；
- [ ] README 和相关设计文档与新语义一致。

## 15. 推荐实施顺序

严格按以下顺序推进：

1. Phase 0 风险止血；
2. Profile、实例、端口与标签基础模型；
3. vLLM 独立实例端到端；
4. TRT 独立实例；
5. FunASR Shared Service Adapter；
6. 前端运行时与模型发布切换；
7. 统一 Model Binding 路由；
8. 按需加载；
9. 兼容层清理和文档更新。

不应先重做整页视觉，再补后端对象模型；也不应在共享服务协议完成前，把“选择现有容器”包装成已经加载模型。
