# Changelog

版本号遵循 A.B.C 机制：A 大版本架构变更、B 功能更新或严重 Bug 修复、C 小修小改。

---

## [1.0.3] — 2026-06-15

### 删除确认 + 容器清理

- **模型删除**：`window.confirm` 改为 `Modal.confirm` 二次确认，显示模型名、路径、大小、格式
- **容器删除**：新增 `DELETE /containers/:key` 端点，联动 `docker stop → rm → rmi → volume prune`
- **容器卡片**：新增「删除模板」按钮，确认对话框列出容器、镜像、数据卷清理范围
- 仅允许删除内置容器模板（vllm/trtllm/audio），保护基础设施容器

## [1.0.2] — 2026-06-15

### 修复模型删除保护

- **关键修复**：`DELETE /models` 后端增加三重保护（store 活跃部署 + 运行中服务 + 活跃任务）
- 新增 `isModelPublished()` — 查询音频服务 `/v1/models` 真实接口，模糊匹配磁盘 slug 名
- 修复：`cosyvoice-300m-sft` 匹配 `iic/CosyVoice-300M-SFT`，不会被误删

## [1.0.1] — 2026-06-15

### 修复音频服务模型误报

- **修复**：`listDeployments` 不再从磁盘扫描推测已发布模型
- 改为查询音频服务 `/v1/models` 实时接口
- whisper 模型不再被误报为"已发布"（磁盘存在但未被音频服务加载）
- 音频服务正确显示 2 个模型：FunASR + CosyVoice

## [1.0.0] — 2026-06-15

### 首个可运行开发版本

完成从 Python 后端到 Node.js 架构的迁移，前端/API/服务三层分离。

**内置 3 个标准化模板容器**
- **vLLM** — 默认 LLM/VLM/Embedding 推理运行时，端口 30000
- **TensorRT-LLM** — DGX Spark 高性能推理，端口 31000
- **Audio Service (PyTorch)** — ASR/TTS 音频服务，端口 32000

三个容器均已调试好 Docker 镜像、组件依赖和重启策略，开箱即用。

**核心工作流**
- 模型下载：支持 HuggingFace / ModelScope，后台任务跟踪进度
- 启动容器：一键拉取镜像、运行测试、查看日志
- 加载模型：将本地模型部署到目标推理容器，自动匹配兼容性

**功能**
- 仪表盘：主机状态、CPU/内存/存储监控、运行中容器、模型端点
- 模型注册：自动扫描本地模型目录，显示格式、大小、兼容性
- 容器管理：查看运行状态、拉取镜像、启停操作
- 任务系统：下载/部署/容器操作均有任务跟踪和日志
- 网络设置：局域网访问开关、端口配置
- 国际化：中文 / English 双语界面

**架构迁移**
- `apps/api/` — 新 Node.js/TypeScript 控制面，替代旧 `legacy/` Python 后端
- `apps/frontend/` — Vue 3 + Vite 管理控制台
- `services/audio/` — Python 音频微服务（FunASR + CosyVoice）
- 旧 `legacy/python-backend/` 已移除
