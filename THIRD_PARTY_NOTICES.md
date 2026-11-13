# 第三方组件与源码来源

本仓库包含新版 LifeOS 源码，以及运行所需的既有桌宠源码和素材。公开仓库不等于为所有内容另行授予统一许可证；各组件保留自己的版权和许可声明。

| 路径 | 来源及许可 |
| --- | --- |
| `vendor/dsh-pet` | 基于 PC2005-cloud 的 dsh-pet 0.4.7，并保留本项目的宿主和 helper 改动；许可证见该目录 `LICENSE`，MIT。原项目地址见其 `package.json`。 |
| `vendor/pet-plugins/bili/upstream` | c1overzz 的 dsh-bili-scroll，MIT；包含的 bilibili-mcp 另有随附 MIT 许可证。 |
| `public/bili` | 随附 B 站 MCP 服务及依赖清单，保留原 MIT 许可证；来自上方的既有组件。 |
| `vendor/pet-plugins/behavior`、`memory`、`diary` 与 `vendor/pet-humanity` | 本地既有领域实现及本项目兼容修改；原组件的 `package.json` 和随附声明予以保留，没有额外授予开源许可。 |
| npm 依赖 | 使用 `package-lock.json` 锁定版本；每个依赖适用其自身许可证。安装目录不提交。 |

角色图片、动画、字体和声音沿用既有桌宠包；单独使用或分发时应保留相应来源并确认素材自身的使用条件。Node、Electron、Python 发行包及 Python 依赖不包含在 Git 历史中，部署者另行准备并遵守其许可证。
