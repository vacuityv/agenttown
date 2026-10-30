// Thin client for the /v1 API and the SSE stream.

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

export async function api(path, { token, method, body, signal } = {}) {
  const headers = {};
  if (body) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch("/v1" + path, { method: method ?? (body ? "POST" : "GET"), headers, body: body ? JSON.stringify(body) : undefined, signal });
  let json = null;
  try { json = await res.json(); } catch {}
  if (!res.ok) throw new ApiError(res.status, json?.error ?? "http_" + res.status, json?.message);
  return json;
}

// Fetch every home of the world, paging through /world (server caps limit at 2000).
export async function fetchWorld(signal) {
  const PAGE = 2000;
  let offset = 0;
  let totals = null;
  const homes = [];
  for (;;) {
    const r = await api(`/world?limit=${PAGE}&offset=${offset}`, { signal });
    totals = r.totals;
    homes.push(...r.homes);
    if (r.homes.length < PAGE) break;
    offset += PAGE;
  }
  return { totals, homes };
}

// EventSource wrapper with handlers per event type. EventSource reconnects by itself;
// onReconnect lets the view resync state it may have missed.
export function openStream(query, handlers, { onReconnect, onState } = {}) {
  const url = "/v1/stream" + (query ? "?" + query : "");
  const es = new EventSource(url);
  let opened = false;
  es.addEventListener("hello", () => {
    onState?.("live");
    if (opened) onReconnect?.();
    opened = true;
  });
  es.onerror = () => onState?.(es.readyState === EventSource.CLOSED ? "closed" : "reconnecting");
  for (const [type, fn] of Object.entries(handlers)) {
    es.addEventListener(type, (ev) => {
      let data;
      try { data = JSON.parse(ev.data); } catch { return; }
      fn(data);
    });
  }
  return () => es.close();
}
