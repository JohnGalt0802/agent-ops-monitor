// lib/recorder.js — 操作记录器：内存存储 + JSONL 解析 + diff 生成
import fs from "node:fs";
import path from "node:path";

const MAX_RECORDS = 200;

export class OperationRecorder {
  constructor(log) {
    this.log = log || { info() {}, warn() {}, error() {} };
    this.records = [];
    this.subscribers = new Set();
    this.lastScanPositions = new Map(); // sessionPath → last byte offset
    this.pendingCalls = new Map();      // toolCallId → record (等待 result)
    this.currentTurnId = 1;             // 当前轮次 ID
    this.turnPrompts = new Map();       // turnId → 用户 prompt 文本
  }

  // 开始新一轮
  nextTurn(promptText) {
    if (promptText && this.turnPrompts) {
      this.turnPrompts.set(this.currentTurnId + 1, promptText);
    }
    this.currentTurnId++;
    this._broadcast({ type: "turn_changed", turnId: this.currentTurnId });
  }

  // 添加一条记录
  add(record) {
    record.id = record.id || `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    record.timestamp = record.timestamp || Date.now();
    record.turnId = record.turnId || this.currentTurnId;
    this.records.push(record);
    if (this.records.length > MAX_RECORDS) {
      this.records = this.records.slice(-MAX_RECORDS);
    }
    this._broadcast({ type: "record_added", record });
  }

  // 获取所有 turn（分组结构）
  getTurns() {
    const turnMap = new Map();
    for (const rec of this.records) {
      const tid = rec.turnId || 1;
      if (!turnMap.has(tid)) {
        turnMap.set(tid, {
          id: tid,
          records: [],
          archived: tid < this.currentTurnId,
          prompt: this.turnPrompts?.get(tid) || "",
          firstTimestamp: rec.timestamp,
          lastTimestamp: rec.timestamp,
        });
      }
      const turn = turnMap.get(tid);
      turn.records.push(rec);
      if (rec.timestamp < turn.firstTimestamp) turn.firstTimestamp = rec.timestamp;
      if (rec.timestamp > turn.lastTimestamp) turn.lastTimestamp = rec.timestamp;
    }
    // 补全每个 turn 的状态：全部操作完成 = 已完成
    for (const turn of turnMap.values()) {
      turn.allDone = turn.records.every(r => r.status !== "running");
    }
    // 按 turn id 降序（最新的在前）
    return Array.from(turnMap.values()).sort((a, b) => b.id - a.id);
  }

  // 获取所有记录
  getAll() {
    return [...this.records];
  }

  // 获取本轮记录（若当前轮无记录，fallback 到最高轮）
  getCurrentTurnRecords() {
    const current = this.records.filter(r => (r.turnId || 1) === this.currentTurnId);
    if (current.length > 0) return current;
    // fallback：取最新一轮有记录的
    const maxTurn = this.records.reduce((max, r) => Math.max(max, r.turnId || 1), 0);
    return this.records.filter(r => (r.turnId || 1) === maxTurn);
  }

  // 清空
  clear() {
    this.records = [];
    this.lastScanPositions.clear();
    this._broadcast({ type: "records_cleared" });
  }

  // 扫描 session JSONL 文件，提取新的工具调用记录
  scanSession(sessionPath) {
    if (!sessionPath || !fs.existsSync(sessionPath)) return [];
    
    try {
      const stat = fs.statSync(sessionPath);
      const lastPos = this.lastScanPositions.get(sessionPath) || 0;
      
      if (stat.size <= lastPos) return []; // 没有新内容
      
      // 从上次位置读取新内容
      const fd = fs.openSync(sessionPath, "r");
      const buf = Buffer.alloc(stat.size - lastPos);
      fs.readSync(fd, buf, 0, buf.length, lastPos);
      fs.closeSync(fd);
      
      const newContent = buf.toString("utf-8");
      this.lastScanPositions.set(sessionPath, stat.size);
      
      return this._parseLines(newContent);
    } catch (err) {
      this.log.warn("scanSession error:", err.message);
      return [];
    }
  }

  // 全量扫描 session JSONL
  fullScan(sessionPath) {
    if (!sessionPath || !fs.existsSync(sessionPath)) return [];
    
    try {
      const content = fs.readFileSync(sessionPath, "utf-8");
      const stat = fs.statSync(sessionPath);
      this.lastScanPositions.set(sessionPath, stat.size);
      return this._parseLines(content);
    } catch (err) {
      this.log.warn("fullScan error:", err.message);
      return [];
    }
  }

  // 解析 JSONL 行，提取工具调用记录
  _parseLines(content) {
    const lines = content.split("\n").filter(Boolean);
    const newRecords = [];
    const pendingToolCalls = new Map(); // toolCallId → { name, args, timestamp }

    for (const line of lines) {
      let parsed;
      try { parsed = JSON.parse(line); } catch { continue; }

      // Assistant 消息：提取 toolCall
      if (parsed.type === "message" && parsed.message?.role === "assistant") {
        const contentArr = Array.isArray(parsed.message.content)
          ? parsed.message.content
          : [];
        
        for (const item of contentArr) {
          if (item?.type === "toolCall" && item.name && item.id) {
            pendingToolCalls.set(item.id, {
              name: item.name,
              args: item.arguments || {},
              timestamp: parsed.timestamp || Date.now(),
            });
          }
        }
      }

      // ToolResult 消息：匹配 toolCall 并生成记录
      if (parsed.type === "toolResult" || 
          (parsed.type === "message" && parsed.message?.role === "toolResult")) {
        const tr = parsed.type === "toolResult" ? parsed : parsed.message;
        const toolCallId = tr.toolCallId;
        const tc = toolCallId ? pendingToolCalls.get(toolCallId) : null;
        
        if (!tc) continue;

        // 只记录我们关心的工具
        if (!["exec_command", "edit", "write"].includes(tc.name)) continue;

        const isError = tr.isError || tr.details?.isError || false;
        const record = this._buildRecord(tc, tr, isError);
        if (record) {
          newRecords.push(record);
          pendingToolCalls.delete(toolCallId);
        }
      }
    }

    // 将新记录添加到存储
    for (const rec of newRecords) {
      this.add(rec);
    }

    return newRecords;
  }

  // 根据 toolCall + toolResult 构建记录
  _buildRecord(tc, tr, isError) {
    const base = {
      id: `${tc.timestamp}-${Math.random().toString(36).slice(2, 6)}`,
      type: tc.name,
      timestamp: tc.timestamp,
      status: isError ? "error" : "success",
    };

    if (tc.name === "exec_command") {
      const cmd = tc.args?.cmd || "";
      const output = tr.details?.output || tr.output || tr.content || "";
      return {
        ...base,
        summary: cmd.length > 80 ? cmd.slice(0, 77) + "..." : cmd,
        detail: {
          command: cmd,
          output: typeof output === "string" ? output : JSON.stringify(output),
          exitCode: tr.details?.exitCode ?? (isError ? 1 : 0),
        },
      };
    }

    if (tc.name === "edit") {
      const filePath = tc.args?.path || "";
      const oldText = tc.args?.edits?.[0]?.oldText || "";
      const newText = tc.args?.edits?.[0]?.newText || "";
      const fileName = filePath.split(/[\\/]/).pop() || filePath;
      return {
        ...base,
        summary: `编辑 ${fileName}`,
        detail: {
          filePath,
          oldText,
          newText,
          editCount: tc.args?.edits?.length || 1,
        },
      };
    }

    if (tc.name === "write") {
      const filePath = tc.args?.path || "";
      const content = tc.args?.content || "";
      const fileName = filePath.split(/[\\/]/).pop() || filePath;
      const contentPreview = content.length > 50 ? content.slice(0, 47) + "..." : content;
      return {
        ...base,
        summary: `写入 ${fileName}: ${contentPreview}`,
        detail: {
          filePath,
          content,
          isNew: true, // write 通常创建新文件
        },
      };
    }

    return null;
  }

  // SSE 广播
  subscribe(send) {
    this.subscribers.add(send);
    return () => this.subscribers.delete(send);
  }

  // ── Pi SDK 实时接口：pi:tool_call → 创建 pending 记录 ──
  recordToolCall(toolCallId, name, args) {
    if (!toolCallId || !name) return;
    if (!["exec_command", "edit", "write"].includes(name)) return;

    const rec = this._buildPendingRecord(toolCallId, name, args || {});
    if (!rec) return;

    this.pendingCalls.set(toolCallId, rec);
    this.add(rec);
  }

  // ── Pi SDK 实时接口：pi:tool_result → 更新 pending 记录 ──
  recordToolResult(toolCallId, result, isError) {
    const rec = this.pendingCalls.get(toolCallId);
    if (!rec) return;

    rec.status = isError ? "error" : "success";

    if (rec.type === "exec_command") {
      rec.detail.output = typeof result === "string" ? result : (result?.output || JSON.stringify(result || ""));
      rec.detail.exitCode = isError ? 1 : 0;
    }
    // edit 和 write 的结果不做额外处理，状态已由 isError 决定

    this.pendingCalls.delete(toolCallId);
    this._broadcast({ type: "record_updated", record: rec });
  }

  // 为实时工具调用构建 pending 记录
  _buildPendingRecord(toolCallId, name, args) {
    const ts = Date.now();

    if (name === "exec_command") {
      const cmd = args?.cmd || "";
      return {
        id: toolCallId,
        type: "exec_command",
        status: "running",
        timestamp: ts,
        summary: cmd.length > 80 ? cmd.slice(0, 77) + "..." : cmd,
        detail: { command: cmd, output: "", exitCode: undefined },
      };
    }

    if (name === "edit") {
      const filePath = args?.path || "";
      const oldText = args?.edits?.[0]?.oldText || "";
      const newText = args?.edits?.[0]?.newText || "";
      const fileName = filePath.split(/[\\/]/).pop() || filePath;
      return {
        id: toolCallId,
        type: "edit",
        status: "running",
        timestamp: ts,
        summary: `编辑 ${fileName}`,
        detail: { filePath, oldText, newText, editCount: args?.edits?.length || 1 },
      };
    }

    if (name === "write") {
      const filePath = args?.path || "";
      const content = args?.content || "";
      const fileName = filePath.split(/[\\/]/).pop() || filePath;
      const contentPreview = content.length > 50 ? content.slice(0, 47) + "..." : content;
      return {
        id: toolCallId,
        type: "write",
        status: "running",
        timestamp: ts,
        summary: `写入 ${fileName}: ${contentPreview}`,
        detail: { filePath, content, isNew: true },
      };
    }

    return null;
  }

  _broadcast(payload) {
    const stale = [];
    for (const send of this.subscribers) {
      try { send(payload); } catch { stale.push(send); }
    }
    for (const s of stale) this.subscribers.delete(s);
  }
}
