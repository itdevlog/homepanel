import os
import tempfile
import unittest

from homepanel.config import load_config
from server import build_app


class EntryTest(unittest.TestCase):
    def test_build_app_wires_components(self):
        with tempfile.TemporaryDirectory() as d:
            cfg = load_config(None)
            cfg.db_path = os.path.join(d, "t.sqlite3")
            app, sched = build_app(cfg)
            self.assertIsNotNone(app.make_handler())
            self.assertEqual(sched.run_once(0)["expired"], 0)
            app.store.close()


if __name__ == "__main__":
    unittest.main()
