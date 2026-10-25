// Чистые помощники панели: без DOM и без fetch — тестируются в Node.
// (см. docs/superpowers/specs/2026-10-18-homepanel-design.md, §12)

/**
 * Человекочитаемая длительность. Незначащие части опускаются:
 * 0 -> "0 мин", 5400 -> "1 ч 30 мин", 93600 -> "1 д 2 ч".
 * @param {number} seconds
 * @returns {string}
 */
export function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);

  const parts = [];
  if (days > 0) parts.push(`${days} д`);
  if (hours > 0) parts.push(`${hours} ч`);
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes} мин`);
  return parts.join(" ");
}

/**
 * Группировка устройств по человеку. `home` истинно, только если у человека
 * есть не скрытое устройство в состоянии "home"; `since` — минимальный `since`
 * среди таких устройств. Люди без устройств не появляются; скрытые устройства
 * не дают `home`, но их человек в списке остаётся. Порядок: «дома» вперёд,
 * внутри группы — по первому появлению.
 * @param {object[]} devices
 * @returns {object[]}
 */
export function groupPeople(devices) {
  const order = [];
  const byPerson = new Map();

  for (const device of devices || []) {
    const person = device.person;
    if (!person) continue;

    let entry = byPerson.get(person);
    if (!entry) {
      entry = { person, home: false, since: null, devices: [] };
      byPerson.set(person, entry);
      order.push(entry);
    }
    entry.devices.push(device);

    if (device.state === "home" && !device.hidden) {
      entry.home = true;
      const since = Number(device.since);
      if (Number.isFinite(since) && (entry.since === null || since < entry.since)) {
        entry.since = since;
      }
    }
  }

  // sort — стабильная сортировка: равные сохраняют порядок добавления.
  return order.slice().sort((a, b) => (a.home === b.home ? 0 : a.home ? -1 : 1));
}

/**
 * События, появившиеся после последнего известного id.
 * @param {object[]} events
 * @param {number} lastId
 * @returns {object[]}
 */
export function diffEvents(events, lastId) {
  const threshold = Number(lastId) || 0;
  return (events || []).filter((event) => Number(event.id) > threshold);
}

/**
 * Преобразование агрегатов /api/stats в столбцы графика.
 * @param {object[]} rows
 * @returns {{label: string, value: number}[]}
 */
export function barsFromStats(rows) {
  return (rows || []).map((row) => ({
    label: String(row.bucket),
    value: Number(row.minutes) || 0,
  }));
}

/**
 * «Неопознанное» устройство: без имени, без человека и не скрытое.
 * (Скрытое или уже размеченное неопознанным не считается — ревью I3.)
 * @param {object} device
 * @returns {boolean}
 */
export function isUnidentified(device) {
  if (!device) return false;
  return !device.name && !device.person && !device.hidden;
}

/**
 * «Сколько назад» с секундной точностью для свежих данных.
 * @param {number} seconds
 * @returns {string}
 */
export function formatAgo(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  if (total < 5) return "только что";
  if (total < 60) return `${total} с назад`;
  return `${formatDuration(total)} назад`;
}

/**
 * Подпись устройства: имя, человек, реальный hostname (не "*"), иначе MAC.
 * @param {object} device
 * @returns {string}
 */
export function deviceLabel(device) {
  if (!device) return "";
  const hostname = device.hostname && device.hostname !== "*" ? device.hostname : "";
  return device.name || device.person || hostname || device.mac || "";
}

/**
 * Поиск и быстрые фильтры страницы «Устройства».
 * @param {object[]} devices
 * @param {string} query — ищет по MAC, имени, человеку, hostname и IP
 * @param {"all"|"home"|"unknown"|"hidden"} mode
 * @returns {object[]}
 */
export function filterDevices(devices, query, mode = "all") {
  const q = String(query || "").trim().toLowerCase();
  return (devices || []).filter((device) => {
    if (mode === "home" && device.state !== "home") return false;
    if (mode === "hidden" && !device.hidden) return false;
    if (mode === "unknown" && (device.name || device.person)) return false;
    if (!q) return true;
    return [device.mac, device.name, device.person, device.hostname, device.ip]
      .some((value) => value && String(value).toLowerCase().includes(q));
  });
}

function sortValue(device, key) {
  if (key === "signal") {
    if (device.signal == null) return null;
    const dbm = Number(device.signal);
    return Number.isFinite(dbm) ? dbm : null;
  }
  if (key === "state") return device.state === "home" ? 0 : 1;
  if (key === "mac") return device.mac || "";
  return deviceLabel(device);
}

/**
 * Сортировка списка устройств. Пустой сигнал всегда в конце.
 * @param {object[]} devices
 * @param {"name"|"signal"|"state"|"mac"} key
 * @param {"asc"|"desc"} dir
 * @returns {object[]} новый массив
 */
export function sortDevices(devices, key = "name", dir = "asc") {
  const sign = dir === "desc" ? -1 : 1;
  return (devices || []).slice().sort((a, b) => {
    const av = sortValue(a, key);
    const bv = sortValue(b, key);
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * sign;
    return String(av).localeCompare(String(bv), "ru") * sign;
  });
}

/**
 * Уровень сигнала для подкраски: weak при <= -75, fair при <= -65.
 * @param {number|null} signal
 * @returns {"none"|"weak"|"fair"|"good"}
 */
export function signalLevel(signal) {
  if (signal == null || !Number.isFinite(Number(signal))) return "none";
  const dbm = Number(signal);
  if (dbm <= -75) return "weak";
  if (dbm <= -65) return "fair";
  return "good";
}

/** Русская форма множественного числа: 1 устройство, 2 устройства, 5 устройств. */
export function plural(n, one, few, many) {
  const value = Math.abs(Number(n) || 0) % 100;
  const last = value % 10;
  if (value > 10 && value < 20) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

/** Следующая тема в цикле: авто → тёмная → светлая → авто. */
export function nextTheme(current) {
  if (current === "auto") return "dark";
  if (current === "dark") return "light";
  return "auto";
}

/**
 * Подпись «последний раз» для строки устройства.
 * @param {object} device
 * @param {number} now — секунды
 * @returns {string}
 */
export function lastSeenText(device, now) {
  if (!device) return "";
  if (device.state === "home") return "дома";
  const last = Number(device.last_seen);
  if (!Number.isFinite(last) || last <= 0) return "не видели";
  return "ушёл " + formatAgo(Math.max(0, Number(now) - last));
}

/** Экранирование одного поля CSV. */
export function csvEscape(value) {
  const text = value == null ? "" : String(value);
  if (/[;"\n\r]/.test(text)) return '"' + text.replace(/"/g, '""') + '"';
  return text;
}

/**
 * CSV с разделителем «;» (Excel в русской локали) и CRLF.
 * @param {{label: string, value: (row: object) => unknown}[]} columns
 * @param {object[]} rows
 * @returns {string}
 */
export function toCsv(columns, rows) {
  const line = (values) => values.map(csvEscape).join(";");
  const head = line((columns || []).map((column) => column.label));
  const body = (rows || []).map((row) =>
    line((columns || []).map((column) => column.value(row))),
  );
  return [head, ...body].join("\r\n") + "\r\n";
}

/** Имя CSV-файла с датой: homepanel-devices-2026-10-24.csv. */
export function csvFilename(prefix, date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${prefix}-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.csv`;
}

/** Скачивание текста как файла (BOM — чтобы Excel понял UTF-8). */
export function downloadText(filename, text, mime = "text/csv;charset=utf-8") {
  const blob = new Blob(["\uFEFF" + text], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** Группы устройств с одинаковым hostname или IP — кандидаты на объединение. */
export function duplicateGroups(devices) {
  const groups = new Map();
  for (const device of devices || []) {
    if (!device || !device.mac) continue;
    const hostname =
      device.hostname && device.hostname !== "*"
        ? String(device.hostname).toLowerCase()
        : "";
    const key = hostname ? "host:" + hostname : device.ip ? "ip:" + device.ip : "";
    if (!key) continue;
    let group = groups.get(key);
    if (!group) {
      group = { key, hostname, ip: device.ip || "", devices: [] };
      groups.set(key, group);
    }
    group.devices.push(device);
  }
  return Array.from(groups.values())
    .filter((group) => group.devices.length > 1)
    .sort((a, b) => b.devices.length - a.devices.length);
}

/** Предупреждения по состоянию: нет данных, агент офлайн, неопознанные дома. */
export function alertsFromState(state) {
  const alerts = [];
  if (!state) return alerts;
  const agent = state.agent || {};
  const now = Number(state.now) || 0;
  const lastSnapshot = Number(agent.last_snapshot_ts) || 0;

  if (!lastSnapshot) {
    alerts.push({ key: "no-data", level: "warn", text: "Данных от роутера ещё не было" });
  } else if (!agent.online) {
    const age = Math.max(0, now - lastSnapshot);
    alerts.push({
      key: "agent-offline",
      level: age >= 900 ? "danger" : "warn",
      text: "Роутер не выходит на связь " + formatDuration(age),
    });
  }

  const unknown = (state.devices || []).filter(
    (device) => isUnidentified(device) && device.state === "home",
  ).length;
  if (unknown > 0) {
    alerts.push({
      key: "unknown",
      level: "warn",
      text:
        "Дома " + unknown + " " +
        plural(
          unknown,
          "неопознанное устройство",
          "неопознанных устройства",
          "неопознанных устройств",
        ),
    });
  }
  return alerts;
}

function localIso(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Сетка «дни × часы» для тепловой карты.
 * @param {{hour_ts: number, devices: number}[]} points
 * @param {number} now — секунды
 * @param {number} days
 * @returns {{max: number, rows: object[]}}
 */
export function heatmapGrid(points, now, days = 7) {
  const byTs = new Map();
  for (const point of points || []) {
    const ts = Number(point.hour_ts);
    if (Number.isFinite(ts)) byTs.set(ts, Number(point.devices) || 0);
  }

  const base = new Date((Number(now) || 0) * 1000);
  const rows = [];
  let max = 0;

  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() - offset);
    const cells = [];
    for (let hour = 0; hour < 24; hour += 1) {
      const ts = Math.round(
        new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour).getTime() / 1000,
      );
      const value = byTs.get(ts) || 0;
      if (value > max) max = value;
      cells.push({ hour, ts, value });
    }
    rows.push({
      date: localIso(day),
      label:
        String(day.getDate()).padStart(2, "0") +
        "." +
        String(day.getMonth() + 1).padStart(2, "0"),
      cells,
    });
  }
  return { max, rows };
}

/** Доли интервалов в процентах для полосы дня. */
export function timelineSegments(intervals, from, to) {
  const start = Number(from) || 0;
  const span = Math.max(1, (Number(to) || 0) - start);
  return (intervals || []).map((interval) => {
    const left = ((Number(interval.from) - start) / span) * 100;
    const width = ((Number(interval.to) - Number(interval.from)) / span) * 100;
    return {
      ...interval,
      left: Math.max(0, Math.min(100, left)),
      width: Math.max(0.3, width),
    };
  });
}

/** Фильтр событий истории по строке, типу и периоду. */
export function filterEvents(events, { query = "", type = "all", from = 0, to = Infinity } = {}) {
  const q = String(query || "").trim().toLowerCase();
  return (events || []).filter((event) => {
    if (type !== "all" && event.type !== type) return false;
    const ts = Number(event.ts);
    if (ts < from || ts >= to) return false;
    if (!q) return true;
    return [event.mac, event.ip, event.bss, event.person, event.label].some(
      (value) => value && String(value).toLowerCase().includes(q),
    );
  });
}

/** Доли для пончика: share и накопленное смещение offset. */
export function donutSegments(items) {
  const values = (items || []).map((item) => Math.max(0, Number(item.value) || 0));
  const total = values.reduce((sum, value) => sum + value, 0);
  let offset = 0;
  return (items || []).map((item, index) => {
    const value = values[index];
    const share = total > 0 ? value / total : 0;
    const segment = { ...item, value, share, offset };
    offset += share;
    return segment;
  });
}

/** Уровень закраски календаря: 0 — нет данных, 4 — максимум. */
export function calendarLevel(minutes, max) {
  const value = Math.max(0, Number(minutes) || 0);
  if (!value) return 0;
  const top = Math.max(1, Number(max) || 0);
  return Math.min(4, Math.max(1, Math.ceil((value / top) * 4)));
}

/** Поиск по устройствам и событиям для глобального окна (Ctrl+K). */
export function searchMatches(devices, events, query) {
  const text = String(query || "").trim();
  if (!text) return { devices: [], events: [] };
  const lower = text.toLowerCase();
  const found = (devices || []).filter((device) =>
    [device.mac, device.name, device.person, device.ip, device.hostname].some(
      (value) => value && String(value).toLowerCase().includes(lower),
    ),
  );
  return {
    devices: found.slice(0, 8),
    events: filterEvents(events, { query: text }).slice(-8).reverse(),
  };
}

/** Случайный (локально администрируемый) MAC: второй бит первого октета. */
export function isRandomMac(mac) {
  const first = String(mac || "").split(":")[0];
  if (!/^[0-9a-f]{2}$/i.test(first)) return false;
  return (parseInt(first, 16) & 2) !== 0;
}
