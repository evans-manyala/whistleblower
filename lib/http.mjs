const rateLimits = new Map();
setInterval(() => {
  for (const [key, entry] of rateLimits) if (entry.until < Date.now()) rateLimits.delete(key);
}, 60_000).unref();

export class HttpError extends Error {
  constructor(status, message, field) {
    super(message);
    this.status = status;
    this.field = field;
  }
}

export function limit(request, scope, count, milliseconds) {
  const tenant = request.url.match(/^\/o\/([a-z0-9-]+)\//)?.[1] || "";
  const key = `${tenant}:${scope}:${request.clientAddress}`;
  const time = Date.now();
  let entry = rateLimits.get(key);
  if (!entry || entry.until <= time) {
    entry = { until: time + milliseconds, count: 0 };
    rateLimits.set(key, entry);
  }
  if (entry.count >= count) throw new HttpError(429, "Too many attempts. Wait a few minutes and try again.");
  entry.count += 1;
}

export function checkedText(body, key, minimum, maximum, label) {
  const raw = body[key];
  const value = typeof raw === "string" ? raw.trim() : "";
  if ((raw != null && typeof raw !== "string") || value.length < minimum || value.length > maximum) {
    const message = minimum > 0
      ? `Enter ${label} using ${minimum}–${maximum} characters.`
      : `Use at most ${maximum} characters for ${label}.`;
    throw new HttpError(400, message, key);
  }
  return value;
}

export async function readBody(request) {
  if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json") {
    throw new HttpError(415, "Send the request as JSON.");
  }
  const maximum = 128 * 1024;
  if (Number(request.headers["content-length"]) > maximum) {
    request.resume();
    throw new HttpError(413, "This request is too large.");
  }
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length <= maximum) chunks.push(chunk);
  }
  if (length > maximum) throw new HttpError(413, "This request is too large.");
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || Array.isArray(body) || typeof body !== "object") throw new Error();
    return body;
  } catch {
    throw new HttpError(400, "The request could not be read. Try again.");
  }
}

export function sendJson(response, status, data, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  response.end(JSON.stringify(data));
}

export function readCookie(request, name) {
  return request.headers.cookie?.match(new RegExp(`(?:^|;\\s*)${name}=([a-f0-9]{64})(?:;|$)`))?.[1] || "";
}

export function requireSameOrigin(request, url) {
  if (request.method === "POST" && (request.headers.origin !== url.origin || request.headers["sec-fetch-site"] === "cross-site")) {
    throw new HttpError(403, "Open the portal directly and try again.");
  }
}
