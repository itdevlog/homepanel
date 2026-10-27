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
const EVENT_PAGE = 500;

let group = "day";
let person = "";
let peopleKey = null;
let stateRef = null;
let events = [];
let eventsExhausted = false;
let eventsToken = 0;
let eventQuery = "";
let eventType = "all";
let eventDays = 7;
let nowTs = 0;
let statsToken = 0;

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

function eventPeriod() {
  if (eventDays <= 0) return {};
  return { from: nowTs - eventDays * 86400, to: nowTs + 60 };
}

async function loadEvents(root, { append = false } = {}) {
  const list = root.querySelector(".event-list");
  if (!list) return;
  const token = ++eventsToken;
  const period = eventPeriod();
  const before = append && events.length ? Number(events[0].id) : undefined;
  const loading = document.createElement("p");
  loading.className = "muted";
  loading.textContent = "Загрузка…";
  if (append) {
    const more = list.querySelector(".events-more");
    if (more) more.replaceWith(loading);
    else list.append(loading);
  } else {
    events = [];
    eventsExhausted = false;
    list.innerHTML = '<p class="muted">Загрузка…</p>';
  }
  try {
    const page = decorate(await getEvents(null, EVENT_PAGE, { ...period, before }));
    if (token !== eventsToken) return;
    events = append ? page.concat(events) : page;
    eventsExhausted = page.length < EVENT_PAGE;
    paintEvents(root);
  } catch (error) {
    if (token !== eventsToken) return;
    list.innerHTML = '<p class="error">' + esc(error.message) + "</p>";
  }
}

function filteredEvents() {
  const period = eventPeriod();
  return filterEvents(events, {
    query: eventQuery,
    type: eventType,
    from: period.from || 0,
    to: period.to || Infinity,
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
    .map(eventRow)
    .join("");
  if (!eventsExhausted) {
    list.insertAdjacentHTML(
      "beforeend",
      '<button type="button" class="btn ghost events-more">Показать ещё</button>',
    );
  }
}

async function exportEvents(root) {
  const button = root.querySelector(".events-csv");
  if (button) button.disabled = true;
  try {
    const period = eventPeriod();
    const all = [];
    let before;
    while (all.length < 50000) {
      const page = decorate(await getEvents(null, 1000, { ...period, before }));
      if (!page.length) break;
      all.unshift(...page);
      before = Number(page[0].id);
      if (page.length < 1000) break;
    }
    const rows = filterEvents(all, {
      query: eventQuery,
      type: eventType,
      from: period.from || 0,
      to: period.to || Infinity,
    });
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
    downloadText(csvFilename("homepanel-events"), toCsv(columns, rows));
  } catch (error) {
    window.alert("Не удалось выгрузить события: " + error.message);
  } finally {
    if (button) button.disabled = false;
  }
}

async function loadStats(root) {
  const output = root.querySelector(".history-output");
  if (!output) return;
  const token = ++statsToken;
  const { from, to } = rangeFor(group);
  output.innerHTML = '<p class="muted">Загрузка…</p>';
  try {
    const rows = await getStats({ group, from, to, person: person || undefined });
    if (token !== statsToken) return;
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
    if (token !== statsToken) return;
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
    loadEvents(root);
  }
}

function onInput(root, event) {
  const target = event.target;
  if (!target || !target.classList.contains("event-search")) return;
  eventQuery = target.value;
  paintEvents(root);
}

function onClick(root, event) {
  if (event.target.closest(".events-csv")) exportEvents(root);
  else if (event.target.closest(".events-more")) loadEvents(root, { append: true });
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
