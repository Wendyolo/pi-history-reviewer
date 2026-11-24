/**
 * Pi History Reviewer — /viz 命令
 *
 * 启动/停止本地 Web 可视化服务（会话历史审查器）。
 *
 * 用法:
 *   /viz           启动服务并自动打开浏览器
 *   /viz stop      停止服务
 *
 * 安全:
 *   - 仅监听 127.0.0.1
 *   - 使用随机 token 认证（URL 查询参数 ?token=...）
 *   - pi 退出时自动关闭服务（跨会话切换保持运行）
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, randomInt } from "node:crypto";
import http from "node:http";

interface VizState {
  pid: number;
  port: number;
  token: string;
  url: string;
}

const STATE_FILE = join(tmpdir(), "pi-viz-state.json");
const MAX_TRIES = 5;

function readState(): VizState | null {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as VizState;
  } catch {
    return null;
  }
}

function writeState(s: VizState): void {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(s));
  } catch {}
}

function clearState(): void {
  try {
    rmSync(STATE_FILE, { force: true });
  } catch {}
}

function isAlive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stopServer(): void {
  const pid = readState()?.pid;
  if (pid && isAlive(pid)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  clearState();
}

function openBrowser(url: string): void {
  const platform = process.platform;
  let cmd: string;
  let args: string[];
  if (platform === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else if (platform === "darwin") {
    cmd = "open";
    args = [url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  const p = spawn(cmd, args, { stdio: "ignore", detached: true });
  p.on("error", () => {});
  p.unref();
}

function waitReady(port: number, token: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const check = () => {
      const req = http.get(
        { host: "127.0.0.1", port, path: `/?token=${encodeURIComponent(token)}` },
        (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        }
      );
      req.on("error", () => {
        if (Date.now() >= deadline) resolve(false);
        else setTimeout(check, 150);
      });
      req.setTimeout(700, () => {
        req.destroy();
        if (Date.now() >= deadline) resolve(false);
        else setTimeout(check, 150);
      });
    };
    check();
  });
}

export default function (pi: ExtensionAPI) {
  const serverPath = join(__dirname, "server.js");

  // pi 进程退出时关闭服务（跨会话切换保持运行）
  process.on("exit", () => stopServer());

  pi.registerCommand("viz", {
    description: "Start/stop the Pi History Reviewer web UI (local)",
    getArgumentCompletions: (prefix) => {
      const opts = ["start", "stop"].filter((o) => o.startsWith(prefix));
      return opts.length > 0 ? opts.map((o) => ({ value: o, label: o })) : null;
    },
    handler: async (args, ctx) => {
      const cmd = args.trim();

      if (cmd === "stop") {
        stopServer();
        ctx.ui.notify("Pi History Reviewer 已停止", "info");
        return;
      }

      const existing = readState();
      if (existing && isAlive(existing.pid)) {
        openBrowser(existing.url);
        ctx.ui.notify(`已在运行: ${existing.url}`, "info");
        return;
      }
      clearState();

      if (!existsSync(serverPath)) {
        ctx.ui.notify(`viz: 未找到 server.js (${serverPath})`, "error");
        return;
      }

      for (let i = 0; i < MAX_TRIES; i++) {
        const port = 4300 + randomInt(0, 600);
        const token = randomBytes(16).toString("hex");
        const url = `http://127.0.0.1:${port}/?token=${token}`;

        const child = spawn(
          process.execPath,
          [serverPath, `--port=${port}`, `--token=${token}`, "--host=127.0.0.1"],
          { stdio: "ignore" }
        );

        if (await waitReady(port, token, 4000)) {
          writeState({ pid: child.pid!, port, token, url });
          openBrowser(url);
          ctx.ui.notify(`Pi History Reviewer: ${url}`, "info");
          return;
        }
        try {
          child.kill("SIGKILL");
        } catch {}
      }

      ctx.ui.notify("viz: 启动失败（端口可能被占用）", "error");
    },
  });
}
