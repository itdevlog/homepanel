/** ТВ-режим: крупная спокойная сводка «кто дома» для экрана в гостиной. */

import { formatAgo, formatDuration, plural } from "../lib.js";
import { avatar, deviceIcon, icon } from "../icons.js";

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[ch]);
}

function personCard(person, now) {
  const devices = (person.devices || [])
    .filter((device) => device.state === "home" && !device.hidden)
    .map((device) => device.name || device.mac);
  const since = person.since
    ? "дома " + formatDuration(Math.max(0, now - Number(person.since)))
    : "дома";
  const today = Number(person.today_minutes);
  return (
    '<article class="tv-card">' +
    '<div class="tv-person">' + avatar(person.person, "tv-avatar") +
    '<div><div class="tv-name">' + esc(person.person) + "</div>" +
    '<div class="tv-since"><i class="presence-dot is-on"></i>' + esc(since) + "</div>" +
    (today > 0
      ? '<div class="tv-today">сегодня ' + esc(formatDuration(today * 60)) + "</div>"
      : "") +
    "</div></div>" +
    (devices.length
      ? '<div class="tv-devices">' + devices.slice(0, 4).map((name) =>
          '<span class="tv-device">' + esc(name) + "</span>").join("") +
        (devices.length > 4 ? '<span class="tv-device muted">+' + (devices.length - 4) + "</span>" : "") +
        "</div>"
      : '<p class="tv-note">Устройства не размечены</p>') +
    "</article>"
  );
}

export function render(root, state) {
  const now = Number(state.now) || Math.floor(Date.now() / 1000);
  const date = new Date(now * 1000);
  const people = (state.people || []).filter((person) => person.home);
  const devices = (state.devices || []).filter(
    (device) => device.state === "home" && !device.hidden,
  );
  const router = state.router || {};
  const agent = state.agent || {};
  const clock = date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  const rawDay = date.toLocaleDateString("ru-RU", {
    weekday: "long", day: "numeric", month: "long",
  });
  const day = rawDay.charAt(0).toUpperCase() + rawDay.slice(1);
  const cards = people.map((person) => personCard(person, now)).join("");
  const onlineList = devices.map((device) => {
    const name = device.name || device.mac;
    const label = device.room ? name + " · " + device.room : name;
    return '<span class="tv-online-item">' + icon(deviceIcon(device)) +
      esc(label) + "</span>";
  }).join("");
  const live = agent.online
    ? "Агент на связи"
    : agent.last_snapshot_ts
      ? "Обновлено " + formatAgo(Math.max(0, now - agent.last_snapshot_ts))
      : "Агент ещё не присылал данные";

  root.innerHTML =
    '<div class="tv">' +
    '<header class="tv-head">' +
    '<div class="tv-brand"><span class="tv-logo">' + icon("home") + "</span>" +
    '<div><strong>Home Panel</strong><span>умный дом</span></div></div>' +
    '<div class="tv-clock-wrap"><div class="tv-clock">' + esc(clock) + "</div>" +
    '<div class="tv-date">' + esc(day) + "</div></div></header>" +
    '<main class="tv-main">' +
    '<div class="tv-title"><div><p class="eyebrow">Сейчас в доме</p>' +
    "<h1>" + (people.length
      ? people.length + " " + plural(people.length, "человек", "человека", "человек")
      : "Дома никого") + "</h1></div>" +
    '<span class="tv-live' + (agent.online ? " is-on" : "") + '">' +
    '<i class="presence-dot' + (agent.online ? " is-on" : "") + '"></i>' + esc(live) + "</span></div>" +
    (people.length
      ? '<div class="tv-cards">' + cards + "</div>"
      : '<div class="tv-empty">' + icon("users") +
        "<h2>Дома тихо</h2><p>Панель покажет жильцов, как только их устройства появятся в сети.</p></div>") +
    (devices.length
      ? '<div class="tv-online"><p class="eyebrow">В сети · ' + devices.length + "</p>" +
        '<div class="tv-online-list">' + onlineList + "</div></div>"
      : "") +
    "</main>" +
    '<footer class="tv-foot">' +
    '<span class="tv-status"><i class="presence-dot' + (router.online ? " is-on" : "") + '"></i>' +
    "Роутер " + (router.online ? "в сети" : "не в сети") + "</span>" +
    '<span class="tv-status">' + icon("devices") + devices.length + " " +
    plural(devices.length, "устройство", "устройства", "устройств") + " в сети</span>" +
    '<span class="tv-hint">Обновляется автоматически</span>' +
    "</footer></div>";
}
