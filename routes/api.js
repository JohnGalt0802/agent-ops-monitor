// routes/api.js — API 路由
import { renderWidgetShell } from "../lib/shell.js";

export default function registerRoutes(app, ctx) {
  // Widget 页面
  app.get("/widget", (c) => c.html(renderWidgetShell(c, ctx)));

  // 获取所有记录
  app.get("/api/records", (c) => {
    const recorder = ctx._agentOpsRecorder;
    if (!recorder) return c.json({ records: [], error: "recorder not ready" }, 503);
    return c.json({ records: recorder.getAll() });
  });

  // 清空记录
  app.post("/api/clear", (c) => {
    const recorder = ctx._agentOpsRecorder;
    if (!recorder) return c.json({ ok: false, error: "recorder not ready" }, 503);
    recorder.clear();
    return c.json({ ok: true });
  });

  // 刷新：扫描活跃 session
  app.post("/api/refresh", (c) => {
    const recorder = ctx._agentOpsRecorder;
    if (!recorder) return c.json({ ok: false, error: "recorder not ready" }, 503);

    const sessionPath = recorder._activeSessionPath;
    if (!sessionPath) {
      return c.json({ ok: false, error: "no active session", records: recorder.getAll() });
    }

    const newRecords = recorder.fullScan(sessionPath);
    return c.json({ ok: true, sessionPath, newCount: newRecords.length, records: recorder.getAll() });
  });

  // SSE 实时推送
  app.get("/api/events", (c) => {
    const recorder = ctx._agentOpsRecorder;
    if (!recorder) return c.json({ error: "recorder not ready" }, 503);

    const encoder = new TextEncoder();
    let send = null;
    let heartbeat = null;
    let streamController = null;
    let closed = false;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
      if (send) { recorder.subscribers.delete(send); send = null; }
    };

    const safeSend = (payload) => {
      if (closed || !streamController) return false;
      try {
        streamController.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        return true;
      } catch {
        cleanup();
        return false;
      }
    };

    const stream = new ReadableStream({
      start(controller) {
        streamController = controller;
        send = safeSend;
        recorder.subscribers.add(send);
        send({ type: "hello", ts: Date.now() });
        heartbeat = setInterval(() => {
          if (!safeSend({ type: "heartbeat", ts: Date.now() })) cleanup();
        }, 15000);
      },
      cancel() { cleanup(); },
    });

    c.header("Content-Type", "text/event-stream; charset=utf-8");
    c.header("Cache-Control", "no-cache, no-transform");
    c.header("Connection", "keep-alive");
    return c.body(stream);
  });
}
