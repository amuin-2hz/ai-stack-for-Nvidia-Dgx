# 前后端连接激活 — 设计文档

> 日期：2026-06-26
> 方案：端点逐一验证与修复

## 目标

激活前端所有页面（Dashboard / Models / Services / Deploy / Playground / Tasks / Settings），确保后端 API 数据正确流到前端渲染。

## 当前状况

- 前端已通过 `refresh()` 每 5 秒轮询 7 个后端端点
- Vite 代理 `/api` → `http://127.0.0.1:8000`（剥离 `/api` 前缀）
- 前端 types.ts 定义了 ModelRecord、DeploymentRecord、ContainerRecord 等类型
- 后端有完整的路由处理器

## 执行步骤

### 阶段 1：启动服务

- 启动 API 后端：`bash scripts/dev-api.sh`（端口 8000）
- 启动前端 Vite：（端口 8888）
- 验证代理连通性

### 阶段 2：API 端点审计

用 curl 验证以下端点返回格式：

| 端点 | 前端类型 | 用途 |
|------|---------|------|
| GET /models | ModelRecord[] | 模型库 |
| GET /deployments | DeploymentRecord[] | 运行中部署 |
| GET /tasks | TaskRecord[] | 任务列表 |
| GET /system/check | SystemCheck | 系统状态 |
| GET /settings/network | NetworkSettings | 网络配置 |
| GET /settings/workbench | WorkbenchSettings | 管理端口 |
| GET /containers | ContainerRecord[] | 容器列表 |

对比前端 types.ts 类型定义与实际响应，修复不匹配。

### 阶段 3：前端渲染验证

逐页检查：
- Dashboard — 统计卡片、资源仪表盘、已发布模型、近期任务
- Models — 模型表格、详情面板、下载弹窗
- Services — 容器列表、启停操作、日志
- Deploy — 部署参数、运行时日志
- Playground — Chat/Vision/Audio API 调用
- Tasks — 任务列表、日志、诊断
- Settings — General/Network 子面板

### 阶段 4：修复

- 类型不匹配 → 修正 types.ts 或后端响应格式
- 字段缺失 → 添加 fallback
- 功能断连 → 补完缺失逻辑

## 成功标准

- [ ] 后端 8000 端口正常运行
- [ ] 前端 8888 端口可访问
- [ ] Dashboard 显示真实系统数据（非全 0/空）
- [ ] Models 页能列出发现的模型
- [ ] Services 页能显示容器状态
- [ ] Tasks 页能显示任务
- [ ] 无 console 报错（类型错误、404 等）
