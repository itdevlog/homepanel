/** ТВ-режим: крупные карточки «кто дома», без навигации. */

import { formatDuration, plural } from "../lib.js";

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[ch]);
}

export function render(root, state) {
  const now = Number(state.now) || Math.floor(Date.now() / 1000);
  const people = (state.people || []).filter((person) => person.home);
  const devices = (state.devices || []).filter(
    (device) => device.state === "home" && !device.hidden,
  );
  const clock = new Date(now * 1000).toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  });

  const cards = people
    .map((person) => {
      const since = person.since
        ? "дома " + esc(formatDuration(Math.max(0, now - person.since)))
        : "дома";
      return (
        '<article class="tv-card">' +
        '<div class="tv-name">' + esc(person.person) + "</div>" +
        '<div class="tv-since">' + since + "</div>" +
        "</article>"
      );
    })
    .join("");

  root.innerHTML =
    '<div class="tv">' +
    '<div class="tv-head"><h1>Кто дома</h1>' +
    '<span class="tv-clock">' + esc(clock) + "</span></div>" +
    (people.length
      ? '<div class="tv-cards">' + cards + "</div>"
      : '<p class="tv-empty">Дома никого</p>') +
    '<div class="tv-foot">' + devices.length + " " +
    plural(devices.length, "устройство", "устройства", "устройств") +
    " в сети</div>" +
    "</div>";
}
