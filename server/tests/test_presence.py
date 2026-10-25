import json
import os
import tempfile
import unittest

from homepanel.store import Store
from homepanel.ingest import parse_snapshot
from homepanel.presence import PresenceEngine


def snap(clients, ts=1000):
    return parse_snapshot(json.dumps(
        {"schema": 1, "agent": {"hostname": "r", "version": "1", "ts": ts},
         "clients": clients}).encode())


CL = [{"mac": "aa:bb:cc:dd:ee:ff", "bss": "phy0-ap0", "band": "2.4", "signal": -50}]


class PresenceTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.store = Store(os.path.join(self.dir.name, "t.sqlite3"))
        self.eng = PresenceEngine(self.store, grace_seconds=300)

    def tearDown(self):
        self.store.close()
        self.dir.cleanup()

    def test_arrival_then_expiry_after_grace(self):
        r = self.eng.apply_snapshot(snap(CL), now=1000)
        self.assertEqual(r["arrived"], ["aa:bb:cc:dd:ee:ff"])
        self.assertEqual(self.store.get_presence("aa:bb:cc:dd:ee:ff")["state"], "home")
        self.assertEqual(self.eng.expire(now=1200), [])            # grace не истёк
        left = self.eng.expire(now=1400)                            # 1000+300 < 1400
        self.assertEqual([e["type"] for e in left], ["left"])
        self.assertEqual(self.store.get_presence("aa:bb:cc:dd:ee:ff")["state"], "away")

    def test_repeated_snapshot_is_idempotent(self):
        self.eng.apply_snapshot(snap(CL), now=1000)
        r = self.eng.apply_snapshot(snap(CL), now=1010)
        self.assertEqual(r["arrived"], [])
        self.assertEqual(len(self.store.get_events()), 1)

    def test_link_is_stored_and_preserved_without_explicit_value(self):
        mac = "aa:bb:cc:dd:ee:ff"
        self.store.set_presence(mac, state="home", link="wired")
        self.assertEqual(self.store.get_presence(mac)["link"], "wired")
        self.store.set_presence(mac, state="away")
        self.assertEqual(self.store.get_presence(mac)["link"], "wired")

    def test_apply_snapshot_passes_link(self):
        self.eng.apply_snapshot(snap([{"mac": "aa:bb:cc:dd:ee:01", "link": "wired"}]), now=1000)
        self.assertEqual(self.store.get_presence("aa:bb:cc:dd:ee:01")["link"], "wired")

    def test_agent_ts_does_not_move_server_now(self):        # Review Focus 3
        self.eng.apply_snapshot(snap(CL, ts=9_999_999), now=1000)
        self.assertEqual(self.store.get_presence("aa:bb:cc:dd:ee:ff")["last_seen"], 1000)

    def test_same_mac_on_two_bss_kept_once_with_strongest_signal(self):   # Review Focus 4
        two = [dict(CL[0], bss="phy0-ap0", signal=-70), dict(CL[0], bss="phy1-ap0", signal=-45)]
        r = self.eng.apply_snapshot(snap(two), now=1000)
        p = self.store.get_presence("aa:bb:cc:dd:ee:ff")
        self.assertEqual(r["arrived"], ["aa:bb:cc:dd:ee:ff"])
        self.assertEqual((p["bss"], p["signal"]), ("phy1-ap0", -45))
        self.assertEqual(len(self.store.get_events()), 1)

    def test_empty_clients_expires_everyone(self):           # Review Focus 5
        self.eng.apply_snapshot(snap(CL), now=1000)
        self.eng.apply_snapshot(snap([]), now=1010)
        self.assertEqual([e["type"] for e in self.eng.expire(now=1400)], ["left"])


if __name__ == "__main__":
    unittest.main()
