/**
 * Страница «Устройства»: поиск, фильтры, сортировка, правка и объединение MAC.
 *
 * Данные приходят массивом строк из `GET /api/devices`
 * (`{mac, name, person, kind, trust, hidden, state, bss, band, signal, ip, hostname}`).
 * Правка сохраняется сразу: `change` на поле -> `POST /api/devices` с одним MAC.
 */
import { postJSON, getDevices, getJSON } from "../api.js";
import {
  csvFilename,
  deviceLabel,
  downloadText,
  duplicateGroups,
  filterDevices,
  formatDuration,
  lastSeenText,
  plural,
  signalLevel,
  sortDevices,
  toCsv,
} from "../lib.js";
import { sparkline } from "../charts.js";

const KINDS = [
  ["", "—"],
  ["phone", "Телефон"],
  ["laptop", "Ноутбук"],
  ["tv", "ТВ"],
  ["iot", "IoT"],
  ["other", "Другое"],
];

const TRUSTS = [
  ["unknown", "неизвестно"],
  ["own", "свой"],
  ["guest", "гость"],
];

const MODES = [
  ["all", "Все"],
  ["home", "Дома"],
  ["unknown", "Без имени"],
  ["hidden", "Скрытые"],
];

const COLUMNS = 6;

let query = "";
let mode = "all";
let sortKey = "state";
let sortDir = "asc";
let note = null;
let devices = [];
let rootEl = null;
let dialogEl = null;
let hoursSeries = {};
let hoursAt = 0;
let nowTs = 0;

function esc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
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
  return band ? esc(band) : "—";
}

function signalHtml(signal) {
  const level = signalLevel(signal);
  if (level === "none") return '<span class="muted">—</span>';
  return (
    `<span class="signal signal-${level}"><span class="bar"></span>` +
    `${esc(signal)} dBm</span>`
  );
}

function stateBadge(device) {
  if (device.state === "home")
    return '<span class="badge is-home">дома</span>';
  return '<span class="badge">нет</span>';
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
  return sparkline(values);
}

function sortHeader(key, label) {
  const active = sortKey === key;
  const arrow = active ? (sortDir === "asc" ? "↑" : "↓") : "";
  const aria = active
    ? (sortDir === "asc" ? "ascending" : "descending")
    : "none";
  return (
    `<th class="sortable" data-sort="${key}" aria-sort="${aria}" ` +
    `title="Сортировать по: ${esc(label)}">${esc(label)}` +
    `<span class="arrow">${arrow}</span></th>`
  );
}

function row(device) {
  const hostname =
    device.hostname && device.hostname !== "*" ? device.hostname : "";
  const sub = [hostname, device.ip].filter(Boolean).join(" · ");
  const classes = [
    device.state === "home" ? "" : "is-away",
    device.hidden ? "is-hidden" : "",
    device.name || device.person ? "" : "is-unknown",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    `<tr data-mac="${esc(device.mac)}"${classes ? ` class="${classes}"` : ""}>` +
    `<td data-label="Устройство">` +
    `<div class="dev-label">${esc(deviceLabel(device))}</div>` +
    `<div class="sub mac">${esc(device.mac)}</div>` +
    (sub ? `<div class="sub">${esc(sub)}</div>` : "") +
    `</td>` +
    `<td data-label="Имя / человек"><div class="cell-stack">` +
    `<input type="text" name="name" maxlength="64" placeholder="имя" ` +
    `value="${esc(device.name || "")}">` +
    `<input type="text" name="person" maxlength="64" placeholder="человек" ` +
    `value="${esc(device.person || "")}">` +
    `</div></td>` +
    `<td data-label="Тип / доверие"><div class="cell-stack">` +
    `<select name="kind">${options(KINDS, device.kind)}</select>` +
    `<select name="trust">${options(TRUSTS, device.trust || "unknown")}</select>` +
    `</div></td>` +
    `<td data-label="Сеть"><div class="cell-stack">` +
    `<div>${bandLabel(device.band)}</div>` +
    `<div class="sub">${esc(device.bss || "—")}</div>` +
    signalHtml(device.signal) +
    `</div></td>` +
    `<td data-label="Дома"><div class="cell-stack">` +
    `${stateBadge(device)}` +
    `<div class="sub">${esc(presenceText(device))}</div>` +
    `${sparkHtml(device.mac)}` +
    `</div></td>` +
    `<td data-label="Действия"><div class="actions">` +
    `<label class="check"><input type="checkbox" name="hidden"` +
    `${device.hidden ? " checked" : ""}> скрыто</label>` +
    `<button type="button" class="btn merge-btn" ` +
    `data-mac="${esc(device.mac)}">Объединить</button>` +
    `</div></td>` +
    `</tr>`
  );
}

function toolbar(filteredCount) {
  const home = devices.filter((d) => d.state === "home" && !d.hidden).length;
  const total = devices.length;
  const shown =
    filteredCount === total ? "" : ` · показано ${filteredCount}`;
  const counter =
    `${total} ${plural(total, "устройство", "устройства", "устройств")}` +
    ` · ${home} дома${shown}`;

  return (
    `<div class="toolbar">` +
    `<input type="search" class="search" placeholder="Поиск: MAC, имя, hostname, IP" ` +
    `value="${esc(query)}" aria-label="Поиск устройств">` +
    `<div class="chips">` +
    MODES.map(
      ([value, label]) =>
        `<button type="button" class="chip" data-mode="${value}" ` +
        `aria-pressed="${value === mode}">${esc(label)}</button>`
    ).join("") +
    `</div>` +
    `<span class="counter">${esc(counter)}</span>` +
    `<button type="button" class="btn csv-btn" title="Скачать таблицу в CSV">CSV</button>` +
    `</div>`
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
        `<span class="dup-item">${esc(deviceLabel(device))} ` +
        `<span class="sub mac">${esc(device.mac)}</span>` +
        (isTarget
          ? ` <span class="dup-target">оставить</span>`
          : ` <button type="button" class="btn dup-merge" ` +
            `data-src="${esc(device.mac)}" data-dst="${esc(target.mac)}">объединить</button>`) +
        `</span>`
      );
    });
    return (
      `<div class="dup-group"><div class="dup-title">${esc(group.hostname || group.ip)}</div>` +
      items.join("") + `</div>`
    );
  });

  return (
    `<details class="duplicates"><summary>Возможные дубли: ${groups.length}</summary>` +
    blocks.join("") + `</details>`
  );
}

function exportCsv() {
  const rows = sortDevices(filterDevices(devices, query, mode), sortKey, sortDir);
  const columns = [
    { label: "MAC", value: (d) => d.mac },
    { label: "Имя", value: (d) => d.name || "" },
    { label: "Человек", value: (d) => d.person || "" },
    { label: "Тип", value: (d) => d.kind || "" },
    { label: "Доверие", value: (d) => d.trust || "" },
    { label: "Скрыто", value: (d) => (d.hidden ? "да" : "нет") },
    { label: "Состояние", value: (d) => (d.state === "home" ? "дома" : "нет") },
    { label: "Диапазон", value: (d) => d.band || "" },
    { label: "BSSID", value: (d) => d.bss || "" },
    { label: "Сигнал, dBm", value: (d) => (d.signal == null ? "" : d.signal) },
    { label: "IP", value: (d) => d.ip || "" },
    { label: "Hostname", value: (d) => (d.hostname && d.hostname !== "*" ? d.hostname : "") },
    {
      label: "Последний раз",
      value: (d) => (d.last_seen ? new Date(d.last_seen * 1000).toLocaleString("ru-RU") : ""),
    },
  ];
  downloadText(csvFilename("homepanel-devices"), toCsv(columns, rows));
  setNote(
    `Экспортировано ${rows.length} ` +
      plural(rows.length, "устройство", "устройства", "устройств") + ".",
    false,
  );
}

function paint() {
  if (!rootEl) return;

  const filtered = sortDevices(filterDevices(devices, query, mode), sortKey, sortDir);
  const body = filtered.length
    ? filtered.map(row).join("")
    : `<tr><td colspan="${COLUMNS}" class="empty">Ничего не найдено.</td></tr>`;

  rootEl.innerHTML =
    `<h2>Устройства</h2>` +
    `<p class="muted">Имя, человек, тип и доверие сохраняются сразу. ` +
    `«Скрыто» убирает устройство с главной страницы.</p>` +
    toolbar(filtered.length) +
    duplicatesHtml() +
    `<p class="devices-status${note && note.error ? " error" : " muted"}">` +
    `${note ? esc(note.text) : ""}</p>` +
    `<div class="table-wrap"><table class="device-table">` +
    `<thead><tr>` +
    sortHeader("name", "Устройство") +
    `<th>Имя / человек</th>` +
    `<th>Тип / доверие</th>` +
    sortHeader("signal", "Сеть") +
    sortHeader("state", "Дома") +
    `<th>Действия</th>` +
    `</tr></thead><tbody>${body}</tbody>` +
    `</table></div>`;
}

function ensureDialog() {
  if (dialogEl) return dialogEl;

  dialogEl = document.createElement("dialog");
  dialogEl.className = "merge-dialog";
  dialogEl.innerHTML =
    `<form method="dialog">` +
    `<h3>Объединить устройство</h3>` +
    `<p class="hint muted"></p>` +
    `<label>Перенести данные в` +
    `<select class="merge-target"></select></label>` +
    `<div class="dialog-actions">` +
    `<button type="button" class="btn merge-cancel">Отмена</button>` +
    `<button type="button" class="btn primary merge-ok">Объединить</button>` +
    `</div></form>`;

  dialogEl.querySelector(".merge-cancel").addEventListener("click", () => {
    dialogEl.close();
  });
  dialogEl.querySelector(".merge-ok").addEventListener("click", () => {
    const mac = dialogEl.dataset.mac;
    const target = dialogEl.querySelector(".merge-target").value;
    dialogEl.close();
    if (mac && target) save({ mac, mergeInto: target });
  });

  document.body.appendChild(dialogEl);
  return dialogEl;
}

function openMerge(mac) {
  const others = devices.filter((device) => device.mac !== mac);
  if (!others.length) {
    note = { text: "Некуда объединять: других устройств нет.", error: true };
    paint();
    return;
  }

  const dialog = ensureDialog();
  dialog.querySelector(".merge-target").innerHTML = others
    .map(
      (device) =>
        `<option value="${esc(device.mac)}">${esc(deviceLabel(device))} — ` +
        `${esc(device.mac)}</option>`
    )
    .join("");
  dialog.querySelector(".hint").textContent =
    `Данные ${mac} перенесутся в выбранное устройство, запись ${mac} исчезнет.`;
  dialog.dataset.mac = mac;
  dialog.showModal();
}

function isEditing() {
  const active = document.activeElement;
  if (!rootEl || !active || !rootEl.contains(active)) return false;
  return /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName);
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
    devices = await getDevices();
  } catch (error) {
    note = { text: error.message, error: true };
  }
  await loadHours();
  if (!isEditing()) paint();
  else setNote(note ? note.text : "", note && note.error);
}

async function save(payload) {
  try {
    await postJSON("/api/devices", payload);
    note = null;
  } catch (error) {
    note = { text: error.message, error: true };
  }
  await refresh();
}

function onFieldChange(event) {
  const target = event.target;
  if (!target.name) return;

  const rowEl = target.closest("tr[data-mac]");
  if (!rowEl) return;

  const value = target.type === "checkbox" ? target.checked : target.value;
  save({ mac: rowEl.dataset.mac, [target.name]: value });
}

function onSearchInput(event) {
  const input = event.target;
  if (!input.classList.contains("search")) return;

  query = input.value;
  const pos = input.selectionStart;
  paint();

  const next = rootEl.querySelector(".search");
  if (next) {
    next.focus();
    next.setSelectionRange(pos, pos);
  }
}

function onSortClick(header) {
  const key = header.dataset.sort;
  if (!key) return;
  if (sortKey === key) sortDir = sortDir === "asc" ? "desc" : "asc";
  else {
    sortKey = key;
    sortDir = key === "signal" ? "desc" : "asc";
  }
  paint();
}

function onClick(event) {
  const csv = event.target.closest(".csv-btn");
  if (csv) {
    exportCsv();
    return;
  }

  const dup = event.target.closest(".dup-merge");
  if (dup) {
    const source = dup.dataset.src;
    const target = dup.dataset.dst;
    if (
      source && target &&
      window.confirm(
        `Объединить ${source} в ${target}? Данные первой записи перенесутся, запись исчезнет.`,
      )
    ) {
      save({ mac: source, mergeInto: target });
    }
    return;
  }

  const chip = event.target.closest(".chip");
  if (chip) {
    mode = chip.dataset.mode;
    paint();
    return;
  }

  const header = event.target.closest("th[data-sort]");
  if (header) {
    onSortClick(header);
    return;
  }

  const merge = event.target.closest(".merge-btn");
  if (merge) openMerge(merge.dataset.mac);
}

/**
 * @param {HTMLElement} root
 * @param {{devices?: object[]}} state
 */
export function render(root, state) {
  rootEl = root;
  devices = (state && state.devices) || [];
  nowTs = Number(state && state.now) || Math.floor(Date.now() / 1000);

  root.onchange = onFieldChange;
  root.oninput = onSearchInput;
  root.onclick = onClick;

  if (!isEditing()) paint();
  maybeLoadHours();
}
