import { getEvents } from "../api.js";

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
  paint(document.getElementById("app"), ui.devices);
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
    </section>`;
}

async function enable(root) {
  if (typeof Notification !== "undefined" && Notification.permission === "default") {
    // запрос разрешения вызывается по жесту пользователя — до любых await
    Notification.requestPermission().then(() => paint(root, ui.devices));
  }
  const lastId = currentLastId();
  try {
    const events = await getEvents(lastId);
    writeJSON(STORAGE_KEY, nextLastId(events, lastId)); // гасим накопившиеся события
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
    root.addEventListener("click", (event) => {
      const button = event.target.closest("[data-action]");
      if (!button) return;
      if (button.dataset.action === "enable-notify") enable(root);
      else if (button.dataset.action === "disable-notify") disable(root);
      else if (button.dataset.action === "test-notify") notifySample();
    });
  }

  if (!isEditing(root)) paint(root, ui.devices);
  startLoop();
}
