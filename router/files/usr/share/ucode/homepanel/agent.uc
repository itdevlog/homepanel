#!/usr/bin/ucode
//
// homepanel-agent — снимает список подключённых к WiFi клиентов роутера
// и (в следующих задачах) отправляет снимок на сервер Home Panel.
//
// Спека: docs/superpowers/specs/2026-10-18-homepanel-design.md (§5, §6)

import { readfile, lsdir, popen, writefile, chmod, unlink } from 'fs';

const VERSION = '2.1';
const DEFAULT_LEASES = '/tmp/dhcp.leases';
const DEFAULT_LOADAVG = '/proc/loadavg';
const DEFAULT_STATUS = '/tmp/homepanel.status';
const DEFAULT_BODY = '/tmp/homepanel.body.json';
const DEFAULT_INTERVAL = 30;
const HTTP_TIMEOUT = 15;
const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;

let opts = {
	once: false,
	send: false,
	ubus_dir: null,
	nft: null,
	ubus: null,
	fdb: null,
	neigh: null,
	bridge: null,
	ip: null,
	leases: null,
	loadavg: null,
	nlbw: null,
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
	     "                [--ubus-dir DIR] [--leases PATH] [--loadavg PATH] [--now TS]\n" +
	     "                [--fdb PATH] [--neigh PATH] [--bridge PATH] [--ip PATH]\n" +
	     "                [--nlbw PATH] [--server-url URL] [--secret KEY] [--interval SEC]\n" +
	     "                [--nft PATH] [--ubus PATH] [--ubus-object]\n");
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

// Счётчики трафика WiFi-клиентов по BSS: {mac: {rx_bytes, tx_bytes}}.
function assoc_traffic(bss) {
	let raw = null;
	if (opts.ubus_dir != null)
		raw = read_file(sprintf("%s/assoclist_%s.json", opts.ubus_dir, bss));
	else
		raw = run_capture(sprintf("ubus call iwinfo assoclist '{\"device\":\"%s\"}'", bss));

	if (raw == null)
		return {};
	let data = null;
	try {
		data = json(raw);
	} catch (e) {
		return {};
	}
	if (data == null || type(data.results) != 'array')
		return {};

	let out = {};
	for (let i = 0; i < length(data.results); i++) {
		let item = data.results[i];
		if (item == null || item.mac == null)
			continue;
		out[lc(item.mac)] = {
			rx_bytes: (item.rx != null && item.rx.bytes != null) ? int(item.rx.bytes) : null,
			tx_bytes: (item.tx != null && item.tx.bytes != null) ? int(item.tx.bytes) : null,
		};
	}
	return out;
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
function read_fdb() {
	let raw = null;
	if (opts.fdb != null) {
		raw = read_file(opts.fdb);
	} else {
		raw = run_capture(sprintf("%s fdb show br-lan",
			opts.bridge != null ? opts.bridge : 'bridge'));
		if (raw == null)
			raw = run_capture("brctl showmacs br-lan");
	}
	if (raw == null)
		return [];

	let macs = {};
	let lines = split(raw, "\n");
	for (let i = 0; i < length(lines); i++) {
		let line = trim(lines[i]);
		if (line == '')
			continue;
		let parts = split(line, / +/);
		let mac = null;
		for (let j = 0; j < length(parts); j++) {
			let low = lc(parts[j]);
			if (match(low, MAC_RE) != null) {
				mac = low;
				break;
			}
		}
		if (mac == null)
			continue;
		if (match(line, /(^| )self( |$)/) != null)
			continue;
		if (match(line, /(^| )local( |$)/) != null)
			continue;
		if (match(line, /(^| )permanent( |$)/) != null)
			continue;
		// multicast: младший бит первого октета
		if (match(substr(mac, 1, 1), /[13579bdf]/) != null)
			continue;
		macs[mac] = true;
	}
	return keys(macs);
}

function read_neigh() {
	let raw = null;
	if (opts.neigh != null) {
		raw = read_file(opts.neigh);
	} else {
		raw = run_capture(sprintf("%s neigh show dev br-lan",
			opts.ip != null ? opts.ip : 'ip'));
	}
	if (raw == null)
		return {};

	let states = { REACHABLE: true, STALE: true, DELAY: true, PROBE: true };
	let out = {};
	let lines = split(raw, "\n");
	for (let i = 0; i < length(lines); i++) {
		let parts = split(trim(lines[i]), / +/);
		if (length(parts) < 4)
			continue;
		let state = parts[length(parts) - 1];
		if (states[state] == null)
			continue;
		let mac = null;
		for (let j = 1; j + 1 < length(parts); j++)
			if (parts[j] == 'lladdr')
				mac = lc(parts[j + 1]);
		if (mac == null || match(mac, MAC_RE) == null)
			continue;
		out[mac] = parts[0];
	}
	return out;
}

function collect_wired(leases, wifi_macs) {
	let neigh = read_neigh();
	let macs = read_fdb();
	let out = [];
	for (let i = 0; i < length(macs); i++) {
		let mac = macs[i];
		if (wifi_macs[mac] != null)
			continue;
		let lease = leases[mac];
		push(out, {
			mac: mac,
			bss: null,
			band: null,
			signal: null,
			ip: neigh[mac] != null ? neigh[mac] : (lease != null ? lease.ip : null),
			hostname: lease != null ? lease.hostname : null,
			link: 'wired',
		});
	}
	return out;
}

function collect(env, cfg) {
	let leases = read_leases(env.leases);
	let by_mac = {};
	let bss_list = list_bss();

	for (let i = 0; i < length(bss_list); i++) {
		let bss = bss_list[i];
		let short = replace(bss, /^hostapd\./, '');
		let data = get_bss_clients(bss);
		if (data == null || type(data.clients) != 'object')
			continue;

		let traffic = assoc_traffic(short);

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
				bss: short,
				band: band_of(data.freq),
				signal: signal,
				ip: null,
				hostname: null,
				link: 'wifi',
				rx_bytes: traffic[key] != null ? traffic[key].rx_bytes : null,
				tx_bytes: traffic[key] != null ? traffic[key].tx_bytes : null,
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

	if (cfg == null || cfg.wired !== false) {
		let wired = collect_wired(leases, by_mac);
		for (let i = 0; i < length(wired); i++)
			by_mac[wired[i].mac] = wired[i];
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

function collect_router(env) {
	let info = null;
	let wan = null;

	if (opts.ubus_dir != null) {
		let raw = read_file(sprintf("%s/system_info.json", opts.ubus_dir));
		if (raw != null) {
			try { info = json(raw); } catch (e) { info = null; }
		}
		raw = read_file(sprintf("%s/wan_status.json", opts.ubus_dir));
		if (raw != null) {
			try { wan = json(raw); } catch (e) { wan = null; }
		}
	} else {
		let raw = run_capture("ubus call system info");
		if (raw != null) {
			try { info = json(raw); } catch (e) { info = null; }
		}
		raw = run_capture("ubus call network.interface.wan status");
		if (raw != null) {
			try { wan = json(raw); } catch (e) { wan = null; }
		}
	}

	if (info == null)
		return null;

	let load_path = opts.loadavg != null ? opts.loadavg : DEFAULT_LOADAVG;
	let raw_load = read_file(load_path);
	let parts = raw_load != null ? split(trim(raw_load), / +/) : [];

	let router = {
		uptime: info.uptime != null ? int(info.uptime) : null,
		load1: length(parts) > 0 ? +parts[0] : null,
		load5: length(parts) > 1 ? +parts[1] : null,
		load15: length(parts) > 2 ? +parts[2] : null,
		mem_total: (info.memory != null && info.memory.total != null) ? int(info.memory.total) : null,
		mem_free: (info.memory != null && info.memory.free != null) ? int(info.memory.free) : null,
		wan_up: wan != null && wan.up == true,
		wan_ip: null,
	};

	if (wan != null && type(wan['ipv4-address']) == 'array' && length(wan['ipv4-address']) > 0) {
		let addr = wan['ipv4-address'][0];
		if (addr != null && addr.address != null)
			router.wan_ip = addr.address;
	}

	return router;
}

// Читает накопленные acks. Удаляются они только после успешной отправки,
// чтобы сбой сети не потерял подтверждение команды.
function flush_acks() {
	let path = (opts.status != null ? opts.status : DEFAULT_STATUS) + '.acks.json';
	let raw = read_file(path);
	if (raw == null)
		return [];
	try {
		let list = json(raw);
		return type(list) == 'array' ? list : [];
	} catch (e) {
		return [];
	}
}

function read_nlbw(cfg) {
	if (cfg != null && cfg.nlbw === false)
		return null;
	let raw = null;
	if (opts.nlbw != null)
		raw = read_file(opts.nlbw);
	else
		raw = run_capture('nlbw -c json -g mac -n');
	if (raw == null)
		return null;
	let data = null;
	try {
		data = json(raw);
	} catch (e) {
		return null;
	}
	if (data == null || type(data.columns) != 'array' || type(data.data) != 'array')
		return null;
	let idx = {};
	for (let i = 0; i < length(data.columns); i++)
		idx[data.columns[i]] = i;
	if (idx.mac == null || idx.rx_bytes == null || idx.tx_bytes == null)
		return null;
	let out = {};
	for (let i = 0; i < length(data.data); i++) {
		let row = data.data[i];
		if (type(row) != 'array')
			continue;
		let mac = lc(row[idx.mac]);
		if (!match(mac, MAC_RE))
			continue;
		let rx = int(row[idx.rx_bytes]);
		let tx = int(row[idx.tx_bytes]);
		if (rx < 0)
			rx = 0;
		if (tx < 0)
			tx = 0;
		out[mac] = { rx_bytes: rx, tx_bytes: tx };
	}
	return out;
}

function snapshot(env, cfg) {
	return {
		schema: 2,
		agent: {
			hostname: env.hostname,
			version: VERSION,
			ts: env.now,
		},
		clients: collect(env, cfg),
		nlbw: read_nlbw(cfg),
		router: collect_router(env),
		acks: flush_acks(),
	};
}

// --- конфигурация ------------------------------------------------------

function status_path() {
	return opts.status != null ? opts.status : DEFAULT_STATUS;
}

function body_path() {
	return opts.status != null ? opts.status + '.body' : DEFAULT_BODY;
}

function acks_path() {
	return status_path() + '.acks.json';
}

function clear_acks() {
	try {
		unlink(acks_path());
	} catch (e) {
	}
}

function queue_ack(id, ok, error) {
	let list = flush_acks();
	push(list, { id: id, ok: ok, error: error });
	try {
		writefile(acks_path(), sprintf("%J\n", list));
	} catch (e) {
		warn(sprintf("не удалось сохранить ack: %s\n", e));
	}
}

function have_cmd(name) {
	return system(sprintf("command -v %s >/dev/null 2>&1", name)) == 0;
}

function nft_available() {
	return have_cmd(opts.nft != null ? opts.nft : 'nft');
}

// Наблюдатель событий — отдельный procd-сервис; проверяем best effort.
function watcher_running() {
	if (system("test -x /etc/init.d/homepanel-events") != 0)
		return false;
	return system("/etc/init.d/homepanel-events running >/dev/null 2>&1") == 0;
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
	let cfg = { enabled: true, server_url: '', secret: '', interval: DEFAULT_INTERVAL,
	            wired: true, control: true, events: true, nlbw: true };
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
			if (data.wired != null)
				cfg.wired = !(data.wired === false || data.wired === 0 ||
				              data.wired === '0' || data.wired === 'false');
			if (data.control != null)
				cfg.control = !(data.control === false || data.control === 0 ||
				                data.control === '0' || data.control === 'false');
			if (data.events != null)
				cfg.events = !(data.events === false || data.events === 0 ||
				               data.events === '0' || data.events === 'false');
			if (data.nlbw != null)
				cfg.nlbw = !(data.nlbw === false || data.nlbw === 0 ||
				             data.nlbw === '0' || data.nlbw === 'false');
		}
	} catch (e) {
		warn(sprintf("не удалось разобрать %s: %s\n", path, e));
	}
	return cfg;
}

function read_uci_config() {
	let cfg = { enabled: true, server_url: '', secret: '', interval: DEFAULT_INTERVAL,
	            wired: true, control: true, events: true, nlbw: true };

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
	let wired = get('wired');
	if (wired != null)
		cfg.wired = (wired != '0' && wired != 'false');
	let control = get('control');
	if (control != null)
		cfg.control = (control != '0' && control != 'false');
	let events = get('events');
	if (events != null)
		cfg.events = (events != '0' && events != 'false');
	let nlbw = get('nlbw');
	if (nlbw != null)
		cfg.nlbw = (nlbw != '0' && nlbw != 'false');

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

	return { configured: true, ok: ok, code: code, error: error, body: body };
}

// Один цикл: снимок → отправка → запись статуса.
function apply_pause(paused) {
	let nft = opts.nft != null ? opts.nft : 'nft';
	if (!have_cmd(nft))
		return 'nft недоступен';

	let run = function(expr) {
		return system(sprintf("%s %s", sh_quote(nft), sh_quote(expr)));
	};

	run('delete table inet homepanel');
	if (run('add table inet homepanel') != 0)
		return 'не удалось создать таблицу nft';
	run('add set inet homepanel paused { type ether_addr; }');
	run('add chain inet homepanel forward { type filter hook forward priority -150; policy accept; }');
	run('add rule inet homepanel forward ether saddr @paused drop');
	run('add rule inet homepanel forward ether daddr @paused drop');

	for (let i = 0; i < length(paused); i++) {
		let mac = lc(paused[i]);
		if (match(mac, MAC_RE) == null)
			continue;
		if (run(sprintf('add element inet homepanel paused { %s }', mac)) != 0)
			return sprintf('не удалось поставить %s на паузу', mac);
	}
	return null;
}

function take_commands(body, snap) {
	if (type(body) != 'object' || type(body.commands) != 'array')
		return;

	let ubus = opts.ubus != null ? opts.ubus : 'ubus';

	for (let i = 0; i < length(body.commands); i++) {
		let cmd = body.commands[i];
		if (type(cmd) != 'object' || cmd.id == null)
			continue;
		let id = int(cmd.id);

		if (cmd.type == 'restart') {
			queue_ack(id, true, null);
			let st = read_status();
			if (st == null)
				st = {};
			st.version = VERSION;
			st.ok = true;
			st.last_error = null;
			write_status(st);
			system('/etc/init.d/homepanel-agent restart >/dev/null 2>&1 &');
			exit(0);
		}

		if (cmd.type != 'kick')
			continue;

		let mac = lc(cmd.mac != null ? cmd.mac : '');
		let bss = null;
		for (let j = 0; j < length(snap.clients); j++) {
			if (snap.clients[j].mac == mac) {
				bss = snap.clients[j].bss;
				break;
			}
		}
		if (bss == null) {
			queue_ack(id, false, 'клиент не найден');
			continue;
		}

		let payload = sprintf('{"addr":"%s","deauth":true,"reason":5}', mac);
		let rc = system(sprintf("%s call %s del_client %s",
			sh_quote(ubus), sh_quote(bss), sh_quote(payload)));
		queue_ack(id, rc == 0, rc == 0 ? null : sprintf('ubus завершился с кодом %d', rc));
	}
}

function run_cycle(env, cfg) {
	let snap = snapshot(env, cfg);
	let res = send_snapshot(cfg, snap);

	let control_error = null;
	if (res.ok && res.body != null && cfg.control !== false) {
		if (length(snap.acks) > 0)
			clear_acks();
		let control = res.body.control;
		if (type(control) == 'object' && type(control.paused) == 'array') {
			let err = apply_pause(control.paused);
			if (err != null) {
				control_error = err;
				warn(sprintf("control: %s\n", err));
			}
		}
		take_commands(res.body, snap);
	}

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
		watcher: watcher_running(),
		nft: nft_available(),
		last_control_error: control_error,
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
		} else if (a == '--loadavg') {
			i++;
			opts.loadavg = args[i];
		} else if (a == '--fdb') {
			i++;
			opts.fdb = args[i];
		} else if (a == '--neigh') {
			i++;
			opts.neigh = args[i];
		} else if (a == '--bridge') {
			i++;
			opts.bridge = args[i];
		} else if (a == '--ip') {
			i++;
			opts.ip = args[i];
		} else if (a == '--nlbw') {
			i++;
			opts.nlbw = args[i];
		} else if (a == '--nft') {
			i++;
			opts.nft = args[i];
		} else if (a == '--ubus') {
			i++;
			opts.ubus = args[i];
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
			         last_error: null, watcher: false, nft: false,
			         last_control_error: null };
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
					watcher: st.watcher != null ? st.watcher === true : watcher_running(),
					nft: nft_available(),
					last_control_error: st.last_control_error != null ? st.last_control_error : null,
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

	// uloop нужен и для обслуживания ubus-объекта, и для таймера, причём
	// инициализировать его нужно ДО ubus.connect(): модуль ubus регистрирует
	// свой дескриптор в event loop через ubus_add_uloop().
	let uloop = null;
	try {
		uloop = require('uloop');
		uloop.init();
	} catch (e) {
		uloop = null;
	}

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

	if (conn != null && uloop != null && uloop.timer != null) {
		// Сигнатура модуля: uloop.timer([timeout_ms], callback) — сначала
		// таймаут, потом колбэк. При неверных аргументах модуль возвращает
		// null, а не бросает исключение.
		let timer = null;
		timer = uloop.timer(interval * 1000, function() {
			let next = tick();
			if (timer != null)
				timer.set(next * 1000);
		});

		if (timer != null) {
			tick();
			uloop.run();
			return;
		}
	}

	if (conn != null)
		warn("homepanel: uloop недоступен — ubus-объект не будет обслуживаться\n");

	while (true) {
		system(sprintf("sleep %d", tick()));
	}
}

main();
