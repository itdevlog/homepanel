import os
import tempfile
import unittest

from homepanel.presence import PresenceEngine
from homepanel.scheduler import Scheduler
from homepanel.store import Store


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


if __name__ == "__main__":
    unittest.main()
