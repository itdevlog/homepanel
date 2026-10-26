"""Разбор снимка присутствия, приходящего в `POST /api/ingest` (спека §5)."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

MAX_SCHEMA = 2

_MAC_RE = re.compile(r"^[0-9a-f]{2}(:[0-9a-f]{2}){5}$")
MAC_RE = _MAC_RE


class IngestError(Exception):
    """Снимок не соответствует контракту агент ↔ сервер."""

    def __init__(self, message: str, reason: str = "bad_request"):
        super().__init__(message)
        self.reason = reason


@dataclass
class Client:
    mac: str
    bss: str | None = None
    band: str | None = None
    signal: int | None = None
    ip: str | None = None
    hostname: str | None = None
    connected_at: int | None = None
    link: str = "wifi"
    rx_bytes: int | None = None
    tx_bytes: int | None = None


@dataclass
class Router:
    uptime: int | None = None
    load1: float | None = None
    load5: float | None = None
    load15: float | None = None
    mem_total: int | None = None
    mem_free: int | None = None
    wan_up: bool = False
    wan_ip: str | None = None


@dataclass
class Snapshot:
    schema: int
    agent_hostname: str | None
    agent_version: str | None
    ts: int | None
    clients: list[Client]
    router: Router | None = None
    acks: list = field(default_factory=list)
    errors: list = field(default_factory=list)
    nlbw: dict = field(default_factory=dict)


def _as_int(value) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _as_float(value) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _as_nonneg_int(value) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if value >= 0 else None


def _parse_client(raw) -> Client | None:
    if not isinstance(raw, dict):
        return None
    mac = raw.get("mac")
    if not isinstance(mac, str):
        return None
    mac = mac.lower()
    if not _MAC_RE.match(mac):
        return None
    return Client(
        mac=mac,
        bss=raw.get("bss"),
        band=raw.get("band"),
        signal=_as_int(raw.get("signal")),
        ip=raw.get("ip"),
        hostname=raw.get("hostname"),
        connected_at=_as_int(raw.get("connected_at")),
        link="wired" if raw.get("link") == "wired" else "wifi",
        rx_bytes=_as_nonneg_int(raw.get("rx_bytes")),
        tx_bytes=_as_nonneg_int(raw.get("tx_bytes")),
    )


def _parse_router(raw) -> Router | None:
    if not isinstance(raw, dict):
        return None
    return Router(
        uptime=_as_int(raw.get("uptime")),
        load1=_as_float(raw.get("load1")),
        load5=_as_float(raw.get("load5")),
        load15=_as_float(raw.get("load15")),
        mem_total=_as_int(raw.get("mem_total")),
        mem_free=_as_int(raw.get("mem_free")),
        wan_up=raw.get("wan_up") is True,
        wan_ip=raw.get("wan_ip") if isinstance(raw.get("wan_ip"), str) else None,
    )


def _parse_acks(raw) -> list:
    if not isinstance(raw, list):
        return []
    parsed = []
    for item in raw[:50]:
        if not isinstance(item, dict):
            continue
        command_id = item.get("id")
        if isinstance(command_id, bool) or not isinstance(command_id, int):
            continue
        if not isinstance(item.get("ok"), bool):
            continue
        ack = {"id": command_id, "ok": item["ok"]}
        if isinstance(item.get("error"), str):
            ack["error"] = item["error"]
        parsed.append(ack)
    return parsed


def _parse_nlbw(raw) -> dict:
    if not isinstance(raw, dict):
        return {}
    out = {}
    for mac, item in raw.items():
        if not isinstance(item, dict):
            continue
        key = str(mac or "").strip().lower()
        if not MAC_RE.match(key):
            continue
        rx = _as_nonneg_int(item.get("rx_bytes"))
        tx = _as_nonneg_int(item.get("tx_bytes"))
        if rx is None or tx is None:
            continue
        out[key] = {"rx_bytes": rx, "tx_bytes": tx}
    return out


def parse_snapshot(raw: bytes) -> Snapshot:
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise IngestError(f"invalid JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise IngestError("payload is not a JSON object")

    schema = payload.get("schema", 1)
    if isinstance(schema, bool) or not isinstance(schema, int):
        raise IngestError("schema must be an integer")
    if schema > MAX_SCHEMA:
        raise IngestError(f"unsupported schema: {schema}", "unsupported_schema")

    raw_clients = payload.get("clients")
    if not isinstance(raw_clients, list):
        raise IngestError("clients must be a list")
    clients = [c for c in (_parse_client(item) for item in raw_clients) if c is not None]

    raw_errors = payload.get("errors")
    errors = (
        [item for item in raw_errors if isinstance(item, str)][:20]
        if isinstance(raw_errors, list)
        else []
    )

    agent = payload.get("agent")
    agent = agent if isinstance(agent, dict) else {}
    return Snapshot(
        schema=schema,
        agent_hostname=agent.get("hostname"),
        agent_version=agent.get("version"),
        ts=_as_int(agent.get("ts")),
        clients=clients,
        router=_parse_router(payload.get("router")),
        acks=_parse_acks(payload.get("acks")),
        errors=errors,
        nlbw=_parse_nlbw(payload.get("nlbw")),
    )
