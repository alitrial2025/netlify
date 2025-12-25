const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Cookie, X-Referer, X-Origin, X-User-Agent, X-X-Real-Ip',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS',
};

const HEADER_MAP = {
  'x-cookie': 'cookie',
  'x-referer': 'referer',
  'x-origin': 'origin',
  'x-user-agent': 'user-agent',
  'x-x-real-ip': 'x-real-ip',
};

const HOP_HEADERS = new Set(['host', 'connection', 'content-length']);
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

const jsonResponse = (statusCode, body) => ({
  statusCode,
  headers: {
    ...CORS_HEADERS,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(body),
});

const mapHeaders = (headers = {}) => {
  const result = {};
  Object.entries(headers).forEach(([key, value]) => {
    if (!value) return;
    const lower = key.toLowerCase();
    if (HOP_HEADERS.has(lower)) return;
    const mapped = HEADER_MAP[lower];
    if (mapped) {
      result[mapped] = value;
      return;
    }
    result[lower] = value;
  });
  if (!result['user-agent']) {
    result['user-agent'] = DEFAULT_USER_AGENT;
  }
  return result;
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: CORS_HEADERS,
      body: '',
    };
  }

  const method = (event.httpMethod || 'GET').toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    return {
      statusCode: 405,
      headers: {
        ...CORS_HEADERS,
        Allow: Array.from(ALLOWED_METHODS).join(','),
      },
      body: '',
    };
  }

  const destination = event.queryStringParameters?.destination;
  if (!destination) {
    return jsonResponse(400, { error: 'Missing destination parameter' });
  }

  let targetUrl;
  try {
    targetUrl = new URL(destination).toString();
  } catch (error) {
    return jsonResponse(400, { error: 'Invalid destination parameter' });
  }

  let requestBody;
  if (method !== 'GET' && method !== 'HEAD' && event.body) {
    requestBody = event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body;
  }

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(targetUrl, {
      method,
      headers: mapHeaders(event.headers || {}),
      body: requestBody,
      redirect: 'follow',
    });
  } catch (error) {
    return jsonResponse(502, { error: `Upstream request failed: ${(error && error.message) || 'unknown'}` });
  }

  if (method === 'HEAD') {
    const headHeaders = {
      ...CORS_HEADERS,
      'X-Final-Destination': upstreamResponse.url || targetUrl,
    };
    const passthroughHead = ['content-type', 'content-length', 'cache-control', 'etag', 'last-modified', 'accept-ranges', 'content-range', 'expires'];
    passthroughHead.forEach((header) => {
      const value = upstreamResponse.headers.get(header);
      if (value) headHeaders[header] = value;
    });
    const setCookie = upstreamResponse.headers.get('set-cookie');
    if (setCookie) headHeaders['x-set-cookie'] = setCookie;
    return {
      statusCode: upstreamResponse.status,
      headers: headHeaders,
      body: '',
    };
  }

  const arrayBuffer = await upstreamResponse.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const responseHeaders = {
    ...CORS_HEADERS,
    'X-Final-Destination': upstreamResponse.url || targetUrl,
  };
  const passthrough = ['content-type', 'cache-control', 'etag', 'last-modified', 'accept-ranges', 'content-range', 'expires'];
  passthrough.forEach((header) => {
    const value = upstreamResponse.headers.get(header);
    if (value) responseHeaders[header] = value;
  });
  responseHeaders['content-length'] = String(buffer.length);

  const setCookie = upstreamResponse.headers.get('set-cookie');
  if (setCookie) {
    responseHeaders['x-set-cookie'] = setCookie;
  }

  return {
    statusCode: upstreamResponse.status,
    headers: responseHeaders,
    body: buffer.toString('base64'),
    isBase64Encoded: true,
  };
};
