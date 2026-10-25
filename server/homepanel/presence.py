"""Автомат присутствия: снимок клиентов -> состояния `home`/`away` (спека §10).

Логика опирается только на собственное `now` сервера; `agent.ts` из снимка
не влияет на `last_seen`/`since` (Review Focus 3).
"""

from __future__ import annotations

from .ingest import Client, Snapshot
from .store import Store

STATE_HOME = "home"
STATE_AWAY = "away"

_MISSING_SIGNAL = -999


def _signal_rank(client: Client) -> int:
    return client.signal if client.signal is not None else _MISSING_SIGNAL


class PresenceEngine:
    def __init__(self, store: Store, grace_seconds: int):
        self.store = store
        self.grace_seconds = int(grace_seconds)

    def apply_snapshot(self, snap: Snapshot, now: int) -> dict:
        strongest: dict[str, Client] = {}
        for client in snap.clients:
            previous = strongest.get(client.mac)
            if previous is None or _signal_rank(client) > _signal_rank(previous):
                strongest[client.mac] = client

        arrived: list[str] = []
        updated: list[str] = []
        for mac, client in strongest.items():
            previous_state = self.store.get_presence(mac)
            if previous_state is None or previous_state["state"] != STATE_HOME:
                self.store.add_event(mac, "arrived", now, bss=client.bss,
                                     band=client.band, ip=client.ip)
                arrived.append(mac)
                since = now
            else:
                since = previous_state["since"] if previous_state["since"] is not None else now

            self.store.set_presence(
                mac, state=STATE_HOME, last_seen=now, since=since, bss=client.bss,
                band=client.band, signal=client.signal, ip=client.ip,
                hostname=client.hostname, link=client.link, updated_at=now,
            )
            updated.append(mac)

        return {"arrived": arrived, "updated": updated}

    def expire(self, now: int) -> list[dict]:
        left: list[dict] = []
        for presence in self.store.all_presence():
            if presence["state"] != STATE_HOME:
                continue
            last_seen = presence["last_seen"] or 0
            if now - last_seen > self.grace_seconds:
                self.store.set_presence(presence["mac"], state=STATE_AWAY, updated_at=now)
                self.store.add_event(presence["mac"], "left", now, bss=presence["bss"],
                                     band=presence["band"], ip=presence["ip"])
                left.append({
                    "mac": presence["mac"], "type": "left", "ts": now,
                    "bss": presence["bss"], "band": presence["band"], "ip": presence["ip"],
                })
        return left
