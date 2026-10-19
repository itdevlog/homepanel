#!/usr/bin/ucode
//
// homepanel-agent — снимает список подключённых к WiFi клиентов роутера
// и (в следующих задачах) отправляет снимок на сервер Home Panel.
//
// Спека: docs/superpowers/specs/2026-10-18-homepanel-design.md (§5, §6)

import { readfile, lsdir, popen, writefile, chmod, unlink } from 'fs';

const VERSION = '1.0';
const DEFAULT_LEASES = '/tmp/dhcp.leases';
const DEFAULT_STATUS = '/tmp/homepanel.status';
const DEFAULT_BODY = '/tmp/homepanel.body.json';
const DEFAULT_INTERVAL = 30;
const HTTP_TIMEOUT = 15;
const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;

let opts = {
	once: false,
	send: false,
	ubus_dir: null,
	leases: null,
	now: null,
	config_json: null,
	status: null,
	server_url: null,
	secret: null,
	interval: null,
	ubus_object: false,
};

function usage() {
	warn("usage: agent.uc [--once] [--send] [--config-json PATH] [--status PATH]\n" +
	     "                [--ubus-dir DIR] [--leases PATH] [--now TS]\n" +
	     "                [--server-url URL] [--secret KEY] [--interval SEC]\n" +
	     "                [--ubus-object]\n");
}

// --- утилиты -----------------------------------------------------------

function read_file(path) {
	try {
		return readfile(path);
	} catch (e) {
		return null;
	}
}

function run_capture(cmd) {
	let h = popen(cmd, 'r');
	if (h == null)
		return null;
	let out = null;
	try {
		out = h.read('all');
	} catch (e) {
		out = null;
	}
	h.close();
	return out;
}

function hostname() {
	let h = read_file('/proc/sys/kernel/hostname');
	if (h == null)
		return 'OpenWrt';
	h = trim(h);
	return h == '' ? 'OpenWrt' : h;
}

// --- сбор данных -------------------------------------------------------

function list_bss() {
	let names = [];

	// Тестовый режим: имена BSS берём из имён файлов фикстур.
	if (opts.ubus_dir != null) {
		let files = null;
		try {
			files = lsdir(opts.ubus_dir);
		} catch (e) {
			files = null;
		}
		if (files == null)
			return [];
		for (let i = 0; i < length(files); i++) {
			let m = match(files[i], /^get_clients_(.+)\.json$/);
			if (m != null)
				push(names, m[1]);
		}
		return sort(names);
	}

	let out = run_capture("ubus list 'hostapd.*'");
	if (out == null)
		return [];

	let lines = split(out, "\n");
	for (let i = 0; i < length(lines); i++) {
		let name = trim(lines[i]);
		// Служебные объекты hostapd и hostapd-auth — не точки доступа.
		if (name == '' || name == 'hostapd' || name == 'hostapd-auth')
			continue;
		if (match(name, /^hostapd\./) == null)
			continue;
		push(names, name);
	}
	return sort(names);
}

function get_bss_clients(bss) {
	let raw = null;
	if (opts.ubus_dir != null)
		raw = read_file(sprintf("%s/get_clients_%s.json", opts.ubus_dir, bss));
	else
		raw = run_capture(sprintf("ubus call %s get_clients", bss));

	if (raw == null)
		return null;
	try {
		return json(raw);
	} catch (e) {
		return null;
	}
}

function read_leases(path) {
	let leases = {};
	let raw = read_file(path);
	if (raw == null)
		return leases;

	let lines = split(raw, "\n");
	for (let i = 0; i < length(lines); i++) {
		let parts = split(trim(lines[i]), / +/);
		if (length(parts) < 4)
			continue;
		let mac = lc(parts[1]);
		if (match(mac, MAC_RE) == null)
			continue;
		leases[mac] = { ip: parts[2], hostname: parts[3] };
	}
	return leases;
}

function band_of(freq) {
	freq = int(freq);
	if (freq >= 5925)
		return '6';
	if (freq >= 4900)
		return '5';
	if (freq >= 2400)
		return '2.4';
	return '?';
}

// Объединяет клиентов всех BSS по MAC (при дубле оставляет сильнейший
// сигнал) и обогащает их данными DHCP-арен.
function collect(env) {
	let leases = read_leases(env.leases);
	let by_mac = {};
	let bss_list = list_bss();

	for (let i = 0; i < length(bss_list); i++) {
		let bss = bss_list[i];
		let data = get_bss_clients(bss);
		if (data == null || type(data.clients) != 'object')
			continue;

		for (let mac in data.clients) {
			let key = lc(mac);
			let info = data.clients[mac];
			let signal = (info != null && info.signal != null) ? int(info.signal) : null;

			let prev = by_mac[key];
			if (prev != null) {
				let prev_sig = prev.signal != null ? prev.signal : -999;
				let cur_sig = signal != null ? signal : -999;
				if (prev_sig >= cur_sig)
					continue;
			}

			let client = {
				mac: key,
				bss: bss,
				band: band_of(data.freq),
				signal: signal,
				ip: null,
				hostname: null,
			};

			let lease = leases[key];
			if (lease != null) {
				client.ip = lease.ip;
				client.hostname = lease.hostname;
			}

			// Спека §5: connected_at — только если роутер сообщил время.
			if (info != null && info.connected_time != null) {
				let ct = int(info.connected_time);
				if (ct >= 0)
					client.connected_at = env.now - ct;
			}

			by_mac[key] = client;
		}
	}

	let clients = values(by_mac);
	return sort(clients, function(a, b) {
		if (a.mac < b.mac)
			return -1;
		if (a.mac > b.mac)
			return 1;
		return 0;
	});
}

function snapshot(env) {
	return {
		schema: 1,
		agent: {
			hostname: env.hostname,
			version: VERSION,
			ts: env.now,
		},
		clients: collect(env),
	};
}

// --- конфигурация ------------------------------------------------------

function status_path() {
	return opts.status != null ? opts.status : DEFAULT_STATUS;
}

function body_path() {
	return opts.status != null ? opts.status + '.body' : DEFAULT_BODY;
}

function have_cmd(name) {
	return system(sprintf("command -v %s >/dev/null 2>&1", name)) == 0;
}

let _post_file_supported = null;

// busybox wget не умеет --post-file; GNU wget умеет.
function supports_post_file() {
	if (_post_file_supported == null)
		_post_file_supported = system("wget --help 2>&1 | grep -q -- --post-file") == 0;
	return _post_file_supported;
}

function read_status() {
	let raw = read_file(status_path());
	if (raw == null)
		return null;
	try {
		return json(raw);
	} catch (e) {
		return null;
	}
}

function write_status(st) {
	try {
		writefile(status_path(), sprintf("%J\n", st));
	} catch (e) {
		warn(sprintf("не удалось записать статус %s: %s\n", status_path(), e));
	}
}

// Тестовый шов (Ruling R2): JSON-файл вместо UCI-конфига.
function read_json_config(path) {
	let cfg = { enabled: true, server_url: '', secret: '', interval: DEFAULT_INTERVAL };
	let raw = read_file(path);
	if (raw == null)
		return cfg;
	try {
		let data = json(raw);
		if (type(data) == 'object') {
			if (data.enabled != null)
				cfg.enabled = (data.enabled === true || data.enabled === 1 ||
				               data.enabled === '1' || data.enabled === 'true');
			if (data.server_url != null)
				cfg.server_url = data.server_url;
			if (data.secret != null)
				cfg.secret = data.secret;
			if (data.interval != null)
				cfg.interval = int(data.interval);
		}
	} catch (e) {
		warn(sprintf("не удалось разобрать %s: %s\n", path, e));
	}
	return cfg;
}

function read_uci_config() {
	let cfg = { enabled: true, server_url: '', secret: '', interval: DEFAULT_INTERVAL };

	let uci = null;
	try {
		uci = require('uci');
	} catch (e) {
		uci = null;
	}
	if (uci == null)
		return cfg;

	let cursor = null;
	try {
		cursor = uci.cursor();
	} catch (e) {
		cursor = null;
	}
	if (cursor == null)
		return cfg;

	let get = function(name) {
		try {
			return cursor.get('homepanel', 'main', name);
		} catch (e) {
			return null;
		}
	};

	let enabled = get('enabled');
	if (enabled != null)
		cfg.enabled = (enabled != '0' && enabled != 'false');
	let server_url = get('server_url');
	if (server_url != null)
		cfg.server_url = server_url;
	let secret = get('secret');
	if (secret != null)
		cfg.secret = secret;
	let interval = get('interval');
	if (interval != null)
		cfg.interval = int(interval);

	return cfg;
}

function read_config() {
	let path = opts.config_json != null ? opts.config_json : getenv('HOMEPANEL_CONFIG');
	return path != null ? read_json_config(path) : read_uci_config();
}

function apply_overrides(cfg) {
	if (opts.server_url != null)
		cfg.server_url = opts.server_url;
	if (opts.secret != null)
		cfg.secret = opts.secret;
	if (opts.interval != null)
		cfg.interval = opts.interval;
}

// --- отправка ----------------------------------------------------------

// Экранирует произвольную строку для передачи в shell одной командой.
// Проверено: replace(s, "'", "'\\''") даёт корректную последовательность.
function sh_quote(s) {
	return "'" + replace(s, "'", "'\\''") + "'";
}

// Отправляет снимок на сервер. Никогда не бросает исключений; возвращает
// { configured, ok, code, error }.
function send_snapshot(cfg, snap) {
	let url = cfg.server_url != null ? trim(cfg.server_url) : '';
	let secret = cfg.secret != null ? cfg.secret : '';

	if (url == '' || secret == '')
		return { configured: false, ok: false, code: 0,
		         error: 'не настроен: укажите server_url и secret' };

	let bp = body_path();
	let out_file = bp + '.out';
	let res_file = bp + '.res';

	try {
		writefile(bp, sprintf("%J", snap));
		chmod(bp, 0o600);
	} catch (e) {
		return { configured: true, ok: false, code: 0,
		         error: sprintf("не удалось записать тело запроса: %s", e) };
	}

	// Все подставляемые значения экранируются: секрет и URL приходят из
	// конфигурации и не должны попадать в shell как исполняемый код.
	let q_out = sh_quote(out_file);
	let q_body = sh_quote(bp);
	let q_res = sh_quote(res_file);
	let q_url = sh_quote(url);
	let hdr_ct = sh_quote("Content-Type: application/json");
	let hdr_key = sh_quote(sprintf("X-Homepanel-Key: %s", secret));

	let cmd;
	if (have_cmd('uclient-fetch'))
		cmd = sprintf("uclient-fetch -q -O %s -T %d --post-file=%s --header=%s --header=%s %s",
			q_out, HTTP_TIMEOUT, q_body, hdr_ct, hdr_key, q_url);
	else if (supports_post_file())
		cmd = sprintf("wget -q -O %s -T %d --post-file=%s --header=%s --header=%s %s",
			q_out, HTTP_TIMEOUT, q_body, hdr_ct, hdr_key, q_url);
	else
		cmd = sprintf("wget -q -O %s -T %d --post-data=\"$(cat %s)\" --header=%s --header=%s %s",
			q_out, HTTP_TIMEOUT, q_body, hdr_ct, hdr_key, q_url);

	let rc = system(sprintf("%s > %s 2>&1", cmd, q_res));

	// HTTP-код — best-effort: он есть в выводе busybox при ошибке; иначе
	// считаем 200 только после успешного разбора тела ответа.
	let code = 0;
	let out = read_file(res_file);
	if (out != null) {
		let m = match(out, /HTTP\/[0-9.]+[ \t]+([0-9]{3})/);
		if (m != null)
			code = int(m[1]);
	}

	// Тело ответа обязано быть JSON-объектом с ok == true (спека §5).
	let body_raw = read_file(out_file);
	let body = null;
	if (body_raw != null) {
		try {
			body = json(body_raw);
		} catch (e) {
			body = null;
		}
	}

	let ok = false;
	let error = null;

	if (rc != 0) {
		let msg = out != null ? trim(out) : '';
		error = msg != '' ? msg : sprintf("команда отправки завершилась с кодом %d", rc);
	} else if (type(body) != 'object' || body.ok != true) {
		error = sprintf("некорректный ответ сервера: %s",
		                body_raw != null && trim(body_raw) != '' ? trim(body_raw) : '(пусто)');
	} else {
		ok = true;
		if (code == 0)
			code = 200;
	}

	try { unlink(bp); } catch (e) {}
	try { unlink(out_file); } catch (e) {}
	try { unlink(res_file); } catch (e) {}

	return { configured: true, ok: ok, code: code, error: error };
}

// Один цикл: снимок → отправка → запись статуса.
function run_cycle(env, cfg) {
	let snap = snapshot(env);
	let res = send_snapshot(cfg, snap);
	let prev = read_status();
	let last_send = res.ok ? env.now : (prev != null ? prev.last_send : null);

	write_status({
		enabled: cfg.enabled,
		configured: res.configured,
		ok: res.ok,
		last_send: last_send,
		client_count: length(snap.clients),
		version: VERSION,
		last_error: res.error,
	});

	return res;
}

// --- запуск ------------------------------------------------------------

function parse_args(args) {
	for (let i = 0; i < length(args); i++) {
		let a = args[i];
		if (a == '--once') {
			opts.once = true;
		} else if (a == '--send') {
			opts.send = true;
		} else if (a == '--ubus-object') {
			opts.ubus_object = true;
		} else if (a == '--config-json') {
			i++;
			opts.config_json = args[i];
		} else if (a == '--status') {
			i++;
			opts.status = args[i];
		} else if (a == '--server-url') {
			i++;
			opts.server_url = args[i];
		} else if (a == '--secret') {
			i++;
			opts.secret = args[i];
		} else if (a == '--interval') {
			i++;
			opts.interval = int(args[i]);
		} else if (a == '--ubus-dir') {
			i++;
			opts.ubus_dir = args[i];
		} else if (a == '--leases') {
			i++;
			opts.leases = args[i];
		} else if (a == '--now') {
			i++;
			opts.now = int(args[i]);
		} else if (a == '--version') {
			print(sprintf("homepanel-agent %s\n", VERSION));
			exit(0);
		} else {
			warn(sprintf("unknown argument: %s\n", a));
			usage();
			exit(2);
		}
	}
}

// --- ubus-объект -------------------------------------------------------

// Публикует объект homepanel (status / send). Возвращает соединение или
// null, если модуль ubus недоступен — агент продолжает работу без объекта.
function publish_object(env, cfg) {
	let ubus = null;
	try { ubus = require('ubus'); } catch (e) { ubus = null; }

	if (ubus == null || ubus.connect == null) {
		warn("homepanel: модуль ubus недоступен — объект homepanel не зарегистрирован\n");
		return null;
	}

	let conn = null;
	try { conn = ubus.connect(); } catch (e) { conn = null; }

	if (conn == null || conn.publish == null) {
		warn("homepanel: не удалось подключиться к ubus\n");
		return null;
	}

	let current_status = function() {
		let st = read_status();
		if (st == null) {
			return { enabled: cfg.enabled === true, configured: false, ok: false,
			         last_send: null, client_count: 0, version: VERSION,
			         last_error: null };
		}
		return st;
	};

	let fresh_env = function() {
		return {
			now: opts.now != null ? opts.now : int(time()),
			leases: env.leases,
			hostname: env.hostname,
		};
	};

	let methods = {
		status: {
			call: function(req) {
				let st = current_status();
				req.reply({
					configured: st.configured === true,
					enabled: st.enabled === true,
					last_send: st.last_send != null ? st.last_send : 0,
					client_count: st.client_count != null ? st.client_count : 0,
					version: st.version != null ? st.version : VERSION,
					last_error: st.last_error != null ? st.last_error : null,
				});
			},
		},
		send: {
			call: function(req) {
				let c = read_config();
				apply_overrides(c);
				let res = run_cycle(fresh_env(), c);
				req.reply({ ok: res.ok === true });
			},
		},
	};

	try {
		conn.publish('homepanel', methods);
	} catch (e) {
		warn(sprintf("homepanel: не удалось зарегистрировать ubus-объект: %s\n", e));
		return null;
	}

	warn("homepanel: ubus-объект homepanel зарегистрирован\n");
	return conn;
}

function main() {
	parse_args(ARGV);

	let cfg = read_config();
	apply_overrides(cfg);

	let env = {
		now: opts.now != null ? opts.now : int(time()),
		leases: opts.leases != null ? opts.leases : DEFAULT_LEASES,
		hostname: hostname(),
	};

	if (!cfg.enabled) {
		warn("homepanel: агент отключён (enabled = 0)\n");
		write_status({ enabled: false, configured: false, ok: false,
		               last_send: null, client_count: 0, version: VERSION,
		               last_error: null });
		exit(0);
	}

	let conn = null;
	if (opts.ubus_object)
		conn = publish_object(env, cfg);

	if (opts.send) {
		let res = run_cycle(env, cfg);
		if (!res.configured)
			warn("homepanel: не настроен — укажите server_url и secret\n");
		exit(0);
	}

	if (opts.once) {
		print(sprintf("%J\n", snapshot(env)));
		exit(0);
	}

	// Демон-режим: цикл с интервалом из конфига. Конфиг перечитывается на
	// каждом тике, поэтому изменения в LuCI применяются без перезапуска
	// сервиса (не позже следующего тика).
	let interval = cfg.interval > 0 ? cfg.interval : DEFAULT_INTERVAL;
	warn(sprintf("homepanel: запуск, интервал %d с\n", interval));

	let tick = function() {
		let current = read_config();
		apply_overrides(current);

		env.now = opts.now != null ? opts.now : int(time());
		let res = run_cycle(env, current);
		if (!res.ok)
			warn(sprintf("homepanel: отправка не удалась: %s\n",
			             res.error != null ? res.error : 'неизвестная ошибка'));

		return current.interval > 0 ? current.interval : DEFAULT_INTERVAL;
	};

	if (conn != null) {
		let uloop = null;
		try { uloop = require('uloop'); } catch (e) { uloop = null; }
		if (uloop != null && uloop.timer != null) {
			let timer = null;
			timer = uloop.timer(function() {
				let next = tick();
				timer.set(next * 1000);
			});
			timer.set(tick() * 1000);
			uloop.run();
			return;
		}
	}

	while (true) {
		system(sprintf("sleep %d", tick()));
	}
}

main();
