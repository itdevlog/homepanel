/** Страница истории: часы онлайн по дням и неделям. */

import { getStats } from "../api.js";
import { barsFromStats, formatDuration } from "../lib.js";
import { barChart } from "../charts.js";

const DAYS = 14;
const WEEKS = 8;

let group = "day";
let person = "";
let peopleKey = null;

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
    .map((value) => {
      const label = value === "" ? "Все люди" : value;
      const isSel = value === selected ? " selected" : "";
      return '<option value="' + esc(value) + '"' + isSel + ">" + esc(label) + "</option>";
    })
    .join("");
}

function shell(people) {
  const names = [""].concat(people.map((p) => p.person));
  if (person && !names.includes(person)) names.push(person);
  const groupOptions = options([["day", "По дням"], ["week", "По неделям"]].map(([v]) => v), group);
  return (
    '<h2>История</h2>' +
    '<div class="history-controls">' +
    '<label>Период <select class="history-group">' + groupOptions + "</select></label>" +
    '<label>Человек <select class="history-person">' + options(names, person) + "</select></label>" +
    "</div>" +
    '<div class="history-output"></div>'
  );
}

async function load(root) {
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
  } else if (target.classList.contains("history-person")) {
    person = target.value;
  } else {
    return;
  }
  load(root);
}

export function render(root, state) {
  const people = state.people || [];
  const key = people.map((p) => p.person).join("|");
  if (root.querySelector(".history-controls") && peopleKey === key) return;
  peopleKey = key;
  root.innerHTML = shell(people);
  root.onchange = (event) => onControlsChange(root, event);
  load(root);
}
