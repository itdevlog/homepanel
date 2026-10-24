"""Логика приложения и HTTP-слой.

`App` держит бизнес-логику (приём снимков, состояние, устройства, события,
статистика) и умеет породить `BaseHTTPRequestHandler`, который лишь
транслирует HTTP в методы `App`. Такое разделение позволяет тестировать
логику без сокетов, а HTTP-слой — тонким.

Спека §5 (приём), §11 (JSON API), §12 (статика).
"""

from __future__ import annotations

import json
import logging
import mimetypes
import os
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler

from .aggregator import day_key
from .config import Config
from .ingest import IngestError, MAC_RE, parse_snapshot
from .presence import PresenceEngine
from .stats import compute_stats, day_bounds, week_key
from .store import DEVICE_FIELDS, KIND_VALUES, TRUST_VALUES, Store

log = logging.getLogger("homepanel.app")

MAX_BODY = 1024 * 1024
# Сколько тела запроса разрешено «слить» перед ответом 413, чтобы клиент
# успел закончить отправку и получил внятный код. Память при этом не растёт.
DRAIN_LIMIT = 32 * 1024 * 1024
# Снимок считается свежим, если получен не позже этого числа секунд назад.
AGENT_STALE_SECONDS = 90

_PRESENCE_DEFAULTS = {
    "state": "away",
    "last_seen": None,
    "since": None,
    "bss": None,
    "band": None,
    "signal": None,
    "ip": None,
    "hostname": None,
}
_DEVICE_DEFAULTS = {
    "name": None,
    "person": None,
    "kind": None,
    "trust": "unknown",
    "hidden": False,
    "notes": None,
}


def _error(reason: str, message: str) -> dict:
    return {"error": {"reason": reason, "message": message}}


def _local_midnight(ts: int) -> int:
    """Epoch-секунды локальной полуночи суток, в которые попадает `ts`."""
    return int(time.mktime(time.strptime(day_key(ts), "%Y-%m-%d")))


def _bounded_int(value, default: int, minimum: int, maximum: int, name: str) -> int:
    if value is None or value == "":
        return default
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise ValueError(f"{name} должен быть целым числом") from None
    return max(minimum, min(maximum, number))


def _runs(minutes: list[int], gap: int = 300) -> list[dict]:
    """Непрерывные интервалы минут: разрыв больше `gap` начинает новый."""
    runs: list[dict] = []
    current: dict | None = None
    for minute in minutes:
        if current is None or minute - current["to"] > gap:
            current = {"from": minute, "to": minute + 60}
            runs.append(current)
        else:
            current["to"] = minute + 60
    return runs


class App:
    def __init__(self, config: Config, store: Store, engine: PresenceEngine, clock=time.time):
        self.config = config
        self.store = store
        self.engine = engine
        self.clock = clock
        self.started_at = int(clock())
        self._last_snapshot_ts: int | None = None
        self._last_client_count = 0

    # -- логика ----------------------------------------------------------

    def handle_ingest(self, payload: bytes, key: str | None, now: int) -> tuple[int, dict]:
        if key != self.config.secret:
            return 401, _error("unauthorized", "Неверный или отсутствующий ключ агента")
        try:
            snap = parse_snapshot(payload)
        except IngestError as exc:
            return 400, _error("bad_request", str(exc))

        result = self.engine.apply_snapshot(snap, now)
        for client in snap.clients:
            if client.signal is not None:
                self.store.add_signal_sample(client.mac, now, client.signal)
        self._last_snapshot_ts = now
        self._last_client_count = len(snap.clients)
        return 200, {
            "ok": True,
            "ts": now,
            "clients": len(snap.clients),
            "arrived": result["arrived"],
        }

    def _device_rows(self) -> list[dict]:
        presence = {p["mac"]: p for p in self.store.all_presence()}
        rows: list[dict] = []
        seen: set[str] = set()
        for device in self.store.get_devices():
            row = {**_DEVICE_DEFAULTS, **device}
            row.update({k: presence.get(device["mac"], {}).get(k, v) for k, v in _PRESENCE_DEFAULTS.items()})
            rows.append(row)
            seen.add(device["mac"])
        for mac, state in presence.items():
            if mac in seen:
                continue
            row = {"mac": mac, **_DEVICE_DEFAULTS, **state}
            rows.append(row)
        rows.sort(key=lambda r: (r["state"] != "home", r["person"] or "", r["mac"]))
        return rows

    def list_devices(self) -> list[dict]:
        return self._device_rows()

    def state(self, now: int) -> dict:
        rows = self._device_rows()

        people: dict[str, dict] = {}
        for row in rows:
            person = row.get("person")
            if not person:
                continue
            entry = people.setdefault(
                person, {"person": person, "home": False, "since": None, "devices": []}
            )
            entry["devices"].append(row)
            if row["state"] == "home" and not row["hidden"]:
                entry["home"] = True
                if row["since"] is not None:
                    entry["since"] = (
                        row["since"] if entry["since"] is None else min(entry["since"], row["since"])
                    )

        people_list = sorted(people.values(), key=lambda p: (not p["home"], p["person"]))
        today_start = _local_midnight(now)
        for entry in people_list:
            macs = [device["mac"] for device in entry["devices"]]
            entry["today_minutes"] = self.store.minutes_union(
                today_start, today_start + 86400, macs
            )

        agent = {
            "last_snapshot_ts": self._last_snapshot_ts,
            "client_count": self._last_client_count,
            "online": (
                self._last_snapshot_ts is not None
                and now - self._last_snapshot_ts <= AGENT_STALE_SECONDS
            ),
        }
        return {"now": now, "agent": agent, "people": people_list, "devices": rows}

    def update_device(self, body: dict, now: int) -> dict:
        mac = body.get("mac")
        if not mac or not isinstance(mac, str):
            raise ValueError("поле mac обязательно")
        mac = mac.lower()
        if not MAC_RE.match(mac):
            raise ValueError("некорректный MAC")
        merge_into = body.get("mergeInto")
        if merge_into:
            if not isinstance(merge_into, str) or not MAC_RE.match(merge_into.lower()):
                raise ValueError("некорректный MAC для объединения")
            if merge_into.lower() == mac:
                raise ValueError("нельзя объединить устройство с самим собой")
            merged = self.store.merge_devices(mac, merge_into)
            return self._row_for(merged["mac"])
        fields = {k: body[k] for k in DEVICE_FIELDS if k in body}
        if "trust" in fields and fields["trust"] not in TRUST_VALUES:
            raise ValueError("недопустимое значение trust")
        if "kind" in fields and fields["kind"] not in KIND_VALUES:
            raise ValueError("недопустимое значение kind")
        if "hidden" in fields:
            value = fields["hidden"]
            if isinstance(value, bool):
                pass
            elif isinstance(value, str) and value.strip().lower() in ("true", "false"):
                fields["hidden"] = value.strip().lower() == "true"
            else:
                raise ValueError("hidden должен быть логическим")
        self.store.upsert_device(mac, **fields)
        return self._row_for(mac)

    def _row_for(self, mac: str) -> dict:
        for row in self._device_rows():
            if row["mac"] == mac:
                return row
        return {"mac": mac, **_DEVICE_DEFAULTS, **_PRESENCE_DEFAULTS}

    def list_events(self, since_id: int | None, limit: int) -> list[dict]:
        return self.store.get_events(since_id=since_id, limit=limit)

    def stats(self, query: dict, now: int) -> list[dict]:
        group = query.get("group") or "day"
        to_day = query.get("to") or day_key(now)
        from_day = query.get("from") or day_key(now - 6 * 86400)

        macs: list[str] | None = None
        if query.get("mac"):
            macs = [query["mac"].lower()]
        elif query.get("person"):
            macs = [d["mac"] for d in self.store.get_devices() if d["person"] == query["person"]]

        return compute_stats(
            self.store, group=group, from_day=from_day, to_day=to_day, macs=macs
        )

    def _person_macs(self, person: str | None) -> list[str] | None:
        if not person:
            return None
        return [d["mac"] for d in self.store.get_devices() if d["person"] == person]

    def analytics(self, query: dict, now: int) -> dict:
        """Данные для страницы «Аналитика»: занятость, события, новые устройства."""
        days = _bounded_int(query.get("days"), 7, 1, 30, "days")
        weeks = _bounded_int(query.get("weeks"), 8, 1, 52, "weeks")
        macs = self._person_macs(query.get("person"))

        today = _local_midnight(now)
        start = today - (days - 1) * 86400
        end = today + 86400

        weeks_start = today - (weeks * 7 - 1) * 86400
        counts: dict[str, int] = {}
        for created_at in self.store.devices_created_between(weeks_start, now):
            key = week_key(day_key(created_at))
            counts[key] = counts.get(key, 0) + 1

        return {
            "now": now,
            "from": start,
            "to": end,
            "days": days,
            "occupancy": self.store.occupancy_by_hour(start, end, macs),
            "events_by_hour": self.store.event_counts_by_hour(start, end, macs),
            "new_devices": [
                {"week": key, "count": counts[key]} for key in sorted(counts)
            ],
        }

    def timeline(self, query: dict, now: int) -> dict:
        """Полоса присутствия за день: интервалы, когда человек был в сети."""
        day = query.get("day") or day_key(now)
        try:
            start, end = day_bounds(day, day)
        except ValueError:
            raise ValueError("day должен быть в формате YYYY-MM-DD") from None

        if query.get("mac"):
            macs = [query["mac"].lower()]
        else:
            macs = self._person_macs(query.get("person"))

        return {
            "day": day,
            "from": start,
            "to": end,
            "intervals": _runs(self.store.minute_timestamps(start, end, macs)),
        }

    def signal(self, query: dict, now: int) -> dict:
        """История сигнала одного устройства (точки раз в 5 минут)."""
        mac = (query.get("mac") or "").lower()
        if not MAC_RE.match(mac):
            raise ValueError("mac обязателен и должен быть корректным")
        hours = _bounded_int(query.get("hours"), 24, 1, 24 * 7, "hours")
        return {
            "mac": mac,
            "from": now - hours * 3600,
            "to": now,
            "points": self.store.signal_series(mac, now - hours * 3600, now),
        }

    def device_hours(self, query: dict, now: int) -> dict:
        """Минуты присутствия по часам для спарклайнов в таблице устройств."""
        hours = _bounded_int(query.get("hours"), 24, 1, 72, "hours")
        end = now - now % 3600 + 3600
        start = end - hours * 3600
        series: dict[str, list[int]] = {}
        for row in self.store.device_hour_matrix(start, end):
            index = (row["hour_ts"] - start) // 3600
            if 0 <= index < hours:
                series.setdefault(row["mac"], [0] * hours)[index] = row["minutes"]
        return {"from": start, "to": end, "hours": hours, "series": series}

    # -- HTTP ------------------------------------------------------------

    def make_handler(self) -> type[BaseHTTPRequestHandler]:
        app = self

        class Handler(BaseHTTPRequestHandler):
            server_version = "homepanel/1.0"
            # Верхняя граница ожидания запроса: без неё «молчащий» клиент
            # держит поток бесконечно (ревью I4).
            timeout = 30

            def log_message(self, fmt, *args):  # noqa: A003 - сигнатура базового класса
                log.debug("%s - %s", self.address_string(), fmt % args)

            def do_GET(self):  # noqa: N802
                app._handle(self, "GET")

            def do_POST(self):  # noqa: N802
                app._handle(self, "POST")

            def _send_json(self, code: int, payload: dict):
                data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
                self.send_response(code)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _read_body(self) -> tuple[int | None, bytes | None]:
                """Возвращает (код_ошибки, тело). При ошибке тело None."""
                # uclient-fetch/busybox wget отправляют --post-file как
                # Transfer-Encoding: chunked, без Content-Length (RFC 9112 §7.1).
                # Поддерживаем оба способа, иначе агент получает 400 на пустом
                # теле, хотя ключ и путь верны.
                if "chunked" in (self.headers.get("Transfer-Encoding") or "").lower():
                    return self._read_chunked()

                raw = self.headers.get("Content-Length")
                if raw is None:
                    return None, b""
                try:
                    length = int(raw)
                except ValueError:
                    return 400, None
                if length > MAX_BODY:
                    self._drain(length)
                    self.close_connection = True
                    return 413, None
                return None, self.rfile.read(length)

            def _read_chunked(self) -> tuple[int | None, bytes | None]:
                chunks: list[bytes] = []
                total = 0
                while True:
                    line = self.rfile.readline(65536)
                    if not line:
                        self.close_connection = True
                        return 400, None
                    try:
                        size = int(line.split(b";", 1)[0].strip(), 16)
                    except ValueError:
                        self.close_connection = True
                        return 400, None
                    if size < 0:
                        self.close_connection = True
                        return 400, None
                    if size == 0:
                        # Завершающие трейлеры отделяются пустой строкой.
                        while True:
                            trailer = self.rfile.readline(65536)
                            if trailer in (b"\r\n", b"\n", b""):
                                break
                        return None, b"".join(chunks)
                    total += size
                    if total > MAX_BODY:
                        self.close_connection = True
                        return 413, None
                    chunk = self.rfile.read(size)
                    if len(chunk) != size:
                        self.close_connection = True
                        return 400, None
                    chunks.append(chunk)
                    self.rfile.read(2)  # CRLF после данных чанка

            def _drain(self, length: int) -> None:
                remaining = min(length, DRAIN_LIMIT)
                while remaining > 0:
                    chunk = self.rfile.read(min(65536, remaining))
                    if not chunk:
                        break
                    remaining -= len(chunk)

        return Handler

    def _handle(self, handler: BaseHTTPRequestHandler, method: str) -> None:
        parsed = urllib.parse.urlsplit(handler.path)
        path = urllib.parse.unquote(parsed.path)
        try:
            if path == "/api/ingest":
                return self._handle_ingest(handler, method)
            if path.startswith("/api/"):
                return self._handle_api(handler, method, path, parsed.query)
            return self._serve_static(handler, path)
        except Exception:  # pragma: no cover - страховка от падения сервера
            log.exception("необработанная ошибка при обработке %s %s", method, path)
            handler._send_json(500, _error("internal", "Внутренняя ошибка сервера"))

    def _handle_ingest(self, handler: BaseHTTPRequestHandler, method: str) -> None:
        if method != "POST":
            return handler._send_json(405, _error("method_not_allowed", "Ожидается POST"))
        # Ключ проверяем до чтения тела: незачем принимать десятки мегабайт от
        # неавторизованного клиента (ревью I4).
        if handler.headers.get("X-Homepanel-Key") != self.config.secret:
            handler.close_connection = True
            return handler._send_json(
                401, _error("unauthorized", "Неверный или отсутствующий ключ агента")
            )
        code, payload = handler._read_body()
        if code == 413:
            return handler._send_json(413, _error("payload_too_large", "Тело запроса слишком велико"))
        if code == 400:
            return handler._send_json(400, _error("bad_request", "Некорректный Content-Length"))
        status, body = self.handle_ingest(
            payload, handler.headers.get("X-Homepanel-Key"), int(self.clock())
        )
        handler._send_json(status, body)

    def _handle_api(self, handler, method: str, path: str, query: str) -> None:
        params = dict(urllib.parse.parse_qsl(query))
        now = int(self.clock())

        if path == "/api/state" and method == "GET":
            return handler._send_json(200, self.state(now))

        if path == "/api/devices":
            if method == "GET":
                return handler._send_json(200, self.list_devices())
            code, payload = handler._read_body()
            if code is not None:
                return handler._send_json(
                    413 if code == 413 else 400,
                    _error("payload_too_large" if code == 413 else "bad_request", "Неверное тело запроса"),
                )
            try:
                body = json.loads(payload or b"{}")
            except (ValueError, UnicodeDecodeError):
                return handler._send_json(400, _error("bad_request", "Тело не является JSON"))
            if not isinstance(body, dict):
                return handler._send_json(400, _error("bad_request", "Ожидается объект JSON"))
            try:
                return handler._send_json(200, self.update_device(body, now))
            except ValueError as exc:
                return handler._send_json(400, _error("bad_request", str(exc)))

        if path == "/api/events" and method == "GET":
            since = params.get("since")
            try:
                since_id = int(since) if since else None
            except ValueError:
                return handler._send_json(400, _error("bad_request", "since должен быть числом"))
            try:
                limit = int(params.get("limit", 200))
            except ValueError:
                return handler._send_json(400, _error("bad_request", "limit должен быть числом"))
            return handler._send_json(200, self.list_events(since_id, limit))

        if path == "/api/stats" and method == "GET":
            try:
                return handler._send_json(200, self.stats(params, now))
            except ValueError as exc:
                return handler._send_json(400, _error("bad_request", str(exc)))

        for route, handler_method in (
            ("/api/analytics", self.analytics),
            ("/api/timeline", self.timeline),
            ("/api/signal", self.signal),
            ("/api/device_hours", self.device_hours),
        ):
            if path == route and method == "GET":
                try:
                    return handler._send_json(200, handler_method(params, now))
                except ValueError as exc:
                    return handler._send_json(400, _error("bad_request", str(exc)))

        return handler._send_json(404, _error("not_found", "Неизвестный метод API"))

    def _serve_static(self, handler: BaseHTTPRequestHandler, path: str) -> None:
        static_dir = os.path.normpath(os.path.abspath(self.config.static_dir))
        if path in ("", "/"):
            path = "/index.html"
        full = os.path.normpath(os.path.join(static_dir, path.lstrip("/")))
        if full != static_dir and not full.startswith(static_dir + os.sep):
            return handler._send_json(404, _error("not_found", "Файл не найден"))
        if not os.path.isfile(full):
            return handler._send_json(404, _error("not_found", "Файл не найден"))

        with open(full, "rb") as fh:
            data = fh.read()
        content_type, _ = mimetypes.guess_type(full)
        handler.send_response(200)
        handler.send_header("Content-Type", content_type or "application/octet-stream")
        handler.send_header("Content-Length", str(len(data)))
        handler.end_headers()
        handler.wfile.write(data)
