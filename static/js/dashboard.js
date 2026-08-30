/* ================================================================
   CodeBuddy Headless Log Visualizer - Dashboard
   ================================================================ */

let currentFile = "";
let analysisData = null;
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
    if (data?.files) {
        data.files.forEach(f => {
            const o = document.createElement("option");
            o.value = f.path;
            o.textContent = `${f.name} (${fsize(f.size)})`;
            sel.appendChild(o);
        });
        if (!currentFile && data.files.length) {
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
        chartTypePie.setOption({ ...chartBase(), title: { text: "暂无数据", left: "center", top: "center", textStyle: { color: "#8b90a0" } } });
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
    });
}

function updateToolBar(usage) {
    if (!usage || !Object.keys(usage).length) {
        chartToolBar.setOption({ ...chartBase(), title: { text: "暂无工具调用", left: "center", top: "center", textStyle: { color: "#8b90a0" } } });
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
    });
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
        chartTokenBar.setOption({ ...chartBase(), title: { text: "暂无 Token 数据", left: "center", top: "center", textStyle: { color: "#8b90a0" } } });
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
    });
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
        chartBlockPie.setOption({ ...chartBase(), title: { text: "暂无 Block 数据", left: "center", top: "center", textStyle: { color: "#8b90a0" } } });
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
    });
}

function updateToolResult(results, usage) {
    const ok = results.ok || results.success || 0;
    const err = results.error || 0;
    if (!results || (ok === 0 && err === 0)) {
        chartToolResult.setOption({ ...chartBase(), title: { text: "暂无工具结果", left: "center", top: "center", textStyle: { color: "#8b90a0" } } });
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
    });
}

// ---- Timeline Table ----
function renderTimeline(timeline) {
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

        return `<tr data-type="${escHtml(e.type)}" data-summary="${escHtml(e.summary)}">
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
    document.querySelectorAll("#eventsBody tr").forEach(row => {
        const t = (row.dataset.type||"").toLowerCase();
        const s = (row.dataset.summary||"").toLowerCase();
        const typeMatch = !typeFilter || t === typeFilter;
        const searchMatch = !search || t.includes(search) || s.includes(search);
        row.style.display = (typeMatch && searchMatch) ? "" : "none";
    });
}

// ---- Modal ----
let currentModalEvent = null;
let currentModalTab = "content";

function showDetail(idx) {
    const timeline = analysisData?.timeline || [];
    const event = timeline[idx];
    if (!event) return;
    currentModalEvent = event;
    currentModalTab = "content";

    // 渲染内容
    renderModalContent(event);
    // 渲染 JSON
    const display = {
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
    document.getElementById("modalTabJson").textContent = JSON.stringify(display, null, 2);

    // 切换 tab
    document.querySelectorAll(".modal-tab").forEach(btn => btn.classList.remove("active"));
    document.querySelector('.modal-tab[data-tab="content"]').classList.add("active");
    document.getElementById("modalTabContent").style.display = "block";
    document.getElementById("modalTabJson").style.display = "none";

    document.getElementById("detailModal").classList.add("active");
}

function renderModalContent(event) {
    const container = document.getElementById("modalTabContent");
    const grepDataMap = {};
    const readBlocksMap = {};
    let md = "";

    // 头部信息
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

    // Content blocks
    const blocks = event.content_blocks || [];
    if (blocks.length > 0) {
        blocks.forEach((b, i) => {
            const label = blocks.length > 1 ? `**Block ${i+1}** \`${escHtml(b.block_type)}\`\n\n` : "";

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
    if (blocks.length === 0 && event.result_text) {
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
    container.scrollTop = 0;
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
