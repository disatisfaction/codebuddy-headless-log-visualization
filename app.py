"""
CodeBuddy Headless 日志可视化服务
解析无头模式流式输出 JSONL 日志并提供可视化 Dashboard。
"""

import json
import os
import re
import glob
from datetime import datetime
from collections import defaultdict, Counter
from pathlib import Path

from flask import Flask, jsonify, render_template, request

app = Flask(__name__)

LOG_DIR = os.environ.get("LOG_DIR", os.path.join(os.path.dirname(__file__), "logs"))


# =============================================================================
# 真实 CodeBuddy JSONL 格式解析器
# =============================================================================

def _read_file_auto_enc(filepath: str) -> list[str]:
    """尝试多种编码读取文件，返回各行"""
    encodings = ["utf-8-sig", "utf-8", "utf-16", "utf-16-le", "utf-16-be", "gbk", "gb2312", "latin-1"]
    for enc in encodings:
        try:
            with open(filepath, "r", encoding=enc, errors="strict") as f:
                return f.read().splitlines()
        except (UnicodeDecodeError, UnicodeError):
            continue
    # 最终兜底：替换无法解码的字符
    with open(filepath, "r", encoding="utf-8", errors="replace") as f:
        return f.read().splitlines()


def parse_jsonl(filepath: str) -> list[dict]:
    """解析 JSONL 文件，每行一个 JSON 事件"""
    events = []
    if not os.path.exists(filepath):
        return events
    lines = _read_file_auto_enc(filepath)
    for line_no, line in enumerate(lines, 1):
        line = line.strip()
        if not line:
            continue
        try:
            data = json.loads(line)
            data["_line"] = line_no
            events.append(data)
        except json.JSONDecodeError:
            events.append({
                "_line": line_no,
                "_parse_error": True,
                "_raw": line[:300],
                "type": "parse_error",
                "__timestamp": datetime.now().isoformat(),
            })
    return events


def normalize_event(raw: dict) -> dict:
    """将原始事件标准化，展开 assistant 的 content blocks"""
    etype = raw.get("type", "unknown")
    subtype = raw.get("subtype", "")
    ts = raw.get("__timestamp", "")
    line_no = raw.get("_line", 0)

    base = {
        "_line": line_no,
        "type": etype,
        "subtype": subtype,
        "timestamp": ts,
        "session_id": raw.get("session_id", ""),
        "uuid": raw.get("uuid", ""),
        "parent_tool_use_id": raw.get("parent_tool_use_id"),
    }

    if etype == "system":
        if subtype == "init":
            base["model"] = raw.get("model", "")
            base["cwd"] = raw.get("cwd", "")
            base["tools_count"] = len(raw.get("tools", []))
            base["tools"] = raw.get("tools", [])
            base["slash_commands"] = raw.get("slash_commands", [])
            base["output_style"] = raw.get("output_style", "")
        base["summary"] = f"[system/{subtype}]"

    elif etype == "file-history-snapshot":
        backups = raw.get("snapshot", {}).get("trackedFileBackups", {})
        files = list(backups.keys())
        base["files"] = files
        base["summary"] = f"[file-snapshot] {len(files)} files tracked"

    elif etype == "ai-title":
        base["title"] = raw.get("aiTitle", "")
        base["summary"] = f"[title] {base['title']}"

    elif etype == "assistant":
        msg = raw.get("message", {})
        content_blocks = msg.get("content", [])
        usage = msg.get("usage", {})
        base["model"] = msg.get("model", "")
        base["stop_reason"] = msg.get("stop_reason", "")
        base["message_id"] = msg.get("id", "")
        base["usage"] = {
            "input_tokens": usage.get("input_tokens", 0) or 0,
            "output_tokens": usage.get("output_tokens", 0) or 0,
            "cache_read": usage.get("cache_read_input_tokens", 0) or 0,
            "cache_creation": usage.get("cache_creation_input_tokens", 0) or 0,
        }
        # 展开 content blocks（同时保留完整文本）
        blocks = []
        for block in content_blocks:
            bi = {
                "block_type": block.get("type", "?"),
                "tool_name": "",
                "tool_id": "",
                "text_preview": "",
                "text_full": "",          # 完整文本（用于详情弹窗渲染）
                "thinking_preview": "",
                "thinking_full": "",       # 完整思考文本
                "tool_input_full": "",     # 完整工具输入
                "has_text": False,
                "has_thinking": False,
                "has_tool": False,
            }
            if block.get("type") == "thinking":
                full_thinking = block.get("thinking", "")
                bi["thinking_preview"] = full_thinking[:200]
                bi["thinking_full"] = full_thinking
                bi["has_thinking"] = True
            elif block.get("type") == "text":
                full_text = block.get("text", "")
                bi["text_preview"] = full_text[:300]
                bi["text_full"] = full_text
                bi["has_text"] = True
            elif block.get("type") == "tool_use":
                tool_input = block.get("input", {})
                tool_name = block.get("name", "")
                bi["tool_name"] = tool_name
                bi["tool_id"] = block.get("id", "")
                bi["text_preview"] = json.dumps(tool_input, ensure_ascii=False)[:300]
                bi["tool_input_full"] = json.dumps(tool_input, ensure_ascii=False)
                bi["has_tool"] = True
                # 提取 file_path
                if "file_path" in tool_input or "filePath" in tool_input:
                    bi["tool_file_path"] = tool_input.get("file_path") or tool_input.get("filePath")
                # Write/WriteFile：单个 content
                if tool_name in ("Write", "WriteFile") and "content" in tool_input:
                    bi["tool_content"] = tool_input["content"]
                # Edit：old_string + new_string 成对出现
                if tool_name == "Edit" and "old_string" in tool_input:
                    bi["tool_edits"] = [{
                        "old_string": tool_input.get("old_string", ""),
                        "new_string": tool_input.get("new_string", ""),
                    }]
                # MultiEdit：edits[] 数组，每个元素包含 old_string/new_string
                if tool_name == "MultiEdit" and "edits" in tool_input:
                    bi["tool_edits"] = [
                        {"old_string": e.get("old_string", ""), "new_string": e.get("new_string", "")}
                        for e in tool_input.get("edits", [])
                    ]
                if tool_name == "Read":
                    # Read 输入只显示路径，没有 content
                    bi["tool_content"] = ""
                if tool_name == "Bash" and "command" in tool_input:
                    bi["tool_command"] = tool_input["command"]
                    bi["tool_description"] = tool_input.get("description", "")
                if tool_name == "DeferExecuteTool":
                    bi["defer_tool_name"] = tool_input.get("toolName", "")
            blocks.append(bi)
        base["content_blocks"] = blocks
        base["block_count"] = len(blocks)
        # 生成摘要
        parts = []
        for b in blocks:
            if b["has_thinking"]:
                parts.append("[思考]")
            elif b["has_text"]:
                parts.append(f"[文本] {b['text_preview'][:60]}")
            elif b["has_tool"]:
                tool_part = f"[工具] {b['tool_name']}"
                if b.get("tool_file_path"):
                    tool_part += f" @ {b['tool_file_path']}"
                parts.append(tool_part)
        base["summary"] = " | ".join(parts) if parts else "[assistant]"

    elif etype == "user":
        # user 类型是 tool result
        msg = raw.get("message", {})
        content_blocks = msg.get("content", [])
        tool_use_id = raw.get("parent_tool_use_id", "")
        blocks = []
        for block in content_blocks:
            bi = {
                "block_type": block.get("type", "?"),
                "tool_use_id": block.get("tool_use_id") or tool_use_id,
                "is_error": block.get("is_error", False),
                "text_preview": "",
                "text_full": "",          # 完整工具结果文本（保留原始行号）
                "text_clean": "",         # 清洗后的文本（去掉行号前缀）
                "text_numbered": "",      # 格式化行号版本 (如 "  1│ code")
            }
            if block.get("type") == "tool_result":
                inner_content = block.get("content", [])
                texts = []
                for ic in inner_content:
                    if isinstance(ic, dict) and ic.get("type") == "text":
                        texts.append(ic.get("text", "")[:200])
                bi["text_preview"] = " | ".join(texts)[:300]
                # 拼接完整文本 + 清洗版本 + 格式化行号版本
                full_texts = []
                clean_texts = []
                numbered_texts = []
                all_read_lines = []
                for ic in inner_content:
                    if isinstance(ic, dict) and ic.get("type") == "text":
                        t = ic.get("text", "")
                        full_texts.append(t)
                        # 去掉 " 行号→" 样式前缀 (如 "   1→")
                        cleaned = re.sub(r'^\s*\d+→', '', t, flags=re.MULTILINE)
                        clean_texts.append(cleaned)
                        # 保留行号但转换为更清晰的格式 "   1│ code"
                        numbered = re.sub(r'^(\s*)(\d+)→', r'\1\2│', t, flags=re.MULTILINE)
                        numbered_texts.append(numbered)
                        # 提取 → 前的真实行号 (供 Read 结果前端渲染使用)
                        for rl in t.split("\n"):
                            rm = re.match(r'^\s*(\d+)→(.*)$', rl)
                            if rm:
                                all_read_lines.append({"line_num": int(rm.group(1)), "content": rm.group(2)})
                bi["text_full"] = "\n".join(full_texts)
                bi["text_clean"] = "\n".join(clean_texts)
                bi["text_numbered"] = "\n".join(numbered_texts)
                bi["read_lines"] = all_read_lines
            blocks.append(bi)
        base["content_blocks"] = blocks
        base["block_count"] = len(blocks)
        status = "error" if any(b.get("is_error") for b in blocks) else "ok"
        base["tool_status"] = status
        previews = [b["text_preview"][:80] for b in blocks if b["text_preview"]]
        base["summary"] = f"[tool_result/{status}] {'; '.join(previews)}" if previews else f"[tool_result/{status}]"

    elif etype == "result":
        base["is_error"] = raw.get("is_error", False)
        base["duration_ms"] = raw.get("duration_ms", 0)
        base["duration_api_ms"] = raw.get("duration_api_ms", 0)
        base["num_turns"] = raw.get("num_turns", 0)
        base["total_cost_usd"] = raw.get("total_cost_usd", 0)
        usage = raw.get("usage", {})
        base["usage"] = {
            "input_tokens": usage.get("input_tokens", 0) or 0,
            "output_tokens": usage.get("output_tokens", 0) or 0,
            "cache_read": usage.get("cache_read_input_tokens", 0) or 0,
            "cache_creation": usage.get("cache_creation_input_tokens", 0) or 0,
        }
        base["result_text"] = raw.get("result", "")[:500]
        seconds = base["duration_ms"] / 1000
        cost = base["total_cost_usd"]
        base["summary"] = f"[完成] {seconds:.1f}s, {base['num_turns']} turns, ${cost:.4f}"

    else:
        base["summary"] = f"[{etype}]"

    return base


def _parse_grep_content(text: str) -> list:
    """解析 Grep output_mode=content 结果，按文件分组并按连续行号聚合。
    输入格式：每行 {文件名}-{行号}-{行内容}
    返回：[{file, start_line, end_line, lines: [str, ...]}, ...]

    从行首用非贪婪匹配第一个 -数字- 作为行号分隔符，
    确保行内容中的 "-数字-" 不被误识别为行号。
    代价：文件名含 "-数字-" 模式（如 src-v2/utils.py）会被截断。
    """
    if not text:
        return []
    entries = []
    for line in text.split("\n"):
        line = line.strip()
        if not line:
            continue
        m = re.match(r"^(.+?)-(\d+)-(.+)$", line)
        if m:
            entries.append({"file": m.group(1), "line_num": int(m.group(2)), "content": m.group(3)})
    if not entries:
        return []

    # 按文件分组并聚合连续行号
    file_groups = {}
    for e in entries:
        file_groups.setdefault(e["file"], []).append(e)
    result = []
    for file, group in file_groups.items():
        group.sort(key=lambda x: x["line_num"])
        block = None
        for e in group:
            if block is None:
                block = {"file": file, "start_line": e["line_num"],
                         "end_line": e["line_num"], "lines": [e["content"]]}
            elif e["line_num"] == block["end_line"] + 1:
                block["end_line"] = e["line_num"]
                block["lines"].append(e["content"])
            else:
                result.append(block)
                block = {"file": file, "start_line": e["line_num"],
                         "end_line": e["line_num"], "lines": [e["content"]]}
        if block:
            result.append(block)
    return result


def analyze_logs(filepath: str) -> dict:
    """全面分析日志文件"""
    raw_events = parse_jsonl(filepath)
    if not raw_events:
        return {"total_events": 0, "error": "No valid events found"}

    # 排除解析失败的行，不参与任何统计
    valid_raw = [e for e in raw_events if not e.get("_parse_error")]
    parse_errors = len(raw_events) - len(valid_raw)

    events = [normalize_event(e) for e in valid_raw]

    # --- 为 tool_result 关联父工具名 + 文件路径 ---
    tool_id_to_info = {}
    for e in events:
        for block in e.get("content_blocks", []):
            if block.get("tool_id") and block.get("tool_name"):
                tool_id_to_info[block["tool_id"]] = {
                    "name": block["tool_name"],
                    "file_path": block.get("tool_file_path", ""),
                }
    for e in events:
        if e["type"] == "user":
            for block in e.get("content_blocks", []):
                tid = block.get("tool_use_id", "")
                if tid in tool_id_to_info:
                    info = tool_id_to_info[tid]
                    block["parent_tool_name"] = info["name"]
                    if info["file_path"]:
                        block["parent_tool_file_path"] = info["file_path"]
            # 对于文件操作类工具结果，摘要前缀文件路径
            fp = e.get("content_blocks", [{}])[0].get("parent_tool_file_path", "")
            if fp:
                old = e.get("summary", "")
                prefix = f"[tool_result/{e.get('tool_status', 'ok')}]"
                rest = old[len(prefix):].lstrip() if old.startswith(prefix) else ""
                e["summary"] = f"{prefix} @ {fp}" + (f" | {rest}" if rest else "")

    # --- 为 Grep content 模式结果解析结构化数据 ---
    for e in events:
        if e["type"] == "user":
            for block in e.get("content_blocks", []):
                if block.get("parent_tool_name") == "Grep" and block.get("block_type") == "tool_result":
                    parsed = _parse_grep_content(block.get("text_full", ""))
                    if parsed:
                        block["grep_blocks"] = parsed

    # --- 基础统计 ---
    type_counts = Counter(e["type"] for e in events)

    # --- 工具调用统计 ---
    tool_usage = Counter()
    tool_results = Counter()
    for e in events:
        for block in e.get("content_blocks", []):
            if block.get("has_tool") and block.get("tool_name"):
                tool_usage[block["tool_name"]] += 1
        if e["type"] == "user" and e.get("tool_status"):
            tool_results[e["tool_status"]] += 1

    # --- Token 用量 ---
    total_usage = {"input_tokens": 0, "output_tokens": 0, "cache_read": 0, "cache_creation": 0}
    for e in events:
        usage = e.get("usage", {})
        if usage:
            for k in total_usage:
                total_usage[k] += usage.get(k, 0) or 0

    # --- Session 信息 ---
    session_id = ""
    model = ""
    cwd = ""
    ai_title = ""
    session_count = 0      # system/init 次数 — 作为"对话轮次"
    internal_turns = 0      # CodeBuddy 内部对话轮次
    duration_ms = 0
    total_cost = 0
    result_text = ""
    tools_count = 0

    for e in events:
        if e["type"] == "system" and e["subtype"] == "init":
            session_count += 1
            session_id = e.get("session_id", "")
            model = e.get("model", "")
            cwd = e.get("cwd", "")
            tools_count = e.get("tools_count", 0)
        if e["type"] == "ai-title":
            ai_title = e.get("title", "")
        if e["type"] == "result":
            internal_turns = e.get("num_turns", 0)
            duration_ms += e.get("duration_ms", 0) or 0
            total_cost += e.get("total_cost_usd", 0) or 0
            result_text = e.get("result_text", "")

    # --- 对话时间线 ---
    timeline = []
    for e in events:
        item = {
            "line": e["_line"],
            "type": e["type"],
            "subtype": e.get("subtype", ""),
            "timestamp": e.get("timestamp", ""),
            "summary": e.get("summary", ""),
            "block_count": e.get("block_count", 0),
            "tool_status": e.get("tool_status", ""),
            "stop_reason": e.get("stop_reason", ""),
            "is_error": e.get("is_error", False),
            "usage": e.get("usage"),
            "content_blocks": e.get("content_blocks", []),
            "result_text": e.get("result_text", ""),
        }
        timeline.append(item)

    # --- 时间范围 ---
    timestamps = [e.get("timestamp") for e in events if e.get("timestamp")]

    result = {
        "filepath": filepath,
        "total_events": len(valid_raw),
        "parse_errors": parse_errors,
        "type_distribution": dict(type_counts.most_common()),
        "tool_usage": dict(tool_usage.most_common()),
        "tool_results": tool_results,
        "total_usage": total_usage,
        "total_tokens": total_usage["input_tokens"] + total_usage["output_tokens"],
        "session_id": session_id,
        "model": model,
        "cwd": cwd,
        "ai_title": ai_title,
        "session_count": session_count,
        "internal_turns": internal_turns,
        "duration_ms": duration_ms,
        "duration_sec": round(duration_ms / 1000, 1),
        "total_cost_usd": total_cost,
        "result_text": result_text,
        "tools_count": tools_count,
        "time_range": {
            "start": min(timestamps) if timestamps else None,
            "end": max(timestamps) if timestamps else None,
        },
        "timeline": timeline,
        "events": events,
    }
    return result


# =============================================================================
# API
# =============================================================================

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/files")
def list_files():
    files = []
    # 扫描 LOG_DIR 和项目根目录
    scan_dirs = [LOG_DIR, os.path.dirname(__file__)]
    seen = set()
    for scan_dir in scan_dirs:
        if not os.path.isdir(scan_dir):
            continue
        for ext in ("*.jsonl", "*.log"):
            for f in sorted(glob.glob(os.path.join(scan_dir, ext)), key=os.path.getmtime, reverse=True):
                if f in seen:
                    continue
                seen.add(f)
                stat = os.stat(f)
                files.append({
                    "name": os.path.basename(f),
                    "path": f,
                    "size": stat.st_size,
                    "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(),
                })
    return jsonify({"files": files})


@app.route("/api/scan")
def scan_dir():
    """扫描任意目录下的 .jsonl / .log 文件"""
    target = request.args.get("dir", "").strip()
    if not target:
        return jsonify({"error": "No directory specified"}), 400
    if not os.path.isdir(target):
        return jsonify({"error": f"Not a valid directory: {target}"}), 404

    files = []
    for ext in ("*.jsonl", "*.log"):
        for f in sorted(glob.glob(os.path.join(target, ext)), key=os.path.getmtime, reverse=True):
            stat = os.stat(f)
            files.append({
                "name": os.path.basename(f),
                "path": f,
                "size": stat.st_size,
                "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(),
            })
    return jsonify({"dir": target, "files": files, "count": len(files)})


@app.route("/api/browse")
def browse_dir():
    """浏览目录结构，返回子目录列表"""
    path = request.args.get("path", "").strip()
    if not path:
        # 根目录：Windows 列驱动器号，Linux/Mac 列 /
        if os.name == "nt":
            roots = _get_windows_drives()
            return jsonify({"path": "", "parent": None, "entries": roots, "is_root": True})
        else:
            path = "/"

    path = os.path.normpath(path)
    if not os.path.isdir(path):
        return jsonify({"error": f"Not a directory: {path}"}), 404

    parent = os.path.dirname(path)
    # 根边界
    if os.name == "nt":
        if path.endswith(":\\"):
            parent = None  # 盘符根
        elif path == parent:
            parent = None
    else:
        if path == "/":
            parent = None

    entries = []
    try:
        for name in sorted(os.listdir(path), key=str.lower):
            full = os.path.join(path, name)
            if os.path.isdir(full) and not name.startswith("."):
                entries.append({"name": name, "type": "dir", "path": full})
    except PermissionError:
        return jsonify({"error": f"Permission denied: {path}"}), 403

    return jsonify({
        "path": path,
        "parent": parent,
        "entries": entries,
        "is_root": False,
    })


def _get_windows_drives():
    """返回 Windows 可用驱动器列表"""
    import string
    drives = []
    for letter in string.ascii_uppercase:
        d = f"{letter}:\\"
        if os.path.exists(d):
            drives.append({"name": f"{letter}:", "type": "drive", "path": d})
    return drives


@app.route("/api/upload", methods=["POST"])
def upload_files():
    """接收浏览器文件夹选择控件上传的日志文件"""
    uploaded = []
    temp_dir = os.path.join(LOG_DIR, "_uploaded")
    os.makedirs(temp_dir, exist_ok=True)

    for key in request.files:
        f = request.files[key]
        # 只处理 .log / .jsonl
        if not (f.filename.endswith(".log") or f.filename.endswith(".jsonl")):
            continue
        # 保留相对子目录结构
        rel = f.filename.replace("\\", "/")
        save_path = os.path.join(temp_dir, rel)
        os.makedirs(os.path.dirname(save_path), exist_ok=True)
        f.save(save_path)
        uploaded.append({
            "name": os.path.basename(rel),
            "path": save_path,
            "size": os.path.getsize(save_path),
        })

    if not uploaded:
        return jsonify({"error": "所选文件夹中没有 .log 或 .jsonl 文件"}), 400
    return jsonify({"files": uploaded, "count": len(uploaded)})


@app.route("/api/analyze")
def analyze_file():
    filepath = request.args.get("file", "")
    if not filepath or not os.path.isfile(filepath):
        return jsonify({"error": "File not found"}), 404
    return jsonify(analyze_logs(filepath))


@app.route("/api/raw")
def raw_events():
    filepath = request.args.get("file", "")
    if not filepath or not os.path.isfile(filepath):
        return jsonify({"error": "File not found"}), 404

    raw = parse_jsonl(filepath)
    return jsonify({
        "total": len(raw),
        "events": raw,
    })


if __name__ == "__main__":
    os.makedirs(LOG_DIR, exist_ok=True)
    print(f"[*] 日志目录: {LOG_DIR}")
    print(f"[*] Dashboard: http://0.0.0.0:5000")
    app.run(host="0.0.0.0", port=5000, debug=True)
