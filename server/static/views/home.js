/** Главная страница: сводка, предупреждения, кто дома и неопознанные. */

import {
  alertsFromState,
  formatAgo,
  formatDuration,
  isUnidentified,
  plural,
} from "../lib.js";

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

function summaryItem(value, label, cls) {
  return (
    '<div class="summary-item' + (cls ? " " + cls : "") + '">' +
    '<span class="summary-value">' + esc(value) + "</span>" +
    '<span class="summary-label">' + esc(label) + "</span></div>"
  );
}

function summary(state) {
  const people = state.people || [];
  const devices = state.devices || [];
  const home = people.filter((person) => person.home).length;
  const devicesHome = devices.filter((d) => d.state === "home" && !d.hidden).length;
  const unknown = devices.filter((d) => isUnidentified(d) && d.state === "home").length;
  const online = Boolean((state.agent || {}).online);

  const items = [
    summaryItem(
      home,
      plural(home, "человек дома", "человека дома", "человек дома"),
      home ? "is-home" : "",
    ),
    summaryItem(
      devicesHome,
      plural(devicesHome, "устройство дома", "устройства дома", "устройств дома"),
    ),
    summaryItem(
      unknown,
      plural(unknown, "неопознанное", "неопознанных", "неопознанных"),
      unknown ? "is-warn" : "",
    ),
    summaryItem(online ? "онлайн" : "офлайн", "роутер", online ? "is-home" : "is-warn"),
  ];

  return '<div class="summary">' + items.join("") + "</div>";
}

function alertsBlock(state) {
  const alerts = alertsFromState(state);
  if (!alerts.length) return "";
  return (
    '<div class="alerts">' +
    alerts
      .map((alert) => '<div class="alert alert-' + alert.level + '">' + esc(alert.text) + "</div>")
      .join("") +
    "</div>"
  );
}

function personCard(person, now) {
  const visible = person.devices.filter((d) => !d.hidden);
  const lines = (visible.length ? visible : person.devices).map((d) => deviceLine(d, now));
  const today =
    person.today_minutes == null
      ? ""
      : " · сегодня " + formatDuration(person.today_minutes * 60);
  const since = person.home && person.since != null
    ? "дома уже " + esc(formatDuration(now - person.since)) + today
    : "не дома" + today;
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
    device.state === "home"
      ? "дома"
      : device.last_seen
        ? "ушёл " + esc(formatAgo(now - device.last_seen))
        : "не видели",
  ].filter(Boolean);
  return (
    '<div class="unknown-row">' +
    '<span class="mac">' + esc(device.mac) + "</span>" +
    '<span class="meta">' + meta.join(" · ") + "</span>" +
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
    summary(state) +
    alertsBlock(state) +
    freshness(state) +
    "<h2>Кто дома</h2>" + peopleHtml +
    "<h2>Неопознанные устройства</h2>" + unknownHtml;
}
