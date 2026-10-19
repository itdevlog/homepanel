#!/usr/bin/env python3
"""Мини-сервер для тестов агента (router/tests/run-send.sh).

Принимает РОВНО один POST, записывает запрос в журнал и завершается.
Это тестовый инструмент уровня разработки: на роутере python3 нет, но
проверка Task 2 выполняется локально (см. Ruling R1 в ledger).

usage: fake_server.py <port> <ok|error> <log-path>
"""
import json
import sys
import http.server
import socketserver

port = int(sys.argv[1])
mode = sys.argv[2] if len(sys.argv) > 2 else "ok"
log_path = sys.argv[3] if len(sys.argv) > 3 else "/dev/null"


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
        with open(log_path, "w", encoding="utf-8") as fh:
            json.dump(record, fh, ensure_ascii=False)

        if mode == "ok":
            payload = json.dumps({"ok": True, "ts": 1760000300}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
        else:
            payload = b"internal server error"
            self.send_response(500)
            self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass


socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("127.0.0.1", port), Handler) as server:
    # Ждать запрос не дольше 5 с: тест не должен зависать, если агент
    # ничего не отправил (например, режим ещё не реализован).
    server.timeout = 5
    server.handle_request()
