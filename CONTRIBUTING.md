# 贡献指南

感谢关注 Pi History Reviewer！欢迎提交 issue 和 PR。

## 开发环境

无需安装任何依赖——项目只用 Node.js 内置模块。

```bash
node server.js          # 启动独立服务器 http://127.0.0.1:4000
```

前端在 `public/` 下（原生 HTML / CSS / JS），改完刷新浏览器（`Ctrl+Shift+R` 强制刷新）即可看到效果，无需构建。

## 目录结构

```
.
├── index.ts       # Pi 扩展入口（/viz 命令）
├── server.js      # Node 后端（零依赖）
├── public/        # 前端
├── package.json   # pi package 清单（pi.extensions）
└── README.md
```

## 本地测试扩展

把仓库放到 Pi 的扩展目录，或临时加载：

```bash
# 方式一：放进扩展目录
cp -r . ~/.pi/agent/extensions/viz
# 在 pi 里 /reload

# 方式二：临时加载
pi -e ./index.ts
```

然后在 pi 里运行 `/viz`。

## 提交规范

- 提交前确保 `node --check server.js` 和 `node --check public/app.js` 通过。
- 如果改了 `server.js` 或 `public/`，记得同步到 `~/.pi/agent/extensions/viz/`（本地安装副本）。
- 说明清楚改动了什么、为什么。

## 报告问题

在 GitHub Issues 里描述：pi 版本、操作系统、复现步骤、期望/实际行为。涉及会话数据时，不要直接粘贴原文，可以用脱敏后的片段。
