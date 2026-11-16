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

## SAG references

The local reranker prompt and retrieval design are informed by
[SAG-Benchmark](https://github.com/Zleap-AI/SAG-Benchmark) and
[SAG-Wiki](https://github.com/Zleap-AI/SAG-Wiki). The Qwen model is a separate
download and is not distributed by this repository.

MIT License

Copyright (c) 2026 Zleap Team

Copyright (c) 2026 sag contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
