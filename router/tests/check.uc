#!/usr/bin/ucode
//
// Сравнивает массив clients снимка агента с ожидаемым (тесты Task 1).
// usage: check.uc <expected-clients.json> <snapshot.json>
//
// ВАЖНО: в ucode `for (x in array)` перебирает ЗНАЧЕНИЯ, а `for (x in obj)`
// — КЛЮЧИ, поэтому здесь везде явные индексные циклы.

import { readfile } from 'fs';

let FIELDS = [ "mac", "bss", "band", "signal", "ip", "hostname", "connected_at" ];

function die(msg) {
	warn(msg + "\n");
	exit(1);
}

function canon(v) {
	return sprintf("%J", v);
}

function has_key(obj, name) {
	let ks = keys(obj);
	for (let i = 0; i < length(ks); i++)
		if (ks[i] == name)
			return true;
	return false;
}

let want = json(readfile(ARGV[0]));
let snapshot = json(readfile(ARGV[1]));
let got = snapshot.clients;

if (type(got) != 'array')
	die("snapshot has no clients array");

if (length(want) != length(got))
	die(sprintf("clients count mismatch: expected %d, got %d", length(want), length(got)));

for (let i = 0; i < length(want); i++) {
	let e = want[i];
	let a = got[i] != null ? got[i] : {};

	for (let j = 0; j < length(FIELDS); j++) {
		let name = FIELDS[j];
		if (has_key(e, name)) {
			if (canon(a[name]) != canon(e[name]))
				die(sprintf("clients[%d].%s mismatch: expected %s, got %s",
				    i, name, canon(e[name]), canon(a[name])));
		} else if (a[name] != null) {
			die(sprintf("clients[%d] has unexpected field '%s'", i, name));
		}
	}
}

printf("clients match (%d)\n", length(got));
