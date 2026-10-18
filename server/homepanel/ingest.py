"""Разбор снимка присутствия, приходящего в `POST /api/ingest` (спека §5)."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass

MAX_SCHEMA = 1

_MAC_RE = re.compile(r"^[0-9a-f]{2}(:[0-9a-f]{2}){5}$")
MAC_RE = _MAC_RE


class IngestError(Exception):
    """Снимок не соответствует контракту агент ↔ сервер."""


@dataclass
class Client:
    mac: str
    bss: str | None = None
    band: str | None = None
    signal: int | None = None
    ip: str | None = None
    hostname: str | None = None
    connected_at: int | None = None


@dataclass
class Snapshot:
    schema: int
    agent_hostname: str | None
    agent_version: str | None
    ts: int | None
    clients: list[Client]


def _as_int(value) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


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
    )


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
        raise IngestError(f"unsupported schema: {schema}")

    raw_clients = payload.get("clients")
    if not isinstance(raw_clients, list):
        raise IngestError("clients must be a list")
    clients = [c for c in (_parse_client(item) for item in raw_clients) if c is not None]

    agent = payload.get("agent")
    agent = agent if isinstance(agent, dict) else {}
    return Snapshot(
        schema=schema,
        agent_hostname=agent.get("hostname"),
        agent_version=agent.get("version"),
        ts=_as_int(agent.get("ts")),
        clients=clients,
    )
