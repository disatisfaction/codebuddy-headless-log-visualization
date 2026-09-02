"""
CodeBuddy Headless 日志可视化 —— 桌面客户端启动方式
使用 pywebview 将 Web 界面包装为原生桌面窗口。

启动:
    python webview_client.py

依赖:
    pip install flask pywebview

说明:
    - 后台线程以 WSGI 方式启动 Flask 服务（仅监听 127.0.0.1），窗口指向本地地址
    - 若端口 5678 被占用，会自动向后寻找空闲端口
    - 窗口关闭时服务线程随进程退出
"""

import os
import socket
import sys
import threading
import time

# 让 app.py 可被导入（支持从任意工作目录启动）
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    import webview
except ImportError:
    print("[!] 未安装 pywebview，请先运行: pip install pywebview")
    sys.exit(1)

from app import LOG_DIR, app as flask_app  # noqa: E402


def _find_free_port(start: int = 5678) -> int:
    """从 start 起寻找空闲端口"""
    for port in range(start, start + 100):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    return start


def _run_flask(port: int) -> None:
    flask_app.run(host="127.0.0.1", port=port, debug=False, use_reloader=False)


def main() -> None:
    os.makedirs(LOG_DIR, exist_ok=True)
    port = _find_free_port()
    url = f"http://127.0.0.1:{port}"
    print(f"[*] 日志目录: {LOG_DIR}")
    print(f"[*] 本地服务: {url}")

    # 后台线程启动 Flask 服务
    threading.Thread(target=_run_flask, args=(port,), daemon=True).start()

    # 等待服务就绪
    for _ in range(50):
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                break
        except OSError:
            time.sleep(0.1)

    # 创建原生桌面窗口
    window = webview.create_window(
        "CodeBuddy 日志可视化",
        url,
        width=1440,
        height=900,
        min_size=(1024, 700),
        background_color="#1e1e2e",
    )
    webview.start()
    print("[*] 客户端已退出")


if __name__ == "__main__":
    main()
