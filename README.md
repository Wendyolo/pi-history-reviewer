# π Pi History Reviewer

本地 Web 版 **pi 会话历史可视化审查器**（类似 Claude Code 的 history reviewer）。同时提供**独立运行**与 **Pi 扩展（`/viz`）**两种用法，同一套代码。

扫描 `~/.pi/agent/sessions/` 下的会话 JSONL，在浏览器里以时间线形式渲染对话。

## 功能

- 🗂 会话列表：按项目目录分组、搜索、按时间/费用排序、悬停复制 Session ID、就地重命名
- 💬 时间线渲染：用户 / 助手 / 工具调用 / 工具结果 / 系统提示 / bash，Markdown + 低饱和代码高亮
- 💭 Thinking 块（虚线虚化、默认折叠），工具调用与结果用左侧竖线表示因果
- 🔢 会话顶部用量面板（input/output/cacheRead/cacheWrite 分项，严格互斥口径）
- 📊 用量统计仪表盘：KPI 卡、按会话/每日的极简折线图、工具调用统计表
- 🔍 会话内全文搜索（高亮）+ 按角色/工具名过滤 + 「仅看错误」
- 🌳 会话树视图、🖼 图片内联、⬇ 导出 HTML / Markdown
- 🗑 删除会话（优先放入回收站）
- 深色模式自动跟随系统

## 用法一：独立运行

```bash
node server.js
# 打开 http://127.0.0.1:4000
```

参数：

```bash
node server.js --port=8080              # 端口
node server.js --session-dir=X:/pi/sessions   # 自定义会话目录
node server.js --token=<随机串>         # 开启 token 认证（保护 /api）
```

## 用法二：Pi 扩展（`/viz`）

把本仓库放到 `~/.pi/agent/extensions/viz/`（Windows 为 `C:\Users\<你>\.pi\agent\extensions\viz\`），或在 pi 里 `/reload` 热加载后：

| 命令 | 作用 |
|---|---|
| `/viz` | 启动服务（随机端口 + 随机 token）并自动打开浏览器 |
| `/viz stop` | 停止服务 |

安全：仅监听 `127.0.0.1`，数据接口需 token 认证；pi 退出时自动关闭服务。

## 恢复某次对话

会话 ID 可在本工具中悬停会话卡片查看（或直接看 `pi -r`）。恢复命令：

```bash
pi --session <session-id>    # 支持完整 UUID 或唯一前缀
pi -r                        # 交互式浏览选择历史会话
```

## 文件结构

```
.
├── index.ts       # Pi 扩展入口（/viz 命令）
├── server.js      # Node 后端（零依赖，仅内置模块）
├── public/        # 前端（index.html / app.js / style.css）
└── README.md
```

## 说明

- 会话数据只在本机解析，不上传任何内容；Markdown/高亮走 CDN，断网时自动降级。
- 重命名映射存于浏览器 `localStorage`，绝不修改原始 JSONL。
- 静态导出的 HTML 是快照，重新导出才会更新；服务器模式实时读盘。
