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
