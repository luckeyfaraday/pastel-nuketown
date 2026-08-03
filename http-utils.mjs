export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export function headerValue(headers, name) {
  if (headers && typeof headers.get === 'function') return headers.get(name);
  if (!headers || typeof headers !== 'object') return null;
  const value = headers[String(name).toLowerCase()];
  return Array.isArray(value) ? value.join(',') : (value ?? null);
}

export function sendJson(response, status, value, headers = {}) {
  const body = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  response.writeHead(status, {
    ...headers,
    'cache-control': 'no-store',
    'content-length': body.byteLength,
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff'
  });
  response.end(body);
}

export async function readRequestBody(request, maxBytes = 1024 * 1024) {
  const declared = Number.parseInt(headerValue(request.headers, 'content-length') || '', 10);
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new HttpError(413, 'request_too_large', 'Request body is too large.');

  const chunks = [];
  let length = 0;
  let idleTimedOut = false;
  /* IncomingMessage delegates this to the socket, whose timeout resets on
     activity. A client may upload slowly, but it may not reserve a connection
     forever by stopping midway through a webhook or checkout body. Test and
     in-process streams do not necessarily expose setTimeout, so they retain the
     stream's own lifetime. */
  if (typeof request.setTimeout === 'function') {
    request.setTimeout(15_000, () => {
      idleTimedOut = true;
      request.destroy(new Error('request body idle timeout'));
    });
  }
  try {
    for await (const chunk of request) {
      length += chunk.length;
      if (length > maxBytes)
        throw new HttpError(413, 'request_too_large', 'Request body is too large.');
      chunks.push(chunk);
    }
  } catch (error) {
    if (idleTimedOut)
      throw new HttpError(408, 'request_timeout', 'Request body timed out.');
    throw error;
  } finally {
    if (typeof request.setTimeout === 'function') request.setTimeout(0);
  }
  return Buffer.concat(chunks, length);
}

export async function readJsonBody(request, maxBytes = 64 * 1024) {
  const raw = await readRequestBody(request, maxBytes);
  if (raw.length === 0)
    throw new HttpError(400, 'invalid_json', 'A JSON request body is required.');
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('expected an object');
    return parsed;
  } catch (error) {
    throw new HttpError(400, 'invalid_json', 'Request body must be a JSON object.');
  }
}
