"""Точка входа сервера Home Panel.

Собирает компоненты (хранилище, автомат присутствия, приложение, планировщик),
поднимает HTTP-сервер и держит его до остановки.
"""

from __future__ import annotations

import argparse
import logging
import sys
from http.server import ThreadingHTTPServer

from homepanel.app import App
from homepanel.config import Config, load_config
from homepanel.presence import PresenceEngine
from homepanel.scheduler import Scheduler
from homepanel.store import Store

log = logging.getLogger("homepanel")


def build_app(config: Config) -> tuple[App, Scheduler]:
    """Собирает приложение и планировщик по конфигурации."""
    store = Store(config.db_path)
    engine = PresenceEngine(store, config.grace_seconds)
    app = App(config, store, engine)
    scheduler = Scheduler(
        store,
        engine,
        minute_days=config.minute_retention_days,
        daily_days=config.daily_retention_days,
        signal_days=config.signal_retention_days,
    )
    return app, scheduler


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Home Panel server")
    parser.add_argument("--config", default=None, help="путь к config.json")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    config = load_config(args.config)
    app, scheduler = build_app(config)

    server = ThreadingHTTPServer((config.host, config.port), app.make_handler())
    scheduler.start()
    log.info(
        "Home Panel слушает http://%s:%s (данные: %s)",
        config.host,
        config.port,
        config.db_path,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("Остановка по Ctrl+C")
    finally:
        scheduler.stop()
        server.server_close()
        app.store.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
