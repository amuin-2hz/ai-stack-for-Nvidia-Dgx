# 热词更新器（GTK4 桌面工具）

用于维护 AI Stack 的 ASR 共享热词表与 TTS 读音词典。

## 文件

| 用途 | 默认路径（容器内） | 环境变量覆盖 |
| --- | --- | --- |
| ASR 热词 | `~/.local/share/ai-stack/cache/asr_hotwords.txt`（`/cache/asr_hotwords.txt`）| `AI_STACK_ASR_HOTWORDS` |
| TTS 读音 | `~/.local/share/ai-stack/cache/lexicon.json`（`/cache/lexicon.json`）| `QWEN3_TTS_LEXICON` |

两个文件都在 `~/ai-stack/cache` 或 `~/.local/share/ai-stack/cache` 下（取决于部署方式），
通过 compose 的 bind mount 进入容器，服务端按 mtime 热更新，保存后无需重启容器。
界面里的「设置」页可以修改这两个路径，配置保存在 `~/.config/hotword-updater/settings.json`。

## 运行

```bash
python3 tools/hotword-updater/hotword_gui.py
```

依赖：Python 3 + PyGObject（GTK4），Ubuntu 24.04 默认已装。

开机菜单/桌面快捷方式可复制 `hotword-manager.desktop`：

```ini
[Desktop Entry]
Type=Application
Name=热词更新器
Exec=/usr/bin/python3 /home/<user>/ai-stack/tools/hotword-updater/hotword_gui.py
Icon=accessories-text-editor
Terminal=false
Categories=Utility;
```

## xlsx 导入格式

- ASR：单列，表头「热词」
- TTS：三列，表头「词 / 读音 / 备注」

界面里有「下载样例文件」按钮可生成对应的 xlsx 模板。
