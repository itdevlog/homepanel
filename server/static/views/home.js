/** Главная страница: кто дома, устройства людей и неопознанные. */

import { formatAgo, formatDuration, isUnidentified } from "../lib.js";

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[ch]);
}

function bandLabel(band) {
  if (band === "2.4") return "2.4 ГГц";
  if (band === "5") return "5 ГГц";
  return band ? esc(band) + " ГГц" : "";
}

function deviceLine(device, now) {
  const label = device.name || device.hostname || device.mac;
  const meta = [
    bandLabel(device.band),
    device.bss ? esc(device.bss) : "",
    device.signal == null ? "" : device.signal + " dBm",
  ].filter(Boolean);
  const isHome = device.state === "home";
  const status = isHome
    ? "онлайн " + esc(formatDuration(now - device.since))
    : "последний раз " + esc(formatDuration(now - (device.last_seen || now))) + " назад";
  const cls = isHome ? "" : " off";
  return (
    '<li class="' + cls.trim() + '">' +
    '<span class="name">' + esc(label) + "</span>" +
    (device.hidden ? '<span class="meta">скрыто</span>' : "") +
    '<span class="meta">' + meta.join(" · ") + "</span>" +
    '<span class="meta">' + status + "</span>" +
    "</li>"
  );
}

function personCard(person, now) {
  const visible = person.devices.filter((d) => !d.hidden);
  const lines = (visible.length ? visible : person.devices).map((d) => deviceLine(d, now));
  const since = person.home && person.since != null
    ? "дома уже " + esc(formatDuration(now - person.since))
    : "не дома";
  return (
    '<article class="card' + (person.home ? " is-home" : "") + '">' +
    "<header><h3>" + esc(person.person) + "</h3>" +
    '<span class="badge' + (person.home ? " is-home" : "") + '">' +
    (person.home ? "дома" : "нет") + "</span></header>" +
    '<p class="since">' + since + "</p>" +
    '<ul class="devices">' + lines.join("") + "</ul>" +
    "</article>"
  );
}

function unknownRow(device, now) {
  const meta = [
    device.hostname ? esc(device.hostname) : "",
    device.ip ? esc(device.ip) : "",
    bandLabel(device.band),
    device.bss ? esc(device.bss) : "",
    device.signal == null ? "" : device.signal + " dBm",
  ].filter(Boolean);
  const state = device.state === "home" ? "дома" : "нет";
  return (
    '<div class="unknown-row">' +
    '<span class="mac">' + esc(device.mac) + "</span>" +
    '<span class="meta">' + meta.join(" · ") + "</span>" +
    '<span class="meta">' + state + "</span>" +
    "</div>"
  );
}

function freshness(state) {
  const agent = state.agent || {};
  const online = Boolean(agent.online);
  let text;
  if (agent.last_snapshot_ts) {
    const ago = formatAgo(Math.max(0, state.now - agent.last_snapshot_ts));
    text =
      "Последние данные от роутера: " + ago +
      (agent.client_count == null ? "" : " · клиентов: " + agent.client_count);
  } else {
    text = "Данных от роутера пока не было";
  }
  return (
    '<div class="freshness' + (online ? " is-online" : "") + '">' +
    '<span class="dot"></span><span>' + esc(text) + "</span></div>"
  );
}

export function render(root, state) {
  const now = state.now;
  const people = state.people || [];
  const devices = state.devices || [];
  const unknown = devices.filter(isUnidentified);

  const peopleHtml = people.length
    ? '<div class="cards">' + people.map((p) => personCard(p, now)).join("") + "</div>"
    : '<p class="muted">Люди ещё не размечены — задайте имена на странице «Устройства».</p>';

  const unknownHtml = unknown.length
    ? '<div class="unknown-list">' + unknown.map((d) => unknownRow(d, now)).join("") + "</div>"
    : '<p class="muted">Неопознанных устройств нет.</p>';

  root.innerHTML =
    freshness(state) +
    "<h2>Кто дома</h2>" + peopleHtml +
    "<h2>Неопознанные устройства</h2>" + unknownHtml;
}
