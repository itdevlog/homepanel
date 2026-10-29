/** История: лента событий по дням и часы онлайн по людям. */

import { getEvents, getStats } from "../api.js";
import {
  barsFromStats,
  csvFilename,
  deviceLabel,
  downloadText,
  filterEvents,
  formatDuration,
  plural,
  toCsv,
} from "../lib.js";
import { barChart } from "../charts.js";
import { avatar, deviceIconSvg, icon } from "../icons.js";
import { toast } from "../ui.js";

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
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

function isoDay(date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return date.getFullYear() + "-" + month + "-" + day;
}

function dayKey(date) {
  return isoDay(date);
}

function rangeFor(kind) {
  const to = new Date();
  const from = new Date();
  if (kind === "week") from.setDate(from.getDate() - WEEKS * 7 + 1);
  else from.setDate(from.getDate() - DAYS + 1);
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

function nowPanel() {
  const people = ((stateRef && stateRef.people) || []).filter((item) => item.home);
  const rows = people
    .map((item) => {
      const devices = (item.devices || []).filter((device) => !device.hidden && device.state === "home");
      return (
        '<div class="now-person">' + avatar(item.person, "now-avatar") +
        '<div class="now-person-body"><strong>' + esc(item.person) + "</strong>" +
        "<span>" + devices.length + " " +
        plural(devices.length, "устройство", "устройства", "устройств") +
        " онлайн</span></div>" +
        '<span class="status-tag is-ok">дома</span></div>'
      );
    })
    .join("");
  return (
    '<section class="panel history-now">' +
    '<div class="panel-head"><div><h3>Сейчас дома</h3>' +
    '<p class="muted">Люди и их устройства прямо сейчас.</p></div>' +
    '<span class="panel-icon">' + icon("users") + "</span></div>" +
    (rows || '<p class="muted history-now-empty">Сейчас дома никого нет.</p>') +
    "</section>"
  );
}

function shell(people) {
  const names = [["", "Все люди"]].concat(people.map((p) => [p.person, p.person]));
  if (person && !names.some(([value]) => value === person)) names.push([person, person]);
  return (
    '<section class="page history-page">' +
    '<header class="page-head"><div><p class="eyebrow">Хроника дома</p><h1>История</h1>' +
    '<p class="page-sub">Приходы и уходы устройств, активность жильцов и время онлайн.</p></div></header>' +
    '<div class="history-grid">' +
    '<section class="panel events-panel">' +
    '<div class="panel-head"><div><h2>События</h2><p class="panel-sub">Последние подключения и отключения.</p></div>' +
    '<span class="panel-icon">' + icon("history") + "</span></div>" +
    '<div class="events-toolbar">' +
    '<label class="search-field">' + icon("search") +
    '<input type="search" class="event-search" placeholder="Имя, MAC или IP" value="' + esc(eventQuery) + '"></label>' +
    '<label class="filter-field compact"><span>Тип</span><select class="event-type">' +
    options([["all", "Все"], ["arrived", "Приходы"], ["left", "Уходы"]], eventType) +
    "</select></label>" +
    '<label class="filter-field compact"><span>Период</span><select class="event-period">' +
    options([["1", "Сутки"], ["7", "7 дней"], ["30", "30 дней"], ["0", "Всё время"]], String(eventDays)) +
    "</select></label>" +
    '<button type="button" class="btn ghost events-csv">' + icon("download") + "CSV</button>" +
    "</div>" +
    '<div class="event-list"><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div></div>' +
    "</section>" +
    '<div class="history-side">' +
    '<section class="panel history-chart-panel">' +
    '<div class="panel-head"><div><h2>Время онлайн</h2>' +
    '<p class="panel-sub">Сколько человек или устройство было в сети.</p></div>' +
    '<span class="panel-icon">' + icon("analytics") + "</span></div>" +
    '<div class="chart-controls">' +
    '<label class="filter-field compact"><span>Период</span><select class="history-group">' +
    options([["day", "По дням"], ["week", "По неделям"]], group) + "</select></label>" +
    '<label class="filter-field compact"><span>Человек</span><select class="history-person">' +
    options(names, person) + "</select></label>" +
    "</div>" +
    '<div class="history-output"><p class="muted">Загрузка…</p></div>' +
    "</section>" +
    nowPanel() +
    "</div></div></section>"
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
      device,
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
  if (append) {
    const more = list.querySelector(".events-more");
    if (more) more.replaceWith(Object.assign(document.createElement("p"), {
      className: "muted", textContent: "Загрузка…",
    }));
  } else {
    events = [];
    eventsExhausted = false;
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

function dateHeading(date) {
  const today = new Date(nowTs * 1000);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const key = dayKey(date);
  if (key === dayKey(today)) return "Сегодня";
  if (key === dayKey(yesterday)) return "Вчера";
  const text = date.toLocaleDateString("ru-RU", {
    day: "numeric", month: "long", weekday: "long",
  });
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function eventRow(event) {
  const date = new Date(Number(event.ts) * 1000);
  const time = String(date.getHours()).padStart(2, "0") + ":" +
    String(date.getMinutes()).padStart(2, "0");
  const arrived = event.type === "arrived";
  const device = event.device;
  return (
    '<div class="event-row ' + (arrived ? "is-arrived" : "is-left") + '">' +
    '<span class="event-time">' + esc(time) + "</span>" +
    '<span class="event-icon">' + (device ? deviceIconSvg(device) : icon("device")) + "</span>" +
    '<span class="event-main"><span class="event-who">' + esc(event.label) + "</span>" +
    '<span class="event-meta">' +
    (event.person ? esc(event.person) + " · " : "") +
    '<span class="mac">' + esc(event.mac) + "</span></span></span>" +
    '<span class="event-badge ' + (arrived ? "arrived" : "left") + '">' +
    '<i class="presence-dot' + (arrived ? " is-on" : "") + '"></i>' +
    (arrived ? "пришёл" : "ушёл") + "</span>" +
    "</div>"
  );
}

function paintEvents(root) {
  const list = root.querySelector(".event-list");
  if (!list) return;
  const rows = filteredEvents();
  if (!rows.length) {
    list.innerHTML = '<div class="empty-state compact">' + icon("history") +
      "<h3>Событий нет</h3><p>За выбранный период ничего не произошло.</p></div>";
    return;
  }
  const sorted = rows.slice().sort((a, b) => Number(b.ts) - Number(a.ts));
  const groups = new Map();
  for (const event of sorted) {
    const key = dayKey(new Date(Number(event.ts) * 1000));
    if (!groups.has(key)) groups.set(key, { date: new Date(Number(event.ts) * 1000), events: [] });
    groups.get(key).events.push(event);
  }
  list.innerHTML = Array.from(groups.values())
    .map((group) => {
      const count = group.events.length;
      return (
        '<section class="event-day"><div class="event-day-head"><h3>' +
        esc(dateHeading(group.date)) + '</h3><span>' + count + " " +
        (count % 10 === 1 && count % 100 !== 11 ? "событие" : "событий") +
        "</span></div>" +
        group.events.map(eventRow).join("") + "</section>"
      );
    })
    .join("") +
    (eventsExhausted ? "" : '<button type="button" class="btn ghost events-more">Показать ещё</button>');
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
      query: eventQuery, type: eventType,
      from: period.from || 0, to: period.to || Infinity,
    });
    const columns = [
      { label: "Время", value: (event) => new Date(Number(event.ts) * 1000).toLocaleString("ru-RU") },
      { label: "Тип", value: (event) => (event.type === "arrived" ? "пришёл" : "ушёл") },
      { label: "Устройство", value: (event) => event.label || "" },
      { label: "MAC", value: (event) => event.mac || "" },
    ];
    downloadText(csvFilename("homepanel-events"), toCsv(columns, rows));
  } catch (error) {
    toast("Не удалось выгрузить события: " + error.message, "error");
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
    const perDayCap = group === "day" ? 1440 : 10080;
    const bars = barsFromStats(rows).map((bar) =>
      person ? { ...bar, value: Math.min(bar.value, perDayCap) } : bar,
    );
    output.innerHTML = "";
    if (!bars.length) {
      output.innerHTML = '<p class="muted">Нет данных за выбранный период.</p>';
      return;
    }
    const total = bars.reduce((sum, bar) => sum + bar.value, 0);
    const summary = document.createElement("div");
    summary.className = "chart-summary";
    const days = bars.length || 1;
    summary.innerHTML =
      '<span class="chart-total">' + esc(formatDuration(total * 60)) +
      "</span><span class=\"muted\">" +
      (person ? "· " + esc(person) : "· суммарно по всем устройствам") +
      " · в среднем " + esc(formatDuration(Math.round(total / days) * 60)) +
      " в " + (group === "week" ? "неделю" : "день") +
      "</span>";
    output.append(summary);
    const chart = document.createElement("div");
    chart.className = "chart-host";
    output.append(chart);
    barChart(chart, bars, {
      height: 220,
      aria: "Время онлайн по периодам",
      valueFormatter: (value) => {
        const hours = Number(value) / 60;
        const rounded = hours >= 10 ? Math.round(hours) : Math.round(hours * 10) / 10;
        return String(rounded).replace(".", ",") + " ч";
      },
    });
    const note = document.createElement("p");
    note.className = "muted chart-note";
    note.textContent =
      "Период: " + from + " — " + to + ". " +
      (person
        ? "Уникальные минуты всех устройств человека, не более суток в день."
        : "Суммарное время устройств по данным агента.");
    output.append(note);
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
  if (!person && people.length) person = people[0].person;
  const key = people.map((p) => p.person).join("|") + "|" + (state.devices || []).length;
  if (root.querySelector(".history-page") && peopleKey === key) return;

  peopleKey = key;
  root.innerHTML = shell(people);
  root.onchange = (event) => onControlsChange(root, event);
  root.oninput = (event) => onInput(root, event);
  root.onclick = (event) => onClick(root, event);
  loadStats(root);
  loadEvents(root);
}
