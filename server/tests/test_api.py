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

    def _ingest(self, payload, now=1000):
        status, body = self.app.handle_ingest(
            json.dumps(payload).encode(), "s3cr3t", now
        )
        self.assertEqual(status, 200)
        return body

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

    def test_ingest_v2_records_everything_and_returns_control(self):
        self.store.set_control("aa:bb:cc:dd:ee:09", True, 1)
        payload = {
            "schema": 2,
            "agent": {"hostname": "r1", "version": "2.0", "ts": 1000},
            "clients": [
                {
                    "mac": "aa:bb:cc:dd:ee:01",
                    "link": "wired",
                    "rx_bytes": 10,
                    "tx_bytes": 20,
                }
            ],
            "router": {
                "uptime": 10,
                "load1": 0.1,
                "mem_total": 100,
                "mem_free": 50,
                "wan_up": True,
            },
            "acks": [],
        }
        out = self._ingest(payload)
        self.assertEqual(out["control"]["paused"], ["aa:bb:cc:dd:ee:09"])
        self.assertEqual(out["commands"], [])
        self.assertEqual(self.store.get_links()["aa:bb:cc:dd:ee:01"], "wired")
        self.assertIsNotNone(self.store.router_latest())
        self.assertNotEqual(
            self.store.traffic_series("aa:bb:cc:dd:ee:01", 0, 10**12), []
        )

    def test_ingest_v2_returns_pending_command_once(self):
        command = self.store.create_command("kick", "aa:bb:cc:dd:ee:01", 1000)
        out = self._ingest({"schema": 2, "agent": {}, "clients": []})
        self.assertEqual([c["id"] for c in out["commands"]], [command["id"]])
        out2 = self._ingest({"schema": 2, "agent": {}, "clients": []})
        self.assertEqual(out2["commands"], [])
        self.assertEqual(self.store.recent_commands(1)[0]["status"], "sent")

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

    def test_cleanup_prunes_old_data(self):
        mac = "aa:bb:cc:dd:ee:02"
        self.store.add_event(mac, "arrived", 1000)
        self.store.mark_minute(mac, 1000)
        out = self._api("/api/cleanup", "POST", {"days": 30})
        self.assertEqual(out["days"], 30)
        self.assertGreaterEqual(out["events"], 1)
        self.assertGreaterEqual(out["minutes"], 1)
        with self.assertRaises(urllib.error.HTTPError) as e:
            self._api("/api/cleanup", "POST", {"days": 0})
        self.assertEqual(e.exception.code, 400)

    def test_uptime_endpoint(self):
        now = int(time.time())
        self.store.mark_agent_seen(now)
        out = self._api("/api/uptime?days=7")
        self.assertEqual(out["days"], 7)
        self.assertTrue(out["online"])
        self.assertGreaterEqual(sum(row["minutes"] for row in out["series"]), 1)

    def test_changes_endpoint_records_update(self):
        mac = "aa:bb:cc:dd:ee:03"
        self.store.upsert_device(mac)
        self._api("/api/devices", "POST", {"mac": mac, "name": "Y"})
        data = self._api("/api/changes?limit=5")
        self.assertTrue(
            any(
                row["action"] == "device.update" and row["mac"] == mac
                for row in data["changes"]
            )
        )

    def test_database_export_and_import_validation(self):
        mac = "aa:bb:cc:dd:ee:04"
        self.store.upsert_device(mac, name="База")
        request = urllib.request.Request(self.base + "/api/db/export")
        data = urllib.request.urlopen(request).read()
        self.assertTrue(data.startswith(b"SQLite format 3\x00"))
        with self.assertRaises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(
                urllib.request.Request(
                    self.base + "/api/db/import",
                    data=b"not a database",
                    headers={"Content-Type": "application/octet-stream"},
                    method="POST",
                )
            )
        self.assertEqual(error.exception.code, 400)

    def test_guest_token_is_read_only(self):
        self.cfg.guest_token = "guest123"
        request = urllib.request.Request(
            self.base + "/api/state", headers={"X-Homepanel-Guest": "guest123"}
        )
        data = json.loads(urllib.request.urlopen(request).read())
        self.assertIn("people", data)

        with self.assertRaises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(
                urllib.request.Request(
                    self.base + "/api/rules",
                    data=b"{}",
                    headers={
                        "Content-Type": "application/json",
                        "X-Homepanel-Guest": "guest123",
                    },
                    method="POST",
                )
            )
        self.assertEqual(error.exception.code, 403)

        with self.assertRaises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(
                urllib.request.Request(
                    self.base + "/api/state", headers={"X-Homepanel-Guest": "wrong"}
                )
            )
        self.assertEqual(error.exception.code, 401)

        with self.assertRaises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(
                urllib.request.Request(
                    self.base + "/api/db/export",
                    headers={"X-Homepanel-Guest": "guest123"},
                )
            )
        self.assertEqual(error.exception.code, 403)

    def test_state_has_link_pause_router_and_commands(self):
        self.store.upsert_device("aa:bb:cc:dd:ee:01", name="PC")
        self.store.set_links("aa:bb:cc:dd:ee:01", "wired")
        self.store.set_control("aa:bb:cc:dd:ee:01", True, 1)
        self.store.record_router(
            1000,
            {
                "uptime": 5,
                "load1": 0.1,
                "mem_total": 10,
                "mem_free": 5,
                "wan_up": True,
            },
        )
        state = self._api("/api/state")
        device = next(d for d in state["devices"] if d["mac"] == "aa:bb:cc:dd:ee:01")
        self.assertEqual(device["link"], "wired")
        self.assertTrue(device["paused"])
        self.assertIn("router", state)
        self.assertIn("commands", state)

    def test_control_endpoints_and_guest_forbidden(self):
        self.store.upsert_device("aa:bb:cc:dd:ee:01", name="PC")
        out = self._api(
            "/api/control/pause", "POST", {"mac": "aa:bb:cc:dd:ee:01", "paused": True}
        )
        self.assertTrue(out["paused"])
        kick = self._api("/api/control/kick", "POST", {"mac": "aa:bb:cc:dd:ee:01"})
        self.assertEqual(kick["command"]["type"], "kick")
        restart = self._api("/api/control/restart", "POST", {})
        self.assertEqual(restart["command"]["type"], "restart")
        with self.assertRaises(urllib.error.HTTPError) as e:
            self._api("/api/control/pause", "POST", {"mac": "bad", "paused": True})
        self.assertEqual(e.exception.code, 400)
        self.cfg.guest_token = "guest123"
        req = urllib.request.Request(
            self.base + "/api/control/kick",
            data=json.dumps({"mac": "aa:bb:cc:dd:ee:01"}).encode(),
            headers={
                "Content-Type": "application/json",
                "X-Homepanel-Guest": "guest123",
            },
            method="POST",
        )
        with self.assertRaises(urllib.error.HTTPError) as g:
            urllib.request.urlopen(req)
        self.assertEqual(g.exception.code, 403)

    def test_router_history_and_traffic_endpoints(self):
        now = int(self.app.clock())
        self.store.record_router(
            now,
            {
                "uptime": 5,
                "load1": 0.1,
                "mem_total": 10,
                "mem_free": 5,
                "wan_up": True,
            },
        )
        history = self._api("/api/router/history?days=7")
        self.assertEqual(history["days"], 7)
        self.assertTrue(history["samples"])
        self.store.record_traffic(now - 60, [("aa:bb:cc:dd:ee:01", 100, 200)])
        self.store.record_traffic(now, [("aa:bb:cc:dd:ee:01", 150, 260)])
        traffic = self._api("/api/traffic?mac=aa:bb:cc:dd:ee:01&hours=1")
        self.assertEqual(traffic["mac"], "aa:bb:cc:dd:ee:01")

    def test_state_derives_infra_role_kind_and_rooms(self):
        now = int(self.app.clock())
        mac = "aa:bb:cc:dd:ee:71"
        self.store.set_presence(
            mac, state="home", last_seen=now, since=now,
            hostname="lamp-kitchen-01", link="wifi",
        )
        state = self._api("/api/state")
        row = next(d for d in state["devices"] if d["mac"] == mac)
        self.assertEqual(row["kind"], "light")
        self.assertEqual(row["role"], "infra")
        self.assertIn("infra", state)
        group = state["infra"][0]
        self.assertEqual(group["room"], "")
        self.assertEqual(group["online"], 1)
        self.assertEqual(group["total"], 1)

    def test_rule_sets_room_and_role(self):
        self._api(
            "/api/rules",
            "POST",
            {"pattern": "lamp-*", "kind": "iot", "room": "Кухня", "role": "infra"},
        )
        now = int(self.app.clock())
        mac = "aa:bb:cc:dd:ee:72"
        self._ingest(
            {
                "schema": 2,
                "agent": {"hostname": "r1", "version": "2.0", "ts": now},
                "clients": [{"mac": mac, "hostname": "lamp-kitchen-02"}],
            },
            now,
        )
        state = self._api("/api/state")
        row = next(d for d in state["devices"] if d["mac"] == mac)
        self.assertEqual(row["room"], "Кухня")
        self.assertEqual(row["role"], "infra")
        self.assertEqual(row["kind"], "iot")

    def test_unmerge_endpoint_restores_device(self):
        src, dst = "aa:bb:cc:dd:ee:81", "aa:bb:cc:dd:ee:82"
        self.store.upsert_device(src, name="Старый")
        self.store.upsert_device(dst, person="Иван")
        self._api("/api/devices", "POST", {"mac": src, "mergeInto": dst})

        state = self._api("/api/state")
        row = next(d for d in state["devices"] if d["mac"] == dst)
        self.assertEqual(row["merged"], [src])

        out = self._api("/api/devices/unmerge", "POST", {"mac": src})
        self.assertTrue(out["ok"])
        self.assertEqual(out["device"]["mac"], src)

        state = self._api("/api/state")
        dst_row = next(d for d in state["devices"] if d["mac"] == dst)
        self.assertEqual(dst_row["merged"], [])

    def test_state_uses_ap_names(self):
        now = int(self.app.clock())
        self.cfg.ap_names = {"phy0-ap0": "FREE"}
        self._ingest(
            {
                "schema": 2,
                "agent": {"hostname": "r1", "version": "2.0", "ts": now},
                "clients": [
                    {"mac": "aa:bb:cc:dd:ee:81", "bss": "phy0-ap0", "hostname": "lamp-1"}
                ],
            },
            now,
        )
        state = self._api("/api/state")
        row = next(d for d in state["devices"] if d["mac"] == "aa:bb:cc:dd:ee:81")
        self.assertEqual(row["bss_name"], "FREE")

    def test_merged_alias_is_hidden_and_promotes_presence(self):
        target = "aa:bb:cc:dd:ee:90"
        alias = "aa:bb:cc:dd:ee:91"
        now = int(self.app.clock())
        self.store.upsert_device(target, name="Телефон", person="Иван")
        self.store.upsert_device(alias)
        self._api("/api/devices", "POST", {"mac": alias, "mergeInto": target})
        self.store.set_presence(
            alias,
            state="home",
            last_seen=now,
            since=now,
            hostname="Redmi",
            ip="192.168.1.5",
        )

        data = self._api("/api/state")
        macs = [row["mac"] for row in data["devices"]]
        self.assertNotIn(alias, macs)
        row = next(item for item in data["devices"] if item["mac"] == target)
        self.assertEqual(row["state"], "home")
        self.assertEqual(row["merged"], [alias])

    def test_ap_names_endpoint_overrides_state(self):
        mac = "aa:bb:cc:dd:ee:95"
        now = int(self.app.clock())
        self.store.set_presence(
            mac, state="home", last_seen=now, since=now, bss="phy0-ap0", link="wifi"
        )
        self._api("/api/ap-names", "POST", {"bss": "phy0-ap0", "name": "FREE"})
        data = self._api("/api/state")
        row = next(item for item in data["devices"] if item["mac"] == mac)
        self.assertEqual(row["bss_name"], "FREE")
        self._api("/api/ap-names", "POST", {"bss": "phy0-ap0", "name": ""})
        data = self._api("/api/state")
        row = next(item for item in data["devices"] if item["mac"] == mac)
        self.assertEqual(row["bss_name"], "phy0-ap0")

    def test_meta_rooms_types_and_icon_state(self):
        mac = "aa:bb:cc:dd:ee:96"
        now = int(self.app.clock())
        meta = self._api("/api/meta")
        self.assertIn("phone", {item["key"] for item in meta["types"]})
        self._api("/api/rooms", "POST", {"name": "Кухня"})
        self._api(
            "/api/types", "POST", {"key": "lamp", "label": "Лампа", "icon": "light"}
        )
        self.store.upsert_device(mac, kind="lamp", room="Кухня")
        self.store.set_presence(
            mac, state="home", last_seen=now, since=now, bss="phy0-ap0", link="wifi"
        )
        data = self._api("/api/state")
        row = next(item for item in data["devices"] if item["mac"] == mac)
        self.assertEqual(row["icon"], "light")
        self.assertEqual(row["room"], "Кухня")

    def test_infra_rooms_follow_dictionary_order(self):
        now = int(self.app.clock())
        self.store.add_room("Спальня", 1, now)
        self.store.add_room("Кухня", 2, now)
        for mac, room in (
            ("aa:bb:cc:dd:ee:71", "Спальня"),
            ("aa:bb:cc:dd:ee:72", "Кухня"),
        ):
            self.store.upsert_device(mac, role="infra", room=room)
            self.store.set_presence(
                mac, state="home", last_seen=now, since=now, link="wifi"
            )
        data = self._api("/api/state")
        self.assertEqual(
            [item["room"] for item in data["infra"]], ["Спальня", "Кухня"]
        )

    def test_ingest_nlbw_flows_to_state_and_traffic(self):
        mac = "aa:bb:cc:dd:ee:97"
        now = int(self.app.clock())
        base = {
            "schema": 2,
            "agent": {"hostname": "r1", "version": "2.1", "ts": now},
            "clients": [{"mac": mac, "link": "wifi"}],
        }
        self._ingest(
            {**base, "nlbw": {mac: {"rx_bytes": 1000, "tx_bytes": 2000}}},
            now - 60,
        )
        self._ingest(
            {**base, "nlbw": {mac: {"rx_bytes": 1500, "tx_bytes": 2600}}},
            now,
        )
        data = self._api("/api/state")
        row = next(item for item in data["devices"] if item["mac"] == mac)
        self.assertEqual((row["rx_bytes"], row["tx_bytes"]), (500, 600))
        self.assertEqual(row["traffic_source"], "nlbw")
        self.assertEqual(data["traffic_source"], "nlbw")
        traffic = self._api(f"/api/traffic?mac={mac}&hours=1")
        self.assertEqual(traffic["source"], "nlbw")
        self.assertEqual(sum(item["rx_bytes"] for item in traffic["samples"]), 500)

    def test_light_groups_events_and_stats(self):
        now = int(self.app.clock())
        first = "aa:bb:cc:dd:ee:80"
        second = "aa:bb:cc:dd:ee:81"
        self.store.upsert_device(first, kind="light", room="Кухня")
        self.store.upsert_device(second, room="Кухня")
        for mac, hostname in ((first, "Camelion-1"), (second, "Camelion-2")):
            self.store.set_presence(
                mac, state="home", last_seen=now, since=now,
                hostname=hostname, link="wifi",
            )

        self.app._update_lights(now)
        light = self._api("/api/state")["lights"][0]
        self.assertEqual(light["room"], "Кухня")
        self.assertTrue(light["on"])
        self.assertEqual(light["online"], 2)
        self.assertEqual(light["total"], 2)

        for mac in (first, second):
            self.store.set_presence(mac, state="away", last_seen=now, since=now)
        self.app._update_lights(now + 10)
        events = self._api("/api/lights/events?limit=5")
        self.assertEqual(events["events"][0]["state"], "off")
        self.assertEqual(events["events"][0]["room"], "Кухня")

        self.store.mark_minute(first, now // 60 * 60)
        stats = self._api("/api/lights/stats?days=1")
        self.assertEqual(stats["days"], 1)
        room = stats["rooms"][0]
        self.assertEqual(room["room"], "Кухня")
        self.assertGreaterEqual(room["total"], 1)

    def test_merged_alias_history_counts_for_person(self):
        source = "aa:bb:cc:dd:ee:a0"
        target = "aa:bb:cc:dd:ee:a1"
        now = int(self.app.clock())
        self.store.upsert_device(source, person="Иван")
        self.store.upsert_device(target)
        self._api("/api/devices", "POST", {"mac": source, "mergeInto": target})
        self.store.mark_minute(source, (now - 60) // 60 * 60)
        data = self._api("/api/state")
        person = next(item for item in data["people"] if item["person"] == "Иван")
        self.assertGreaterEqual(person["today_minutes"], 1)
        self.assertIn(source, person["devices"][0]["merged"])

    def test_forecast_includes_merged_alias_arrivals(self):
        source = "aa:bb:cc:dd:ee:a2"
        target = "aa:bb:cc:dd:ee:a3"
        now = int(self.app.clock())
        self.store.upsert_device(source, person="Иван")
        self.store.upsert_device(target)
        self.app._forecast(now)  # прогреваем пустой кэш
        self._api("/api/devices", "POST", {"mac": source, "mergeInto": target})
        for days in (7, 14):
            self.store.add_event(source, "arrived", now - days * 86400)
        forecast = self.app._forecast(now)
        self.assertIn("Иван", forecast)

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
