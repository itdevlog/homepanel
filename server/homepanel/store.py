"""Хранилище SQLite: устройства, присутствие, события и агрегаты.

Схема — спека §9. Доступ к соединению сериализован `self._lock`
(`check_same_thread=False` позволяет использовать один `Store` из нескольких
потоков сервера).
"""

from __future__ import annotations

import os
import sqlite3
import threading
import time

DEVICE_FIELDS = ("name", "person", "kind", "trust", "hidden", "notes")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS devices (
    mac        TEXT PRIMARY KEY,
    name       TEXT,
    person     TEXT,
    kind       TEXT,
    trust      TEXT NOT NULL DEFAULT 'unknown',
    hidden     INTEGER NOT NULL DEFAULT 0,
    notes      TEXT,
    created_at INTEGER,
    updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS presence (
    mac        TEXT PRIMARY KEY,
    state      TEXT NOT NULL DEFAULT 'away',
    last_seen  INTEGER,
    since      INTEGER,
    bss        TEXT,
    band       TEXT,
    signal     INTEGER,
    ip         TEXT,
    hostname   TEXT,
    updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS events (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    mac  TEXT NOT NULL,
    type TEXT NOT NULL,
    ts   INTEGER NOT NULL,
    bss  TEXT,
    band TEXT,
    ip   TEXT
);

CREATE TABLE IF NOT EXISTS minute_presence (
    mac       TEXT NOT NULL,
    minute_ts INTEGER NOT NULL,
    PRIMARY KEY (mac, minute_ts)
);

CREATE TABLE IF NOT EXISTS daily_presence (
    mac     TEXT NOT NULL,
    day     TEXT NOT NULL,
    minutes INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (mac, day)
);

CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_mac_ts ON events(mac, ts);
CREATE INDEX IF NOT EXISTS idx_minute_mac_ts ON minute_presence(mac, minute_ts);
CREATE INDEX IF NOT EXISTS idx_minute_ts ON minute_presence(minute_ts);
CREATE INDEX IF NOT EXISTS idx_presence_state ON presence(state);
"""


def _device_row_to_dict(row: sqlite3.Row) -> dict:
    data = dict(row)
    data["hidden"] = bool(data["hidden"])
    return data


class Store:
    def __init__(self, path: str):
        self.path = path
        parent = os.path.dirname(os.path.abspath(path))
        os.makedirs(parent, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.executescript(_SCHEMA)
        self._conn.commit()

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # -- устройства ------------------------------------------------------

    def get_devices(self) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM devices ORDER BY mac"
            ).fetchall()
        return [_device_row_to_dict(r) for r in rows]

    def get_device(self, mac: str) -> dict | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM devices WHERE mac = ?", (mac.lower(),)
            ).fetchone()
        return _device_row_to_dict(row) if row else None

    def upsert_device(self, mac: str, **fields) -> dict:
        mac = mac.lower()
        now = int(time.time())
        values = {k: v for k, v in fields.items() if k in DEVICE_FIELDS and v is not None}
        if "hidden" in values:
            values["hidden"] = int(bool(values["hidden"]))

        with self._lock:
            existing = self._conn.execute(
                "SELECT mac FROM devices WHERE mac = ?", (mac,)
            ).fetchone()
            if existing is None:
                columns = ["mac", "created_at", "updated_at", *values.keys()]
                params = [mac, now, now, *values.values()]
                placeholders = ", ".join("?" for _ in columns)
                self._conn.execute(
                    f"INSERT INTO devices ({', '.join(columns)}) VALUES ({placeholders})",
                    params,
                )
            elif values:
                assignments = ", ".join(f"{k} = ?" for k in values)
                self._conn.execute(
                    f"UPDATE devices SET {assignments}, updated_at = ? WHERE mac = ?",
                    [*values.values(), now, mac],
                )
            self._conn.commit()
            row = self._conn.execute(
                "SELECT * FROM devices WHERE mac = ?", (mac,)
            ).fetchone()
        return _device_row_to_dict(row)

    def merge_devices(self, src_mac: str, dst_mac: str) -> dict:
        src_mac, dst_mac = src_mac.lower(), dst_mac.lower()
        src = self.get_device(src_mac)
        dst = self.upsert_device(dst_mac)  # создаёт dst, если его не было

        transferred: dict = {}
        for field in ("name", "person", "kind", "notes"):
            if src and src[field] and not dst.get(field):
                transferred[field] = src[field]
        if src and src.get("trust") and src["trust"] != "unknown" and dst.get("trust") in (
            None,
            "",
            "unknown",
        ):
            transferred["trust"] = src["trust"]
        if src and src.get("hidden") and not dst.get("hidden"):
            transferred["hidden"] = True

        merged = self.upsert_device(dst_mac, **transferred) if transferred else dst

        with self._lock:
            self._conn.execute("DELETE FROM presence WHERE mac = ?", (src_mac,))
            self._conn.execute("DELETE FROM devices WHERE mac = ?", (src_mac,))
            self._conn.commit()
        return merged
