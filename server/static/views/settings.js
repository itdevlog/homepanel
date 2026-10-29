import {
  addRule,
  cleanup,
  deleteRoom,
  deleteRule,
  deleteType,
  exportDatabase,
  getBackup,
  getChanges,
  getEvents,
  getMeta,
  getRules,
  importDatabase,
  saveApName,
  saveBackup,
  saveRoom,
  saveType,
} from "../api.js";
import { ICONS, deviceLabel, iconGlyph, sanitizeFilters } from "../lib.js";
import { icon } from "../icons.js";
import { confirmAction } from "../ui.js";

let settingsMeta = { rooms: [], types: [] };
const metaReady = getMeta()
  .then((data) => {
    settingsMeta = data || { rooms: [], types: [] };
  })
  .catch(() => {});

export const STORAGE_KEY = "homepanel.lastEventId";
export const FILTERS_KEY = "homepanel.notifyFilters";
export const ENABLED_KEY = "homepanel.notifyEnabled";
export const NOTIFY_MS = 10000;
const MAX_BACKUP_BYTES = 1024 * 1024;

const ui = {
  devices: [],
  enabled: false,
  filters: { people: [], devices: [] },
  loopStarted: false,
};

let rules = [];
let rulePreviewTimer = 0;

const RULE_KINDS = [
  ["", "—"],
  ["phone", "Телефон"],
  ["laptop", "Ноутбук"],
  ["tablet", "Планшет"],
  ["tv", "ТВ"],
  ["iot", "IoT"],
  ["other", "Другое"],
];

const RULE_ROLES = [
  ["", "авто"],
  ["person", "человек"],
  ["infra", "инфраструктура"],
  ["guest", "гость"],
];

const RULE_TRUSTS = [
  ["", "—"],
  ["own", "свой"],
  ["guest", "гость"],
  ["unknown", "неизвестно"],
];

function ruleKindChoices(current) {
  const choices =
    settingsMeta.types && settingsMeta.types.length
      ? [["", "—"], ...settingsMeta.types.map((item) => [item.key, item.label])]
      : RULE_KINDS.slice();
  if (current && !choices.some(([key]) => key === current)) {
    choices.push([current, current]);
  }
  return choices;
}

// --- чистая логика (покрыта node-тестами) --------------------------------

export function eventText(event, devices) {
  const device = devices.find((d) => d.mac === event.mac);
  const name = (device && device.name) || event.mac;
  const verb = event.type === "arrived" ? "пришёл" : "ушёл";
  const person = device && device.person;
  return person ? `${person}: ${name} ${verb}` : `${name} ${verb}`;
}

export function nextLastId(events, lastId) {
  let result = lastId;
  for (const event of events) {
    if (event.id > result) result = event.id;
  }
  return result;
}

export function selectNotifiable(events, lastId, filters, devices) {
  const people = filters.people || [];
  const macs = filters.devices || [];
  return events.filter((event) => {
    if (event.id <= lastId) return false;
    if (people.length === 0 && macs.length === 0) return true;
    if (macs.includes(event.mac)) return true;
    const device = devices.find((d) => d.mac === event.mac);
    return Boolean(device && device.person && people.includes(device.person));
  });
}

// --- хранение ------------------------------------------------------------

function readJSON(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* приватный режим — уведомления просто не запомнятся */
  }
}

function currentLastId() {
  const raw = readJSON(STORAGE_KEY, 0);
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

// --- уведомления ---------------------------------------------------------

function notify(event) {
  const text = eventText(event, ui.devices);
  if (typeof Notification !== "undefined" && Notification.permission === "granted") {
    try {
      new Notification("Home Panel", { body: text, tag: `hp-${event.id}` });
      return;
    } catch {
      /* некоторые браузеры требуют service worker — падаем во всплывашку */
    }
  }
  toast(text);
}

function notifySample() {
  const text = "Проверка уведомлений Home Panel";
  if (typeof Notification !== "undefined" && Notification.permission === "granted") {
    try {
      new Notification("Home Panel", { body: text });
      return;
    } catch {
      /* см. notify() */
    }
  }
  toast(text);
}

function toast(text) {
  let host = document.getElementById("toasts");
  if (!host) {
    host = document.createElement("div");
    host.id = "toasts";
    document.body.appendChild(host);
  }
  const node = document.createElement("div");
  node.className = "toast";
  node.textContent = text;
  host.appendChild(node);
  setTimeout(() => node.remove(), 6000);
}

async function tick() {
  if (!ui.enabled) return;
  const lastId = currentLastId();
  let events;
  try {
    events = await getEvents(lastId);
  } catch {
    return;
  }
  if (!events.length) return;
  for (const event of selectNotifiable(events, lastId, ui.filters, ui.devices)) {
    notify(event);
  }
  writeJSON(STORAGE_KEY, nextLastId(events, lastId));
  // Не перерисовываем страницу: tick() идёт в фоне и не должен подменять
  // активную вьюху страницей настроек (ревью C1).
}

function startLoop() {
  if (ui.loopStarted) return;
  ui.loopStarted = true;
  window.setInterval(() => {
    tick();
  }, NOTIFY_MS);
}

// --- отрисовка -----------------------------------------------------------

function isEditing(root) {
  const active = document.activeElement;
  return Boolean(
    active && root.contains(active) && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName),
  );
}

function esc(value) {
  return String(value == null ? "" : value).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]),
  );
}

function peopleOf(devices) {
  const seen = [];
  for (const device of devices) {
    if (device.person && !seen.includes(device.person)) seen.push(device.person);
  }
  return seen;
}

function permissionLabel() {
  if (typeof Notification === "undefined") return "Браузер не поддерживает уведомления.";
  switch (Notification.permission) {
    case "granted":
      return "Разрешение выдано.";
    case "denied":
      return "Разрешение запрещено в настройках браузера — показываем всплывашки на странице.";
    default:
      return "Разрешение ещё не запрошено.";
  }
}

function filterBox(kind, legend, values, selected) {
  if (!values.length) return "";
  const rows = values
    .map((value) => {
      const checked = selected.includes(value) ? " checked" : "";
      let label = value;
      if (kind === "devices") {
        const device = (ui.devices || []).find((item) => item.mac === value);
        if (device) {
          const name = deviceLabel(device);
          label = name === value ? name : name + " · " + value;
        }
      }
      return `<label class="notify-option"><input type="checkbox" data-filter-kind="${kind}" value="${esc(
        value,
      )}"${checked}> <span>${esc(label)}</span></label>`;
    })
    .join("");
  return `<fieldset class="notify-fieldset"><legend>${esc(legend)}</legend><div class="notify-options">${rows}</div></fieldset>`;
}

function selectOptions(pairs, selected) {
  const current = selected || "";
  return pairs
    .map(
      ([value, label]) =>
        `<option value="${esc(value)}"${value === current ? " selected" : ""}>${esc(label)}</option>`,
    )
    .join("");
}

function escapeAttr(value) {
  return String(value || "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

function apNamesHtml() {
  const seen = new Map();
  for (const device of ui.devices || []) {
    if (device.bss) seen.set(device.bss, device.bss_name || device.bss);
  }
  if (!seen.size) return '<p class="muted">Нет данных о точках доступа.</p>';
  return (
    '<div class="ap-list">' +
    Array.from(seen)
      .map(
        ([bss, name]) =>
          '<label class="ap-row"><code>' +
          escapeAttr(bss) +
          '</code><input type="text" class="ap-name" data-bss="' +
          escapeAttr(bss) +
          '" value="' +
          escapeAttr(name) +
          '" maxlength="40" placeholder="имя"></label>',
      )
      .join("") +
    "</div>"
  );
}

function iconOptions() {
  return ICONS.map(([key]) => [key, key]);
}

function dictionariesHtml() {
  const rooms = settingsMeta.rooms || [];
  const types = settingsMeta.types || [];
  const roomsHtml = rooms.length
    ? rooms
        .map(
          (room) =>
            '<div class="dict-row">' +
            '<input type="text" class="room-rename" data-old="' +
            escapeAttr(room.name) +
            '" value="' +
            escapeAttr(room.name) +
            '" maxlength="40">' +
            '<button type="button" class="dict-del" data-kind="room" data-name="' +
            escapeAttr(room.name) +
            '">×</button>' +
            "</div>",
        )
        .join("")
    : '<p class="muted">Комнат пока нет.</p>';
  const typesHtml = types.length
    ? types
        .map(
          (item) =>
            '<div class="dict-row">' +
            '<span class="dict-icon">' +
            icon(item.icon || "other") +
            "</span>" +
            '<span class="dict-label">' +
            escapeAttr(item.label) +
            " <small>" +
            escapeAttr(item.key) +
            "</small></span>" +
            (item.builtin
              ? '<span class="muted">встроенный</span>'
              : '<button type="button" class="dict-del" data-kind="type" data-key="' +
                escapeAttr(item.key) +
                '">×</button>') +
            "</div>",
        )
        .join("")
    : '<p class="muted">Типов пока нет.</p>';
  return (
    '<div class="dict-block"><h4>Комнаты</h4>' +
    '<div class="dict-list">' +
    roomsHtml +
    "</div>" +
    '<form class="room-form">' +
    '<input type="text" class="room-name" placeholder="новая комната" maxlength="40">' +
    '<button type="submit" class="btn">Добавить</button>' +
    "</form></div>" +
    '<div class="dict-block"><h4>Типы устройств</h4>' +
    '<div class="dict-list">' +
    typesHtml +
    "</div>" +
    '<form class="type-form">' +
    '<input type="text" class="type-key" placeholder="ключ" maxlength="32">' +
    '<input type="text" class="type-label" placeholder="название" maxlength="40">' +
    '<select class="type-icon">' +
    selectOptions(iconOptions(), "other") +
    "</select>" +
    '<button type="submit" class="btn">Добавить</button>' +
    "</form></div>"
  );
}

function reloadMeta(root) {
  return getMeta()
    .then((data) => {
      settingsMeta = data || { rooms: [], types: [] };
      paint(root, ui.devices);
    })
    .catch((error) => toast(error.message));
}

function ruleTarget(rule) {
  const kind = (ruleKindChoices(rule.kind).find(([value]) => value === rule.kind) || [
    "",
    "",
  ])[1];
  const role = (RULE_ROLES.find(([value]) => value === rule.role) || ["", ""])[1];
  const trust = (RULE_TRUSTS.find(([value]) => value === rule.trust) || ["", ""])[1];
  return [rule.person, kind, role, rule.room, trust].filter(Boolean).join(" · ");
}

function rulesListHtml() {
  if (!rules.length) {
    return '<p class="muted">Правил пока нет — новые устройства останутся неразмеченными.</p>';
  }
  return rules
    .map(
      (rule) =>
        `<div class="rule-row"><code>${esc(rule.pattern)}</code>` +
        `<span class="rule-target">${esc(ruleTarget(rule) || "—")}</span>` +
        `<button type="button" class="btn danger rule-delete" data-id="${esc(rule.id)}">Удалить</button></div>`,
    )
    .join("");
}

function patternMatches(pattern, device) {
  const value = String(pattern || "").trim().toLowerCase();
  if (!value || value.length > 120) return false;
  const normalized = value.replace(/\*+/g, "*");
  const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const rx = new RegExp("^" + escaped.replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
  const test = (text) => Boolean(text) && rx.test(String(text).toLowerCase());
  return test(device.hostname) || test(device.ip) || test(device.mac);
}

function updateRulePreview(root) {
  const input = root.querySelector(".rule-pattern");
  const box = root.querySelector(".rule-preview");
  if (!input || !box) return;
  const value = input.value.trim();
  if (!value) {
    box.textContent = "";
    return;
  }
  const hits = (ui.devices || []).filter((device) => patternMatches(value, device));
  box.textContent = hits.length
    ? "Совпадает: " +
      hits.slice(0, 5).map((device) => deviceLabel(device)).join(", ") +
      (hits.length > 5 ? " и ещё " + (hits.length - 5) : "")
    : "Совпадений нет";
}

async function loadRules(root) {
  const list = root.querySelector(".rules-list");
  try {
    const data = await getRules();
    rules = (data && data.rules) || [];
  } catch (error) {
    if (list) {
      list.innerHTML =
        '<p class="error">Не удалось загрузить правила: ' + esc(error.message) + "</p>";
    }
    return;
  }
  if (list) list.innerHTML = rulesListHtml();
}

function paint(root, devices) {
  if (!root) return;
  const people = peopleOf(devices);
  const macs = devices.map((d) => d.mac);
  root.innerHTML = `
    <section class="page settings-page">
      <header class="page-head"><div><p class="eyebrow">Конфигурация</p><h1>Настройки</h1>
      <p class="page-sub">Агент, уведомления, правила разметки и данные панели.</p></div></header>
      <div class="settings-grid">
      <section class="panel wide settings-card" id="settings-agent">
        <div class="panel-head"><div><h2>Агент на роутере</h2><p class="panel-sub">Секрет в <code>config.json</code> сервера и UCI-конфиге роутера должен совпадать.</p></div>
        <span class="panel-icon">${icon("router")}</span></div>
        <p class="muted">Настройка — LuCI → Services → Home Panel. Уведомления работают только при открытии панели по HTTPS-домену, не по «сырому» IP:port.</p>
        <details class="code-details"><summary>${icon("code")} Команды установки</summary>
          <div class="code-wrap"><pre><code>uci set homepanel.main.server_url='http://192.168.1.10:8787/api/ingest'
uci set homepanel.main.secret='&lt;ваш секрет&gt;'
uci commit homepanel
/etc/init.d/homepanel-agent restart</code></pre><button type="button" class="icon-btn copy-code" title="Скопировать">${icon("copy")}</button></div>
        </details>
        <details class="code-details"><summary>${icon("code")} Проверка приёма снимка</summary>
          <div class="code-wrap"><pre><code>curl -s -X POST http://127.0.0.1:8787/api/ingest \\
  -H 'X-Homepanel-Key: &lt;ваш секрет&gt;' \\
  -H 'Content-Type: application/json' \\
  -d '{"schema":1,"clients":[]}'</code></pre><button type="button" class="icon-btn copy-code" title="Скопировать">${icon("copy")}</button></div>
        </details>
      </section>
      <section class="panel settings-card" id="settings-notify">
        <div class="panel-head"><div><h2>Уведомления</h2><p class="panel-sub">${esc(permissionLabel())}</p></div>
        <span class="status-tag${ui.enabled ? " is-ok" : ""}">${ui.enabled ? "включены" : "выключены"}</span></div>
        <div class="notify-actions">
          <button class="btn primary" data-action="enable-notify">${icon("bell")}Включить</button>
          <button class="btn ghost" data-action="test-notify">Проверить</button>
          <button class="btn ghost" data-action="disable-notify">Выключить</button>
        </div>
        <div class="notify-filters">
          ${filterBox("people", "Люди", people, ui.filters.people)}
          ${filterBox("devices", "Устройства", macs, ui.filters.devices)}
        </div>
        <p class="muted hint">Ничего не отмечено — уведомляем обо всех. Фильтр применяется к событиям «пришёл» и «ушёл».</p>
      </section>
      <section class="panel wide settings-card" id="settings-rules">
        <div class="panel-head"><div><h2>Правила разметки</h2><p class="panel-sub">Шаблон проверяется по hostname, IP и MAC; поддерживаются <code>*</code> и <code>?</code>.</p></div>
        <span class="panel-icon">${icon("sliders")}</span></div>
        <form class="rule-form">
          <label class="form-field wide"><span>Шаблон</span><input type="text" class="rule-pattern" placeholder="например, iPhone-*" maxlength="120" required></label>
          <label class="form-field"><span>Человек</span><input type="text" class="rule-person" placeholder="имя"></label>
          <label class="form-field"><span>Тип</span><select class="rule-kind">${selectOptions(ruleKindChoices(""), "")}</select></label>
          <label class="form-field"><span>Роль</span><select class="rule-role">${selectOptions(RULE_ROLES, "")}</select></label>
          <label class="form-field"><span>Комната</span><input type="text" class="rule-room" placeholder="комната" maxlength="40"></label>
          <label class="form-field"><span>Доверие</span><select class="rule-trust">${selectOptions(RULE_TRUSTS, "")}</select></label>
          <button type="submit" class="btn primary rule-add">${icon("plus")}Добавить правило</button>
        </form>
        <div class="rule-preview muted"></div>
        <div class="rules-list">${rulesListHtml()}</div>
      </section>
      <section class="panel settings-card" id="settings-backup">
        <div class="panel-head"><div><h2>Резервная копия</h2><p class="panel-sub">Разметка устройств и правила. Без секретов и истории.</p></div>
        <span class="panel-icon">${icon("download")}</span></div>
        <div class="backup-actions">
          <button type="button" class="btn" data-action="backup-download">${icon("download")}Скачать JSON</button>
          <label class="btn ghost backup-upload">${icon("upload")}Загрузить
            <input type="file" class="backup-file" accept="application/json,.json" hidden>
          </label>
        </div>
      </section>
      <section class="panel settings-card" id="settings-db">
        <div class="panel-head"><div><h2>База данных</h2><p class="panel-sub">Полная копия SQLite. Импорт заменяет базу.</p></div>
        <span class="panel-icon">${icon("database")}</span></div>
        <div class="backup-actions">
          <button type="button" class="btn" data-action="db-export">${icon("download")}Скачать базу</button>
          <label class="btn ghost backup-upload">${icon("upload")}Заменить
            <input type="file" class="db-file" accept=".sqlite3,.sqlite,.db,application/octet-stream" hidden>
          </label>
        </div>
        <p class="muted hint">Прежний файл сохраняется рядом как <code>.before-import</code>.</p>
      </section>
      <section class="panel settings-card" id="settings-cleanup">
        <div class="panel-head"><div><h2>Очистка данных</h2><p class="panel-sub">Удаляет старые события, минуты и замеры сигнала. Разметка остаётся.</p></div>
        <span class="panel-icon">${icon("trash")}</span></div>
        <div class="backup-actions">
          <button type="button" class="btn ghost" data-action="cleanup" data-days="30">Старше 30 дней</button>
          <button type="button" class="btn ghost" data-action="cleanup" data-days="90">Старше 90 дней</button>
          <button type="button" class="btn ghost" data-action="cleanup" data-days="365">Старше года</button>
        </div>
      </section>
      <section class="panel settings-card" id="settings-changes">
        <div class="panel-head"><div><h2>Журнал изменений</h2><p class="panel-sub">Последние правки разметки и правил.</p></div>
        <span class="panel-icon">${icon("history")}</span></div>
        <div class="changes-host"><p class="muted">Загрузка…</p></div>
      </section>
      <section class="panel wide settings-card" id="settings-dictionaries">
        <div class="panel-head"><div><h2>Справочники</h2><p class="panel-sub">Комнаты и типы устройств. Встроенные типы удалить нельзя.</p></div>
        <span class="panel-icon">${icon("room")}</span></div>
        ${dictionariesHtml()}
      </section>
      <section class="panel wide settings-card" id="settings-ap">
        <div class="panel-head"><div><h2>Точки доступа</h2><p class="panel-sub">Понятные имена BSS. Пустое поле — показывать BSS как есть.</p></div>
        <span class="panel-icon">${icon("wifi")}</span></div>
        ${apNamesHtml()}
      </section>
      </div>
    </section>`;
}

const CHANGE_LABELS = {
  "device.update": "Изменено устройство",
  "device.delete": "Удалено устройство",
  "device.merge": "Объединены устройства",
  "devices.bulk": "Массовое действие",
  "rule.add": "Добавлено правило",
  "rule.delete": "Удалено правило",
};

async function loadChanges(root) {
  const host = root.querySelector(".changes-host");
  if (!host) return;
  try {
    const data = await getChanges(40);
    const rows = data.changes || [];
    if (!rows.length) {
      host.innerHTML = '<p class="muted">Изменений пока не было.</p>';
      return;
    }
    host.innerHTML =
      '<ul class="changes-list">' +
      rows
        .map((row) => {
          const when = new Date(Number(row.ts) * 1000).toLocaleString("ru-RU");
          const label = CHANGE_LABELS[row.action] || row.action;
          const target = row.mac
            ? esc(row.mac) + (row.detail ? " · " + esc(row.detail) : "")
            : esc(row.detail || "");
          return (
            "<li><span class=\"sub\">" +
            esc(when) +
            "</span> <strong>" +
            esc(label) +
            "</strong> " +
            target +
            "</li>"
          );
        })
        .join("") +
      "</ul>";
  } catch (error) {
    host.innerHTML = '<p class="error">' + esc(error.message) + "</p>";
  }
}

async function enable(root) {
  if (typeof Notification !== "undefined" && Notification.permission === "default") {
    // запрос разрешения вызывается по жесту пользователя — до любых await
    Notification.requestPermission().then(() => paint(root, ui.devices));
  }
  const lastId = currentLastId();
  try {
    // Берём только самое свежее событие, чтобы при первом включении не
    // выплеснуть всю историю уведомлениями (ревью I1).
    const newest = await getEvents(null, 1);
    writeJSON(STORAGE_KEY, nextLastId(newest, lastId));
  } catch {
    /* сеть недоступна — начнём с текущего id */
  }
  ui.enabled = true;
  writeJSON(ENABLED_KEY, true);
  paint(root, ui.devices);
}

function disable(root) {
  ui.enabled = false;
  writeJSON(ENABLED_KEY, false);
  paint(root, ui.devices);
}

async function runCleanup(days) {
  const ok = await confirmAction(
    `События и замеры старше ${days} дней будут удалены. Разметка устройств останется.`,
    { title: "Очистить старые данные?", confirmLabel: "Очистить", danger: true },
  );
  if (!ok) return;
  try {
    const result = await cleanup({ days });
    toast(
      `Удалено: события — ${result.events}, минуты — ${result.minutes}, ` +
        `дни — ${result.days_deleted}, сигнал — ${result.signals}.`,
    );
  } catch (error) {
    toast(error.message);
  }
}

async function downloadDatabase() {
  try {
    const blob = await exportDatabase();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "homepanel.sqlite3";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    toast(error.message);
  }
}

async function uploadDatabase(file) {
  const ok = await confirmAction(
    "Текущая база будет заменена. Прежний файл сохранится рядом на сервере.",
    { title: "Заменить базу данных?", confirmLabel: "Заменить", danger: true },
  );
  if (!ok) return;
  try {
    const result = await importDatabase(file);
    toast(`База заменена. Устройств: ${result.devices}.`);
    location.reload();
  } catch (error) {
    toast(error.message);
  }
}

async function downloadBackup() {
  try {
    const data = await getBackup();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "homepanel-backup-" + new Date().toISOString().slice(0, 10) + ".json";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    toast("Не удалось скачать резервную копию: " + error.message);
  }
}

// --- вход ----------------------------------------------------------------

export function render(root, state) {
  ui.devices = state.devices || [];
  ui.enabled = readJSON(ENABLED_KEY, false);
  ui.filters = sanitizeFilters(readJSON(FILTERS_KEY, { people: [], devices: [] }));

  if (!root.dataset.settingsBound) {
    root.dataset.settingsBound = "1";
    root.addEventListener("change", (event) => {
      const box = event.target.closest("[data-filter-kind]");
      if (!box) return;
      const kind = box.dataset.filterKind;
      const list = ui.filters[kind] || [];
      ui.filters[kind] = box.checked
        ? [...new Set([...list, box.value])]
        : list.filter((v) => v !== box.value);
      writeJSON(FILTERS_KEY, ui.filters);
    });
    root.addEventListener("input", (event) => {
      if (!event.target.classList.contains("rule-pattern")) return;
      clearTimeout(rulePreviewTimer);
      rulePreviewTimer = setTimeout(() => updateRulePreview(root), 150);
    });
    root.addEventListener("change", (event) => {
      if (event.target.classList.contains("db-file")) {
        const file = event.target.files && event.target.files[0];
        if (file) uploadDatabase(file);
        event.target.value = "";
      }
    });
    root.addEventListener("change", (event) => {
      const input = event.target.closest(".ap-name");
      if (!input) return;
      saveApName(input.dataset.bss, input.value.trim()).catch((error) => toast(error.message));
    });
    root.addEventListener("change", (event) => {
      const input = event.target.closest(".room-rename");
      if (!input) return;
      const name = input.value.trim();
      if (!name) {
        toast("Название комнаты не может быть пустым");
        input.value = input.dataset.old;
        return;
      }
      if (
        settingsMeta.rooms.some(
          (room) => room.name === name && room.name !== input.dataset.old,
        )
      ) {
        toast("Комната с таким названием уже существует");
        input.value = input.dataset.old;
        return;
      }
      saveRoom({ name, old: input.dataset.old })
        .then(() => reloadMeta(root))
        .catch((error) => toast(error.message));
    });
    root.addEventListener("submit", (event) => {
      const roomForm = event.target.closest(".room-form");
      if (roomForm) {
        event.preventDefault();
        const name = roomForm.querySelector(".room-name").value.trim();
        if (!name) return;
        saveRoom({ name })
          .then(() => {
            roomForm.reset();
            return reloadMeta(root);
          })
          .catch((error) => toast(error.message));
        return;
      }
      const typeForm = event.target.closest(".type-form");
      if (typeForm) {
        event.preventDefault();
        const key = typeForm.querySelector(".type-key").value.trim().toLowerCase();
        const label = typeForm.querySelector(".type-label").value.trim();
        const icon = typeForm.querySelector(".type-icon").value;
        if (!key || !label) return;
        saveType({ key, label, icon })
          .then(() => {
            typeForm.reset();
            return reloadMeta(root);
          })
          .catch((error) => toast(error.message));
      }
    });
    root.addEventListener("click", async (event) => {
      const button = event.target.closest(".dict-del");
      if (!button) return;
      const kind = button.dataset.kind;
      const name = button.dataset.name || button.dataset.key;
      if (!name) return;
      const what = kind === "room" ? "комнату" : "тип";
      const ok = await confirmAction(
        `«${name}» больше не будет доступен как вариант при разметке.`,
        { title: `Удалить ${what}?`, confirmLabel: "Удалить", danger: true },
      );
      if (!ok) return;
      const action = kind === "room" ? deleteRoom(name) : deleteType(name);
      action.then(() => reloadMeta(root)).catch((error) => toast(error.message));
    });
    root.addEventListener("submit", (event) => {
      const form = event.target.closest(".rule-form");
      if (!form) return;
      event.preventDefault();
      const pattern = form.querySelector(".rule-pattern").value.trim();
      if (!pattern) return;
      const person = form.querySelector(".rule-person").value.trim();
      const kind = form.querySelector(".rule-kind").value;
      const role = form.querySelector(".rule-role").value;
      const room = form.querySelector(".rule-room").value.trim();
      const trust = form.querySelector(".rule-trust").value;
      const body = { pattern };
      if (person) body.person = person;
      if (kind) body.kind = kind;
      if (role) body.role = role;
      if (room) body.room = room;
      if (trust) body.trust = trust;
      addRule(body)
        .then(() => {
          form.reset();
          return loadRules(root);
        })
        .catch((error) => toast(error.message));
    });
    root.addEventListener("click", (event) => {
      const removeRule = event.target.closest(".rule-delete");
      if (removeRule) {
        deleteRule(Number(removeRule.dataset.id))
          .then(() => loadRules(root))
          .catch((error) => toast(error.message));
        return;
      }
      const copy = event.target.closest(".copy-code");
      if (copy) {
        const pre = copy.parentElement.querySelector("pre");
        if (pre && navigator.clipboard) {
          navigator.clipboard.writeText(pre.innerText).then(
            () => toast("Команды скопированы"),
            () => toast("Не удалось скопировать"),
          );
        }
        return;
      }
      const button = event.target.closest("[data-action]");
      if (!button) return;
      if (button.dataset.action === "enable-notify") enable(root);
      else if (button.dataset.action === "disable-notify") disable(root);
      else if (button.dataset.action === "test-notify") notifySample();
      else if (button.dataset.action === "db-export") downloadDatabase();
      else if (button.dataset.action === "cleanup") runCleanup(Number(button.dataset.days));
      else if (button.dataset.action === "backup-download") downloadBackup();
    });
    root.addEventListener("change", (event) => {
      if (!event.target.classList.contains("backup-file")) return;
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      if (file.size > MAX_BACKUP_BYTES) {
        toast("Файл резервной копии слишком большой (максимум 1 МБ)");
        event.target.value = "";
        return;
      }
      if (file.type !== "application/json" && !/\.json$/i.test(file.name)) {
        toast("Выберите файл резервной копии в формате JSON");
        event.target.value = "";
        return;
      }
      file
        .text()
        .then((text) => saveBackup(JSON.parse(text)))
        .then((result) => {
          toast(`Восстановлено: устройств ${result.devices}, правил ${result.rules}.`);
          window.dispatchEvent(new Event("homepanel:refresh"));
          return loadRules(root);
        })
        .catch((error) => toast("Не удалось восстановить: " + error.message));
      event.target.value = "";
    });
  }

  if (!isEditing(root)) paint(root, ui.devices);
  metaReady.then(() => {
    if (isEditing(root)) return;
    paint(root, ui.devices);
    loadChanges(root);
  });
  loadRules(root);
  loadChanges(root);
  startLoop();
}
