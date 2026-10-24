"""Загрузка конфигурации сервера из JSON-файла (см. спеку §14)."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass

DEFAULT_SECRET = "CHANGE_ME"


@dataclass
class Config:
    host: str
    port: int
    secret: str
    grace_seconds: int
    minute_retention_days: int
    daily_retention_days: int
    public_url: str
    db_path: str
    static_dir: str
    signal_retention_days: int = 7


def _defaults() -> Config:
    return Config(
        host="127.0.0.1",
        port=8787,
        secret=DEFAULT_SECRET,
        grace_seconds=300,
        minute_retention_days=30,
        daily_retention_days=365,
        public_url="",
        db_path=os.path.join("data", "homepanel.sqlite3"),
        static_dir=os.path.normpath(
            os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "static")
        ),
    )


def load_config(path: str | None = None) -> Config:
    """Вернуть конфигурацию: умолчания, перекрытые значениями файла `path`.

    Отсутствующий или пустой путь даёт умолчания. Неизвестные ключи
    игнорируются.
    """
    cfg = _defaults()
    if not path or not os.path.isfile(path):
        return cfg

    with open(path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        return cfg

    if "host" in data:
        cfg.host = str(data["host"])
    if "port" in data:
        cfg.port = int(data["port"])
    if "secret" in data:
        cfg.secret = str(data["secret"])
    if "graceSeconds" in data:
        cfg.grace_seconds = int(data["graceSeconds"])
    if "publicUrl" in data:
        cfg.public_url = str(data["publicUrl"])
    if "dbPath" in data:
        cfg.db_path = str(data["dbPath"])
    if "staticDir" in data:
        cfg.static_dir = str(data["staticDir"])

    retention = data.get("retention")
    if isinstance(retention, dict):
        if "minuteDays" in retention:
            cfg.minute_retention_days = int(retention["minuteDays"])
        if "dailyDays" in retention:
            cfg.daily_retention_days = int(retention["dailyDays"])
        if "signalDays" in retention:
            cfg.signal_retention_days = int(retention["signalDays"])

    return cfg
