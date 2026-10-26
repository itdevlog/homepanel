"""Фоновый планировщик: истечение grace, запись минут, дневной роллап и очистка.

`run_once` вызывается из потока, поднятого `start()`, и в тестах — напрямую.
Порядок внутри тика: сначала истечение grace (ушедшие не должны попасть в
текущую минуту), затем запись минуты присутствия для тех, кто ещё дома.
"""

from __future__ import annotations

import glob
import json
import logging
import os
import threading
import time

from . import aggregator

log = logging.getLogger(__name__)


class Scheduler:
    def __init__(
        self,
        store,
        engine,
        *,
        minute_days: int,
        daily_days: int,
        tick_seconds: int = 15,
        clock=time.time,
        signal_days: int = 7,
        backup=None,
        backup_dir: str = "",
        backup_keep: int = 7,
        backup_hour: int = 3,
    ):
        self.store = store
        self.engine = engine
        self.minute_days = minute_days
        self.daily_days = daily_days
        self.signal_days = signal_days
        self.backup = backup
        self.backup_dir = backup_dir
        self.backup_keep = max(1, int(backup_keep))
        self.backup_hour = max(0, min(23, int(backup_hour)))
        self._last_backup_day = ""
        self.tick_seconds = tick_seconds
        self._clock = clock
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def run_once(self, now: int) -> dict:
        expired = len(self.engine.expire(now))
        minutes = aggregator.record_minutes(self.store, now)

        rolled = aggregator.rollup_pending(self.store, now)
        aggregator.prune(self.store, now, self.minute_days, self.daily_days, self.signal_days)
        self.store.prune_agent_seen(now - self.minute_days * 86400)
        self.store.prune_changes(now - 365 * 86400)
        self.store.prune_nlbw(now - self.minute_days * 86400)
        self.store.prune_light_events(now - 365 * 86400)
        return {
            "expired": expired,
            "minutes": minutes,
            "rolled_day": rolled[-1] if rolled else None,
            "backup": self._maybe_backup(now),
        }

    def _maybe_backup(self, now: int) -> str | None:
        """Раз в сутки после `backup_hour` сохранить JSON-копию разметки."""
        if self.backup is None or not self.backup_dir:
            return None
        local = time.localtime(now)
        if local.tm_hour < self.backup_hour:
            return None
        day = time.strftime("%Y-%m-%d", local)
        if day == self._last_backup_day:
            return None

        os.makedirs(self.backup_dir, exist_ok=True)
        path = os.path.join(self.backup_dir, f"homepanel-{day}.json")
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(self.backup(), handle, ensure_ascii=False, indent=1)
        os.replace(tmp, path)

        files = sorted(glob.glob(os.path.join(self.backup_dir, "homepanel-*.json")))
        for old in files[: -self.backup_keep]:
            try:
                os.remove(old)
            except OSError:
                log.warning("не удалось удалить старую копию %s", old)
        self._last_backup_day = day
        return path

    def start(self) -> None:
        if self._thread is not None:
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._loop, name="homepanel-scheduler", daemon=True
        )
        self._thread.start()

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self.run_once(int(self._clock()))
            except Exception:  # планировщик не должен умирать из-за одного тика
                log.exception("scheduler tick failed")
            self._stop.wait(self.tick_seconds)

    def stop(self) -> None:
        self._stop.set()
        thread, self._thread = self._thread, None
        if thread is not None:
            thread.join(timeout=self.tick_seconds + 1)
