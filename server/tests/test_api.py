import http.client
import json
import os
import socket
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import HTTPServer

from homepanel.app import App
from homepanel.config import load_config
from homepanel.presence import PresenceEngine
from homepanel.store import Store


def make_app(tmp):
    cfg = load_config(None)
    cfg.secret = "s3cr3t"
    cfg.static_dir = os.path.join(tmp, "static")
    os.makedirs(cfg.static_dir, exist_ok=True)
    store = Store(os.path.join(tmp, "t.sqlite3"))
    return cfg, store, App(cfg, store, PresenceEngine(store, 300))


class ApiTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.cfg, self.store, self.app = make_app(self.dir.name)
        self.srv = HTTPServer(("127.0.0.1", 0), self.app.make_handler())
        self.port = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.port}"

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        self.store.close()
        self.dir.cleanup()

    def _post(self, body: bytes, key=None):
        req = urllib.request.Request(
            self.base + "/api/ingest",
            data=body,
            headers={
                "Content-Type": "application/json",
                **({"X-Homepanel-Key": key} if key else {}),
            },
        )
        return urllib.request.urlopen(req)

    def test_ingest_requires_secret(self):
        body = json.dumps({"schema": 1, "clients": []}).encode()
        with self.assertRaises(urllib.error.HTTPError) as e:
            self._post(body, key="wrong")
        self.assertEqual(e.exception.code, 401)

    def test_ingest_then_state(self):
        body = json.dumps(
            {
                "schema": 1,
                "agent": {"hostname": "r", "version": "1", "ts": 1},
                "clients": [{"mac": "aa:bb:cc:dd:ee:ff", "signal": -40}],
            }
        ).encode()
        self.assertEqual(json.loads(self._post(body, key="s3cr3t").read())["ok"], True)
        state = json.loads(urllib.request.urlopen(self.base + "/api/state").read())
        self.assertEqual(state["devices"][0]["state"], "home")

    def test_ingest_accepts_chunked_body(self):
        # uclient-fetch (OpenWrt) отправляет --post-file как chunked, без
        # Content-Length: агент должен получать 200, а не 400.
        body = json.dumps(
            {
                "schema": 1,
                "agent": {"hostname": "r", "version": "1", "ts": 1},
                "clients": [{"mac": "aa:bb:cc:dd:ee:ff", "signal": -40}],
            }
        ).encode()
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            conn.request(
                "POST",
                "/api/ingest",
                body=body,
                headers={
                    "Content-Type": "application/json",
                    "X-Homepanel-Key": "s3cr3t",
                },
                encode_chunked=True,
            )
            resp = conn.getresponse()
            self.assertEqual(resp.status, 200)
            self.assertTrue(json.loads(resp.read())["ok"])
        finally:
            conn.close()

    def test_ingest_rejects_malformed_chunk(self):
        request = (
            b"POST /api/ingest HTTP/1.1\r\n"
            b"Host: 127.0.0.1\r\n"
            b"X-Homepanel-Key: s3cr3t\r\n"
            b"Transfer-Encoding: chunked\r\n\r\n"
            b"zz\r\n"
        )
        with socket.create_connection(("127.0.0.1", self.port), timeout=5) as sock:
            sock.sendall(request)
            data = sock.recv(4096)
        self.assertIn(b"400", data.split(b"\r\n", 1)[0])

    def test_oversized_body_rejected(self):  # Review Focus 2
        with self.assertRaises(urllib.error.HTTPError) as e:
            self._post(b"x" * (2 * 1024 * 1024), key="s3cr3t")
        self.assertEqual(e.exception.code, 413)

    def test_static_path_traversal_blocked(self):  # Review Focus 1
        secret_file = os.path.join(os.path.dirname(self.cfg.static_dir), "secret.txt")
        with open(secret_file, "w") as f:
            f.write("nope")
        with self.assertRaises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(self.base + "/../secret.txt")
        self.assertEqual(e.exception.code, 404)

    def test_update_device_and_stats_endpoints(self):
        req = urllib.request.Request(
            self.base + "/api/devices",
            data=json.dumps(
                {"mac": "aa:bb:cc:dd:ee:ff", "name": "Телефон", "person": "Иван"}
            ).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        self.assertEqual(json.loads(urllib.request.urlopen(req).read())["name"], "Телефон")
        rows = json.loads(
            urllib.request.urlopen(
                self.base + "/api/stats?group=day&from=2026-10-14&to=2026-10-14"
            ).read()
        )
        self.assertEqual(rows, [])

    def _post_device(self, body):
        req = urllib.request.Request(
            self.base + "/api/devices",
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        return urllib.request.urlopen(req)

    def test_handler_has_connection_timeout(self):  # Review I4
        handler = self.app.make_handler()
        self.assertIsNotNone(getattr(handler, "timeout", None))
        self.assertLessEqual(handler.timeout, 60)

    def test_update_device_rejects_invalid_input(self):  # Review I6
        for body in (
            {"mac": "zz"},
            {"mac": "aa:bb:cc:dd:ee:ff", "trust": "bogus"},
            {"mac": "aa:bb:cc:dd:ee:ff", "kind": "toaster"},
        ):
            with self.assertRaises(urllib.error.HTTPError) as e:
                self._post_device(body)
            self.assertEqual(e.exception.code, 400)

    def test_update_device_coerces_hidden_to_bool(self):  # Review I6
        out = json.loads(
            self._post_device({"mac": "aa:bb:cc:dd:ee:ff", "hidden": "false"}).read()
        )
        self.assertIs(out["hidden"], False)

    def test_events_since_and_limit(self):  # Review I7
        mac = "aa:bb:cc:dd:ee:ff"
        self.store.add_event(mac, "arrived", 1000)
        self.store.add_event(mac, "left", 1100)
        self.store.add_event(mac, "arrived", 1200)
        rows = json.loads(
            urllib.request.urlopen(self.base + "/api/events?since=1&limit=1").read()
        )
        self.assertEqual([r["id"] for r in rows], [2])
        rows = json.loads(urllib.request.urlopen(self.base + "/api/events?limit=2").read())
        self.assertEqual([r["id"] for r in rows], [2, 3])

    # -- аналитика и телеметрия -----------------------------------------

    def _get(self, path):
        return json.loads(urllib.request.urlopen(self.base + path).read())

    def _fixed_noon(self):
        return int(time.mktime((2026, 10, 14, 12, 0, 0, 0, 0, -1)))

    def test_ingest_stores_signal_samples(self):
        body = json.dumps(
            {
                "schema": 1,
                "clients": [{"mac": "aa:bb:cc:dd:ee:ff", "signal": -55}],
            }
        ).encode()
        self._post(body, key="s3cr3t").read()
        points = self.store.signal_series("aa:bb:cc:dd:ee:ff", 0, 2**31)
        self.assertEqual([p["signal"] for p in points], [-55])

    def test_state_reports_today_minutes_per_person(self):
        mac = "aa:bb:cc:dd:ee:ff"
        fixed = self._fixed_noon()
        self.app.clock = lambda: fixed
        self.store.upsert_device(mac, person="Иван")
        self.store.mark_minute(mac, fixed)

        state = self._get("/api/state")
        self.assertEqual(state["people"][0]["today_minutes"], 1)

    def test_timeline_groups_consecutive_minutes(self):
        mac = "aa:bb:cc:dd:ee:ff"
        fixed = self._fixed_noon()
        self.store.mark_minute(mac, fixed - 120)
        self.store.mark_minute(mac, fixed - 60)
        day = time.strftime("%Y-%m-%d", time.localtime(fixed))

        data = self._get(f"/api/timeline?day={day}&mac={mac}")
        self.assertEqual(
            data["intervals"], [{"from": fixed - 120, "to": fixed}]
        )

        with self.assertRaises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(self.base + "/api/timeline?day=14.10.2026")
        self.assertEqual(e.exception.code, 400)

    def test_analytics_endpoint(self):
        mac = "aa:bb:cc:dd:ee:ff"
        fixed = self._fixed_noon()
        self.app.clock = lambda: fixed
        self.store.mark_minute(mac, fixed)
        self.store.add_event(mac, "arrived", fixed)

        data = self._get("/api/analytics?days=7")
        self.assertEqual(data["days"], 7)
        self.assertEqual(len(data["events_by_hour"]), 24)
        self.assertEqual(sum(r["arrived"] for r in data["events_by_hour"]), 1)
        self.assertEqual(data["occupancy"][-1]["devices"], 1)
        self.assertIn("new_devices", data)

    def test_signal_endpoint(self):
        mac = "aa:bb:cc:dd:ee:ff"
        self.store.add_signal_sample(mac, int(time.time()) - 60, -40)

        data = self._get(f"/api/signal?mac={mac}&hours=24")
        self.assertEqual(data["mac"], mac)
        self.assertEqual(data["points"][-1]["signal"], -40)

        with self.assertRaises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(self.base + "/api/signal?mac=zz")
        self.assertEqual(e.exception.code, 400)

    def test_device_hours_returns_24_buckets(self):
        mac = "aa:bb:cc:dd:ee:ff"
        self.store.mark_minute(mac, int(time.time()) - 60)

        data = self._get("/api/device_hours?hours=24")
        self.assertEqual(data["hours"], 24)
        self.assertEqual(len(data["series"][mac]), 24)
        self.assertEqual(sum(data["series"][mac]), 1)

    # -- разметка, правила и резервные копии ------------------------------

    def _api(self, path, method="GET", body=None):
        data = None if body is None else json.dumps(body).encode()
        headers = {"Content-Type": "application/json"} if data else {}
        req = urllib.request.Request(
            self.base + path, data=data, headers=headers, method=method
        )
        return json.loads(urllib.request.urlopen(req).read())

    def test_delete_device(self):
        mac = "aa:bb:cc:dd:ee:ff"
        self.store.upsert_device(mac, name="X")

        self.assertEqual(self._api(f"/api/devices?mac={mac}", "DELETE")["deleted"], 1)
        self.assertEqual(self._api("/api/devices"), [])

        with self.assertRaises(urllib.error.HTTPError) as e:
            self._api("/api/devices", "DELETE")
        self.assertEqual(e.exception.code, 400)

    def test_bulk_devices_update_and_delete(self):
        first = "aa:bb:cc:dd:ee:01"
        second = "aa:bb:cc:dd:ee:02"

        out = self._api(
            "/api/devices/bulk",
            "POST",
            {"macs": [first, second], "fields": {"person": "Иван", "trust": "own"}},
        )
        self.assertEqual(out["updated"], 2)
        rows = {row["mac"]: row for row in self._api("/api/devices")}
        self.assertEqual(rows[first]["person"], "Иван")
        self.assertEqual(rows[second]["trust"], "own")

        out = self._api("/api/devices/bulk", "POST", {"macs": [first], "delete": True})
        self.assertEqual(out["deleted"], 1)
        self.assertNotIn(first, {row["mac"] for row in self._api("/api/devices")})

    def test_bulk_rejects_bad_mac(self):
        with self.assertRaises(urllib.error.HTTPError) as e:
            self._api(
                "/api/devices/bulk",
                "POST",
                {"macs": ["zz"], "fields": {"person": "A"}},
            )
        self.assertEqual(e.exception.code, 400)

    def test_rules_apply_on_ingest(self):
        self._api(
            "/api/rules",
            "POST",
            {"pattern": "iphone*", "person": "Иван", "kind": "phone", "trust": "own"},
        )
        body = json.dumps(
            {
                "schema": 1,
                "clients": [{"mac": "aa:bb:cc:dd:ee:ff", "hostname": "iPhone-Ivan"}],
            }
        ).encode()
        self._post(body, key="s3cr3t").read()

        rows = {row["mac"]: row for row in self._api("/api/devices")}
        row = rows["aa:bb:cc:dd:ee:ff"]
        self.assertEqual(row["person"], "Иван")
        self.assertEqual(row["kind"], "phone")
        self.assertEqual(row["trust"], "own")

    def test_rules_do_not_override_manual_markup(self):
        mac = "aa:bb:cc:dd:ee:01"
        self.store.upsert_device(mac, person="Мария", name="Phone")
        self._api("/api/rules", "POST", {"pattern": "*", "person": "Иван"})
        body = json.dumps(
            {"schema": 1, "clients": [{"mac": mac, "hostname": "x"}]}
        ).encode()
        self._post(body, key="s3cr3t").read()

        row = {r["mac"]: r for r in self._api("/api/devices")}[mac]
        self.assertEqual(row["person"], "Мария")

    def test_rules_crud(self):
        rule = self._api("/api/rules", "POST", {"pattern": "tv-*", "kind": "tv"})["rule"]
        self.assertEqual(self._api("/api/rules")["rules"][0]["pattern"], "tv-*")
        self.assertEqual(self._api(f"/api/rules?id={rule['id']}", "DELETE")["deleted"], 1)

        with self.assertRaises(urllib.error.HTTPError) as e:
            self._api("/api/rules", "POST", {"person": "A"})
        self.assertEqual(e.exception.code, 400)

    def test_backup_restore_roundtrip(self):
        mac = "aa:bb:cc:dd:ee:01"
        self.store.upsert_device(mac, name="Телефон", person="Иван", hidden=True)
        self._api("/api/rules", "POST", {"pattern": "iphone*", "person": "Иван"})

        data = self._api("/api/backup")
        self.assertEqual(data["version"], 1)
        self.assertEqual(len(data["devices"]), 1)

        self.store.forget_device(mac)
        self.store.replace_rules([])
        out = self._api("/api/backup", "POST", data)
        self.assertEqual(out["devices"], 1)
        self.assertEqual(out["rules"], 1)
        row = self.store.get_device(mac)
        self.assertEqual(row["person"], "Иван")
        self.assertTrue(row["hidden"])

    def test_calendar_shape(self):
        mac = "aa:bb:cc:dd:ee:ff"
        self.store.mark_minute(mac, self._fixed_noon())

        data = self._api("/api/calendar?month=2026-10")
        self.assertEqual(data["month"], "2026-10")
        self.assertEqual(len(data["days"]), 31)
        self.assertEqual(data["total"], 1)

        with self.assertRaises(urllib.error.HTTPError) as e:
            self._api("/api/calendar?month=2026-13")
        self.assertEqual(e.exception.code, 400)

    def test_compare_shape(self):
        data = self._api("/api/compare?days=7")
        self.assertEqual(data["days"], 7)
        self.assertIsInstance(data["people"], list)
        self.assertIn("prev_total", data)

    def test_anomalies_shape(self):
        data = self._api("/api/anomalies")
        self.assertIn("now", data)
        self.assertIsInstance(data["items"], list)


if __name__ == "__main__":
    unittest.main()
