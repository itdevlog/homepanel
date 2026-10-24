/** Аналитика: тепловая карта, приходы/уходы, пончик, новые устройства, таймлайн, сигнал. */

import { getAnalytics, getSignal, getStats, getTimeline } from "../api.js";
import {
  barsFromStats,
  deviceLabel,
  donutSegments,
  formatDuration,
  heatmapGrid,
  timelineSegments,
} from "../lib.js";
import {
  barChart,
  donutChart,
  dualBarChart,
  heatmap,
  signalChart,
  timelineChart,
} from "../charts.js";

let stateRef = null;
let builtKey = null;

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[ch]);
}

function isoDay(date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return date.getFullYear() + "-" + month + "-" + day;
}

function options(items, selected) {
  return items
    .map(([value, label]) => {
      const isSel = value === selected ? " selected" : "";
      return '<option value="' + esc(value) + '"' + isSel + ">" + esc(label) + "</option>";
    })
    .join("");
}

function shell(people, devices) {
  const personItems = [["", "Все люди"]].concat(people.map((p) => [p.person, p.person]));
  const deviceItems = devices.map((device) => [device.mac, deviceLabel(device)]);
  const preferred = devices.find((device) => device.person || device.name) || devices[0];

  return (
    '<h2>Аналитика</h2>' +
    '<div class="analytics-grid">' +
    '<section class="panel wide">' +
    "<h3>Дом за неделю</h3>" +
    '<p class="muted">Сколько устройств было в сети в каждый час.</p>' +
    '<div class="heatmap-host"><p class="muted">Загрузка…</p></div>' +
    '<div class="heatmap-legend"><span>меньше</span>' +
    '<span class="heat-swatch level-1"></span><span class="heat-swatch level-2"></span>' +
    '<span class="heat-swatch level-3"></span><span class="heat-swatch level-4"></span>' +
    "<span>больше</span></div>" +
    "</section>" +
    '<section class="panel">' +
    "<h3>Приходы и уходы</h3>" +
    '<p class="muted">За 7 дней, по часам суток.</p>' +
    '<div class="hours-host"></div>' +
    '<div class="legend"><span class="legend-swatch bar-arrived"></span> пришли' +
    '<span class="legend-swatch bar-left"></span> ушли</div>' +
    "</section>" +
    '<section class="panel">' +
    "<h3>Кто в доме</h3>" +
    '<p class="muted">Устройства по людям.</p>' +
    '<div class="donut-host"></div>' +
    '<div class="donut-legend"></div>' +
    "</section>" +
    '<section class="panel">' +
    "<h3>Новые устройства</h3>" +
    '<p class="muted">По неделям, за 8 недель.</p>' +
    '<div class="new-host"></div>' +
    "</section>" +
    '<section class="panel wide">' +
    "<h3>День человека</h3>" +
    '<div class="history-controls">' +
    '<label>Человек <select class="tl-person">' + options(personItems, "") + "</select></label>" +
    '<label>День <input type="date" class="tl-day" value="' + isoDay(new Date()) + '"></label>' +
    "</div>" +
    '<div class="timeline-host"></div>' +
    '<p class="muted tl-total"></p>' +
    "</section>" +
    '<section class="panel wide">' +
    "<h3>Сигнал Wi-Fi</h3>" +
    '<div class="history-controls">' +
    '<label>Устройство <select class="sig-mac">' + options(deviceItems, preferred ? preferred.mac : "") +
    "</select></label>" +
    '<label>Период <select class="sig-hours">' +
    options([["24", "24 часа"], ["72", "3 дня"], ["168", "7 дней"]], "24") +
    "</select></label>" +
    "</div>" +
    '<div class="signal-host"></div>' +
    '<p class="muted sig-hint"></p>' +
    "</section>" +
    '<section class="panel wide">' +
    "<h3>Время дома по дням</h3>" +
    '<p class="muted">Суммарные часы всех устройств за 14 дней.</p>' +
    '<div class="days-host"></div>' +
    "</section>" +
    "</div>"
  );
}

async function loadOverview(root) {
  const host = root.querySelector(".heatmap-host");
  try {
    const data = await getAnalytics({ days: 7 });
    if (!host) return;

    host.innerHTML = "";
    heatmap(host, heatmapGrid(data.occupancy, data.now, 7));

    const hoursHost = root.querySelector(".hours-host");
    if (hoursHost) {
      hoursHost.innerHTML = "";
      dualBarChart(hoursHost, data.events_by_hour);
    }

    const newHost = root.querySelector(".new-host");
    if (newHost) {
      newHost.innerHTML = "";
      if (!data.new_devices || !data.new_devices.length) {
        newHost.innerHTML = '<p class="muted">Нет данных.</p>';
      } else {
        barChart(
          newHost,
          data.new_devices.map((row) => ({ label: row.week, value: row.count })),
          { height: 140 },
        );
      }
    }
  } catch (error) {
    if (host) host.innerHTML = '<p class="error">' + esc(error.message) + "</p>";
  }
}

function loadDonut(root) {
  const counts = new Map();
  for (const device of (stateRef && stateRef.devices) || []) {
    if (device.hidden) continue;
    const key = device.person || "Без человека";
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const items = Array.from(counts, ([label, value]) => ({ label, value })).sort(
    (a, b) => b.value - a.value,
  );
  const host = root.querySelector(".donut-host");
  const legend = root.querySelector(".donut-legend");
  if (!host || !legend) return;

  host.innerHTML = "";
  legend.innerHTML = "";
  if (!items.length) {
    host.innerHTML = '<p class="muted">Нет устройств.</p>';
    return;
  }

  const segments = donutSegments(items);
  donutChart(host, segments);
  legend.innerHTML = segments
    .map(
      (segment, index) =>
        '<span class="legend-item"><span class="legend-swatch c' + (index % 6) +
        '"></span>' + esc(segment.label) + " — " + segment.value + "</span>",
    )
    .join("");
}

async function loadTimeline(root) {
  const personSelect = root.querySelector(".tl-person");
  const dayInput = root.querySelector(".tl-day");
  const host = root.querySelector(".timeline-host");
  const total = root.querySelector(".tl-total");
  if (!personSelect || !dayInput || !host) return;

  host.innerHTML = '<p class="muted">Загрузка…</p>';
  try {
    const data = await getTimeline({
      day: dayInput.value || undefined,
      person: personSelect.value || undefined,
    });
    host.innerHTML = "";
    const segments = timelineSegments(data.intervals, data.from, data.to);
    if (!segments.length) {
      host.innerHTML = '<p class="muted">В этот день данных нет.</p>';
      if (total) total.textContent = "";
      return;
    }
    timelineChart(host, segments);
    const minutes = segments.reduce(
      (sum, segment) => sum + Math.max(0, segment.to - segment.from),
      0,
    ) / 60;
    if (total) total.textContent = "Всего дома: " + formatDuration(minutes * 60) + ".";
  } catch (error) {
    host.innerHTML = '<p class="error">' + esc(error.message) + "</p>";
  }
}

async function loadSignal(root) {
  const macSelect = root.querySelector(".sig-mac");
  const hoursSelect = root.querySelector(".sig-hours");
  const host = root.querySelector(".signal-host");
  const hint = root.querySelector(".sig-hint");
  if (!macSelect || !host) return;

  if (!macSelect.value) {
    host.innerHTML = '<p class="muted">Нет устройств.</p>';
    return;
  }

  host.innerHTML = '<p class="muted">Загрузка…</p>';
  try {
    const data = await getSignal({
      mac: macSelect.value,
      hours: Number(hoursSelect && hoursSelect.value) || 24,
    });
    host.innerHTML = "";
    if (!data.points.length) {
      host.innerHTML =
        '<p class="muted">История появится после нескольких снимков агента (раз в 5 минут).</p>';
      if (hint) hint.textContent = "";
      return;
    }
    signalChart(host, data.points, data.from, data.to);
    if (hint) hint.textContent = "Точек: " + data.points.length + " · шкала −30…−95 dBm.";
  } catch (error) {
    host.innerHTML = '<p class="error">' + esc(error.message) + "</p>";
  }
}

async function loadDays(root) {
  const host = root.querySelector(".days-host");
  if (!host) return;
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 13);

  host.innerHTML = '<p class="muted">Загрузка…</p>';
  try {
    const rows = await getStats({ group: "day", from: isoDay(from), to: isoDay(to) });
    const bars = barsFromStats(rows);
    host.innerHTML = "";
    if (!bars.length) {
      host.innerHTML = '<p class="muted">Нет данных.</p>';
      return;
    }
    barChart(host, bars, { height: 160 });
    const total = bars.reduce((sum, bar) => sum + bar.value, 0);
    host.insertAdjacentHTML(
      "beforeend",
      '<p class="muted">Всего за 14 дней: ' + formatDuration(total * 60) + ".</p>",
    );
  } catch (error) {
    host.innerHTML = '<p class="error">' + esc(error.message) + "</p>";
  }
}

function onChange(root, event) {
  const target = event.target;
  if (!target) return;
  if (target.classList.contains("tl-person") || target.classList.contains("tl-day")) {
    loadTimeline(root);
  } else if (
    target.classList.contains("sig-mac") ||
    target.classList.contains("sig-hours")
  ) {
    loadSignal(root);
  }
}

export function render(root, state) {
  stateRef = state;
  const people = state.people || [];
  const devices = state.devices || [];
  const key =
    people.map((person) => person.person).join("|") +
    "#" +
    devices.map((device) => device.mac).join("|");

  if (root.querySelector(".analytics-grid") && builtKey === key) return;
  builtKey = key;

  root.innerHTML = shell(people, devices);
  root.onchange = (event) => onChange(root, event);
  loadOverview(root);
  loadDonut(root);
  loadTimeline(root);
  loadSignal(root);
  loadDays(root);
}
