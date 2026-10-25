import os
import tempfile
import time
import unittest

from homepanel.presence import PresenceEngine
from homepanel.scheduler import Scheduler
from homepanel.store import Store


def noon(day: str) -> int:
    return int(time.mktime(time.strptime(day + " 12:00", "%Y-%m-%d %H:%M")))


class SchedulerTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.store = Store(os.path.join(self.dir.name, "t.sqlite3"))
        self.sched = Scheduler(
            self.store,
            PresenceEngine(self.store, 300),
            minute_days=30,
            daily_days=365,
        )

    def tearDown(self):
        self.store.close()
        self.dir.cleanup()

    def test_run_once_expires_and_records_minutes(self):
        self.store.set_presence("aa:aa:aa:aa:aa:aa", state="home", last_seen=1000, since=1000)
        res = self.sched.run_once(now=2000)  # grace истёк
        self.assertEqual(res["expired"], 1)
        self.assertEqual(self.store.get_presence("aa:aa:aa:aa:aa:aa")["state"], "away")

    def test_run_once_records_minute_for_live_device(self):
        self.store.set_presence("aa:aa:aa:aa:aa:aa", state="home", last_seen=1000, since=1000)
        res = self.sched.run_once(now=1100)  # grace не истёк
        self.assertEqual(res["expired"], 0)
        self.assertEqual(res["minutes"], 1)
        self.assertEqual(self.store.minutes_for_day("1970-01-01"), {"aa:aa:aa:aa:aa:aa": 1})

    def test_run_once_is_safe_when_nothing_to_do(self):
        self.assertEqual(self.sched.run_once(now=2000)["expired"], 0)

    def test_multi_day_downtime_rolls_up_every_day(self):
        """Простій в несколько суток не должен терять дни после очистки минут."""
        mac = "aa:aa:aa:aa:aa:aa"
        for day in ("2026-10-10", "2026-10-11", "2026-10-12"):
            self.store.mark_minute(mac, noon(day))
        self.sched.run_once(now=noon("2026-10-13"))
        self.assertEqual(
            self.store.daily_totals("2026-10-10", "2026-10-13"),
            {"2026-10-10": 1, "2026-10-11": 1, "2026-10-12": 1},
        )


    def test_daily_backup_written_once_and_pruned(self):
        backup_dir = os.path.join(self.dir.name, "backups")
        sched = Scheduler(
            self.store,
            PresenceEngine(self.store, 300),
            minute_days=30,
            daily_days=365,
            backup=lambda: {"version": 1},
            backup_dir=backup_dir,
            backup_keep=2,
        )
        first = sched.run_once(now=noon("2026-10-20"))["backup"]
        self.assertTrue(first and os.path.isfile(first))
        self.assertIsNone(sched.run_once(now=noon("2026-10-20") + 60)["backup"])
        sched.run_once(now=noon("2026-10-21"))
        sched.run_once(now=noon("2026-10-22"))
        self.assertEqual(
            sorted(os.listdir(backup_dir)),
            ["homepanel-2026-10-21.json", "homepanel-2026-10-22.json"],
        )


if __name__ == "__main__":
    unittest.main()
