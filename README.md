# 大肥鱼：生命空间

公开源码的全新克隆、运行依赖、配置示例与数据迁移说明见 [PUBLIC_SETUP.md](PUBLIC_SETUP.md)。仓库不包含个人数据、凭据或完整运行时。

这是独立目录版。角色描述来自本目录 `data/dsh/dsh-pet/main-config.jsonc` 中 main 的原文；桌面角色素材和动画沿用复制的原素材。运行需要已有 PostgreSQL 服务，并使用本目录私密配置中的连接信息。请保护整个 `data` 目录及备份文件，其中可能包含凭据和聊天记录。

迁移完成后运行 `启动大肥鱼.cmd`。它使用本目录内的 Node、Electron、Python 和依赖；关闭生命空间会结束本次启动的组件，不关闭旧桌宠。界面可以暂停或恢复自主活动，照料和聊天仍可由人发起。动作状态以真实回执为准；无法确认是否完成的外部动作会显示为未知，不自动重放。

桌面角色决定搬砖时会自己进入网页工地；也可以从角色菜单打开「搬砖工地」，将她拖进窗口。进入后桌面角色会隐藏，工地里可点击或拖动她，她会记住这些操作。被拖进去时，她会留在工地，直到点击「接她出去」；自己进去时，她可以在工作结束后自行离开。退出程序不会清除她在工地的位置，重新启动后会恢复。

## 桌面闲逛与互动

鼠标和键盘连续两分钟无输入时，她可以参考自己的身体、情绪、记忆和当前事务，选择在可用桌面空间里散步、小跑、玩玩具车或魔方、抛球、摇摆、哼歌、伸懒腰、吹泡泡、观察，也可以选择不动。系统只读取无输入的时长，不记录按键或鼠标位置；恢复操作后过期的决定不会开始执行。自主活动暂停、身体不适、睡眠、工作、桌面不可用或自主模型额度不足时不会发起走动。点击或抓起她会立即中断走动，拖拽与抛掷仍使用现有身体、碰撞和情绪机制；行动只有在动画和实际移动均完成后才记录为完成。

这是模型自主选择，不保证每次空闲都移动或每次互动都有固定反应。新能力会在新版应用启动时登记到已有档案，不改变数据库表结构。

## 数据和切换

首次迁移须由用户授权后执行 `tools/migrate.mjs`：它读取原数据库和身心档案，先写独立原档备份，再将数据导入 `silicon_genesis` schema，不改写旧 schema。原档相同的再次导入不会覆盖已运行的新状态；原档变化时拒绝覆盖。运行参数应使用绝对路径，必要的角色文档通过重复的 `--document 名称=绝对路径` 提供。迁移工具需要 `--config`、`--humanity`、`--pet`、`--name`、`--role` 和 `--backup`。

`tools/database.mjs` 提供新 schema 的导出与恢复；恢复只允许写入空目标。原始备份和新版本导出都是敏感文件，请与程序目录一样保护。数据库本身不包含在此目录，搬迁还需要迁移数据库并更新本地连接配置。

已保存的 `data/backups/legacy-source-2026-11-14.json` 是迁移前原档备份；`data/backups/lifeos-initial-2026-11-14.json` 是新版独立 schema 的初始导出，供下方 restore 命令恢复到空目标。旧 QQ 配置曾完成切换；新建机器人时使用下方的独立配对流程。

QQ 切换是单独的一次操作。`tools/cutover-qq.mjs <旧 DSH_HOME> <目标 DSH_HOME>` 会检查旧实例和数据库锁、备份旧配置并停用旧配置中的连接；不结束旧桌宠。新版只在目标目录证明通过且启动时再次确认旧桥不存在时接管。不能确认时 QQ 保持离线。

也可以使用独立创建的 QQ 机器人。先在 QQ 开放平台创建机器人并设置 WebSocket 回调，再将其 AppID 和 AppSecret 放入本机私有目录 `data/dsh/dsh-pet/.qq-new-pending.json`，格式为 `{"appId":"你的 AppID","appSecret":"你的 AppSecret"}`；不要提交或分享该文件。停止新版后运行 `runtime\node\node.exe tools/setup-new-qq.mjs`。工具持有写入租约、备份生命状态并初始化全新的 QQ 身份和 24 小时配对码；如果已有其他机器人身份或未完成的 QQ 发送，它会拒绝切换。配对步骤保存在同目录 `qq-fresh-pairing.txt`：启动新版后先完成私聊绑定，再完成群绑定。新机器人不继承旧机器人的 OpenID 和回执，旧配置及备份保留；新机器人配置存在时优先使用新机器人。配对码过期后需要重新设置，不能继续使用旧码。

生产构建命令：`runtime\node\node.exe runtime\node\node_modules\npm\bin\npm-cli.js run build`。请参阅 `实现状态.md` 了解状态归属与尚未完成的功能。

2026-11-14 最终生产构建已通过。按要求未运行测试、启动应用或连接模型和 QQ；详细功能清单及对应源码入口见 `实现状态.md`。

B 站资料读取可能需要登录。用户可单独运行 `B站登录.cmd`，用手机扫描显示的二维码并确认；凭据保存在本目录 `data/bili`，模型无法调用登录。更换已有凭据需要在登录窗口明确输入 YES。首次导入的目录尚无 B 站登录凭据。图片观察需要所选模型支持视觉输入；本次未进行模型能力验证。

## 导出与恢复命令

在项目根目录的 PowerShell 中执行。路径示例请替换为自己的绝对路径；导出文件必须尚不存在。数据库连接配置的 `namespace` 必须为 `desktop-pet`。

```powershell
.\runtime\node\node.exe .\tools\database.mjs export --config 'D:\DeepSeek\silicon-genesis\data\dsh\dsh-pet\companion\postgres.json' --output 'D:\Backups\silicon-genesis-export.json'
```

恢复前停止使用目标数据库的新实例，准备目标数据库连接配置。目标的 `silicon_genesis` 数据表必须全部为空；恢复不会覆盖现有数据。首次使用目标数据库先创建独立 schema，然后恢复：

```powershell
.\runtime\node\node.exe .\tools\database.mjs schema --config 'D:\Backups\target-postgres.json'
.\runtime\node\node.exe .\tools\database.mjs restore --config 'D:\Backups\target-postgres.json' --input 'D:\Backups\silicon-genesis-export.json'
```

首次原档迁移的 `--document memory.json=<绝对路径>` 会保留原聊天文档并映射有效聊天记录；若文档中有本地图片定位信息，可额外传 `--attachment-root <绝对目录>`，仅导入该目录内可读取、格式受支持的图片，缺失文件会提示。迁移备份和新 schema 导出是两种不同格式；上面的 restore 只接受 `database.mjs export` 产生的文件。

## 模型设置与互动

独立设置页面由宿主的 `/standalone-ai/` 提供，模型设置、列表、测试连接和余额端点走独立宿主及本目录模型配置。设置可保存当前服务商的协议、地址、密钥和模型；手动碎碎念走统一模型预算和已提交来源事件，再显示在桌宠气泡；指定表情只接受该宠物已配置、实际存在于素材目录的名称。自动碎碎念由新版调度器负责，旧自治循环不会启动。

## 补导旧待办

未发现旧待办正式文件，目前无需补导，也不应生成空旧档。将来若找到旧待办 JSON，可在停止新版实例后使用以下命令增量导入；`--source` 和 `--backup` 替换为实际文件路径，备份必须是新文件或内容相同的已有文件。导入要求目标宠物已有生命状态；相同文件不会重复导入，已删除的待办不会复活。

```powershell
.\runtime\node\node.exe .\tools\import-todos.mjs --config 'D:\DeepSeek\silicon-genesis\data\dsh\dsh-pet\companion\postgres.json' --source 'D:\Backups\old-todos.json' --pet main --backup 'D:\Backups\old-todos-source-backup.json'
```

到期待办的提醒会先将领取记录提交到数据库，再显示气泡。如果提交后、气泡显示前进程崩溃，该次提醒可能不会显示，也不会自动重复；待办本身仍保留在列表中。
