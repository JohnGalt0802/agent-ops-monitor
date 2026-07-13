// index.js — Agent 操作面板插件 lifecycle
import { OperationRecorder } from "./lib/recorder.js";

export default class AgentOpsMonitorPlugin {
  async onload() {
    const ctx = this.ctx;
    const log = ctx.log || { info() {}, warn() {}, error() {} };

    // 初始化记录器
    const recorder = new OperationRecorder(log);
    ctx._agentOpsRecorder = recorder;

    // 当前活跃的 session path（从事件中动态获取）
    let activeSessionPath = null;

    // 订阅 EventBus
    if (ctx?.bus && typeof ctx.bus.subscribe === "function") {
      const off = ctx.bus.subscribe((event, sessionPath) => {
        try {
          // 记录 sessionPath
          if (sessionPath) {
            activeSessionPath = sessionPath;
            recorder._activeSessionPath = sessionPath;
          }

          // 也可从事件内取 sessionPath
          const evtSession = event?.sessionPath || event?.sessionId;
          if (evtSession) {
            activeSessionPath = evtSession;
            recorder._activeSessionPath = evtSession;
          }

          const type = event?.type || "";

          // ── Pi SDK 实时事件（逐条工具调用） ──
          if (type === "pi:tool_call") {
            const toolCallId = event.toolCallId || event.id;
            const toolName = event.toolName || event.name;
            const args = event.arguments || event.args || {};
            if (toolCallId && toolName) {
              recorder.recordToolCall(toolCallId, toolName, args);
            }
            return;
          }

          if (type === "pi:tool_result") {
            const toolCallId = event.toolCallId || event.id;
            const result = event.result !== undefined ? event.result : event;
            const isError = event.isError || event.error || false;
            if (toolCallId) {
              recorder.recordToolResult(toolCallId, result, isError);
            }
            return;
          }

          // ── JSONL 扫描触发（fallback） ──
          const relevant = [
            "agent_end",
            "session_user_message",
            "block_update",
          ].includes(type);

          if (relevant && activeSessionPath) {
            // 增量扫描 session JSONL（pi 事件不可用时的兜底）
            recorder.scanSession(activeSessionPath);
          }
        } catch (err) {
          // 静默处理，不干扰主流程
        }
      });

      if (typeof off === "function") this.register(off);
    } else {
      log.warn("Agent Ops Monitor: EventBus unavailable, refresh-only mode");
    }

    // 尝试通过 bus.request 获取初始 session
    try {
      if (ctx.bus?.request) {
        const result = await ctx.bus.request("session:list", {});
        // session:list 返回 { sessions: [{ path, title, agentId }] }
        const sessions = result?.sessions || (Array.isArray(result) ? result : []);
        if (sessions.length > 0) {
          // 取第一个 session 作为初始活跃会话
          const first = sessions[0];
          if (first?.path) {
            activeSessionPath = first.path;
            recorder._activeSessionPath = first.path;
            recorder.fullScan(first.path);
          }
        }
      }
    } catch {
      // 获取 session 列表不是必需的
    }

    this.register(() => {
      recorder.subscribers.clear();
    });

    log.info("Agent Ops Monitor loaded");
  }

  async onunload() {
    this.ctx?.log?.info?.("Agent Ops Monitor unloaded");
  }
}
