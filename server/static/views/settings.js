import {
  addRule,
  cleanup,
  deleteRule,
  exportDatabase,
  getBackup,
  getChanges,
  getEvents,
  getRules,
  importDatabase,
  saveApName,
  saveBackup,
} from "../api.js";
import { deviceLabel } from "../lib.js";

export const STORAGE_KEY = "homepanel.lastEventId";
export const FILTERS_KEY = "homepanel.notifyFilters";
export const ENABLED_KEY = "homepanel.notifyEnabled";
export const NOTIFY_MS = 10000;

const ui = {
  devices: [],
  enabled: false,
  filters: { people: [], devices: [] },
  loopStarted: false,
};

let rules = [];

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
      return `<label class="notify-option"><input type="checkbox" data-filter-kind="${kind}" value="${esc(
        value,
      )}"${checked}> ${esc(value)}</label>`;
    })
    .join("");
  return `<fieldset class="notify-fieldset"><legend>${esc(legend)}</legend>${rows}</fieldset>`;
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

function ruleTarget(rule) {
  const kind = (RULE_KINDS.find(([value]) => value === rule.kind) || ["", ""])[1];
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
  if (!value) return false;
  const escaped = value.replace(/[.+^${}()|[\]\\]/g, "\\$&");
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
  try {
    const data = await getRules();
    rules = (data && data.rules) || [];
  } catch (error) {
    rules = [];
  }
  const list = root.querySelector(".rules-list");
  if (list) list.innerHTML = rulesListHtml();
}

function paint(root, devices) {
  if (!root) return;
  const people = peopleOf(devices);
  const macs = devices.map((d) => d.mac);
  root.innerHTML = `
    <section class="settings-page">
      <h2>Настройки</h2>
      <div class="panel">
        <h3>Агент на роутере</h3>
        <p class="muted">Секрет задаётся в <code>config.json</code> сервера и в UCI-конфиге роутера; значения должны совпадать.</p>
        <pre><code>uci set homepanel.main.server_url='http://192.168.1.10:8787/api/ingest'
uci set homepanel.main.secret='&lt;ваш секрет&gt;'
uci commit homepanel
/etc/init.d/homepanel-agent restart</code></pre>
        <p class="muted">Проверка приёма снимка:</p>
        <pre><code>curl -s -X POST http://127.0.0.1:8787/api/ingest \\
  -H 'X-Homepanel-Key: &lt;ваш секрет&gt;' \\
  -H 'Content-Type: application/json' \\
  -d '{"schema":1,"clients":[]}'</code></pre>
        <p class="muted">Настройка на роутере — LuCI → Services → Home Panel. Уведомления работают только при открытии панели по HTTPS-домену (Nginx Proxy Manager), не по «сырому» IP:port.</p>
      </div>
      <div class="panel">
        <h3>Уведомления</h3>
        <p class="muted" id="notify-permission">${esc(permissionLabel())}</p>
        <p class="notify-actions">
          <button class="btn" data-action="enable-notify">Включить уведомления</button>
          <button class="btn" data-action="test-notify">Проверить</button>
          <button class="btn" data-action="disable-notify">Выключить</button>
          <span class="badge${ui.enabled ? " is-home" : ""}">${ui.enabled ? "включены" : "выключены"}</span>
        </p>
        <div class="notify-filters">
          ${filterBox("people", "Люди", people, ui.filters.people)}
          ${filterBox("devices", "Устройства", macs, ui.filters.devices)}
        </div>
        <p class="muted">Ничего не отмечено — уведомляем обо всех. Фильтр применяется к событиям «пришёл» и «ушёл».</p>
      </div>
      <div class="panel">
        <h3>Правила разметки</h3>
        <p class="muted">Шаблон проверяется по hostname, IP и MAC; поддерживаются <code>*</code> и <code>?</code>. Правило применяется к новым устройствам и к тем, у кого ещё нет имени и человека.</p>
        <form class="rule-form">
          <input type="text" class="rule-pattern" placeholder="например, iPhone-*" required>
          <input type="text" class="rule-person" placeholder="человек">
          <select class="rule-kind">${selectOptions(RULE_KINDS, "")}</select>
          <select class="rule-role">${selectOptions(RULE_ROLES, "")}</select>
          <input type="text" class="rule-room" placeholder="комната" maxlength="40">
          <select class="rule-trust">${selectOptions(RULE_TRUSTS, "")}</select>
          <button type="submit" class="btn primary">Добавить</button>
        </form>
        <div class="rule-preview muted"></div>
        <div class="rules-list">${rulesListHtml()}</div>
      </div>
      <div class="panel">
        <h3>Резервная копия</h3>
        <p class="muted">Экспортирует разметку устройств и правила. Секреты, события и история не выгружаются.</p>
        <div class="backup-actions">
          <button type="button" class="btn" data-action="backup-download">Скачать JSON</button>
          <label class="btn backup-upload">Загрузить
            <input type="file" class="backup-file" accept="application/json,.json" hidden>
          </label>
        </div>
      </div>
      <div class="panel">
        <h3>Точки доступа</h3>
        <p class="muted">Имена BSS. Пустое поле — показывать BSS как есть.</p>
        ${apNamesHtml()}
      </div>
      <div class="panel">
        <h3>Очистка данных</h3>
        <p class="muted">Удаляет старые события, минуты присутствия и замеры сигнала. Устройства и разметка остаются.</p>
        <div class="backup-actions">
          <button type="button" class="btn" data-action="cleanup" data-days="30">Старше 30 дней</button>
          <button type="button" class="btn" data-action="cleanup" data-days="90">Старше 90 дней</button>
          <button type="button" class="btn" data-action="cleanup" data-days="365">Старше года</button>
        </div>
      </div>
      <div class="panel">
        <h3>База данных</h3>
        <p class="muted">Полная копия SQLite: устройства, история, сигнал и журнал. Импорт заменяет текущую базу; прежний файл сохраняется рядом как <code>.before-import</code>.</p>
        <div class="backup-actions">
          <button type="button" class="btn" data-action="db-export">Скачать базу</button>
          <label class="btn backup-upload">Заменить базу
            <input type="file" class="db-file" accept=".sqlite3,.sqlite,.db,application/octet-stream" hidden>
          </label>
        </div>
      </div>
      <div class="panel">
        <h3>Журнал изменений</h3>
        <p class="muted">Последние изменения разметки и правил.</p>
        <div class="changes-host"><p class="muted">Загрузка…</p></div>
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
  if (!confirm(`Удалить данные старше ${days} дней?`)) return;
  try {
    const result = await cleanup({ days });
    alert(
      `Удалено: события — ${result.events}, минуты — ${result.minutes}, ` +
        `дни — ${result.days_deleted}, сигнал — ${result.signals}.`,
    );
  } catch (error) {
    alert(error.message);
  }
}

async function downloadDatabase() {
  try {
    const blob = await exportDatabase();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "homepanel.sqlite3";
    link.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    alert(error.message);
  }
}

async function uploadDatabase(file) {
  if (
    !confirm(
      "Заменить текущую базу данными из файла? Прежняя база сохранится рядом на сервере.",
    )
  ) {
    return;
  }
  try {
    const result = await importDatabase(file);
    alert(`База заменена. Устройств: ${result.devices}.`);
    location.reload();
  } catch (error) {
    alert(error.message);
  }
}

async function downloadBackup() {
  const data = await getBackup();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "homepanel-backup-" + new Date().toISOString().slice(0, 10) + ".json";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

// --- вход ----------------------------------------------------------------

export function render(root, state) {
  ui.devices = state.devices || [];
  ui.enabled = readJSON(ENABLED_KEY, false);
  ui.filters = readJSON(FILTERS_KEY, { people: [], devices: [] });

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
      if (event.target.classList.contains("rule-pattern")) updateRulePreview(root);
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
      saveApName(input.dataset.bss, input.value.trim()).catch((error) => alert(error.message));
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
        .catch((error) => alert(error.message));
    });
    root.addEventListener("click", (event) => {
      const removeRule = event.target.closest(".rule-delete");
      if (removeRule) {
        deleteRule(Number(removeRule.dataset.id))
          .then(() => loadRules(root))
          .catch((error) => alert(error.message));
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
      file
        .text()
        .then((text) => saveBackup(JSON.parse(text)))
        .then((result) => {
          alert(`Восстановлено: устройств ${result.devices}, правил ${result.rules}.`);
          window.dispatchEvent(new Event("homepanel:refresh"));
          return loadRules(root);
        })
        .catch((error) => alert("Не удалось восстановить: " + error.message));
      event.target.value = "";
    });
  }

  if (!isEditing(root)) paint(root, ui.devices);
  loadRules(root);
  loadChanges(root);
  startLoop();
}
