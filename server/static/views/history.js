/** Страница истории: события с фильтрами и часы онлайн по дням/неделям. */

import { getEvents, getStats } from "../api.js";
import {
  barsFromStats,
  csvFilename,
  deviceLabel,
  downloadText,
  filterEvents,
  formatDuration,
  toCsv,
} from "../lib.js";
import { barChart } from "../charts.js";

const DAYS = 14;
const WEEKS = 8;
const EVENT_LIMIT = 500;

let group = "day";
let person = "";
let peopleKey = null;
let stateRef = null;
let events = [];
let eventQuery = "";
let eventType = "all";
let eventDays = 7;
let nowTs = 0;

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

function rangeFor(kind) {
  const to = new Date();
  const from = new Date();
  if (kind === "week") {
    from.setDate(from.getDate() - WEEKS * 7 + 1);
  } else {
    from.setDate(from.getDate() - DAYS + 1);
  }
  return { from: isoDay(from), to: isoDay(to) };
}

function options(values, selected) {
  return values
    .map(([value, label]) => {
      const isSel = value === selected ? " selected" : "";
      return '<option value="' + esc(value) + '"' + isSel + ">" + esc(label) + "</option>";
    })
    .join("");
}

function shell(people) {
  const names = [["", "Все люди"]].concat(people.map((p) => [p.person, p.person]));
  if (person && !names.some(([value]) => value === person)) names.push([person, person]);

  return (
    '<h2>История</h2>' +
    '<section class="panel">' +
    "<h3>События</h3>" +
    '<div class="history-controls history-filters">' +
    '<label>Поиск <input type="search" class="event-search" ' +
    'placeholder="имя, MAC, IP" value="' + esc(eventQuery) + '"></label>' +
    "<label>Тип <select class=\"event-type\">" +
    options([["all", "Все"], ["arrived", "Приходы"], ["left", "Уходы"]], eventType) +
    "</select></label>" +
    "<label>Период <select class=\"event-period\">" +
    options(
      [
        ["1", "Сутки"],
        ["7", "7 дней"],
        ["30", "30 дней"],
        ["0", "Всё время"],
      ],
      String(eventDays),
    ) +
    "</select></label>" +
    '<button type="button" class="btn events-csv">CSV</button>' +
    "</div>" +
    '<div class="event-list"></div>' +
    "</section>" +
    '<section class="panel">' +
    "<h3>Часы онлайн</h3>" +
    '<div class="history-controls">' +
    '<label>Период <select class="history-group">' +
    options([["day", "По дням"], ["week", "По неделям"]], group) +
    "</select></label>" +
    '<label>Человек <select class="history-person">' +
    options(names, person) +
    "</select></label>" +
    "</div>" +
    '<div class="history-output"></div>' +
    "</section>"
  );
}

function decorate(list) {
  const devices = new Map(
    ((stateRef && stateRef.devices) || []).map((device) => [device.mac, device]),
  );
  return (list || []).map((event) => {
    const device = devices.get(event.mac);
    return {
      ...event,
      label: device ? deviceLabel(device) : event.mac,
      person: device ? device.person || "" : "",
    };
  });
}

async function loadEvents(root) {
  const list = root.querySelector(".event-list");
  if (!list) return;
  list.innerHTML = '<p class="muted">Загрузка…</p>';
  try {
    events = decorate(await getEvents(null, EVENT_LIMIT));
  } catch (error) {
    list.innerHTML = '<p class="error">' + esc(error.message) + "</p>";
    return;
  }
  paintEvents(root);
}

function filteredEvents() {
  const from = eventDays > 0 ? nowTs - eventDays * 86400 : 0;
  return filterEvents(events, {
    query: eventQuery,
    type: eventType,
    from,
    to: nowTs + 60,
  });
}

function eventRow(event) {
  const date = new Date(Number(event.ts) * 1000);
  const time = date.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const arrived = event.type === "arrived";
  return (
    '<div class="event-row">' +
    '<span class="event-time">' + esc(time) + "</span>" +
    '<span class="event-badge ' + (arrived ? "arrived" : "left") + '">' +
    (arrived ? "пришёл" : "ушёл") + "</span>" +
    '<span class="event-who">' + esc(event.label) + "</span>" +
    '<span class="sub mac">' + esc(event.mac) + "</span>" +
    "</div>"
  );
}

function paintEvents(root) {
  const list = root.querySelector(".event-list");
  if (!list) return;
  const rows = filteredEvents();
  if (!rows.length) {
    list.innerHTML = '<p class="muted">Событий за выбранный период нет.</p>';
    return;
  }
  list.innerHTML = rows
    .slice()
    .reverse()
    .slice(0, 300)
    .map(eventRow)
    .join("");
}

function exportEvents() {
  const columns = [
    {
      label: "Время",
      value: (event) => new Date(Number(event.ts) * 1000).toLocaleString("ru-RU"),
    },
    {
      label: "Тип",
      value: (event) => (event.type === "arrived" ? "пришёл" : "ушёл"),
    },
    { label: "Устройство", value: (event) => event.label || "" },
    { label: "MAC", value: (event) => event.mac || "" },
  ];
  downloadText(csvFilename("homepanel-events"), toCsv(columns, filteredEvents()));
}

async function loadStats(root) {
  const output = root.querySelector(".history-output");
  if (!output) return;
  const { from, to } = rangeFor(group);
  output.innerHTML = '<p class="muted">Загрузка…</p>';
  try {
    const rows = await getStats({ group, from, to, person: person || undefined });
    const bars = barsFromStats(rows);
    output.innerHTML = "";
    if (!bars.length) {
      output.innerHTML = '<p class="muted">Нет данных за выбранный период.</p>';
      return;
    }
    const total = bars.reduce((sum, bar) => sum + bar.value, 0);
    const summary = document.createElement("p");
    summary.className = "muted";
    summary.textContent =
      "Всего " + formatDuration(total * 60) + " с " + from + " по " + to + ".";
    output.append(summary);
    barChart(output, bars);
  } catch (err) {
    output.innerHTML = '<p class="error">' + esc(err.message) + "</p>";
  }
}

function onControlsChange(root, event) {
  const target = event.target;
  if (!target) return;

  if (target.classList.contains("history-group")) {
    group = target.value === "week" ? "week" : "day";
    loadStats(root);
  } else if (target.classList.contains("history-person")) {
    person = target.value;
    loadStats(root);
  } else if (target.classList.contains("event-type")) {
    eventType = ["arrived", "left"].includes(target.value) ? target.value : "all";
    paintEvents(root);
  } else if (target.classList.contains("event-period")) {
    eventDays = Number(target.value) || 0;
    paintEvents(root);
  }
}

function onInput(root, event) {
  const target = event.target;
  if (!target || !target.classList.contains("event-search")) return;
  eventQuery = target.value;
  paintEvents(root);
}

function onClick(root, event) {
  if (event.target.closest(".events-csv")) exportEvents();
}

export function render(root, state) {
  stateRef = state;
  nowTs = Number(state.now) || Math.floor(Date.now() / 1000);

  const people = state.people || [];
  const key =
    people.map((p) => p.person).join("|") + "|" + (state.devices || []).length;
  if (root.querySelector(".history-controls") && peopleKey === key) return;

  peopleKey = key;
  root.innerHTML = shell(people);
  root.onchange = (event) => onControlsChange(root, event);
  root.oninput = (event) => onInput(root, event);
  root.onclick = (event) => onClick(root, event);
  loadStats(root);
  loadEvents(root);
}
