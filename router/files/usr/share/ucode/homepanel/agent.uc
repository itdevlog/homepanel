#!/usr/bin/ucode
//
// homepanel-agent — снимает список подключённых к WiFi клиентов роутера
// и (в следующих задачах) отправляет снимок на сервер Home Panel.
//
// Спека: docs/superpowers/specs/2026-10-18-homepanel-design.md (§5, §6)

import { readfile, lsdir, popen } from 'fs';

const VERSION = '1.0';
const DEFAULT_LEASES = '/tmp/dhcp.leases';
const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;

let opts = {
	once: false,
	ubus_dir: null,
	leases: null,
	now: null,
};

function usage() {
	warn("usage: agent.uc --once [--ubus-dir DIR] [--leases PATH] [--now TS]\n");
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

// --- запуск ------------------------------------------------------------

function parse_args(args) {
	for (let i = 0; i < length(args); i++) {
		let a = args[i];
		if (a == '--once') {
			opts.once = true;
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

function main() {
	parse_args(ARGV);

	let env = {
		now: opts.now != null ? opts.now : int(time()),
		leases: opts.leases != null ? opts.leases : DEFAULT_LEASES,
		hostname: hostname(),
	};

	if (opts.once) {
		print(sprintf("%J\n", snapshot(env)));
		exit(0);
	}

	warn("no mode selected\n");
	usage();
	exit(2);
}

main();
