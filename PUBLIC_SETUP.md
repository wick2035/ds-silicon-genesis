# 公开源码准备与本地部署

源码仓库不包含用户数据库、原聊天、QQ 账号、密钥、运行时或安装后的依赖。示例均为占位内容；不要将填入凭据的文件提交到 Git。当前独立宿主主要面向 Windows，数据库、模型服务和可合法使用的原始角色数据需要用户自行准备。全新空环境没有可直接启动的生命档案；需要从自己有权使用的旧档迁移，或恢复本项目格式的备份。

## 构建

安装 Node.js 24、npm 和 PostgreSQL，克隆后在项目根目录执行：

```powershell
npm ci
npm run build
```

`npm ci` 使用仓库锁文件。生产运行入口使用目录内运行时，需要另行准备 `runtime/node/node.exe`、`runtime/electron/electron.exe`（同目录包含完整 Electron 发行文件）、`runtime/python311/python.exe` 与 Python 3.11 标准库。不得把运行时或 `node_modules` 提交进仓库。桌宠图像和宿主源码位于 `vendor/dsh-pet`；各第三方组件使用其随附许可证。

## 本地数据和 B 站服务

在 `data/dsh/dsh-pet/companion/` 建立 `postgres.json`，以 `examples/postgres.example.json` 为格式填入自己的数据库连接；在 `data/model-config.json` 以 `examples/model-config.example.json` 为格式填入自己的服务商、模型和密钥。将自己的完整角色配置放到 `data/dsh/dsh-pet/main-config.jsonc`；示例仅说明 `pets` 数组和 `main` 的角色描述位置，并非完整的旧角色档案。为整个 `data` 目录设置只允许当前用户和系统访问的权限。

需要 B 站资料读取时，将 `public/bili/mcp_server.py` 复制到 `data/bili/mcp_server.py`，并使用该发行版 Python 3.11 安装 `public/bili/requirements.txt` 的依赖到 `runtime/python311/Lib/site-packages`。例如，有 pip 的 Python 发行版可执行：

```powershell
.\runtime\python311\python.exe -m pip install --target .\runtime\python311\Lib\site-packages -r .\public\bili\requirements.txt
```

用户可自行运行 `B站登录.cmd` 扫码，凭据保存在 `data/bili`；不要提交凭据。具体模型是否支持图片需要自行确认。语音合成依赖 `@andresaya/edge-tts`；识别器默认未配置。

## 迁移与恢复

迁移前自行备份旧数据库和文件。`tools/migrate.mjs` 需要原数据库中的 `pet_companion.snapshots` 与 `records`、原 `humanity.json` 和自己的身份信息；它先创建独立原档备份，再写入新 schema，保留原 schema。使用真实绝对路径运行，下面仅示意参数：

```powershell
node .\tools\migrate.mjs --config 'C:\local\postgres.json' --humanity 'C:\local\humanity.json' --pet main --name '伙伴' --role '桌面伙伴' --backup 'C:\local\legacy-backup.json' --document 'memory.json=C:\local\memory.json'
```

命令需要先构建；可按需追加原配置等 `--document 名称=绝对路径`，旧图片仅能通过明确的 `--attachment-root` 导入。迁移完成后将对应配置放入本目录 `data`。已有本项目导出时可用 `tools/database.mjs schema` 创建目标 schema，并用 `restore` 向空目标恢复；详细参数见 README。QQ 接管需单独授权并执行 `tools/cutover-qq.mjs`，没有可信切换证明时新版保持 QQ 离线。

最后可运行 `启动大肥鱼.cmd`。本说明未替代对依赖许可、数据库权限、可用模型、系统权限和本地安全配置的检查，也不保证没有原始数据的全新克隆可直接运行。
