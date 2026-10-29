/**
 * Страница «Устройства»: список по комнатам, быстрые действия и редактор.
 * Данные приходят из `GET /api/devices`; правка сохраняется через POST.
 */
import {
  bulkDevices,
  controlKick,
  controlPause,
  forgetDevice,
  getJSON,
  getMeta,
  postJSON,
  promoteDevice,
  unmergeDevice,
} from "../api.js";
import {
  csvFilename,
  deviceLabel,
  downloadText,
  duplicateGroups,
  filterDeviceList,
  formatDuration,
  formatTraffic,
  groupByRoom,
  isRandomMac,
  lastSeenText,
  plural,
  signalLabel,
  signalLevel,
  sortDevices,
  toCsv,
} from "../lib.js";
import { sparkline } from "../charts.js";
import { confirmAction } from "../ui.js";
import { avatar, deviceIconSvg, icon } from "../icons.js";
import { openDeviceDetail } from "./device-detail.js";

let meta = { rooms: [], types: [] };
const metaReady = getMeta()
  .then((data) => {
    meta = data || { rooms: [], types: [] };
  })
  .catch(() => {});

function kindChoices(current) {
  const choices =
    meta.types && meta.types.length
      ? [["", "—"], ...meta.types.map((item) => [item.key, item.label])]
      : KINDS.slice();
  if (current && !choices.some(([key]) => key === current)) choices.push([current, current]);
  return choices;
}

function roomChoices(current) {
  const names = (meta.rooms || []).map((room) => room.name);
  if (current && !names.includes(current)) names.push(current);
  return [["", "—"], ...names.map((name) => [name, name])];
}

function iconChoices(current) {
  const values = [["", "по типу"], ...ICONS.map(([key]) => [key, key])];
  if (current && !ICONS.some(([key]) => key === current)) values.push([current, current]);
  return values;
}

const KINDS = [
  ["", "—"],
  ["phone", "Телефон"],
  ["laptop", "Ноутбук"],
  ["tablet", "Планшет"],
  ["tv", "ТВ"],
  ["iot", "IoT"],
  ["other", "Другое"],
];

const ROLES = [
  ["", "авто"],
  ["person", "человек"],
  ["infra", "инфраструктура"],
  ["guest", "гость"],
];

const TRUSTS = [
  ["unknown", "неизвестно"],
  ["own", "свой"],
  ["guest", "гость"],
];

const ICONS = [
  "phone", "laptop", "tablet", "tv", "light", "vacuum", "router", "speaker",
  "camera", "printer", "watch", "desktop", "plug", "other",
];

const MODES = [
  ["all", "Все"],
  ["home", "Дома"],
  ["unknown", "Без имени"],
  ["hidden", "Скрытые"],
];

const SORTS = [
  ["state", "По статусу"],
  ["name", "По имени"],
  ["signal", "По сигналу"],
  ["mac", "По MAC"],
];

function kindLabel(key) {
  const custom = (meta.types || []).find((item) => item.key === key);
  if (custom) return custom.label || key;
  const builtin = KINDS.find(([value]) => value === key);
  return builtin ? builtin[1] : key;
}

let query = "";
let mode = "all";
let sortKey = "state";
let sortDir = "asc";
let note = null;
let roomFilter = "";
let kindFilter = "";
let personFilter = "";
let groupRooms = true;
const collapsedRooms = new Set();

const FILTER_KEY = "homepanel.devices.filters";
try {
  const saved = JSON.parse(localStorage.getItem(FILTER_KEY) || "{}");
  if (typeof saved.query === "string") query = saved.query;
  if (MODES.some(([value]) => value === saved.mode)) mode = saved.mode;
  if (["name", "signal", "state", "mac"].includes(saved.sortKey)) sortKey = saved.sortKey;
  if (saved.sortDir === "desc") sortDir = "desc";
  if (typeof saved.roomFilter === "string") roomFilter = saved.roomFilter;
  if (typeof saved.kindFilter === "string") kindFilter = saved.kindFilter;
  if (typeof saved.personFilter === "string") personFilter = saved.personFilter;
  if (saved.groupRooms === false) groupRooms = false;
} catch (err) {
  /* приватный режим — умолчания */
}

let devices = [];
let rootEl = null;
let mergeDialog = null;
let editDialog = null;
let hoursSeries = {};
let hoursAt = 0;
let nowTs = 0;
let selection = new Set();

function esc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

function options(pairs, selected) {
  return pairs
    .map(([value, label]) => {
      const sel = value === (selected || "") ? " selected" : "";
      return `<option value="${esc(value)}"${sel}>${esc(label)}</option>`;
    })
    .join("");
}

function bandLabel(band) {
  if (band === "2.4") return "2.4 ГГц";
  if (band === "5") return "5 ГГц";
  return band ? esc(band) + " ГГц" : "";
}

function signalHtml(signal) {
  const level = signalLevel(signal);
  if (level === "none") return '<span class="muted">нет данных</span>';
  return (
    `<span class="signal signal-${level}" title="${esc(signal)} dBm">` +
    `<span class="signal-bars" aria-hidden="true"><i></i><i></i><i></i><i></i></span>` +
    `${esc(signalLabel(signal))}</span>`
  );
}

function presenceText(device) {
  if (device.state === "home") {
    return device.since
      ? "дома " + formatDuration(Math.max(0, nowTs - device.since))
      : "дома";
  }
  return lastSeenText(device, nowTs);
}

function sparkHtml(mac) {
  const values = hoursSeries[mac];
  if (!values || !values.length) return "";
  if (Math.max(...values.map((value) => Number(value) || 0)) < 5) return "";
  return '<span class="device-spark" title="Присутствие за 24 часа">' +
    sparkline(values) + "</span>";
}

function row(device) {
  const hostname = device.hostname && device.hostname !== "*" ? device.hostname : "";
  const sub = [hostname, device.ip].filter(Boolean).join(" · ");
  const classes = [
    "device-card",
    device.state === "home" ? "is-home" : "is-away",
    device.hidden ? "is-hidden" : "",
    device.name || device.person ? "" : "is-unknown",
    selection.has(device.mac) ? "is-selected" : "",
  ].filter(Boolean).join(" ");
  const identity = [device.room, kindLabel(device.kind), device.person]
    .filter(Boolean).join(" · ");
  const net = [
    device.link === "wired" ? "кабель" : "Wi-Fi",
    device.link === "wired" ? "" : bandLabel(device.band),
    device.link === "wired" ? "" : device.bss_name || device.bss || "",
  ].filter(Boolean).join(" · ");
  const bytes = (Number(device.rx_bytes) || 0) + (Number(device.tx_bytes) || 0);

  return (
    `<article class="${classes}" data-mac="${esc(device.mac)}">` +
    `<label class="device-check"><input type="checkbox" class="row-check" data-mac="${esc(device.mac)}"` +
    `${selection.has(device.mac) ? " checked" : ""} aria-label="Выбрать ${esc(deviceLabel(device))}"></label>` +
    `<button type="button" class="device-main device-open" data-mac="${esc(device.mac)}">` +
    `<span class="device-avatar">${deviceIconSvg(device)}` +
    `<i class="presence-dot${device.state === "home" ? " is-on" : ""}"></i></span>` +
    `<span class="device-text"><span class="device-name">${esc(deviceLabel(device))}` +
    `${device.paused ? ' <span class="tag is-warn">пауза</span>' : ""}` +
    `${device.hidden ? ' <span class="tag">скрыто</span>' : ""}</span>` +
    `<span class="device-sub">${esc(identity || "Без разметки")}` +
    `${sub ? " · " + esc(sub) : ""}</span>` +
    `<span class="device-sub mac">${esc(device.mac)}` +
    `${isRandomMac(device.mac) ? " · случайный" : ""}</span></span></button>` +
    `<div class="device-net"><span class="device-net-label">${esc(net || "—")}</span>` +
    `${device.link === "wired" ? "" : signalHtml(device.signal)}</div>` +
    `<div class="device-presence"><span class="device-state${device.state === "home" ? " is-home" : ""}">` +
    `<i class="presence-dot${device.state === "home" ? " is-on" : ""}"></i>${esc(presenceText(device))}</span>` +
    `${bytes ? '<span class="device-traffic">' + esc(formatTraffic(bytes)) + " за 5 мин</span>" : ""}` +
    `${sparkHtml(device.mac)}</div>` +
    `<div class="device-actions">` +
    `<button type="button" class="icon-btn edit-btn" data-mac="${esc(device.mac)}" title="Изменить" aria-label="Изменить">${icon("edit")}</button>` +
    `<button type="button" class="icon-btn open-detail" title="Подробнее" aria-label="Подробнее" data-mac="${esc(device.mac)}">${icon("external")}</button>` +
    (device.link === "wired"
      ? ""
      : `<button type="button" class="icon-btn kick-btn" data-mac="${esc(device.mac)}" title="Отключить от Wi-Fi" aria-label="Отключить от Wi-Fi">${icon("power")}</button>`) +
    `<button type="button" class="icon-btn pause-btn" data-mac="${esc(device.mac)}" title="${device.paused ? "Вернуть интернет" : "Заблокировать интернет"}" aria-label="${device.paused ? "Вернуть интернет" : "Заблокировать интернет"}">${icon(device.paused ? "play" : "pause")}</button>` +
    `<button type="button" class="icon-btn merge-btn" data-mac="${esc(device.mac)}" title="Объединить" aria-label="Объединить">${icon("merge")}</button>` +
    `<button type="button" class="icon-btn danger forget-btn" data-mac="${esc(device.mac)}" title="Удалить" aria-label="Удалить">${icon("trash")}</button>` +
    `</div>` +
    (Array.isArray(device.merged) && device.merged.length
      ? `<div class="merged-list">` +
        device.merged.map((mac) =>
          `<span class="merged-item"><button type="button" class="merged-chip promote-btn" data-mac="${esc(mac)}" data-target="${esc(device.mac)}" title="Сделать основным">${esc(mac)} ${icon("up")}</button>` +
          `<button type="button" class="merged-chip unmerge-btn" data-mac="${esc(mac)}" title="Разъединить">${icon("x")}</button></span>`,
        ).join("") + `</div>`
      : "") +
    `</article>`
  );
}

function toolbar(filteredCount) {
  const home = devices.filter((d) => d.state === "home" && !d.hidden).length;
  const total = devices.length;
  const counter = `${total} ${plural(total, "устройство", "устройства", "устройств")} · ${home} дома` +
    (filteredCount === total ? "" : ` · показано ${filteredCount}`);
  return (
    `<div class="devices-toolbar">` +
    `<div class="toolbar-main">` +
    `<label class="search-field">${icon("search")}` +
    `<input type="search" class="search" placeholder="Поиск по имени, MAC или IP" value="${esc(query)}" aria-label="Поиск устройств"></label>` +
    `<div class="segmented" role="group" aria-label="Быстрый фильтр">` +
    MODES.map(([value, label]) =>
      `<button type="button" class="chip${value === mode ? " is-active" : ""}" data-mode="${value}" aria-pressed="${value === mode}">${esc(label)}</button>`,
    ).join("") +
    `</div>` +
    `<span class="counter">${esc(counter)}</span>` +
    `<button type="button" class="btn ghost csv-btn" title="Скачать таблицу в CSV">${icon("download")}CSV</button>` +
    `</div>` +
    `<div class="toolbar-filters">` +
    `<label class="filter-field"><span>Комната</span><select class="room-filter">${options(roomFilterOptions(), roomFilter)}</select></label>` +
    `<label class="filter-field"><span>Тип</span><select class="kind-filter">${options(kindFilterOptions(), kindFilter)}</select></label>` +
    `<label class="filter-field"><span>Человек</span><select class="person-filter">${options(personFilterOptions(), personFilter)}</select></label>` +
    `<label class="filter-field"><span>Сортировка</span><select class="sort-select">${options(SORTS, sortKey)}</select></label>` +
    `<button type="button" class="icon-btn sort-dir" title="${sortDir === "asc" ? "По возрастанию" : "По убыванию"}">${icon(sortDir === "asc" ? "up" : "down")}</button>` +
    `<label class="switch-field"><input type="checkbox" class="group-toggle-box"${groupRooms ? " checked" : ""}> <span>По комнатам</span></label>` +
    `</div></div>`
  );
}

function roomFilterOptions() {
  const rooms = Array.from(new Set(devices.map((device) => device.room).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b, "ru"));
  const noRoom = devices.filter((device) => !device.room).length;
  const list = [["", "Все комнаты"], ...rooms.map((room) => [room, room])];
  if (noRoom) list.push(["__none__", "Без комнаты (" + noRoom + ")"]);
  return list;
}

function kindFilterOptions() {
  const counts = new Map();
  for (const device of devices) {
    const key = device.kind || "";
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
  }
  const noKind = devices.filter((device) => !device.kind).length;
  const kinds = Array.from(counts.entries())
    .sort((a, b) => kindLabel(a[0]).localeCompare(kindLabel(b[0]), "ru"))
    .map(([key, count]) => [key, kindLabel(key) + " (" + count + ")"]);
  if (noKind) kinds.push(["__none__", "Без типа (" + noKind + ")"]);
  return [["", "Все типы"], ...kinds];
}

function personFilterOptions() {
  const people = Array.from(new Set(devices.map((device) => device.person).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b, "ru"));
  return [["", "Все люди"], ["__none__", "Без человека"], ...people.map((name) => [name, name])];
}

function filtersHtml() {
  return (
    '<div class="history-controls">' +
    '<label>Комната <select class="room-filter">' + options(roomFilterOptions(), roomFilter) + "</select></label>" +
    '<label>Тип <select class="kind-filter">' + options(kindFilterOptions(), kindFilter) + "</select></label>" +
    '<label>Человек <select class="person-filter">' + options(personFilterOptions(), personFilter) + "</select></label>" +
    "</div>"
  );
}

function applyFilters(items = devices) {
  return filterDeviceList(items, { query, mode, kind: kindFilter, person: personFilter, room: roomFilter });
}

function normalizeFilters(items = devices) {
  const kinds = new Set(items.map((device) => device.kind).filter(Boolean));
  if (kindFilter && kindFilter !== "__none__" && !kinds.has(kindFilter)) kindFilter = "";
  const people = new Set(items.map((device) => device.person).filter(Boolean));
  if (personFilter && personFilter !== "__none__" && !people.has(personFilter)) personFilter = "";
  const rooms = new Set(items.map((device) => device.room).filter(Boolean));
  if (roomFilter && roomFilter !== "__none__" && !rooms.has(roomFilter)) roomFilter = "";
}

function groupToggleHtml() {
  return (
    '<label class="group-toggle"><input type="checkbox" class="group-toggle-box"' +
    (groupRooms ? " checked" : "") + "> Группировать по комнатам</label>"
  );
}

function roomHead(group) {
  const collapsed = collapsedRooms.has(group.room);
  return (
    `<div class="room-group-head">` +
    `<button type="button" class="group-toggle-row" data-room="${esc(group.room)}" aria-expanded="${!collapsed}">` +
    `${icon("chevron", "room-chevron" + (collapsed ? " is-collapsed" : ""))}` +
    `<strong>${esc(group.room || "Без комнаты")}</strong></button>` +
    `<span class="room-group-meta">${group.total} ${plural(group.total, "устройство", "устройства", "устройств")} · ${group.online} онлайн</span>` +
    `</div>`
  );
}

function bulkBar() {
  if (!selection.size) return "";
  return (
    `<div class="bulk-bar"><strong>Выбрано: ${selection.size}</strong>` +
    `<input type="text" class="bulk-person" placeholder="человек" maxlength="64">` +
    `<select class="bulk-kind">${options(kindChoices(""), "")}</select>` +
    `<select class="bulk-trust">${options([["", "—"]].concat(TRUSTS), "")}</select>` +
    `<button type="button" class="btn primary bulk-apply">Применить</button>` +
    `<button type="button" class="btn ghost bulk-hide">Скрыть</button>` +
    `<button type="button" class="btn ghost bulk-show">Показать</button>` +
    `<button type="button" class="btn danger bulk-delete">Удалить</button>` +
    `<button type="button" class="btn ghost bulk-clear">Снять</button></div>`
  );
}

function duplicatesHtml() {
  const groups = duplicateGroups(devices);
  if (!groups.length) return "";
  const blocks = groups.map((group) => {
    const target = group.devices.find((device) => device.person || device.name) || group.devices[0];
    const items = group.devices.map((device) => {
      const isTarget = device.mac === target.mac;
      return (
        `<span class="dup-item">${esc(deviceLabel(device))} <span class="sub mac">${esc(device.mac)}</span>` +
        (isTarget ? ` <span class="dup-target">оставить</span>` :
          ` <button type="button" class="btn small dup-merge" data-src="${esc(device.mac)}" data-dst="${esc(target.mac)}">объединить</button>`) +
        `</span>`
      );
    });
    return `<div class="dup-group"><div class="dup-title">${esc(group.hostname || group.ip)}</div>${items.join("")}</div>`;
  });
  return `<details class="duplicates"><summary>${icon("merge")}Возможные дубли · ${groups.length}</summary>${blocks.join("")}</details>`;
}

function exportCsv() {
  const rows = sortDevices(applyFilters(), sortKey, sortDir);
  const columns = [
    { label: "MAC", value: (d) => d.mac },
    { label: "Имя", value: (d) => d.name || "" },
    { label: "Человек", value: (d) => d.person || "" },
    { label: "Тип", value: (d) => [d.kind, d.role, d.room].filter(Boolean).join(" · ") },
    { label: "Доверие", value: (d) => d.trust || "" },
    { label: "Скрыто", value: (d) => (d.hidden ? "да" : "нет") },
    { label: "Состояние", value: (d) => (d.state === "home" ? "дома" : "нет") },
    { label: "Диапазон", value: (d) => d.band || "" },
    { label: "BSSID", value: (d) => d.bss_name || d.bss || "" },
    { label: "Сигнал, dBm", value: (d) => (d.signal == null ? "" : d.signal) },
    { label: "IP", value: (d) => d.ip || "" },
    { label: "Hostname", value: (d) => (d.hostname && d.hostname !== "*" ? d.hostname : "") },
    { label: "Последний раз", value: (d) => (d.last_seen ? new Date(d.last_seen * 1000).toLocaleString("ru-RU") : "") },
  ];
  downloadText(csvFilename("homepanel-devices"), toCsv(columns, rows));
  setNote(`Экспортировано ${rows.length} ${plural(rows.length, "устройство", "устройства", "устройств")}.`, false);
}

function paint() {
  if (!rootEl) return;
  const filtered = sortDevices(applyFilters(), sortKey, sortDir);
  const bodyParts = [];
  if (groupRooms) {
    for (const group of groupByRoom(filtered)) {
      bodyParts.push('<section class="room-group">' + roomHead(group));
      if (!collapsedRooms.has(group.room)) {
        bodyParts.push('<div class="room-body">' + group.devices.map(row).join("") + "</div>");
      }
      bodyParts.push("</section>");
    }
  } else {
    bodyParts.push(filtered.map(row).join(""));
  }
  const body = bodyParts.length
    ? bodyParts.join("")
    : devices.length
      ? `<div class="empty-state">${icon("devices")}<h3>Ничего не найдено</h3><p>Сбросьте фильтры или измените запрос.</p><button type="button" class="btn reset-filters">Сбросить фильтры</button></div>`
      : `<div class="empty-state">${icon("devices")}<h3>Устройств пока нет</h3><p>Как только агент пришлёт первый снимок сети, устройства появятся здесь.</p></div>`;
  const allSelected = filtered.length > 0 && filtered.every((device) => selection.has(device.mac));

  rootEl.innerHTML =
    '<section class="page devices-page">' +
    '<header class="page-head"><div><p class="eyebrow">Инвентарь сети</p><h1>Устройства</h1>' +
    '<p class="page-sub">Кто в сети, где находится и как к нему подключиться. Нажмите на строку, чтобы открыть детали.</p></div>' +
    (devices.length
      ? `<div class="page-actions"><button type="button" class="btn ghost select-all-btn">${allSelected ? "Снять выбор" : "Выбрать все"}</button></div>`
      : "") +
    "</header>" +
    toolbar(filtered.length) +
    duplicatesHtml() +
    `<p class="devices-status${note && note.error ? " error" : " muted"}">${note ? esc(note.text) : ""}</p>` +
    `<div class="devices-list${groupRooms ? " is-grouped" : ""}">${body}</div>` +
    bulkBar() +
    "</section>";
}

function ensureEditDialog() {
  if (editDialog) return editDialog;
  editDialog = document.createElement("dialog");
  editDialog.className = "sheet-dialog device-edit";
  editDialog.innerHTML =
    `<form class="device-form" method="dialog">` +
    `<div class="sheet-head"><div class="sheet-title"></div>` +
    `<button type="button" class="icon-btn sheet-close" aria-label="Закрыть">${icon("x")}</button></div>` +
    `<div class="sheet-body">` +
    `<label class="form-field"><span>Имя</span><input type="text" name="name" maxlength="64" placeholder="Например, iPhone Ани"></label>` +
    `<label class="form-field"><span>Человек</span><input type="text" name="person" maxlength="64" placeholder="Имя жильца" list="people-list"></label>` +
    `<label class="form-field"><span>Комната</span><select name="room"></select></label>` +
    `<label class="form-field"><span>Тип</span><select name="kind"></select></label>` +
    `<label class="form-field"><span>Роль</span><select name="role">${options(ROLES, "")}</select></label>` +
    `<label class="form-field"><span>Доверие</span><select name="trust">${options(TRUSTS, "unknown")}</select></label>` +
    `<label class="form-field"><span>Иконка</span><select name="icon"></select></label>` +
    `<label class="form-field wide"><span>Заметка</span><input type="text" name="notes" maxlength="200" placeholder="Например, рабочий ноутбук"></label>` +
    `<label class="switch-field wide"><input type="checkbox" name="hidden"> <span>Скрыть с главной страницы</span></label>` +
    `</div>` +
    `<div class="sheet-foot"><span class="sheet-hint"></span>` +
    `<button type="button" class="btn ghost sheet-cancel">Отмена</button>` +
    `<button type="submit" class="btn primary">Сохранить</button></div></form>`;
  editDialog.querySelector(".sheet-close").addEventListener("click", () => editDialog.close());
  editDialog.querySelector(".sheet-cancel").addEventListener("click", () => editDialog.close());
  editDialog.addEventListener("click", (event) => {
    if (event.target === editDialog) editDialog.close();
  });
  editDialog.querySelector("form").addEventListener("submit", (event) => {
    event.preventDefault();
    const mac = editDialog.dataset.mac;
    if (!mac) return;
    const form = editDialog.querySelector("form");
    const payload = { mac };
    for (const name of ["name", "person", "notes", "kind", "role", "room", "icon", "trust"]) {
      payload[name] = form.elements[name].value.trim();
    }
    payload.hidden = form.elements.hidden.checked;
    editDialog.close();
    save(payload);
  });
  document.body.appendChild(editDialog);
  return editDialog;
}

function openEdit(mac) {
  const device = devices.find((item) => item.mac === mac);
  if (!device) return;
  const dialog = ensureEditDialog();
  const form = dialog.querySelector("form");
  dialog.dataset.mac = mac;
  dialog.querySelector(".sheet-title").innerHTML =
    `<span class="device-avatar">${deviceIconSvg(device)}</span><span><strong>${esc(deviceLabel(device))}</strong>` +
    `<span class="sub mac">${esc(device.mac)}</span></span>`;
  form.elements.name.value = device.name || "";
  form.elements.person.value = device.person || "";
  form.elements.notes.value = device.notes || "";
  form.elements.room.innerHTML = options(roomChoices(device.room), device.room || "");
  form.elements.kind.innerHTML = options(kindChoices(device.kind), device.kind || "");
  form.elements.role.value = device.role || "";
  form.elements.trust.value = device.trust || "unknown";
  form.elements.icon.innerHTML = options(iconChoices(device.icon), device.icon || "");
  form.elements.hidden.checked = Boolean(device.hidden);
  dialog.querySelector(".sheet-hint").textContent = device.state === "home"
    ? "Сейчас дома" + (device.since ? " · " + formatDuration(Math.max(0, nowTs - device.since)) : "")
    : lastSeenText(device, nowTs);
  if (!dialog.open) dialog.showModal();
  form.elements.name.focus();
}

function ensureMergeDialog() {
  if (mergeDialog) return mergeDialog;
  mergeDialog = document.createElement("dialog");
  mergeDialog.className = "sheet-dialog merge-dialog";
  mergeDialog.innerHTML =
    `<form method="dialog"><div class="sheet-head"><div class="sheet-title"><strong>Объединить устройство</strong></div>` +
    `<button type="button" class="icon-btn merge-cancel" aria-label="Закрыть">${icon("x")}</button></div>` +
    `<div class="sheet-body"><p class="hint muted"></p>` +
    `<p class="muted">Основным станет выбранное устройство. Данные текущего перенесутся в него.</p>` +
    `<label class="form-field"><span>Перенести данные в</span><select class="merge-target"></select></label></div>` +
    `<div class="sheet-foot"><button type="button" class="btn ghost merge-cancel">Отмена</button>` +
    `<button type="button" class="btn primary merge-ok">Объединить</button></div></form>`;
  mergeDialog.querySelectorAll(".merge-cancel").forEach((button) =>
    button.addEventListener("click", () => mergeDialog.close()));
  mergeDialog.querySelector(".merge-ok").addEventListener("click", () => {
    const mac = mergeDialog.dataset.mac;
    const target = mergeDialog.querySelector(".merge-target").value;
    mergeDialog.close();
    if (mac && target) save({ mac, mergeInto: target });
  });
  document.body.appendChild(mergeDialog);
  return mergeDialog;
}

function openMerge(mac) {
  const others = devices.filter((device) => device.mac !== mac);
  if (!others.length) {
    note = { text: "Некуда объединять: других устройств нет.", error: true };
    paint();
    return;
  }
  const dialog = ensureMergeDialog();
  dialog.querySelector(".merge-target").innerHTML = others
    .map((device) => `<option value="${esc(device.mac)}">${esc(deviceLabel(device))} — ${esc(device.mac)}</option>`)
    .join("");
  dialog.querySelector(".hint").textContent = `Данные ${mac} перенесутся в выбранное устройство, запись ${mac} исчезнет.`;
  dialog.dataset.mac = mac;
  dialog.showModal();
}

function isEditing() {
  return Boolean(document.querySelector("dialog[open]"));
}

function setNote(text, error) {
  note = text ? { text, error: Boolean(error) } : null;
  const el = rootEl && rootEl.querySelector(".devices-status");
  if (!el) return;
  el.textContent = note ? note.text : "";
  el.classList.toggle("error", Boolean(note && note.error));
  el.classList.toggle("muted", !note || !note.error);
}

async function loadHours() {
  try {
    const data = await getJSON("/api/device_hours?hours=24");
    hoursSeries = (data && data.series) || {};
  } catch (error) {
    hoursSeries = {};
  }
}

function maybeLoadHours() {
  const stamp = Date.now();
  if (stamp - hoursAt < 60000) return;
  hoursAt = stamp;
  loadHours().then(() => {
    if (!isEditing() && rootEl) paint();
  });
}

async function refresh() {
  try {
    const data = await getJSON("/api/devices");
    devices = Array.isArray(data) ? data : data.devices || [];
  } catch (error) {
    note = { text: error.message, error: true };
  }
  await loadHours();
  if (!isEditing()) paint();
  else setNote(note ? note.text : "", note && note.error);
}

async function save(payload) {
  try {
    const updated = await postJSON("/api/devices", payload);
    note = null;
    if (payload.mergeInto) {
      await refresh();
      return;
    }
    if (updated && updated.mac) {
      const index = devices.findIndex((device) => device.mac === updated.mac);
      if (index >= 0) devices[index] = { ...devices[index], ...updated };
    }
  } catch (error) {
    note = { text: error.message, error: true };
  }
  if (!isEditing()) paint();
  else setNote(note ? note.text : "", note && note.error);
}

function saveFilters() {
  try {
    localStorage.setItem(FILTER_KEY, JSON.stringify({
      query, mode, roomFilter, kindFilter, personFilter, groupRooms, sortKey, sortDir,
    }));
  } catch (err) {
    /* приватный режим */
  }
}

function onFieldChange(event) {
  const target = event.target;
  if (target.closest(".room-filter")) {
    roomFilter = target.value;
    saveFilters();
    paint();
    return;
  }
  if (target.closest(".kind-filter")) {
    kindFilter = target.value;
    saveFilters();
    paint();
    return;
  }
  if (target.closest(".person-filter")) {
    personFilter = target.value;
    saveFilters();
    paint();
    return;
  }
  if (target.closest(".sort-select")) {
    sortKey = target.value;
    saveFilters();
    paint();
    return;
  }
  if (target.closest(".group-toggle-box")) {
    groupRooms = target.checked;
    saveFilters();
    paint();
  }
}

function onSearchInput(event) {
  const input = event.target;
  if (!input.classList.contains("search")) return;
  query = input.value;
  saveFilters();
  const pos = input.selectionStart;
  paint();
  const next = rootEl.querySelector(".search");
  if (next) {
    next.focus();
    next.setSelectionRange(pos, pos);
  }
}

async function bulkAction(kind) {
  const macs = Array.from(selection);
  if (!macs.length) return;
  if (kind === "delete") {
    const ok = await confirmAction(
      `Будут удалены ${macs.length} записей и связанная история. Это действие нельзя отменить.`,
      { title: "Удалить устройства?", confirmLabel: "Удалить", danger: true },
    );
    if (!ok) return;
    bulkDevices({ macs, delete: true })
      .then(() => { selection.clear(); return refresh(); })
      .catch((error) => setNote(error.message, true));
    return;
  }
  if (kind === "hide" || kind === "show") {
    bulkDevices({ macs, fields: { hidden: kind === "hide" } })
      .then(() => { selection.clear(); return refresh(); })
      .catch((error) => setNote(error.message, true));
    return;
  }
  const fields = {};
  const person = rootEl.querySelector(".bulk-person");
  const kindSelect = rootEl.querySelector(".bulk-kind");
  const trustSelect = rootEl.querySelector(".bulk-trust");
  if (person && person.value.trim()) fields.person = person.value.trim();
  if (kindSelect && kindSelect.value) fields.kind = kindSelect.value;
  if (trustSelect && trustSelect.value) fields.trust = trustSelect.value;
  if (!Object.keys(fields).length) {
    setNote("Укажите, что изменить.", true);
    return;
  }
  bulkDevices({ macs, fields })
    .then(() => { selection.clear(); return refresh(); })
    .catch((error) => setNote(error.message, true));
}

async function onClick(event) {
  const edit = event.target.closest(".edit-btn");
  if (edit) {
    openEdit(edit.dataset.mac);
    return;
  }
  const openDetail = event.target.closest(".open-detail");
  if (openDetail) {
    const device = devices.find((item) => item.mac === openDetail.dataset.mac);
    if (device) openDeviceDetail(device, nowTs);
    return;
  }
  const info = event.target.closest(".device-open");
  if (info) {
    const device = devices.find((item) => item.mac === info.dataset.mac);
    if (device) openDeviceDetail(device, nowTs);
    return;
  }
  const promote = event.target.closest(".promote-btn");
  if (promote) {
    const mac = promote.dataset.mac;
    const target = promote.dataset.target;
    const ok = await confirmAction(
      `${mac} станет основной записью, остальные данные объединятся с ней.`,
      { title: "Сделать основным?", confirmLabel: "Сделать основным" },
    );
    if (ok) {
      promoteDevice(mac, target).then(() => refresh()).catch((error) => setNote(error.message, true));
    }
    return;
  }
  const groupButton = event.target.closest(".group-toggle-row");
  if (groupButton) {
    const room = groupButton.dataset.room;
    if (collapsedRooms.has(room)) collapsedRooms.delete(room);
    else collapsedRooms.add(room);
    paint();
    return;
  }
  const dirButton = event.target.closest(".sort-dir");
  if (dirButton) {
    sortDir = sortDir === "asc" ? "desc" : "asc";
    saveFilters();
    paint();
    return;
  }
  const reset = event.target.closest(".reset-filters");
  if (reset) {
    query = ""; mode = "all"; roomFilter = ""; kindFilter = ""; personFilter = "";
    saveFilters();
    paint();
    return;
  }
  const kick = event.target.closest(".kick-btn");
  if (kick) {
    const mac = kick.dataset.mac;
    const device = devices.find((item) => item.mac === mac);
    const ok = await confirmAction(
      "Устройство временно потеряет Wi-Fi и подключится заново.",
      { title: "Отключить " + deviceLabel(device || { mac }), confirmLabel: "Отключить" },
    );
    if (ok) {
      controlKick({ mac }).then(() => refresh()).catch((error) => setNote(error.message, true));
    }
    return;
  }
  const pause = event.target.closest(".pause-btn");
  if (pause) {
    const mac = pause.dataset.mac;
    const device = devices.find((item) => item.mac === mac);
    const next = !(device && device.paused);
    const ok = await confirmAction(
      next
        ? "Устройство останется в сети, но без доступа в интернет."
        : "Доступ в интернет будет восстановлен.",
      {
        title: (next ? "Заблокировать " : "Вернуть интернет: ") + deviceLabel(device || { mac }),
        confirmLabel: next ? "Заблокировать" : "Вернуть",
        danger: next,
      },
    );
    if (ok) {
      controlPause({ mac, paused: next }).then(() => refresh()).catch((error) => setNote(error.message, true));
    }
    return;
  }
  const forget = event.target.closest(".forget-btn");
  if (forget) {
    const mac = forget.dataset.mac;
    const device = devices.find((item) => item.mac === mac);
    const ok = await confirmAction(
      "Запись устройства и связанная история будут удалены без возможности отмены.",
      {
        title: "Удалить " + deviceLabel(device || { mac }) + "?",
        confirmLabel: "Удалить",
        danger: true,
      },
    );
    if (ok) {
      forgetDevice(mac).then(() => { selection.delete(mac); return refresh(); })
        .catch((error) => setNote(error.message, true));
    }
    return;
  }
  const check = event.target.closest(".row-check");
  if (check) {
    if (check.checked) selection.add(check.dataset.mac);
    else selection.delete(check.dataset.mac);
    paint();
    return;
  }
  const selectAll = event.target.closest(".select-all-btn");
  if (selectAll) {
    const filtered = sortDevices(applyFilters(), sortKey, sortDir);
    const allSelected = filtered.length > 0 && filtered.every((device) => selection.has(device.mac));
    if (allSelected) filtered.forEach((device) => selection.delete(device.mac));
    else filtered.forEach((device) => selection.add(device.mac));
    paint();
    return;
  }
  const bulk = event.target.closest(".bulk-apply, .bulk-hide, .bulk-show, .bulk-delete, .bulk-clear");
  if (bulk) {
    if (bulk.classList.contains("bulk-clear")) {
      selection.clear();
      paint();
    } else if (bulk.classList.contains("bulk-hide")) bulkAction("hide");
    else if (bulk.classList.contains("bulk-show")) bulkAction("show");
    else if (bulk.classList.contains("bulk-delete")) bulkAction("delete");
    else bulkAction("apply");
    return;
  }
  if (event.target.closest(".csv-btn")) {
    exportCsv();
    return;
  }
  const dup = event.target.closest(".dup-merge");
  if (dup) {
    const source = dup.dataset.src;
    const target = dup.dataset.dst;
    const ok = source && target && await confirmAction(
      `Данные ${source} перенесутся в ${target}, отдельная запись исчезнет.`,
      { title: "Объединить устройства?", confirmLabel: "Объединить" },
    );
    if (ok) save({ mac: source, mergeInto: target });
    return;
  }
  const chip = event.target.closest(".chip");
  if (chip) {
    mode = chip.dataset.mode;
    saveFilters();
    paint();
    return;
  }
  const unmerge = event.target.closest(".unmerge-btn");
  if (unmerge) {
    const mac = unmerge.dataset.mac;
    const ok = await confirmAction(
      "Запись снова станет отдельным устройством со своей историей.",
      { title: "Разъединить " + mac + "?", confirmLabel: "Разъединить" },
    );
    if (ok) {
      unmergeDevice(mac).then(() => refresh()).catch((error) => setNote(error.message, true));
    }
    return;
  }
  const merge = event.target.closest(".merge-btn");
  if (merge) openMerge(merge.dataset.mac);
}

export function render(root, state) {
  rootEl = root;
  devices = (state && state.devices) || [];
  nowTs = Number(state && state.now) || Math.floor(Date.now() / 1000);
  normalizeFilters();

  const known = new Set(devices.map((device) => device.mac));
  for (const mac of selection) if (!known.has(mac)) selection.delete(mac);

  root.onchange = onFieldChange;
  root.oninput = onSearchInput;
  root.onclick = onClick;

  if (!isEditing()) paint();
  maybeLoadHours();
}
