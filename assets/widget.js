// widget.js — Agent 操作面板前端逻辑 v2.0（按轮次分组）
(function () {
  "use strict";

  const PLUGIN_ID = window.__PLUGIN_ID__ || "agent-ops-monitor";
  const TOKEN = window.__HANA_TOKEN__ || "";

  // ── API 助手 ──
  async function apiFetch(path, opts = {}) {
    const headers = { "Content-Type": "application/json" };
    if (TOKEN) headers["Authorization"] = "Bearer " + TOKEN;
    const res = await fetch(`/api/plugins/${PLUGIN_ID}${path}`, {
      ...opts,
      headers: { ...headers, ...(opts.headers || {}) },
    });
    return res.json();
  }

  // ── 状态 ──
  let viewMode = "current";    // "current" | "all"
  let currentRecords = [];     // 仅本轮（mode=current）
  let allTurns = [];           // 全部 turn（mode=all）
  let currentTurnId = 1;
  let expandedIds = new Set();
  let sseSource = null;

  // ── DOM 引用 ──
  const app = document.getElementById("app");
  if (!app) return;

  // ── 构建 UI ──
  function buildUI() {
    app.innerHTML = `
      <div class="toolbar" id="toolbar">
        <button id="btn-current" class="active" title="仅显示本轮">● 本轮</button>
        <button id="btn-all" title="显示全部轮次">◎ 全部</button>
        <span class="spacer"></span>
        <button id="btn-expand-all" title="全部展开">▤ 展开</button>
        <button id="btn-collapse-all" title="全部折叠">▢ 折叠</button>
        <button id="btn-clear" title="清空记录">✕ 清空</button>
        <button id="btn-refresh" title="刷新活跃会话记录">↻ 刷新</button>
      </div>
      <div class="records-list" id="records-list"></div>
      <div class="status-bar" id="status-bar">
        <span id="status-text">加载中...</span>
        <span id="status-count">0 条记录</span>
      </div>
    `;

    document.getElementById("btn-current").onclick = () => switchMode("current");
    document.getElementById("btn-all").onclick = () => switchMode("all");
    document.getElementById("btn-expand-all").onclick = expandAll;
    document.getElementById("btn-collapse-all").onclick = collapseAll;
    document.getElementById("btn-clear").onclick = clearRecords;
    document.getElementById("btn-refresh").onclick = refreshRecords;
  }

  function updateModeButtons() {
    const btnCur = document.getElementById("btn-current");
    const btnAll = document.getElementById("btn-all");
    if (!btnCur || !btnAll) return;
    btnCur.classList.toggle("active", viewMode === "current");
    btnAll.classList.toggle("active", viewMode === "all");
  }

  // ── 切换视图 ──
  function switchMode(mode) {
    viewMode = mode;
    updateModeButtons();
    loadRecords(mode);
  }

  // ── 加载记录 ──
  async function loadRecords(mode) {
    setStatus("加载中...");
    try {
      const data = await apiFetch(`/api/records?mode=${mode}`);
      currentTurnId = data.currentTurnId || currentTurnId;
      if (mode === "all") {
        allTurns = data.turns || [];
        currentRecords = [];
      } else {
        currentRecords = data.records || [];
        allTurns = [];
      }
      render();
    } catch (err) {
      setStatus("加载失败");
    }
  }

  // ── 渲染 ──
  function render() {
    const list = document.getElementById("records-list");
    const countEl = document.getElementById("status-count");
    if (!list) return;

    if (viewMode === "current") {
      currentRecords.sort((a, b) => a.timestamp - b.timestamp);
      list.innerHTML = "";
      if (currentRecords.length === 0) {
        list.innerHTML = '<div class="turn-empty">本轮暂无操作</div>';
      }
      const frag = document.createDocumentFragment();
      for (const rec of currentRecords) {
        frag.appendChild(createRecordCard(rec));
      }
      list.appendChild(frag);
      if (countEl) countEl.textContent = `本轮 ${currentRecords.length} 条`;
      setStatus("就绪 · v2.0（本轮）");
    } else {
      list.innerHTML = "";
      if (allTurns.length === 0) {
        list.innerHTML = '<div class="turn-empty">暂无记录</div>';
        if (countEl) countEl.textContent = "0 条记录";
        return;
      }
      const frag = document.createDocumentFragment();
      for (const turn of allTurns) {
        frag.appendChild(createTurnGroup(turn));
      }
      list.appendChild(frag);
      let total = 0;
      for (const t of allTurns) total += t.records.length;
      if (countEl) countEl.textContent = `${allTurns.length} 轮 ${total} 条`;
      setStatus("就绪 · v2.0（全部）");
    }
  }

  // ── 创建轮次组 ──
  function createTurnGroup(turn) {
    const group = document.createElement("div");
    group.className = `turn-group${turn.archived ? " archived" : " current"}`;
    group.dataset.turnId = turn.id;

    // 头部
    const header = document.createElement("div");
    header.className = "turn-header";
    header.onclick = () => toggleTurnGroup(group);

    const time = new Date(turn.firstTimestamp).toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const endTime = turn.lastTimestamp !== turn.firstTimestamp
      ? " → " + new Date(turn.lastTimestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
      : "";

    header.innerHTML = `
      <span class="turn-expand">▶</span>
      <span class="turn-label">${turn.archived ? "📋" : "📝"} 第 ${turn.id} 轮</span>
      <span class="turn-time">${time}${endTime}</span>
      <span class="turn-count">${turn.records.length} 次操作</span>
      ${turn.archived ? '<span class="turn-badge">归档</span>' : '<span class="turn-badge live">进行中</span>'}
    `;

    group.appendChild(header);

    // 内容区
    const body = document.createElement("div");
    body.className = "turn-body";
    // 本轮默认展开，归档默认折叠
    if (!turn.archived) body.classList.add("open");

    turn.records.sort((a, b) => a.timestamp - b.timestamp);
    for (const rec of turn.records) {
      body.appendChild(createRecordCard(rec));
    }

    group.appendChild(body);
    return group;
  }

  function toggleTurnGroup(group) {
    const body = group.querySelector(".turn-body");
    const arrow = group.querySelector(".turn-expand");
    if (body) body.classList.toggle("open");
    if (arrow) arrow.classList.toggle("open");
  }

  // ── 创建记录卡片 ──
  function createRecordCard(rec) {
    const card = document.createElement("div");
    card.className = `record-card status-${rec.status}`;
    card.dataset.id = rec.id;

    const isExpanded = expandedIds.has(rec.id);

    // 头部
    const header = document.createElement("div");
    header.className = "card-header";
    header.onclick = (e) => {
      e.stopPropagation();
      toggleCard(rec.id);
    };

    const iconMap = {
      exec_command: { cls: "cmd", symbol: ">" },
      edit: { cls: "edit", symbol: "✎" },
      write: { cls: "write", symbol: "+" },
    };
    const icon = iconMap[rec.type] || { cls: "", symbol: "?" };

    const typeMap = {
      exec_command: "CMD",
      edit: "EDIT",
      write: "WRITE",
    };

    const time = new Date(rec.timestamp).toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

    header.innerHTML = `
      <span class="card-icon ${icon.cls}">${icon.symbol}</span>
      <span class="card-type">${typeMap[rec.type] || rec.type}</span>
      <span class="card-summary" title="${escapeHtml(rec.summary)}">${escapeHtml(rec.summary)}</span>
      <span class="card-expand ${isExpanded ? "expanded" : ""}">▶</span>
      <span class="card-status-dot ${rec.status}"></span>
    `;

    card.appendChild(header);

    // 详情
    const detail = document.createElement("div");
    detail.className = `card-detail ${isExpanded ? "open" : ""}`;
    detail.innerHTML = renderDetail(rec);
    card.appendChild(detail);

    return card;
  }

  // ── 渲染详情内容 ──
  function renderDetail(rec) {
    if (rec.type === "exec_command") {
      return renderCmdDetail(rec);
    }
    if (rec.type === "edit") {
      return renderDiffDetail(rec);
    }
    if (rec.type === "write") {
      return renderWriteDetail(rec);
    }
    return `<div class="cmd-block"><pre>${escapeHtml(JSON.stringify(rec.detail, null, 2))}</pre></div>`;
  }

  function renderCmdDetail(rec) {
    const d = rec.detail || {};
    const cmd = d.command || "";
    const output = d.output || "";
    const exitCode = d.exitCode;
    const isErr = rec.status === "error" || exitCode !== 0;

    return `
      <div class="cmd-block">
        <div class="cmd-label">命令</div>
        <div class="cmd-command">${escapeHtml(cmd)}</div>
        ${output ? `
          <div class="cmd-label">输出</div>
          <div class="cmd-output${isErr ? " error-output" : ""}">${escapeHtml(output)}</div>
        ` : ""}
        ${exitCode !== undefined ? `<div class="cmd-exit">退出码: <code>${exitCode}</code></div>` : ""}
      </div>
    `;
  }

  function renderDiffDetail(rec) {
    const d = rec.detail || {};
    const oldText = d.oldText || "";
    const newText = d.newText || "";
    const filePath = d.filePath || "";
    const diffHtml = generateLineDiff(oldText, newText);

    return `
      <div class="diff-block">
        <div class="diff-file">${escapeHtml(filePath)}</div>
        <div class="diff-content">${diffHtml}</div>
      </div>
    `;
  }

  function renderWriteDetail(rec) {
    const d = rec.detail || {};
    const filePath = d.filePath || "";
    const content = d.content || "";

    return `
      <div class="write-block">
        <div class="write-file">${d.isNew ? "新建: " : ""}${escapeHtml(filePath)}</div>
        <div class="write-content">${escapeHtml(content)}</div>
      </div>
    `;
  }

  // ── 行级 diff 生成（简化 LCS） ──
  function generateLineDiff(oldText, newText) {
    if (!oldText && !newText) return '<div class="diff-line unchanged">无改动</div>';
    if (!oldText) {
      return newText.split("\n").map(l => `<div class="diff-line added">+ ${escapeHtml(l)}</div>`).join("");
    }
    if (!newText) {
      return oldText.split("\n").map(l => `<div class="diff-line removed">- ${escapeHtml(l)}</div>`).join("");
    }

    const oldLines = oldText.split("\n");
    const newLines = newText.split("\n");

    const result = [];
    const lcs = computeLCS(oldLines, newLines);

    let oi = 0, ni = 0, li = 0;
    while (oi < oldLines.length || ni < newLines.length) {
      if (li < lcs.length && oi < oldLines.length && ni < newLines.length &&
          oldLines[oi] === lcs[li] && newLines[ni] === lcs[li]) {
        result.push(`<div class="diff-line unchanged">  ${escapeHtml(lcs[li])}</div>`);
        oi++; ni++; li++;
      } else if (li < lcs.length && oi < oldLines.length && oldLines[oi] !== lcs[li]) {
        result.push(`<div class="diff-line removed">- ${escapeHtml(oldLines[oi])}</div>`);
        oi++;
      } else if (li < lcs.length && ni < newLines.length && newLines[ni] !== lcs[li]) {
        result.push(`<div class="diff-line added">+ ${escapeHtml(newLines[ni])}</div>`);
        ni++;
      } else if (oi < oldLines.length && ni >= newLines.length) {
        result.push(`<div class="diff-line removed">- ${escapeHtml(oldLines[oi])}</div>`);
        oi++;
      } else if (ni < newLines.length && oi >= oldLines.length) {
        result.push(`<div class="diff-line added">+ ${escapeHtml(newLines[ni])}</div>`);
        ni++;
      } else {
        if (oi < oldLines.length) { result.push(`<div class="diff-line removed">- ${escapeHtml(oldLines[oi])}</div>`); oi++; }
        if (ni < newLines.length) { result.push(`<div class="diff-line added">+ ${escapeHtml(newLines[ni])}</div>`); ni++; }
      }
    }

    return result.join("");
  }

  function computeLCS(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
    const result = [];
    let i = m, j = n;
    while (i > 0 && j > 0) {
      if (a[i - 1] === b[j - 1]) {
        result.unshift(a[i - 1]);
        i--; j--;
      } else if (dp[i - 1][j] > dp[i][j - 1]) {
        i--;
      } else {
        j--;
      }
    }
    return result;
  }

  // ── 卡片折叠/展开 ──
  function toggleCard(id) {
    if (expandedIds.has(id)) {
      expandedIds.delete(id);
    } else {
      expandedIds.add(id);
    }
    const card = document.querySelector(`.record-card[data-id="${id}"]`);
    if (card) {
      const detail = card.querySelector(".card-detail");
      const expand = card.querySelector(".card-expand");
      if (detail) detail.classList.toggle("open");
      if (expand) expand.classList.toggle("expanded");
    }
  }

  function expandAll() {
    // 收集所有可见卡片 id
    const allIds = viewMode === "current"
      ? currentRecords.map(r => r.id)
      : allTurns.flatMap(t => t.records.map(r => r.id));
    expandedIds = new Set(allIds);
    render();
  }

  function collapseAll() {
    expandedIds.clear();
    render();
  }

  // ── 清空 ──
  async function clearRecords() {
    try {
      await apiFetch("/api/clear", { method: "POST" });
      currentRecords = [];
      allTurns = [];
      expandedIds.clear();
      render();
      setStatus("已清空");
    } catch (err) {
      setStatus("清空失败: " + err.message);
    }
  }

  // ── 刷新 ──
  async function refreshRecords() {
    setStatus("刷新中...");
    try {
      await apiFetch("/api/refresh", { method: "POST" });
      await loadRecords(viewMode);
    } catch (err) {
      setStatus("刷新失败: " + err.message);
    }
  }

  // ── SSE 实时更新 ──
  function connectSSE() {
    if (sseSource) {
      sseSource.close();
      sseSource = null;
    }

    const url = `/api/plugins/${PLUGIN_ID}/api/events`;
    const headers = TOKEN ? { Authorization: "Bearer " + TOKEN } : {};

    fetch(url, { headers })
      .then((res) => {
        if (!res.ok || !res.body) {
          setStatus("SSE 连接失败");
          setTimeout(connectSSE, 5000);
          return;
        }
        setStatus("已连接实时推送");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        function read() {
          reader.read().then(({ done, value }) => {
            if (done) {
              setStatus("SSE 断开，5s 后重连...");
              setTimeout(connectSSE, 5000);
              return;
            }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              if (line.startsWith("data: ")) {
                try {
                  const data = JSON.parse(line.slice(6));

                  if (data.type === "turn_changed") {
                    currentTurnId = data.turnId;
                    // 本轮模式下重新加载
                    if (viewMode === "current") {
                      loadRecords("current");
                    }
                  } else if (data.type === "record_added" && data.record) {
                    if (viewMode === "current") {
                      currentRecords.push(data.record);
                      if (currentRecords.length > 200) currentRecords = currentRecords.slice(-200);
                      render();
                    }
                    // 全部模式下也更新缓存
                    if (viewMode === "all") {
                      const rec = data.record;
                      const tid = rec.turnId || currentTurnId;
                      let turn = allTurns.find(t => t.id === tid);
                      if (!turn) {
                        turn = {
                          id: tid,
                          records: [],
                          archived: tid < currentTurnId,
                          firstTimestamp: rec.timestamp,
                          lastTimestamp: rec.timestamp,
                        };
                        allTurns.push(turn);
                        allTurns.sort((a, b) => b.id - a.id);
                      }
                      turn.records.push(rec);
                      render();
                    }
                  } else if (data.type === "record_updated" && data.record) {
                    // 更新 pending 记录的状态
                    const updateIn = viewMode === "current" ? currentRecords : (allTurns.flatMap(t => t.records));
                    const idx = updateIn.findIndex(r => r.id === data.record.id);
                    if (idx >= 0) {
                      updateIn[idx] = data.record;
                      render();
                    }
                  } else if (data.type === "records_cleared") {
                    currentRecords = [];
                    allTurns = [];
                    expandedIds.clear();
                    render();
                  }
                } catch {}
              }
            }

            read();
          }).catch(() => {
            setStatus("SSE 错误，5s 后重连...");
            setTimeout(connectSSE, 5000);
          });
        }

        read();
      })
      .catch(() => {
        setStatus("SSE 不可用，请手动刷新");
      });
  }

  // ── 工具函数 ──
  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function setStatus(msg) {
    const el = document.getElementById("status-text");
    if (el) el.textContent = msg;
  }

  // ── 启动 ──
  function init() {
    buildUI();
    loadRecords("current");
    connectSSE();

    try {
      window.parent.postMessage({ source: "hana-plugin", type: "ready" }, "*");
    } catch {}
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
