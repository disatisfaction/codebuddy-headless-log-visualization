/* ================================================================
   CodeBuddy Headless Log Visualizer - Dashboard
   ================================================================ */

let currentFile = "";
let analysisData = null;
let flowToolFilter = new Set(); // 流程图工具标签筛选（空 = 全部）
let activeFlowNodeIdx = null; // 流程图最近一次点击跳转过的节点（用于显示标记）
let flowScrollTop = 0; // 流程图内部滚动位置记忆
let chartTypePie, chartToolBar, chartTokenBar, chartBlockPie, chartToolResult;

// marked config (offline)
if (typeof marked !== "undefined") {
    marked.setOptions({ breaks: true, gfm: true });
}

document.addEventListener("DOMContentLoaded", () => {
    initCharts();
    loadFileList();
    bindEvents();
});
window.addEventListener("resize", () => {
    [chartTypePie, chartToolBar, chartTokenBar, chartBlockPie, chartToolResult]
        .forEach(c => c && c.resize());
});

// ---- ECharts Init ----
function initCharts() {
    chartTypePie    = echarts.init(document.getElementById("chartTypePie"));
    chartToolBar    = echarts.init(document.getElementById("chartToolBar"));
    chartTokenBar   = echarts.init(document.getElementById("chartTokenBar"));
    chartBlockPie   = echarts.init(document.getElementById("chartBlockPie"));
    chartToolResult = echarts.init(document.getElementById("chartToolResult"));
}

// ---- Events ----
function bindEvents() {
    document.getElementById("refreshBtn").addEventListener("click", () => {
        loadFileList();
        if (currentFile) loadAll();
    });
    document.getElementById("fileSelector").addEventListener("change", e => {
        currentFile = e.target.value;
        if (currentFile) loadAll();
    });
    document.getElementById("searchInput").addEventListener("input", debounce(filterTimeline, 250));
    document.getElementById("filterType").addEventListener("change", filterTimeline);
    document.getElementById("fromIdx").addEventListener("input", debounce(filterTimeline, 200));
    document.getElementById("toIdx").addEventListener("input", debounce(filterTimeline, 200));
    document.getElementById("resetFilterBtn").addEventListener("click", resetFilters);
    document.getElementById("viewToggle").addEventListener("click", e => {
        const btn = e.target.closest(".view-btn");
        if (btn) switchTimelineView(btn.dataset.view);
    });
    // 流程图工具标签筛选
    document.getElementById("flowView").addEventListener("click", e => {
        const btn = e.target.closest(".flow-filter-tag");
        if (!btn) return;
        const tool = btn.dataset.tool;
        if (tool === "__all__") {
            flowToolFilter.clear();
        } else if (flowToolFilter.has(tool)) {
            flowToolFilter.delete(tool);
        } else {
            flowToolFilter.add(tool);
        }
        renderFlowView(currentTimelineData);
    });
    document.getElementById("detailModal").addEventListener("click", e => {
        if (e.target.id === "detailModal") closeModal();
        if (e.target.classList.contains("modal-tab")) {
            switchModalTab(e.target.dataset.tab);
        }
    });
    document.getElementById("folderBtn").addEventListener("click", toggleDirBrowser);
    document.getElementById("scanBtn").addEventListener("click", scanDir);
    document.getElementById("pathInput").addEventListener("keydown", e => {
        if (e.key === "Enter") scanDir();
    });
    document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });
}

// ---- API ----
async function api(path) {
    try {
        const r = await fetch(path);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
    } catch (e) { console.error(e); return null; }
}

async function loadFileList() {
    const data = await api("/api/files");
    const sel = document.getElementById("fileSelector");
    sel.innerHTML = '<option value="">-- 选择日志文件 --</option>';
    let fileExists = false;
    if (data?.files) {
        data.files.forEach(f => {
            const o = document.createElement("option");
            o.value = f.path;
            o.textContent = `${f.name} (${fsize(f.size)})`;
            sel.appendChild(o);
            if (currentFile && f.path === currentFile) fileExists = true;
        });
        // 当前查看的文件仍存在时保持选中，不跳回默认项
        if (currentFile && fileExists) {
            sel.value = currentFile;
        } else if (!currentFile && data.files.length) {
            currentFile = data.files[0].path;
            sel.value = currentFile;
            loadAll();
        }
    }
}

async function scanDir() {
    const input = document.getElementById("pathInput");
    const dir = input.value.trim();
    if (!dir) { input.placeholder = "请先输入目录路径"; input.focus(); return; }

    const sel = document.getElementById("fileSelector");
    sel.innerHTML = '<option value="">扫描中...</option>';
    const data = await api(`/api/scan?dir=${encodeURIComponent(dir)}`);
    if (!data || data.error) {
        sel.innerHTML = `<option value="">${(data && data.error) || "扫描失败"}</option>`;
        return;
    }
    if (!data.files || data.files.length === 0) {
        sel.innerHTML = '<option value="">该目录无 .log / .jsonl 文件</option>';
        return;
    }

    sel.innerHTML = '<option value="">-- 选择日志文件 --</option>';
    const optgroup = document.createElement("optgroup");
    optgroup.label = data.dir;
    data.files.forEach(f => {
        const o = document.createElement("option");
        o.value = f.path;
        o.textContent = `${f.name} (${fsize(f.size)})`;
        optgroup.appendChild(o);
    });
    sel.appendChild(optgroup);

    // 同时合并默认列表
    const defaults = await api("/api/files");
    if (defaults?.files) {
        const g2 = document.createElement("optgroup");
        g2.label = "默认日志目录";
        defaults.files.forEach(f => {
            const o = document.createElement("option");
            o.value = f.path;
            o.textContent = `${f.name} (${fsize(f.size)})`;
            g2.appendChild(o);
        });
        sel.appendChild(g2);
    }

    currentFile = data.files[0].path;
    sel.value = currentFile;
    loadAll();
}

// --- 目录浏览器 ---
let curBrowsePath = "";

function toggleDirBrowser() {
    const panel = document.getElementById("dirBrowser");
    if (panel.style.display !== "none") {
        panel.style.display = "none";
        return;
    }
    panel.style.display = "flex";
    browseDir("");
}

function browseDir(path) {
    curBrowsePath = path;
    const list = document.getElementById("dirList");
    const bc = document.getElementById("dirBreadcrumb");
    list.innerHTML = '<div class="dir-loading">加载中...</div>';
    bc.innerHTML = "";

    fetch("/api/browse?path=" + encodeURIComponent(path))
        .then(r => r.json())
        .then(data => {
            if (data.error) { list.innerHTML = '<div class="dir-empty">' + data.error + '</div>'; return; }
            renderBreadcrumb(data);
            renderDirList(data);
        })
        .catch(() => {
            list.innerHTML = '<div class="dir-empty">请求失败</div>';
        });
}

function renderBreadcrumb(data) {
    const bc = document.getElementById("dirBreadcrumb");
    bc.innerHTML = "";
    if (data.is_root || !data.path) {
        const span = document.createElement("span");
        span.textContent = "📁 根目录";
        bc.appendChild(span);
        return;
    }
    // 构建面包屑
    const parts = [];
    if (data.path) {
        if (data.path.endsWith(":\\")) {
            parts.push({ label: data.path, path: data.path });
        } else {
            let p = data.path;
            while (p && p !== "/") {
                const name = p.split("/").pop() || p.split("\\").pop() || p;
                const prev = p.substring(0, p.length - name.length - 1) || (p.match(/^[A-Z]:\\/) ? p.substring(0, 3) : "/");
                parts.unshift({ label: name, path: p });
                if (p.endsWith(":\\") || p === "/") break;
                p = prev;
            }
        }
    }
    parts.forEach((part, i) => {
        if (i > 0) {
            const sep = document.createElement("span");
            sep.className = "dir-sep";
            sep.textContent = "›";
            bc.appendChild(sep);
        }
        const span = document.createElement("span");
        span.textContent = part.label;
        span.title = part.path;
        span.onclick = (e) => { e.stopPropagation(); browseDir(part.path); };
        bc.appendChild(span);
    });
}

function renderDirList(data) {
    const list = document.getElementById("dirList");
    list.innerHTML = "";
    if (!data.entries || data.entries.length === 0) {
        list.innerHTML = '<div class="dir-empty">此目录下没有子目录</div>';
        return;
    }
    // 上级目录
    if (data.parent !== null && data.parent !== undefined) {
        const up = document.createElement("div");
        up.className = "dir-entry dir-up";
        up.innerHTML = '<span class="dir-icon">📂</span><span class="dir-name">..</span>';
        up.onclick = (e) => { e.stopPropagation(); browseDir(data.parent); };
        list.appendChild(up);
    }
    data.entries.forEach(entry => {
        const div = document.createElement("div");
        div.className = "dir-entry" + (entry.type === "drive" ? " dir-drive" : "");
        div.innerHTML = '<span class="dir-icon">' + (entry.type === "drive" ? "💿" : "📁") + '</span><span class="dir-name">' + escapeHtml(entry.name) + "</span>";
        div.title = entry.path;
        // 单击：进入目录
        div.onclick = (e) => { e.stopPropagation(); browseDir(entry.path); };
        list.appendChild(div);
    });
}

document.getElementById("dirSelectBtn").onclick = function() {
    document.getElementById("pathInput").value = curBrowsePath;
    document.getElementById("dirBrowser").style.display = "none";
    scanDir();
};

// 点击面板外关闭（含按钮子节点判断）
document.addEventListener("click", function(e) {
    const panel = document.getElementById("dirBrowser");
    const btn = document.getElementById("folderBtn");
    if (panel.style.display !== "none" && !panel.contains(e.target) && !btn.contains(e.target)) {
        panel.style.display = "none";
    }
});

// 目录浏览器面板打开时，默认选中当前路径

async function loadAll() {
    if (!currentFile) return;
    const data = await api(`/api/analyze?file=${encodeURIComponent(currentFile)}`);
    if (!data || data.error) return;
    analysisData = data;
    updateCards(data);
    updateSessionBar(data);
    updateCharts(data);
    renderTimeline(data.timeline || []);
}

// ---- Cards ----
function updateCards(d) {
    setVal("totalEvents", d.total_events);
    const badge = document.getElementById("parseBadge");
    if (d.parse_errors > 0) {
        badge.style.display = "inline";
        badge.textContent = `(${d.parse_errors} 行解析失败)`;
    } else {
        badge.style.display = "none";
    }
    setVal("totalTurns",    d.session_count || "0");
    setVal("internalTurns", d.internal_turns || "0");
    setVal("totalTokens", fnum(d.total_tokens || 0));
    setVal("inputTokens", fnum(d.total_usage?.input_tokens || 0));
    setVal("outputTokens",fnum(d.total_usage?.output_tokens || 0));
    setVal("cacheTokens",fnum((d.total_usage?.cache_read || 0) + (d.total_usage?.cache_creation || 0)));
    const tc = Object.values(d.tool_usage || {}).reduce((a,b)=>a+b,0);
    setVal("totalTools", tc || "-");
    setVal("duration",   d.duration_sec ? d.duration_sec + "s" : "-");
}
function setVal(id, v) { document.getElementById(id).textContent = v; }

function updateSessionBar(d) {
    const bar = document.getElementById("sessionInfo");
    if (d.ai_title || d.model || d.cwd) {
        bar.style.display = "flex";
        document.getElementById("sCwd").textContent   = d.cwd || "-";
        document.getElementById("sModel").textContent = d.model || "-";
        document.getElementById("sTitle").textContent = d.ai_title || "-";
        document.getElementById("sTurns").textContent = d.session_count || "0";
    } else {
        bar.style.display = "none";
    }
}

// ---- Charts ----
function chartBase() {
    return { backgroundColor: "transparent", textStyle: { color: "#e1e4ea" }, animationDuration: 500 };
}

function updateCharts(data) {
    updateTypePie(data.type_distribution);
    updateToolBar(data.tool_usage);
    updateTokenBar(data);
    updateBlockPie(data.timeline || []);
    updateToolResult(data.tool_results, data.tool_usage);
}

function updateTypePie(dist) {
    if (!dist || !Object.keys(dist).length) {
        chartTypePie.setOption({ ...chartBase(), title: { text: "暂无数据", left: "center", top: "center", textStyle: { color: "#8b90a0" } } }, true);
        return;
    }
    const entries = Object.entries(dist).sort((a,b)=>b[1]-a[1]);
    const colors = ["#6c5ce7","#00b894","#fdcb6e","#e17055","#74b9ff","#fd79a8","#00cec9","#a29bfe","#dfe6e9"];
    chartTypePie.setOption({
        ...chartBase(),
        tooltip: { trigger: "item", formatter: "{b}: {c} ({d}%)" },
        legend: { bottom: 0, textStyle: { color: "#8b90a0", fontSize: 11 }, itemWidth: 10, itemHeight: 10 },
        series: [{
            type: "pie", radius: ["55%","80%"], center: ["50%","48%"],
            itemStyle: { borderRadius: 4, borderColor: "#181b23", borderWidth: 2 },
            label: { show: false },
            data: entries.map(([n,v],i)=>({name: n, value: v, itemStyle:{color:colors[i%colors.length]}})),
        }],
    }, true);
}

function updateToolBar(usage) {
    if (!usage || !Object.keys(usage).length) {
        chartToolBar.setOption({ ...chartBase(), title: { text: "暂无工具调用", left: "center", top: "center", textStyle: { color: "#8b90a0" } } }, true);
        return;
    }
    const entries = Object.entries(usage).sort((a,b)=>b[1]-a[1]).slice(0, 10);
    chartToolBar.setOption({
        ...chartBase(),
        tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
        grid: { left: 100, right: 30, top: 10, bottom: 20 },
        xAxis: { type: "value", splitLine: { lineStyle: { color: "#2a2d3a" } }, axisLabel: { fontSize: 11, color: "#8b90a0" } },
        yAxis: { type: "category", data: entries.map(e=>e[0]).reverse(), axisLabel: { fontSize: 11, color: "#8b90a0" }, axisLine: { show: false }, axisTick: { show: false } },
        series: [{
            type: "bar",
            data: entries.map(e=>e[1]).reverse(),
            itemStyle: {
                borderRadius: [0, 4, 4, 0],
                color: new echarts.graphic.LinearGradient(0,0,1,0,[
                    {offset:0,color:"#6c5ce7"},{offset:1,color:"#a29bfe"}
                ]),
            },
            barWidth: 16,
        }],
    }, true);
}

function updateTokenBar(data) {
    const timeline = data.timeline || [];
    // 筛选有 usage 的 assistant 事件
    const points = [];
    timeline.forEach((e, i) => {
        if (e.type === "assistant" && e.usage) {
            const u = e.usage;
            const total = (u.input_tokens||0) + (u.output_tokens||0);
            if (total > 0) {
                points.push({
                    idx: i + 1,
                    input: u.input_tokens || 0,
                    output: u.output_tokens || 0,
                    cache_read: u.cache_read || 0,
                    cache_creation: u.cache_creation || 0,
                });
            }
        }
    });

    if (!points.length) {
        chartTokenBar.setOption({ ...chartBase(), title: { text: "暂无 Token 数据", left: "center", top: "center", textStyle: { color: "#8b90a0" } } }, true);
        return;
    }
    chartTokenBar.setOption({
        ...chartBase(),
        tooltip: { trigger: "axis" },
        legend: { bottom: 0, textStyle: { color: "#8b90a0", fontSize: 11 }, data: ["输入", "输出", "Cache 读", "Cache 写"] },
        grid: { left: 55, right: 15, top: 10, bottom: 35 },
        xAxis: { type: "category", data: points.map(p => `#${p.idx}`), axisLabel: { fontSize: 10, color: "#8b90a0" }, axisTick: { show: false } },
        yAxis: {
            type: "value", splitLine: { lineStyle: { color: "#2a2d3a" } },
            axisLabel: { fontSize: 10, color: "#8b90a0", formatter: v => fnum(v) },
        },
        series: [
            { name: "输入", type: "bar", stack: "tokens", data: points.map(p=>p.input), itemStyle: { color: "#74b9ff" }, barWidth: 30 },
            { name: "输出", type: "bar", stack: "tokens", data: points.map(p=>p.output), itemStyle: { color: "#00b894" } },
            { name: "Cache 读", type: "bar", stack: "tokens", data: points.map(p=>p.cache_read), itemStyle: { color: "#a29bfe" } },
            { name: "Cache 写", type: "bar", stack: "tokens", data: points.map(p=>p.cache_creation), itemStyle: { color: "#fdcb6e" } },
        ],
    }, true);
}

function updateBlockPie(timeline) {
    // 统计 content blocks 类型分布
    const blockCounts = {};
    timeline.forEach(e => {
        (e.content_blocks || []).forEach(b => {
            const key = b.block_type || "?";
            blockCounts[key] = (blockCounts[key] || 0) + 1;
        });
    });
    if (!Object.keys(blockCounts).length) {
        chartBlockPie.setOption({ ...chartBase(), title: { text: "暂无 Block 数据", left: "center", top: "center", textStyle: { color: "#8b90a0" } } }, true);
        return;
    }
    const entries = Object.entries(blockCounts);
    const colors = { thinking: "#fdcb6e", text: "#a29bfe", tool_use: "#00b894", tool_result: "#74b9ff" };
    chartBlockPie.setOption({
        ...chartBase(),
        tooltip: { trigger: "item", formatter: "{b}: {c} ({d}%)" },
        legend: { bottom: 0, textStyle: { color: "#8b90a0", fontSize: 11 } },
        series: [{
            type: "pie", radius: ["45%","72%"], center: ["50%","48%"],
            itemStyle: { borderRadius: 6, borderColor: "#181b23", borderWidth: 3 },
            label: { show: true, formatter: "{b}\n{d}%", fontSize: 11, color: "#e1e4ea" },
            data: entries.map(([n,v]) => ({ name: n, value: v, itemStyle: { color: colors[n] || "#dfe6e9" } })),
        }],
    }, true);
}

function updateToolResult(results, usage) {
    const ok = results.ok || results.success || 0;
    const err = results.error || 0;
    if (!results || (ok === 0 && err === 0)) {
        chartToolResult.setOption({ ...chartBase(), title: { text: "暂无工具结果", left: "center", top: "center", textStyle: { color: "#8b90a0" } } }, true);
        return;
    }
    chartToolResult.setOption({
        ...chartBase(),
        tooltip: { trigger: "item" },
        legend: { bottom: 0, textStyle: { color: "#8b90a0", fontSize: 11 } },
        series: [{
            type: "pie", radius: ["55%","78%"], center: ["50%","48%"],
            itemStyle: { borderRadius: 6, borderColor: "#181b23", borderWidth: 3 },
            label: { show: true, formatter: "{b}\n{d}%", fontSize: 12 },
            data: [
                { name: "成功", value: ok, itemStyle: { color: "#00b894" } },
                { name: "失败", value: err, itemStyle: { color: "#e17055" } },
            ],
        }],
    }, true);
}

// ---- Timeline Views ----
let currentTimelineView = "table";
let currentTimelineData = [];

function switchTimelineView(view) {
    currentTimelineView = view;
    document.querySelectorAll("#viewToggle .view-btn").forEach(b =>
        b.classList.toggle("active", b.dataset.view === view));
    const table = document.getElementById("tableWrapper");
    const flow = document.getElementById("flowView");
    if (view === "flow") {
        table.style.display = "none";
        flow.style.display = "flex";
        renderFlowView(currentTimelineData);
        // 外部滚轮：让流程图大框回到页面中央
        flow.scrollIntoView({ behavior: "smooth", block: "center" });
    } else {
        // 记录内部滚动位置，供切回时恢复
        const sc = flow.querySelector(".flow-scroll");
        if (sc) flowScrollTop = sc.scrollTop;
        flow.style.display = "none";
        flow.style.height = "";
        table.style.display = "";
    }
}

// 流程图视图：从上到下展示所有 assistant 文本节点
function renderFlowView(timeline) {
    const flow = document.getElementById("flowView");
    if (!timeline.length) {
        flow.innerHTML = '<div class="flow-empty">暂无事件</div>';
        return;
    }
    // 全局构建 tool_id → tool_result 摘要映射（与后端关联逻辑一致）
    const resultMap = {};
    timeline.forEach((e, i) => {
        if (e.type !== "user") return;
        (e.content_blocks || []).forEach((b, bi) => {
            if (b.block_type === "tool_result" && b.tool_use_id) {
                const preview = (b.text_preview || "").slice(0, 120);
                const rpath = b.parent_tool_file_path || "";
                resultMap[b.tool_use_id] = {
                    preview,
                    error: !!b.is_error,
                    eventIdx: i,   // tool_result 所在 user 事件索引
                    blockIdx: bi,  // tool_result 块在事件中的索引
                    filePath: rpath,
                    // 对齐表格视图 user 行摘要：[tool_result/ok] @ path | preview
                    summary: `[tool_result/${b.is_error ? "error" : "ok"}]`
                        + (rpath ? ` @ ${rpath}` : "")
                        + (preview ? ` | ${preview}` : ""),
                };
            }
        });
    });
    // 收集所有 assistant 事件的文本/思考块及工具调用
    // 每个文本节点显示"它之后紧接着调用"的工具（文本引导工具调用）：
    // 遇到文本节点即开始收集，遇到下一个文本节点则停止，中途的工具归属当前文本节点
    const nodes = [];
    let openNode = null; // 正在收集工具的文本节点
    timeline.forEach((e, i) => {
        if (e.type !== "assistant") return;
        (e.content_blocks || []).forEach((b, bi) => {
            const text = b.has_text && b.text_full ? b.text_full.trim() : "";
            const think = b.has_thinking && b.thinking_full ? b.thinking_full.trim() : "";
            if (text || think) {
                // 新文本节点出现，上一个节点停止收集
                openNode = { idx: i, ts: e.timestamp || "", text, think, tools: [] };
                nodes.push(openNode);
            } else if (b.has_tool && b.tool_name) {
                if (!openNode) return; // 没有打开的文本节点，工具不归属任何节点
                const fp = b.tool_file_path || "";
                openNode.tools.push({
                    name: b.defer_tool_name || b.tool_name,
                    rawName: b.tool_name || "",
                    deferName: b.defer_tool_name || "",
                    filePath: fp,
                    id: b.tool_id || "",
                    result: resultMap[b.tool_id] || null,
                    eventIdx: i,   // 工具调用所在 assistant 事件索引
                    blockIdx: bi,  // 工具调用块在事件中的索引
                    // 对齐表格视图 assistant 工具行摘要：[工具] name @ path
                    summary: `[工具] ${b.tool_name || b.defer_tool_name}` + (fp ? ` @ ${fp}` : ""),
                });
            }
        });
    });

    if (!nodes.length) {
        flow.innerHTML = '<div class="flow-empty">没有 assistant 文本节点</div>';
        return;
    }

    // 统计每个工具出现在多少个节点中
    const toolCount = new Map();
    nodes.forEach(n => n.tools.forEach(t => {
        toolCount.set(t.name, (toolCount.get(t.name) || 0) + 1);
    }));
    const toolNames = [...toolCount.keys()].sort();

    // 工具筛选区（左上角）
    let html = '<div class="flow-filter">';
    html += '<span class="flow-filter-title">工具筛选</span>';
    html += `<button class="flow-filter-tag${flowToolFilter.size === 0 ? " active" : ""}" data-tool="__all__">全部 (${nodes.length})</button>`;
    toolNames.forEach(name => {
        html += `<button class="flow-filter-tag${flowToolFilter.has(name) ? " active" : ""}" data-tool="${escHtml(name)}">${escHtml(name)} (${toolCount.get(name)})</button>`;
    });
    html += '</div>';

    // 按选中的工具标签过滤节点
    let shown = nodes;
    if (flowToolFilter.size > 0) {
        shown = nodes.filter(n => n.tools.some(t => flowToolFilter.has(t.name)));
    }
    if (!shown.length) {
        flow.innerHTML = html + '<div class="flow-main"><div class="flow-scroll"><div class="flow-empty">没有匹配该工具筛选的节点</div></div></div>';
        return;
    }

    // ---- 对话划分：system/init 事件为对话开头，直到 result 事件为对话结尾 ----
    // custom_title 事件（位于 init 之前）可为紧随其后的对话指定标题
    const convoRanges = [];
    let cur = null;
    let pendingTitle = "";
    timeline.forEach((e, i) => {
        if (e.type === "system" && e.subtype === "custom_title") {
            pendingTitle = e.custom_title || "";
        } else if (e.type === "system" && e.subtype === "init") {
            cur = { start: i, end: i, title: pendingTitle || "" };
            pendingTitle = ""; // 标题只作用于紧随其后的对话
            convoRanges.push(cur);
        } else if (cur) {
            cur.end = i;
            if (e.type === "result") cur = null; // 对话结束
        }
    });
    // 将过滤后的节点按事件索引归入所属对话；不在任何对话范围内的归入"未分组"
    const groups = [];
    convoRanges.forEach((c, gi) => {
        const gNodes = shown.filter(n => n.idx >= c.start && n.idx <= c.end);
        if (gNodes.length) {
            groups.push({ id: `flow-convo-${gi}`, label: c.title || `对话 ${gi + 1}`, nodes: gNodes });
        }
    });
    const rest = shown.filter(n => !convoRanges.some(c => n.idx >= c.start && n.idx <= c.end));
    if (rest.length) groups.push({ id: "flow-convo-rest", label: "未分组", nodes: rest });

    // 单节点行构建（节点框 + 右侧工具展开框）
    const buildRow = (n, rowId) => {
        const hasTools = n.tools.length > 0;
        const toolsHtml = hasTools
            ? n.tools.map(t => {
                // 对齐表格视图外层显示（getToolNames）：工具名 + 文件路径提示 + defer 提示
                let nameHtml = `⚙ ${escHtml(t.rawName || t.name)}`;
                if (t.filePath && /^(Read|Write|Edit|WriteFile|MultiEdit)$/i.test(t.rawName)) {
                    const fn = t.filePath.replace(/\\/g, "/").split("/").pop();
                    nameHtml += ` <span class="file-path-hint">${escHtml(fn)}</span>`;
                }
                if (t.deferName) {
                    nameHtml += ` <span class="defer-hint">→${escHtml(t.deferName)}</span>`;
                }
                return `
            <div class="flow-tool-card">
                <div class="flow-tool-head">
                    <span class="flow-tool-name">${nameHtml}</span>
                    ${t.result ? `<span class="flow-tool-status ${t.result.error ? "err" : "ok"}">${t.result.error ? "失败" : "成功"}</span>` : ""}
                </div>
                ${t.summary ? `<div class="flow-tool-summary">${escHtml(t.summary)}</div>` : ""}
                ${t.result
                    ? `<div class="flow-tool-result${t.result.error ? " err" : ""}">${escHtml(t.result.summary)}</div>`
                    : '<div class="flow-tool-result muted">（无结果文本）</div>'}
                <div class="flow-tool-actions">
                    <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation();showToolDetail(${t.eventIdx}, ${t.blockIdx})">工具详情</button>
                    ${t.result && t.result.eventIdx !== undefined
                        ? `<button class="btn btn-secondary btn-sm" onclick="event.stopPropagation();showResultDetail(${t.result.eventIdx}, ${t.result.blockIdx})">结果详情</button>`
                        : ""}
                </div>
            </div>`;
            }).join("")
            : '<div class="flow-tool-card muted">（该节点无工具调用）</div>';
        // 工具标签列：同名工具合并，重复时显示 *n
        const tagCounts = new Map();
        n.tools.forEach(t => tagCounts.set(t.name, (tagCounts.get(t.name) || 0) + 1));
        const tagsHtml = hasTools
            ? `<div class="flow-node-tags">${[...tagCounts.entries()].map(([name, cnt]) =>
                `<span class="flow-node-tag" title="${escHtml(name)}">⚙ ${escHtml(name)}${cnt > 1 ? ` *${cnt}` : ""}</span>`).join("")}</div>`
            : '<div class="flow-node-tags"><span class="flow-node-tag muted">无工具</span></div>';
        return `
        <div class="flow-row" id="${rowId}">
            <div class="flow-node flow-node-${n.text ? "text" : "thinking"}${n.idx === activeFlowNodeIdx ? " flow-node-active" : ""}" data-idx="${n.idx}">
                <div class="flow-node-jump" title="点击跳转到表格视图并筛选该节点" onclick="flowNodeClick(${n.idx})"></div>
                <div class="flow-node-meta">
                    <span class="flow-node-idx">#${n.idx + 1}</span>
                    ${n.ts ? `<span class="flow-node-time">${escHtml(n.ts)}</span>` : ""}
                </div>
                <div class="flow-node-body">
                    <div class="flow-node-content">${escHtml((n.text || n.think))}</div>
                    <span class="flow-node-expand" style="display:none" onclick="event.stopPropagation();toggleFlowExpand(this)">展开全文</span>
                </div>
                ${tagsHtml}
                <span class="flow-node-bubble${hasTools ? "" : " empty"}" title="${hasTools ? "查看工具调用" : "无工具调用"}" onclick="event.stopPropagation();toggleFlowTools(this)">⚙</span>
            </div>
            <div class="flow-tools" style="display:none">${toolsHtml}</div>
        </div>`;
    };

    // 左侧目录（两级：对话 → 节点，二级默认折叠）
    // 一级项拆分为两个触发区：箭头=展开/折叠，标签文字=滚动跳转到对话
    let toc = '<div class="flow-toc"><div class="flow-toc-header">'
        + '<span class="flow-toc-title">目录</span>'
        + '<div class="flow-toc-actions">'
        + '<button class="flow-toc-btn" onclick="flowTocExpandAll(true)">全部展开</button>'
        + '<button class="flow-toc-btn" onclick="flowTocExpandAll(false)">全部折叠</button>'
        + '</div></div>';
    groups.forEach(g => {
        toc += `<div class="flow-toc-item convo" data-group="${g.id}">`
            + `<span class="flow-toc-arrow" title="展开/折叠二级节点" onclick="flowTocToggle('${g.id}')">▸</span>`
            + `<span class="flow-toc-label" title="滚动到${escHtml(g.label)}" onclick="flowTocJump('${g.id}')">${escHtml(g.label)}</span>`
            + `</div>`;
        toc += `<div class="flow-toc-sub" data-group="${g.id}" style="display:none">`;
        g.nodes.forEach((n, ni) => {
            const brief = (n.text || n.think || "").replace(/\s+/g, " ").trim().slice(0, 20);
            toc += `<div class="flow-toc-item node" title="滚动到 #${n.idx + 1}" onclick="flowTocScroll('${g.id}-node-${ni}')">#${n.idx + 1} ${escHtml(brief)}</div>`;
        });
        toc += '</div>';
    });
    toc += '</div>';

    // 主体：每个对话一个虚线框，把其下所有节点框起来
    html += '<div class="flow-main">' + toc + '<div class="flow-scroll"><div class="flow-item">';
    groups.forEach(g => {
        html += `<div class="flow-convo" id="${g.id}"><div class="flow-convo-header">${escHtml(g.label)} · ${g.nodes.length} 个节点</div><div class="flow-convo-body">`;
        g.nodes.forEach((n, ni) => {
            html += buildRow(n, `${g.id}-node-${ni}`);
            if (ni < g.nodes.length - 1) html += '<div class="flow-connector"></div>';
        });
        html += '</div></div>';
    });
    html += "</div></div></div>";
    flow.innerHTML = html;

    // 内容超长时显示遮罩与展开按钮
    flow.querySelectorAll(".flow-node").forEach(node => {
        const content = node.querySelector(".flow-node-content");
        const expand = node.querySelector(".flow-node-expand");
        if (content.scrollHeight > 180) {
            content.classList.add("collapsed");
            expand.style.display = "inline-block";
        }
    });
    // 恢复内部滚动位置（新 DOM 重建后，clamp 防越界）
    const sc = flow.querySelector(".flow-scroll");
    if (sc) sc.scrollTop = Math.min(flowScrollTop, sc.scrollHeight);
}

// 目录点击：在流程图滚动区内部平滑滚动到目标元素
function flowTocScroll(id) {
    const sc = document.querySelector("#flowView .flow-scroll");
    if (!sc) return;
    const target = sc.querySelector("#" + id);
    if (!target) return;
    const top = target.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
    sc.scrollTo({ top: Math.max(0, top - 8), behavior: "smooth" });
}

// 目录一级项箭头：仅展开/折叠二级节点
function flowTocToggle(id) {
    const sub = document.querySelector(`#flowView .flow-toc-sub[data-group="${id}"]`);
    if (!sub) return;
    const closed = sub.style.display === "none";
    sub.style.display = closed ? "flex" : "none";
    const arrow = document.querySelector(`#flowView .flow-toc-item.convo[data-group="${id}"] .flow-toc-arrow`);
    if (arrow) arrow.textContent = closed ? "▾" : "▸";
}

// 目录一级项标签：滚动到该对话
function flowTocJump(id) {
    flowTocScroll(id);
}

// 全部展开/折叠二级节点
function flowTocExpandAll(expand) {
    document.querySelectorAll("#flowView .flow-toc-sub").forEach(sub => {
        sub.style.display = expand ? "flex" : "none";
    });
    document.querySelectorAll("#flowView .flow-toc-arrow").forEach(arrow => {
        arrow.textContent = expand ? "▾" : "▸";
    });
}

// 点击节点右侧圆圈：展开/收起工具调用框
function toggleFlowTools(bubble) {
    const node = bubble.closest(".flow-node");
    if (!node) return;
    const tools = node.parentElement.querySelector(".flow-tools");
    if (!tools) return;
    const open = tools.style.display !== "none";
    tools.style.display = open ? "none" : "flex";
    bubble.classList.toggle("open", !open);
    bubble.title = open ? "查看工具调用" : "收起工具调用";
}

function toggleFlowExpand(el) {
    const content = el.previousElementSibling;
    const collapsed = content.classList.toggle("collapsed");
    el.textContent = collapsed ? "展开全文" : "收起";
}

// 点击流程图节点：切换到表格视图并筛选该节点至下一个 assistant 文本之前的事件
function flowNodeClick(idx) {
    const timeline = currentTimelineData || analysisData?.timeline || [];
    if (!timeline[idx]) return;
    activeFlowNodeIdx = idx; // 记录该节点为"已跳转"，流程图上的标记保留
    // 找到下一个含文本块的 assistant 事件作为终点（不含）
    let end = timeline.length;
    for (let j = idx + 1; j < timeline.length; j++) {
        const e = timeline[j];
        const hasText = (e.content_blocks || []).some(b => b.has_text && b.text_full && b.text_full.trim());
        if (e.type === "assistant" && hasText) {
            end = j;
            break;
        }
    }
    // 切到表格视图并应用范围筛选（1 基行号：idx+1 ~ end）
    switchTimelineView("table");
    setRangeFilter(idx + 1, end);
    // 滚动到表格中的对应行
    setTimeout(() => {
        const row = document.querySelector(`#eventsBody tr[data-idx="${idx}"]`);
        if (row) row.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 50);
}

// ---- Timeline Table ----
function renderTimeline(timeline) {
    currentTimelineData = timeline;
    const tbody = document.getElementById("eventsBody");
    if (!timeline.length) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:32px;color:#8b90a0;">暂无事件</td></tr>';
        return;
    }
    tbody.innerHTML = timeline.map((e, i) => {
        const ts = e.timestamp ? e.timestamp.substring(11, 23) : "-";
        const typeBadge = badgeClass(e.type);
        const toolName = getToolNames(e);  // 返回安全 HTML（含文件路径提示）
        const statusBadge = e.tool_status === "error" ? '<span class="badge badge-error">失败</span>'
                          : e.tool_status === "ok" ? '<span class="badge badge-ok">成功</span>' : "-";
        const usage = e.usage ? `${e.usage.input_tokens||0}+${e.usage.output_tokens||0}` : "-";
        const summary = escHtml(e.summary || "");
        const blockBadges = (e.content_blocks || []).map(b => {
            if (b.has_thinking) return '<span class="badge badge-thinking">思考</span>';
            if (b.has_text) return '<span class="badge badge-text">文本</span>';
            if (b.has_tool) {
                let badge = escHtml(b.tool_name);
                if (b.defer_tool_name) badge += `<span class="defer-hint">→${escHtml(b.defer_tool_name)}</span>`;
                return `<span class="badge badge-tool">${badge}</span>`;
            }
            if (b.block_type === "tool_result") return '<span class="badge badge-ok">结果</span>';
            return '';
        }).filter(Boolean).join(' ');

        return `<tr data-type="${escHtml(e.type)}" data-summary="${escHtml(e.summary)}" data-idx="${i}">
            <td>${i+1}</td>
            <td>${ts}</td>
            <td><span class="badge ${typeBadge}">${escHtml(e.type)}</span></td>
            <td><span class="badge badge-tool_name">${toolName}</span></td>
            <td>${statusBadge}</td>
            <td>
                <span style="margin-right:8px;">${blockBadges}</span>
                <span class="summary-cell">${summary}</span>
            </td>
            <td class="tokens-cell">${usage}</td>
            <td><button class="btn btn-secondary btn-sm" onclick="showDetail(${i})">详情</button></td>
        </tr>`;
    }).join("");
    // 当前处于流程图视图时同步渲染流程图
    if (currentTimelineView === "flow") {
        renderFlowView(timeline);
    }
}

function getToolNames(e) {
    if (!e.content_blocks) return "-";
    const parts = e.content_blocks
        .filter(b => b.has_tool && b.tool_name)
        .map(b => {
            let label = escHtml(b.tool_name);
            // 文件工具显示目标文件路径
            if (b.tool_file_path && /^(Read|Write|Edit|WriteFile|MultiEdit)$/i.test(b.tool_name)) {
                const fn = (b.tool_file_path.replace(/\\/g, "/").split("/").pop());
                label += ` <span class="file-path-hint">${escHtml(fn)}</span>`;
            }
            // DeferExecuteTool 显示被代理的工具名
            if (b.defer_tool_name) {
                label += ` <span class="defer-hint">→${escHtml(b.defer_tool_name)}</span>`;
            }
            return label;
        });
    return parts.length ? parts.join(", ") : "-";
}

function badgeClass(type) {
    const map = {
        assistant: "badge-assistant", user: "badge-user", system: "badge-system",
        result: "badge-result", "file-history-snapshot": "badge-file_snapshot",
        "ai-title": "badge-ai_title",
    };
    return map[type] || "badge-system";
}

// ---- Filter ----
function filterTimeline() {
    const search = document.getElementById("searchInput").value.toLowerCase();
    const typeFilter = document.getElementById("filterType").value.toLowerCase();
    // 行号范围筛选（1 基，含端点）
    let fromNum = parseInt(document.getElementById("fromIdx").value, 10);
    let toNum = parseInt(document.getElementById("toIdx").value, 10);
    if (Number.isNaN(fromNum)) fromNum = -1;
    if (Number.isNaN(toNum)) toNum = -1;
    document.querySelectorAll("#eventsBody tr").forEach(row => {
        const t = (row.dataset.type||"").toLowerCase();
        const s = (row.dataset.summary||"").toLowerCase();
        const idx = parseInt(row.dataset.idx, 10); // 0 基事件索引
        const lineNum = idx + 1;
        const typeMatch = !typeFilter || t === typeFilter;
        const searchMatch = !search || t.includes(search) || s.includes(search);
        let rangeMatch = true;
        if (fromNum > 0 && lineNum < fromNum) rangeMatch = false;
        if (toNum > 0 && lineNum > toNum) rangeMatch = false;
        row.style.display = (typeMatch && searchMatch && rangeMatch) ? "" : "none";
    });
}

function setRangeFilter(fromOneBased, toOneBased) {
    document.getElementById("fromIdx").value = fromOneBased || "";
    document.getElementById("toIdx").value = toOneBased || "";
    filterTimeline();
}

// 重置表格视图的所有筛选条件
function resetFilters() {
    document.getElementById("searchInput").value = "";
    document.getElementById("filterType").value = "";
    document.getElementById("fromIdx").value = "";
    document.getElementById("toIdx").value = "";
    activeFlowNodeIdx = null; // 清除流程图节点的跳转标记
    filterTimeline();
    // 若流程图视图可见，立即重渲染以移除节点高亮
    const flow = document.getElementById("flowView");
    if (flow && flow.style.display !== "none" && currentTimelineData) {
        renderFlowView(currentTimelineData);
    }
}

// ---- Modal ----
let currentModalEvent = null;
let currentModalTab = "content";

// 打开工具调用（tool_use 块）的详情
function showToolDetail(eventIdx, blockIdx) {
    showDetail(eventIdx, { block: blockIdx });
}

// 打开工具结果（tool_result 块）的详情
function showResultDetail(eventIdx, blockIdx) {
    showDetail(eventIdx, { block: blockIdx });
}

function showDetail(idx, opts) {
    opts = opts || {};
    const timeline = analysisData?.timeline || [];
    const event = timeline[idx];
    if (!event) return;
    event._index = idx + 1;
    currentModalEvent = event;
    currentModalTab = "content";

    // 弹窗标题：聚焦单块时显示工具/结果详情，否则事件详情
    const titleEl = document.getElementById("modalTitle");
    if (titleEl) {
        if (opts.block !== undefined) {
            const fblock = (event.content_blocks || [])[opts.block];
            if (fblock && fblock.has_tool && fblock.tool_name) titleEl.textContent = `工具详情 · ${fblock.tool_name}`;
            else if (fblock && fblock.block_type === "tool_result") titleEl.textContent = "工具结果详情";
            else titleEl.textContent = "事件详情";
        } else {
            titleEl.textContent = `事件详情 · #${idx + 1}`;
        }
    }

    // 渲染内容（聚焦单块时仅渲染该块）
    renderModalContent(event, opts);
    // 渲染 JSON（聚焦单块时仅显示该块）
    let display = {
        _index: idx + 1,
        type: event.type,
        subtype: event.subtype,
        timestamp: event.timestamp,
        summary: event.summary,
        usage: event.usage,
        stop_reason: event.stop_reason,
        tool_status: event.tool_status,
        block_count: event.block_count,
        content_blocks: event.content_blocks,
    };
    if (opts.block !== undefined && event.content_blocks && event.content_blocks[opts.block]) {
        display = {
            _index: idx + 1,
            _block_index: opts.block,
            type: event.type,
            timestamp: event.timestamp,
            content_block: event.content_blocks[opts.block],
        };
    }
    document.getElementById("modalTabJson").textContent = JSON.stringify(display, null, 2);

    // 切换 tab
    document.querySelectorAll(".modal-tab").forEach(btn => btn.classList.remove("active"));
    document.querySelector('.modal-tab[data-tab="content"]').classList.add("active");
    document.getElementById("modalTabContent").style.display = "block";
    document.getElementById("modalTabJson").style.display = "none";

    document.getElementById("detailModal").classList.add("active");
}

function renderModalContent(event, opts) {
    opts = opts || {};
    const container = document.getElementById("modalTabContent");
    const grepDataMap = {};
    const readBlocksMap = {};
    let md = "";

    // 头部信息（聚焦单块时：工具详情来源即工具自身，无需头部；结果详情保留关联信息）
    const focusedBlock = opts.block !== undefined ? (event.content_blocks || [])[opts.block] : null;
    if (focusedBlock) {
        if (focusedBlock.block_type === "tool_result") {
            md += `### 📥 工具结果\n`;
            md += `- **来源事件**: \`#${event._index || "?"}\` (${escHtml(event.type)}) ${escHtml(event.timestamp || "")}\n`;
            if (focusedBlock.tool_use_id) md += `- **tool_use_id**: \`${escHtml(focusedBlock.tool_use_id)}\`\n`;
            if (focusedBlock.is_error) md += `- **状态**: \`error\`\n`;
            if (focusedBlock.parent_tool_name) md += `- **父工具**: \`${escHtml(focusedBlock.parent_tool_name)}\`\n`;
            if (focusedBlock.parent_tool_file_path) md += fmtFileBadge(focusedBlock.parent_tool_file_path);
            md += `\n---\n\n`;
        } else if (!(focusedBlock.has_tool && focusedBlock.tool_name)) {
            md += `### 详情\n`;
            md += `- **来源事件**: \`#${event._index || "?"}\` (${escHtml(event.type)}) ${escHtml(event.timestamp || "")}\n`;
            md += `\n---\n\n`;
        }
        // has_tool 聚焦时：不渲染任何头部，正文块直接展示工具调用内容
    } else {
        md += `### ${event.type} \`#${event._index || "?"}\`\n`;
        if (event.subtype) md += `- **子类型**: ${escHtml(event.subtype)}\n`;
        if (event.timestamp) md += `- **时间**: ${escHtml(event.timestamp)}\n`;
        if (event.tool_status) md += `- **状态**: ${escHtml(event.tool_status)}\n`;
        if (event.usage) {
            md += `- **Tokens**: 输入 ${event.usage.input_tokens||0} + 输出 ${event.usage.output_tokens||0}`;
            if (event.usage.cache_read) md += ` (cache: ${event.usage.cache_read})`;
            md += `\n`;
        }
        if (event.stop_reason) md += `- **停止原因**: ${escHtml(event.stop_reason)}\n`;
        md += `\n---\n\n`;
    }

    // Content blocks（聚焦单块时仅渲染该块）
    const blocks = event.content_blocks || [];
    const renderList = opts.block !== undefined ? [blocks[opts.block]].filter(Boolean) : blocks;
    if (renderList.length > 0) {
        renderList.forEach((b, i) => {
            const origIdx = opts.block !== undefined ? opts.block : i;
            const label = (opts.block === undefined && renderList.length > 1) ? `**Block ${origIdx+1}** \`${escHtml(b.block_type)}\`\n\n` : "";

            if (b.has_thinking && b.thinking_full) {
                md += label;
                md += `<details><summary><b>💭 思考过程</b></summary>\n\n${b.thinking_full}\n\n</details>\n\n`;
            }

            if (b.has_text && b.text_full) {
                md += label;
                md += b.text_full + "\n\n";
            }

            if (b.has_tool && b.tool_name) {
                md += label;
                if (b.defer_tool_name) {
                    md += `**🔧 Defer 工具** \`${escHtml(b.tool_name)}\` → \`${escHtml(b.defer_tool_name)}\`\n\n`;
                } else {
                    md += `**🔧 工具调用** \`${escHtml(b.tool_name)}\`\n\n`;
                }

                if (b.tool_file_path) {
                    md += fmtFileBadge(b.tool_file_path);
                }

                // Write / WriteFile：单个 content 展示
                if ((b.tool_name === "Write" || b.tool_name === "WriteFile") && b.tool_content) {
                    const writeLang = guessLangFromPath(b.tool_file_path || "");
                    if (writeLang) {
                        md += `\n**📝 写入文件内容**\n\n\`\`\`${writeLang}\n${b.tool_content}\n\`\`\`\n\n`;
                    } else {
                        md += "\n**📝 写入文件内容**\n\n" + b.tool_content + "\n\n";
                    }
                }

                // Edit / MultiEdit：成对展示 old_string → new_string
                if ((b.tool_name === "Edit" || b.tool_name === "MultiEdit") && b.tool_edits && b.tool_edits.length > 0) {
                    const editLang = guessLangFromPath(b.tool_file_path || "");
                    b.tool_edits.forEach((ed, edIdx) => {
                        const editLabel = b.tool_edits.length > 1 ? `#${edIdx + 1} ` : "";
                        md += `\n**🔴 原内容 ${editLabel}(old_string)**\n\n`;
                        if (editLang) {
                            md += `\`\`\`${editLang}\n${ed.old_string}\n\`\`\`\n\n`;
                        } else {
                            md += ed.old_string + "\n\n";
                        }
                        md += `**🟢 修改后 ${editLabel}(new_string)**\n\n`;
                        if (editLang) {
                            md += `\`\`\`${editLang}\n${ed.new_string}\n\`\`\`\n\n`;
                        } else {
                            md += ed.new_string + "\n\n";
                        }
                    });
                } else if (b.tool_name === "Bash" && b.tool_command) {
                    if (b.tool_description) {
                        md += `\n**📝 说明**\n\n${b.tool_description}\n\n`;
                    }
                    md += `\n**💻 命令**\n\n\`\`\`bash\n${b.tool_command}\n\`\`\`\n\n`;
                } else if (b.tool_input_full) {
                    // 其他工具：折叠 JSON 参数
                    md += `\n<details><summary><b>📥 输入参数</b></summary>\n\n\`\`\`json\n${b.tool_input_full}\n\`\`\`\n\n</details>\n\n`;
                }
            }

            // tool_result 特殊渲染
            if (b.block_type === "tool_result") {
                md += label;
                const parentTool = b.parent_tool_name || "";

                if (parentTool === "Read" && (b.text_full)) {
                    // Read 工具结果：清洗版内容（不带行号，不干扰复制）
                    const code = b.text_clean || b.text_full;
                    // 尝试提取 FilePath
                    const fileMatch = b.text_full ? b.text_full.match(/"(.*?)"/) : null;
                    const fileLabel = fileMatch ? fileMatch[1].replace(/\\\\/g, "/") : b.tool_use_id;
                    const lang = guessLangFromPath(fileLabel) || "";
                    md += `📥 **Read 结果** → \`${escHtml(fileLabel)}\`\n\n`;
                    if (b.read_lines && b.read_lines.length > 0) {
                        // 用 → 前的真实行号渲染
                        const rid = "R" + i;
                        readBlocksMap[rid] = { lines: b.read_lines, lang: lang };
                        md += rid + "\n\n";
                    } else {
                        md += `\`\`\`${lang}\n${code}\n\`\`\`\n\n`;
                    }
                } else if (parentTool === "Grep" && b.grep_blocks && b.grep_blocks.length > 0) {
                    // Grep content-mode 结果：按文件分块展示
                    const gid = "G" + i;
                    grepDataMap[gid] = b.grep_blocks;
                    md += `📥 **Grep 匹配结果**\n\n${gid}\n\n`;
                } else if (parentTool === "DeferExecuteTool" && b.text_full) {
                    // DeferExecuteTool 结果：保持原始文本展示
                    md += `📥 **DeferExecuteTool 结果**\n\n\`\`\`\n${b.text_full}\n\`\`\`\n\n`;
                } else if (parentTool === "Write" && b.text_full) {
                    md += `✅ **Write 结果**\n\n${b.text_full}\n\n`;
                } else if (parentTool === "Bash" && (b.text_full || b.text_clean)) {
                    const bashOutput = b.text_clean || b.text_full;
                    md += `📤 **执行结果**\n\n\`\`\`shell\n${bashOutput}\n\`\`\`\n\n`;
                } else if (b.text_full) {
                    md += `📤 **返回内容**\n\n${b.text_full}\n\n`;
                }
            }
        });
    }

    // 无 blocks 但有 result_text
    if (renderList.length === 0 && event.result_text) {
        md += event.result_text + "\n\n";
    }

    if (!md.replace(/[#\-\*\`>\s\n]/g, "")) {
        md = "*无文本内容*";
    }

    let html = marked.parse(md);

    // 注入 Grep 结构化代码块（带真实行号）
    for (const [gid, blocks] of Object.entries(grepDataMap)) {
        html = html.replace("<p>" + gid + "</p>", buildGrepBlocksHtml(blocks));
    }

    // 注入 Read 结构化代码块（带真实行号，从 → 前提取）
    for (const [rid, data] of Object.entries(readBlocksMap)) {
        html = html.replace("<p>" + rid + "</p>", buildReadBlocksHtml(data));
    }

    container.innerHTML = html;
    addLineNumbersToCodeBlocks(container);
    setupCodeWrapToggle(container);
    container.scrollTop = 0;
}

// 事件详情中代码块是否自动换行（在弹窗会话内保持状态）
let codeWrapEnabled = false;

// 当内容存在代码框时，在顶部插入"代码自动换行"切换器
function setupCodeWrapToggle(container) {
    const oldBar = container.querySelector(".code-wrap-toggle");
    if (oldBar) oldBar.remove();

    const codeEls = container.querySelectorAll("pre, .code-block-wrapper");
    if (codeEls.length === 0) return; // 无代码框则不显示切换器

    const bar = document.createElement("div");
    bar.className = "code-wrap-toggle";
    bar.innerHTML = `<label class="switch" title="切换代码块是否自动换行">
        <input type="checkbox"${codeWrapEnabled ? " checked" : ""}>
        <span class="slider"></span>
    </label><span>代码自动换行</span>`;
    container.insertBefore(bar, container.firstChild);

    applyCodeWrap(container);
    const cb = bar.querySelector("input");
    cb.onchange = () => {
        codeWrapEnabled = cb.checked;
        applyCodeWrap(container);
    };
}

// 根据 codeWrapEnabled 对容器内所有代码框应用/移除换行
function applyCodeWrap(container) {
    container.querySelectorAll("pre").forEach(p => p.classList.toggle("wrap", codeWrapEnabled));
    container.querySelectorAll(".code-block-wrapper").forEach(w => w.classList.toggle("wrap", codeWrapEnabled));
}

function fmtFileBadge(path) {
    if (!path) return "";
    const short = path.replace(/\\\\/g, "/");
    const name = short.split("/").pop() || short;
    return `- 📄 **文件**: \`${escHtml(name)}\`\n`;
}

// 根据文件扩展名推断语言（代码文件返回 lang，文档/未知返回空字符串）
function guessLangFromPath(filePath) {
    if (!filePath) return "";
    const ext = filePath.replace(/\\\\/g, "/").split("/").pop().split(".").pop().toLowerCase();
    const map = {
        py: "python", js: "javascript", ts: "typescript", jsx: "jsx", tsx: "tsx",
        html: "html", htm: "html", css: "css", scss: "scss", less: "less",
        json: "json", xml: "xml", yaml: "yaml", yml: "yaml", toml: "toml",
        md: "", markdown: "",   // Markdown 文档不放进代码块
        sh: "bash", bash: "bash", zsh: "bash", bat: "bat", ps1: "powershell",
        go: "go", java: "java", c: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", h: "c", hpp: "cpp",
        rs: "rust", swift: "swift", kt: "kotlin", kts: "kotlin", scala: "scala",
        sql: "sql", graphql: "graphql", gql: "graphql", proto: "protobuf",
        dockerfile: "dockerfile", makefile: "makefile", cmake: "cmake",
        rb: "ruby", php: "php", lua: "lua", r: "r", pl: "perl",
        dart: "dart", vue: "html", svelte: "html", elm: "elm",
        clj: "clojure", cljs: "clojure", edm: "clojure",
        erl: "erlang", hrl: "erlang", ex: "elixir", exs: "elixir",
        hs: "haskell", lhs: "haskell", jl: "julia", nim: "nim",
        v: "v", zig: "zig", cr: "crystal",
        ini: "ini", cfg: "ini", conf: "ini", properties: "properties",
        gradle: "groovy", tf: "hcl", tfvars: "hcl",
        nginx: "nginx", tex: "latex", rst: "rst",
        csv: "", tsv: "", log: "", txt: "",
    };
    return map[ext] !== undefined ? map[ext] : "";
}

function buildGrepBlocksHtml(grepBlocks) {
    let h = "";
    grepBlocks.forEach(function(gb) {
        const lang = guessLangFromPath(gb.file) || "";
        h += `<p>📁 <strong>${escHtml(gb.file)}</strong> (行 ${gb.start_line}-${gb.end_line})</p>`;
        h += '<div class="code-block-wrapper"><table class="code-block-table"><tbody>';
        gb.lines.forEach(function(line, j) {
            h += "<tr><td class=\"code-ln\">" + (gb.start_line + j) + "</td>";
            h += "<td class=\"code-line\"><code" + (lang ? " class=\"language-" + lang + "\"" : "") + ">";
            h += escapeHtml(line) + "</code></td></tr>";
        });
        h += "</tbody></table></div>";
    });
    return h;
}

function buildReadBlocksHtml(data) {
    const lang = data.lang || "";
    let h = '<div class="code-block-wrapper"><table class="code-block-table"><tbody>';
    data.lines.forEach(function(line) {
        h += "<tr><td class=\"code-ln\">" + line.line_num + "</td>";
        h += "<td class=\"code-line\"><code" + (lang ? " class=\"language-" + lang + "\"" : "") + ">";
        h += escapeHtml(line.content) + "</code></td></tr>";
    });
    h += "</tbody></table></div>";
    return h;
}

function switchModalTab(tabName) {
    currentModalTab = tabName;
    document.querySelectorAll(".modal-tab").forEach(b => b.classList.remove("active"));
    document.querySelector(`.modal-tab[data-tab="${tabName}"]`).classList.add("active");
    document.getElementById("modalTabContent").style.display = tabName === "content" ? "block" : "none";
    document.getElementById("modalTabJson").style.display = tabName === "json" ? "block" : "none";
}

function closeModal() {
    document.getElementById("detailModal").classList.remove("active");
    currentModalEvent = null;
}

// ---- Helpers ----
function escapeHtml(str) {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function addLineNumbersToCodeBlocks(container) {
    container.querySelectorAll("pre code").forEach(code => {
        const text = code.textContent || "";
        const lines = text.split("\n");
        if (lines.length <= 1) return;

        const pre = code.parentElement;
        const langCls = code.className || "";

        // 构建表格：每行一个 tr，行号和代码天然对齐
        let html = '<table class="code-block-table"><tbody>';
        lines.forEach((line, i) => {
            html += `<tr><td class="code-ln">${i + 1}</td><td class="code-line"><code class="${langCls}">${escapeHtml(line)}</code></td></tr>`;
        });
        html += '</tbody></table>';

        const wrapper = document.createElement("div");
        wrapper.className = "code-block-wrapper";
        wrapper.innerHTML = html;
        pre.parentNode.replaceChild(wrapper, pre);
    });
}

function fsize(b) { return b < 1024 ? b+"B" : b < 1048576 ? (b/1024).toFixed(1)+"KB" : (b/1048576).toFixed(1)+"MB"; }
function fnum(n) { return n >= 1e6 ? (n/1e6).toFixed(1)+"M" : n >= 1000 ? (n/1000).toFixed(1)+"K" : String(n); }
function escHtml(s) { return s ? String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;") : ""; }
function debounce(fn,d) { let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn.apply(this,a),d); }; }
