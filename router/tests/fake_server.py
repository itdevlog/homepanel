#!/usr/bin/env python3
"""Мини-сервер для тестов агента (router/tests/run-send.sh).

Принимает заданное число POST-запросов, дописывает журнал (JSON Lines) и
завершается. Это тестовый инструмент уровня разработки: на роутере python3
нет, но проверка Task 2 выполняется локально (см. Ruling R1 в ledger).

usage: fake_server.py <port> <ok|jsonfail|junk|error> <log-path> [count]
"""
import json
import sys
import http.server
import socketserver

port = int(sys.argv[1])
mode = sys.argv[2] if len(sys.argv) > 2 else "ok"
log_path = sys.argv[3] if len(sys.argv) > 3 else "/dev/null"
count = int(sys.argv[4]) if len(sys.argv) > 4 else 1

MODES = {
    "ok": (200, "application/json", b'{"ok": true, "ts": 1760000300}'),
    "control": (
        200,
        "application/json",
        b'{"ok": true, "ts": 1760000300, '
        b'"control": {"paused": ["11:22:33:44:55:66"]}, '
        b'"commands": [{"id": 7, "type": "kick", "mac": "11:22:33:44:55:66"}]}',
    ),
    "jsonfail": (200, "application/json", b'{"ok": false}'),
    "junk": (200, "text/plain", b"not json at all"),
    "error": (500, "text/plain", b"internal server error"),
}


class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length)
        record = {
            "method": self.command,
            "path": self.path,
            "headers": {k.lower(): v for k, v in self.headers.items()},
            "body": body.decode("utf-8", "replace"),
        }
        with open(log_path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")

        status, ctype, payload = MODES.get(mode, MODES["ok"])
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass


socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("127.0.0.1", port), Handler) as server:
    # Ждать запросы не дольше 5 с каждый: тест не должен зависать, если агент
    # ничего не отправил (например, режим ещё не реализован).
    server.timeout = 5
    for _ in range(count):
        server.handle_request()
