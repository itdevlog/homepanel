"""Логика приложения и HTTP-слой.

`App` держит бизнес-логику (приём снимков, состояние, устройства, события,
статистика) и умеет породить `BaseHTTPRequestHandler`, который лишь
транслирует HTTP в методы `App`. Такое разделение позволяет тестировать
логику без сокетов, а HTTP-слой — тонким.

Спека §5 (приём), §11 (JSON API), §12 (статика).
"""

from __future__ import annotations

import fnmatch
import json
import logging
import mimetypes
import os
import time
import urllib.parse
from datetime import datetime, timedelta
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


def _rule_matches(rule: dict, mac: str, hostname: str | None, ip: str | None) -> bool:
    """Совпадает ли правило разметки с клиентом (hostname/IP/MAC)."""
    pattern = str(rule.get("pattern") or "").strip().lower()
    if not pattern:
        return False
    values = []
    for value in (hostname, ip, mac):
        text = str(value or "").strip().lower()
        if text and text != "*":
            values.append(text)
    if not values:
        return False
    if any(ch in pattern for ch in "*?[]"):
        return any(fnmatch.fnmatchcase(value, pattern) for value in values)
    return any(pattern in value for value in values)


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
        self._apply_rules(snap, now)
        self._last_snapshot_ts = now
        self.store.mark_agent_seen(now)
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

        forecast = self._forecast(now)
        for entry in people_list:
            macs = [device["mac"] for device in entry["devices"]]
            entry["sessions"] = self._sessions(macs, today_start, now + 60, now)
            minutes = forecast.get(entry["person"])
            if minutes is not None:
                entry["forecast_minutes"] = minutes

        agent = {
            "last_snapshot_ts": self._last_snapshot_ts,
            "client_count": self._last_client_count,
            "online": (
                self._last_snapshot_ts is not None
                and now - self._last_snapshot_ts <= AGENT_STALE_SECONDS
            ),
        }
        return {"now": now, "agent": agent, "people": people_list, "devices": rows}

    def _sessions(self, macs, from_ts: int, to_ts: int, now: int, limit: int = 4) -> list[dict]:
        """Недавние интервалы присутствия человека за период."""
        runs = _runs(self.store.minute_timestamps(from_ts, to_ts, macs))
        return [
            {"from": run["from"], "to": min(run["to"], now)}
            for run in runs[-limit:]
        ]

    def _forecast(self, now: int) -> dict[str, int]:
        """Медиана времени прихода по текущему дню недели за 4 недели."""
        day = int(now // 86400)
        if getattr(self, "_forecast_day", None) == day:
            return getattr(self, "_forecast_map", {}) or {}
        since = _local_midnight(now) - 28 * 86400
        person_by_mac = {
            row["mac"]: row.get("person") for row in self.store.get_devices()
        }
        weekday = time.localtime(now).tm_wday
        samples: dict[str, list[int]] = {}
        for event in self.store.events_between(since, now + 1):
            if event.get("type") != "arrived":
                continue
            person = person_by_mac.get(event.get("mac"))
            if not person:
                continue
            local = time.localtime(int(event["ts"]))
            if local.tm_wday != weekday:
                continue
            samples.setdefault(person, []).append(local.tm_hour * 60 + local.tm_min)
        result: dict[str, int] = {}
        for person, values in samples.items():
            if len(values) < 2:
                continue
            values.sort()
            result[person] = values[len(values) // 2]
        self._forecast_day = day
        self._forecast_map = result
        return result

    def widget_svg(self, now: int) -> str:
        rows = self._device_rows()
        home_people = {
            row.get("person")
            for row in rows
            if row.get("state") == "home" and row.get("person") and not row.get("hidden")
        }
        home_devices = [row for row in rows if row.get("state") == "home" and not row.get("hidden")]
        return (
            '<svg xmlns="http://www.w3.org/2000/svg" width="280" height="72" viewBox="0 0 280 72">'
            '<rect width="280" height="72" rx="12" fill="#12151c"/>'
            '<text x="16" y="27" fill="#8b95a8" font-family="system-ui,sans-serif" font-size="13">Дома</text>'
            '<text x="16" y="56" fill="#4fd1c5" font-family="system-ui,sans-serif" '
            'font-size="24" font-weight="700">'
            + f"{len(home_people)} чел. · {len(home_devices)} устр."
            + "</text></svg>"
        )

    def uptime(self, query: dict, now: int) -> dict:
        try:
            days = int(query.get("days", 7))
        except (TypeError, ValueError) as exc:
            raise ValueError("days должен быть числом") from exc
        if not 1 <= days <= 90:
            raise ValueError("days должен быть от 1 до 90")
        start_day = time.strftime("%Y-%m-%d", time.localtime(now - (days - 1) * 86400))
        start_ts = int(time.mktime(time.strptime(start_day, "%Y-%m-%d")))
        last = self.store.last_agent_seen()
        return {
            "days": days,
            "last_seen": last,
            "online": bool(last is not None and now - last <= 600),
            "series": self.store.agent_uptime(start_ts, now + 1),
        }

    def timemachine(self, query: dict, now: int) -> dict:
        """Кто был в сети в выбранный час (по минутным данным)."""
        date = query.get("date") or day_key(now)
        try:
            start, _end = day_bounds(date, date)
        except ValueError as exc:
            raise ValueError("некорректная дата") from exc
        hour = _bounded_int(query.get("hour"), time.localtime(now).tm_hour, 0, 23, "hour")
        at = start + hour * 3600
        macs = self.store.macs_in_range(at, at + 3600)
        rows = [row for row in self._device_rows() if row["mac"] in macs]
        return {"at": at, "date": date, "hour": hour, "devices": rows}

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
            self.store.log_change(int(self.clock()), "device.merge", mac, merge_into.lower())
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
        self.store.log_change(
            int(self.clock()), "device.update", mac, ",".join(sorted(fields))
        )
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

    # -- разметка, массовые действия и отчёты -----------------------------

    def _apply_rules(self, snap, now: int) -> None:
        """Размечает клиентов по правилам, не трогая ручные правки."""
        rules = self.store.get_rules()
        if not rules:
            return
        known = {row["mac"]: row for row in self.store.get_devices()}
        for client in snap.clients:
            rule = next(
                (
                    item
                    for item in rules
                    if _rule_matches(item, client.mac, client.hostname, client.ip)
                ),
                None,
            )
            if rule is None:
                continue
            wanted = {
                key: rule.get(key)
                for key in ("person", "kind", "trust")
                if rule.get(key)
            }
            if not wanted:
                continue
            row = known.get(client.mac)
            if row is None:
                self.store.upsert_device(client.mac, **wanted)
                known[client.mac] = {"mac": client.mac, **wanted}
                continue
            if row.get("person") or row.get("name"):
                continue
            patch = {}
            if wanted.get("person") and not row.get("person"):
                patch["person"] = wanted["person"]
            if wanted.get("kind") and not row.get("kind"):
                patch["kind"] = wanted["kind"]
            if wanted.get("trust") and row.get("trust") in (None, "", "unknown"):
                patch["trust"] = wanted["trust"]
            if patch:
                self.store.upsert_device(client.mac, **patch)
                row.update(patch)

    def _validated_fields(self, fields) -> dict:
        if fields is None:
            fields = {}
        if not isinstance(fields, dict):
            raise ValueError("Поля должны быть объектом")
        clean = {}
        for key, value in fields.items():
            if key not in DEVICE_FIELDS:
                continue
            if key in ("trust", "kind"):
                if value in (None, ""):
                    clean[key] = None
                elif key == "trust":
                    if value not in TRUST_VALUES:
                        raise ValueError(f"Недопустимое значение trust: {value}")
                    clean[key] = value
                else:
                    if value not in KIND_VALUES:
                        raise ValueError(f"Недопустимое значение kind: {value}")
                    clean[key] = value
            elif key == "hidden":
                if isinstance(value, bool):
                    clean[key] = value
                elif value in ("true", "false"):
                    clean[key] = value == "true"
                elif value in (0, 1):
                    clean[key] = bool(value)
                else:
                    raise ValueError("hidden должен быть boolean")
            elif value is None:
                clean[key] = None
            elif isinstance(value, str):
                clean[key] = value.strip()
            else:
                raise ValueError(f"Поле {key} должно быть строкой")
        return clean

    def bulk_devices(self, body: dict, now: int) -> dict:
        macs = body.get("macs")
        if not isinstance(macs, list) or not macs:
            raise ValueError("macs должен быть непустым списком")
        clean_macs = []
        for mac in macs:
            value = str(mac or "").strip().lower()
            if not MAC_RE.match(value):
                raise ValueError(f"Некорректный MAC: {mac}")
            clean_macs.append(value)
        if body.get("delete"):
            deleted = sum(1 for mac in clean_macs if self.store.forget_device(mac))
            if deleted:
                self.store.log_change(
                    int(self.clock()), "devices.bulk", None, f"удалено {deleted}"
                )
            return {"ok": True, "deleted": deleted}
        fields = self._validated_fields(body.get("fields"))
        if not fields:
            raise ValueError("Нет полей для изменения")
        updated = self.store.bulk_update(clean_macs, fields)
        self.store.log_change(
            int(self.clock()), "devices.bulk", None, f"изменено {updated}"
        )
        return {"ok": True, "updated": updated}

    def forget_device(self, mac: str | None) -> dict:
        value = str(mac or "").strip().lower()
        if not MAC_RE.match(value):
            raise ValueError("Некорректный MAC")
        deleted = self.store.forget_device(value)
        if deleted:
            self.store.log_change(int(self.clock()), "device.delete", value)
        return {"ok": True, "deleted": deleted}

    def list_rules(self) -> dict:
        return {"rules": self.store.get_rules()}

    def add_rule(self, body: dict) -> dict:
        pattern = body.get("pattern")
        if not isinstance(pattern, str) or not pattern.strip():
            raise ValueError("pattern обязателен")
        fields = self._validated_fields(
            {key: body[key] for key in ("person", "kind", "trust") if key in body}
        )
        rule = self.store.add_rule(
            pattern.strip(),
            person=fields.get("person"),
            kind=fields.get("kind"),
            trust=fields.get("trust"),
        )
        self.store.log_change(
            int(self.clock()), "rule.add", None, pattern.strip()
        )
        return {"ok": True, "rule": rule}

    def remove_rule(self, rule_id: str | None) -> dict:
        try:
            value = int(rule_id or "")
        except (TypeError, ValueError):
            raise ValueError("id должен быть числом") from None
        deleted = self.store.delete_rule(value)
        if deleted:
            self.store.log_change(int(self.clock()), "rule.delete", None, str(value))
        return {"ok": True, "deleted": deleted}

    def changes(self, query: dict, now: int) -> dict:
        try:
            limit = int(query.get("limit", 50))
        except (TypeError, ValueError) as exc:
            raise ValueError("limit должен быть числом") from exc
        if not 1 <= limit <= 500:
            raise ValueError("limit должен быть от 1 до 500")
        return {"changes": self.store.get_changes(limit)}

    def cleanup(self, body: dict, now: int) -> dict:
        try:
            days = int(body.get("days", 30))
        except (TypeError, ValueError) as exc:
            raise ValueError("days должен быть числом") from exc
        if not 1 <= days <= 3650:
            raise ValueError("days должен быть от 1 до 3650")
        before_ts = now - days * 86400
        before_day = time.strftime("%Y-%m-%d", time.localtime(before_ts))
        return {
            "days": days,
            "events": self.store.prune_events(before_ts),
            "minutes": self.store.prune_minutes(before_ts),
            "days_deleted": self.store.prune_daily(before_day),
            "signals": self.store.prune_signals(before_ts),
        }

    def backup(self) -> dict:
        devices = [
            {key: row.get(key) for key in ("mac",) + DEVICE_FIELDS}
            for row in self.store.get_devices()
        ]
        return {
            "version": 1,
            "exported_at": int(self.clock()),
            "devices": devices,
            "rules": self.store.get_rules(),
        }

    def restore(self, body: dict) -> dict:
        if body.get("version") != 1:
            raise ValueError("Неподдерживаемая версия резервной копии")
        devices = body.get("devices") or []
        rules = body.get("rules") or []
        if not isinstance(devices, list) or not isinstance(rules, list):
            raise ValueError("devices и rules должны быть списками")
        restored = 0
        for item in devices:
            if not isinstance(item, dict):
                raise ValueError("Элемент devices должен быть объектом")
            mac = str(item.get("mac") or "").strip().lower()
            if not MAC_RE.match(mac):
                raise ValueError(f"Некорректный MAC: {item.get('mac')}")
            fields = self._validated_fields(item)
            if fields:
                self.store.upsert_device(mac, **fields)
                restored += 1
        clean_rules = []
        for item in rules:
            if not isinstance(item, dict):
                raise ValueError("Элемент rules должен быть объектом")
            pattern = item.get("pattern")
            if not isinstance(pattern, str) or not pattern.strip():
                raise ValueError("У правила отсутствует pattern")
            fields = self._validated_fields(
                {key: item[key] for key in ("person", "kind", "trust") if key in item}
            )
            clean_rules.append(
                {
                    "pattern": pattern.strip(),
                    "person": fields.get("person"),
                    "kind": fields.get("kind"),
                    "trust": fields.get("trust"),
                }
            )
        return {
            "ok": True,
            "devices": restored,
            "rules": self.store.replace_rules(clean_rules),
        }

    def calendar(self, query: dict, now: int) -> dict:
        month = (query.get("month") or datetime.fromtimestamp(now).strftime("%Y-%m")).strip()
        try:
            first = datetime.strptime(month, "%Y-%m")
        except ValueError:
            raise ValueError("month должен быть в формате YYYY-MM") from None
        person = (query.get("person") or "").strip()
        macs = self._person_macs(person) if person else None
        days = []
        total = 0
        cursor = first
        while cursor.month == first.month:
            start = int(cursor.timestamp())
            end = _local_midnight(start + 90000)
            minutes = self.store.minutes_union(start, end, macs)
            days.append({"date": cursor.strftime("%Y-%m-%d"), "minutes": minutes})
            total += minutes
            cursor += timedelta(days=1)
        return {
            "month": first.strftime("%Y-%m"),
            "person": person,
            "days": days,
            "total": total,
        }

    def compare(self, query: dict, now: int) -> dict:
        days = _bounded_int(query.get("days"), 7, 1, 30, "days")
        today = _local_midnight(now)
        current_from = today - (days - 1) * 86400
        current_to = today + 86400
        previous_to = current_from
        previous_from = current_from - days * 86400

        groups: dict[str, list[str]] = {}
        for device in self.store.get_devices():
            person = (device.get("person") or "").strip()
            if person:
                groups.setdefault(person, []).append(device["mac"])

        people = [
            {
                "person": person,
                "minutes": self.store.minutes_union(current_from, current_to, macs),
                "prev_minutes": self.store.minutes_union(previous_from, previous_to, macs),
            }
            for person, macs in groups.items()
        ]
        people.sort(key=lambda item: (-item["minutes"], item["person"]))
        return {
            "days": days,
            "from": current_from,
            "to": current_to,
            "people": people,
            "total": self.store.minutes_union(current_from, current_to, None),
            "prev_total": self.store.minutes_union(previous_from, previous_to, None),
        }

    def anomalies(self, query: dict, now: int) -> dict:
        items = []
        local = datetime.fromtimestamp(now)
        hour = local.hour
        presence = {row["mac"]: row.get("state") for row in self.store.all_presence()}

        groups: dict[str, list[str]] = {}
        for device in self.store.get_devices():
            person = (device.get("person") or "").strip()
            if person:
                groups.setdefault(person, []).append(device["mac"])

        for person, macs in sorted(groups.items()):
            if any(presence.get(mac) == "home" for mac in macs):
                continue
            hits = 0
            for weeks_ago in range(1, 5):
                day = local.date() - timedelta(days=7 * weeks_ago)
                moment = datetime.combine(day, datetime.min.time()).replace(hour=hour)
                start = int(moment.timestamp())
                if self.store.macs_in_range(start, start + 3600) & set(macs):
                    hits += 1
            if hits >= 3:
                items.append(
                    {
                        "kind": "usually-home",
                        "level": "warn",
                        "text": f"Обычно в это время {person} дома",
                    }
                )

        stale = []
        for row in self._device_rows():
            last_seen = row.get("last_seen")
            if row.get("state") == "home" or row.get("hidden") or not last_seen:
                continue
            age = now - int(last_seen)
            if age >= 3 * 86400:
                stale.append((age, row))
        stale.sort(key=lambda item: -item[0])
        for age, row in stale[:5]:
            label = row.get("name") or row.get("person") or row.get("mac")
            items.append(
                {
                    "kind": "stale-device",
                    "level": "info",
                    "text": f"{label} не появлялось {age // 86400} дн.",
                }
            )
        return {"now": now, "items": items}

    def _json_body(self, handler: BaseHTTPRequestHandler):
        """Читает JSON-объект тела; возвращает (body, (status, payload)|None)."""
        code, payload = handler._read_body()
        if code is not None:
            status = 413 if code == 413 else 400
            reason = "payload_too_large" if code == 413 else "bad_request"
            message = (
                "Тело запроса слишком велико" if code == 413 else "Неверное тело запроса"
            )
            return None, (status, _error(reason, message))
        try:
            body = json.loads(payload or b"{}")
        except (ValueError, UnicodeDecodeError):
            return None, (400, _error("bad_request", "Тело не является JSON"))
        if not isinstance(body, dict):
            return None, (400, _error("bad_request", "Ожидается объект JSON"))
        return body, None

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

            def do_DELETE(self):  # noqa: N802
                app._handle(self, "DELETE")

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

        if path == "/api/widget.svg" and method == "GET":
            payload = self.widget_svg(now).encode("utf-8")
            handler.send_response(200)
            handler.send_header("Content-Type", "image/svg+xml; charset=utf-8")
            handler.send_header("Content-Length", str(len(payload)))
            handler.send_header("Cache-Control", "no-store")
            handler.end_headers()
            handler.wfile.write(payload)
            return

        if path == "/api/db/export" and method == "GET":
            payload = self.store.snapshot_bytes()
            handler.send_response(200)
            handler.send_header("Content-Type", "application/octet-stream")
            handler.send_header(
                "Content-Disposition", 'attachment; filename="homepanel.sqlite3"'
            )
            handler.send_header("Content-Length", str(len(payload)))
            handler.send_header("Cache-Control", "no-store")
            handler.end_headers()
            handler.wfile.write(payload)
            return

        if path == "/api/db/import" and method == "POST":
            code, payload = handler._read_body()
            if code is not None:
                return handler._send_json(
                    413 if code == 413 else 400,
                    _error(
                        "payload_too_large" if code == 413 else "bad_request",
                        "Неверное тело запроса",
                    ),
                )
            try:
                result = self.store.replace_from_bytes(payload)
            except ValueError as exc:
                return handler._send_json(400, _error("bad_request", str(exc)))
            except Exception:
                log.exception("не удалось импортировать базу")
                return handler._send_json(
                    500, _error("internal", "Не удалось заменить базу")
                )
            return handler._send_json(200, {"ok": True, **result})

        if path == "/api/state" and method == "GET":
            return handler._send_json(200, self.state(now))

        if path == "/api/devices" and method == "DELETE":
            try:
                return handler._send_json(200, self.forget_device(params.get("mac")))
            except ValueError as exc:
                return handler._send_json(400, _error("bad_request", str(exc)))

        if path == "/api/devices/bulk" and method == "POST":
            body, error = self._json_body(handler)
            if error is not None:
                return handler._send_json(*error)
            try:
                return handler._send_json(200, self.bulk_devices(body, now))
            except ValueError as exc:
                return handler._send_json(400, _error("bad_request", str(exc)))

        if path == "/api/rules":
            if method == "GET":
                return handler._send_json(200, self.list_rules())
            if method == "DELETE":
                try:
                    return handler._send_json(200, self.remove_rule(params.get("id")))
                except ValueError as exc:
                    return handler._send_json(400, _error("bad_request", str(exc)))
            if method == "POST":
                body, error = self._json_body(handler)
                if error is not None:
                    return handler._send_json(*error)
                try:
                    return handler._send_json(200, self.add_rule(body))
                except ValueError as exc:
                    return handler._send_json(400, _error("bad_request", str(exc)))

        if path == "/api/backup":
            if method == "GET":
                return handler._send_json(200, self.backup())
            if method == "POST":
                body, error = self._json_body(handler)
                if error is not None:
                    return handler._send_json(*error)
                try:
                    return handler._send_json(200, self.restore(body))
                except ValueError as exc:
                    return handler._send_json(400, _error("bad_request", str(exc)))

        if path == "/api/cleanup" and method == "POST":
            body, error = self._json_body(handler)
            if error is not None:
                return handler._send_json(*error)
            try:
                return handler._send_json(200, self.cleanup(body, now))
            except ValueError as exc:
                return handler._send_json(400, _error("bad_request", str(exc)))

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
            ("/api/calendar", self.calendar),
            ("/api/timemachine", self.timemachine),
            ("/api/uptime", self.uptime),
            ("/api/changes", self.changes),
            ("/api/compare", self.compare),
            ("/api/anomalies", self.anomalies),
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
        if full.endswith(".webmanifest"):
            content_type = "application/manifest+json"
        handler.send_response(200)
        handler.send_header("Content-Type", content_type or "application/octet-stream")
        handler.send_header("Content-Length", str(len(data)))
        handler.end_headers()
        handler.wfile.write(data)
