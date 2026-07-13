# Agent 操作面板 (agent-ops-monitor)

HanaAgent 插件。在右侧侧边栏 widget 中以时间线卡片布局可视化 Agent 的后台操作：

- **命令执行**：exec_command 及标准输出/错误输出
- **代码编辑**：edit 操作的红绿 diff
- **文件写入**：write 操作的完整内容

## 功能

- 实时记录（Pi SDK `pi:tool_call` / `pi:tool_result` 事件） + JSONL 兜底扫描
- 展开/折叠卡片详情
- 全部展开 / 全部折叠 / 清空 / 刷新
- 颜色状态：绿色（成功）、红色（失败）、脉冲绿（执行中）

## 安装

将本目录放入 `C:\Users\<用户名>\.hanako\plugins\agent-ops-monitor\`，重启 HanaAgent。

## 文件结构

```
manifest.json      # 插件清单
index.js           # 入口：Pi SDK 事件订阅 + SSE 端点
lib/recorder.js    # 操作记录器
lib/shell.js       # 会话发现 + JSONL 扫描
routes/
  api.js           # 查询 API
  shell.js         # Widget HTML 渲染
assets/
  widget.css       # 暗色主题样式
  widget.js        # 前端交互逻辑
```
