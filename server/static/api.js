/** Тонкие обёртки над JSON-API сервера. */

async function request(path, options) {
  const response = await fetch(path, options);
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (err) {
      data = null;
    }
  }
  if (!response.ok) {
    const message =
      (data && data.error && data.error.message) || response.statusText || "Ошибка запроса";
    throw new Error(message);
  }
  return data;
}

export function getJSON(path) {
  return request(path, { method: "GET" });
}

export function postJSON(path, body) {
  return request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function getState() {
  return getJSON("/api/state");
}

export function getDevices() {
  return getJSON("/api/devices");
}

/**
 * Строка запроса для /api/events. `since` опускается, если не задан, — иначе
 * сервер при since=0 отдаёт САМЫЕ СТАРЫЕ события (ревью I1).
 * @param {number|null|undefined} sinceId
 * @param {number|null|undefined} limit
 * @returns {string}
 */
export function eventsQuery(sinceId, limit) {
  const params = new URLSearchParams();
  if (sinceId != null) params.set("since", String(sinceId));
  if (limit != null) params.set("limit", String(limit));
  return params.toString();
}

export function getEvents(sinceId, limit) {
  const query = eventsQuery(sinceId, limit);
  return getJSON("/api/events" + (query ? "?" + query : ""));
}

export function getStats({ group = "day", from, to, mac, person } = {}) {
  const params = new URLSearchParams({ group });
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  if (mac) params.set("mac", mac);
  if (person) params.set("person", person);
  return getJSON("/api/stats?" + params.toString());
}

export function getAnalytics({ days = 7, person } = {}) {
  const params = new URLSearchParams({ days: String(days) });
  if (person) params.set("person", person);
  return getJSON("/api/analytics?" + params.toString());
}

export function getTimeline({ day, person, mac } = {}) {
  const params = new URLSearchParams();
  if (day) params.set("day", day);
  if (person) params.set("person", person);
  if (mac) params.set("mac", mac);
  const query = params.toString();
  return getJSON("/api/timeline" + (query ? "?" + query : ""));
}

export function getSignal({ mac, hours = 24 } = {}) {
  const params = new URLSearchParams({ mac: String(mac || ""), hours: String(hours) });
  return getJSON("/api/signal?" + params.toString());
}

export function getDeviceHours({ hours = 24 } = {}) {
  const params = new URLSearchParams({ hours: String(hours) });
  return getJSON("/api/device_hours?" + params.toString());
}

export function deleteJSON(path) {
  return request(path, { method: "DELETE" });
}

export function forgetDevice(mac) {
  return deleteJSON("/api/devices?mac=" + encodeURIComponent(mac));
}

export function bulkDevices(body) {
  return postJSON("/api/devices/bulk", body);
}

export function getRules() {
  return getJSON("/api/rules");
}

export function addRule(body) {
  return postJSON("/api/rules", body);
}

export function deleteRule(id) {
  return deleteJSON("/api/rules?id=" + encodeURIComponent(id));
}

export function getBackup() {
  return getJSON("/api/backup");
}

export function saveBackup(body) {
  return postJSON("/api/backup", body);
}

export function getCalendar({ month, person } = {}) {
  const params = new URLSearchParams();
  if (month) params.set("month", month);
  if (person) params.set("person", person);
  const query = params.toString();
  return getJSON("/api/calendar" + (query ? "?" + query : ""));
}

export function getCompare({ days = 7 } = {}) {
  return getJSON("/api/compare?days=" + String(days));
}

export function getAnomalies() {
  return getJSON("/api/anomalies");
}

export function getTimeMachine({ date, hour } = {}) {
  const params = new URLSearchParams();
  if (date) params.set("date", date);
  if (hour != null) params.set("hour", String(hour));
  const query = params.toString();
  return getJSON("/api/timemachine" + (query ? "?" + query : ""));
}
