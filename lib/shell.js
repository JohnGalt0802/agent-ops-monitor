// lib/shell.js — Widget HTML shell
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readAsset(name) {
  try {
    return fs.readFileSync(path.join(__dirname, "..", "assets", name), "utf-8");
  } catch {
    return "";
  }
}



export function renderWidgetShell(c, ctx) {
  const hanaCss = c.req.query("hana-css") || "";
  const token = c.req.query("token") || "";
  const pluginId = ctx.pluginId;

  // 每次请求重新读取 CSS，确保热更新生效
  const css = readAsset("widget.css");
  const js = readAsset("widget.js");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Agent 操作面板</title>
  ${hanaCss ? `<link rel="stylesheet" href="${escapeAttr(hanaCss)}">` : ""}
  <style>${css}</style>
</head>
<body data-plugin-id="${escapeAttr(pluginId)}">
  <div id="app"></div>
  <script>window.__HANA_TOKEN__ = ${JSON.stringify(token)};</script>
  <script>window.__PLUGIN_ID__ = ${JSON.stringify(pluginId)};</script>
  <script>${js}</script>
</body>
</html>`;
}

function escapeAttr(v) {
  return String(v).replace(/"/g, "&quot;");
}
