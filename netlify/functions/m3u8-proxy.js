const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Range, Accept, Accept-Encoding, Accept-Language, User-Agent, Origin, Referer',
  'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
  'Access-Control-Expose-Headers': 'Content-Type, Content-Length, Accept-Ranges, Content-Range',
};

const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const jsonResponse = (statusCode, payload) => ({
  statusCode,
  headers: {
    ...CORS_HEADERS,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(payload),
});

const decodeBase64 = (value) => {
  try {
    return Buffer.from(value, 'base64').toString('utf-8');
  } catch (error) {
    throw new Error('Invalid base64 input');
  }
};

const decodeHeaders = (encoded) => {
  if (!encoded) return {};
  try {
    const parsed = JSON.parse(decodeBase64(encoded));
    if (parsed && typeof parsed === 'object') {
      return Object.entries(parsed).reduce((acc, [key, value]) => {
        if (typeof value === 'string') {
          acc[key.toLowerCase()] = value;
        }
        return acc;
      }, {});
    }
  } catch (error) {
    throw new Error('Invalid header payload');
  }
  return {};
};

const pickHeader = (incomingHeaders = {}, name) => {
  if (!incomingHeaders) return undefined;
  const lower = name.toLowerCase();
  return incomingHeaders[name] ?? incomingHeaders[lower] ?? incomingHeaders[lower.toUpperCase()];
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
        Allow: 'GET,HEAD,OPTIONS',
      },
      body: '',
    };
  }

  const encodedUrl = event.queryStringParameters?.url;
  if (!encodedUrl) {
    return jsonResponse(400, { error: 'Missing url parameter' });
  }

  let targetUrl;
  try {
    const decodedUrl = decodeBase64(encodedUrl);
    const parsed = new URL(decodedUrl);
    if (!/^https?:/.test(parsed.protocol)) {
      return jsonResponse(400, { error: 'Only http/https protocols are supported' });
    }
    targetUrl = parsed.toString();
  } catch (error) {
    return jsonResponse(400, { error: 'Invalid url parameter' });
  }

  let forwardedHeaders;
  try {
    forwardedHeaders = decodeHeaders(event.queryStringParameters?.h);
  } catch (error) {
    return jsonResponse(400, { error: 'Invalid h parameter' });
  }

  const incomingHeaders = event.headers || {};
  const headerWhitelist = ['range', 'accept', 'accept-encoding', 'accept-language', 'referer', 'origin', 'user-agent'];
  headerWhitelist.forEach((headerName) => {
    if (forwardedHeaders[headerName]) return;
    const value = pickHeader(incomingHeaders, headerName);
    if (value) {
      forwardedHeaders[headerName] = value;
    }
  });

  if (!forwardedHeaders['user-agent']) {
    forwardedHeaders['user-agent'] = DEFAULT_USER_AGENT;
  }

  let requestBody;
  if (method !== 'GET' && method !== 'HEAD' && event.body) {
    requestBody = event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body;
  }

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(targetUrl, {
      method,
      headers: forwardedHeaders,
      body: method === 'GET' || method === 'HEAD' ? undefined : requestBody,
      redirect: 'follow',
    });
  } catch (error) {
    return jsonResponse(502, { error: `Upstream request failed: ${(error && error.message) || 'unknown'}` });
  }

  const responseHeaders = { ...CORS_HEADERS };
  const passthroughHeaders = [
    'content-type',
    'content-length',
    'accept-ranges',
    'content-range',
    'cache-control',
    'etag',
    'last-modified',
    'expires',
  ];
  passthroughHeaders.forEach((headerName) => {
    const value = upstreamResponse.headers.get(headerName);
    if (value) {
      const formattedName = headerName
        .split('-')
        .map((chunk) => chunk.charAt(0).toUpperCase() + chunk.slice(1))
        .join('-');
      responseHeaders[formattedName] = value;
    }
  });
  responseHeaders['X-Final-Url'] = upstreamResponse.url || targetUrl;

  if (!responseHeaders['Content-Type']) {
    responseHeaders['Content-Type'] = 'application/octet-stream';
  }

  if (method === 'HEAD') {
    return {
      statusCode: upstreamResponse.status,
      headers: responseHeaders,
      body: '',
    };
  }

  const buffer = Buffer.from(await upstreamResponse.arrayBuffer());
  responseHeaders['Content-Length'] = responseHeaders['Content-Length'] || String(buffer.length);

  return {
    statusCode: upstreamResponse.status,
    headers: responseHeaders,
    body: buffer.toString('base64'),
    isBase64Encoded: true,
  };
};
