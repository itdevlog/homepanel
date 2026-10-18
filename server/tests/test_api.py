import json
import os
import tempfile
import threading
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


if __name__ == "__main__":
    unittest.main()
