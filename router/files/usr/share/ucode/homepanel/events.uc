#!/usr/bin/env ucode
// Watcher hostapd: при подключении/отключении клиента сразу запускает
// отправку снимка агентом. Debounce 1 с и rate-limit 3 с защищают от
// лавины событий при роуминге нескольких клиентов.
'use strict';

import { readfile, popen } from 'fs';

const DEBOUNCE_MS = 1000;
const RATE_MS = 3000;
const DEFAULT_AGENT = '/usr/share/ucode/homepanel/agent.uc';

let opts = { replay: null, agent: DEFAULT_AGENT };

function usage() {
	warn('Использование: events.uc [--replay FILE] [--agent PATH]\n');
}

function parse_args(argv) {
	for (let i = 0; i < length(argv); i++) {
		let arg = argv[i];
		if (arg == '--replay') {
			i++;
			opts.replay = argv[i];
		} else if (arg == '--agent') {
			i++;
			opts.agent = argv[i];
		} else if (arg == '--help' || arg == '-h') {
			usage();
			exit(0);
		} else {
			warn('events.uc: неизвестный аргумент: ' + arg + '\n');
			usage();
			exit(2);
		}
	}
}

function sh_quote(value) {
	return "'" + replace(value, "'", "'\\''") + "'";
}

let last_event = {};
let last_fire = -1000000;

function fire(now) {
	if (now - last_fire < RATE_MS)
		return;
	last_fire = now;
	try {
		system(sh_quote(opts.agent) + ' --send >/dev/null 2>&1 &');
	} catch (e) {
		warn('events.uc: не удалось запустить агент: ' + e + '\n');
	}
}

function handle(line, now) {
	let obj;
	try {
		obj = json(line);
	} catch (e) {
		obj = null;
	}
	if (type(obj) != 'object')
		return;

	let kind = obj.type;
	if (kind == null)
		kind = obj.event;
	if (kind != 'sta_connect' && kind != 'sta_disconnect')
		return;

	let mac = obj.mac;
	if (mac == null)
		mac = obj.addr;
	if (mac == null || mac == '')
		mac = kind;

	let prev = last_event[mac];
	last_event[mac] = now;
	if (prev != null && now - prev < DEBOUNCE_MS)
		return;
	fire(now);
}

function replay(path) {
	let data;
	try {
		data = readfile(path);
	} catch (e) {
		data = null;
	}
	if (data == null) {
		warn('events.uc: не удалось открыть ' + path + '\n');
		exit(1);
	}
	let now = 0;
	let lines = split(data, '\n');
	for (let i = 0; i < length(lines); i++) {
		let line = trim(lines[i]);
		if (line != '') {
			let obj;
			try {
				obj = json(line);
			} catch (e) {
				obj = null;
			}
			if (type(obj) == 'object' && obj.sleep != null)
				now += int(obj.sleep);
			else
				handle(line, now);
		}
	}
}

function live() {
	let proc;
	try {
		proc = popen('ubus listen hostapd.*', 'r');
	} catch (e) {
		proc = null;
	}
	if (proc == null) {
		warn('events.uc: не удалось запустить ubus listen\n');
		return 1;
	}
	let line = proc.read('line');
	while (line != null) {
		let c = clock(true);
		handle(trim(line), c[0] * 1000 + int(c[1] / 1000000));
		line = proc.read('line');
	}
	return 0;
}

parse_args(ARGV);
if (opts.replay != null) {
	replay(opts.replay);
	exit(0);
}
exit(live());
