const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
};

const jsonResponse = (statusCode, body) => ({
  statusCode,
  headers: {
    ...CORS_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  },
  body: JSON.stringify(body),
});

const getBaseUrl = (event) => {
  const envUrl = (process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.NETLIFY_URL || '').trim();
  if (envUrl) return envUrl.replace(/\/$/, '');

  const proto = (event.headers?.['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = (event.headers?.host || '').trim();
  if (!host) return '';
  return `${proto}://${host}`;
};

const parseBool = (raw, fallback) => {
  if (raw == null) return fallback;
  const s = String(raw).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no') return false;
  return fallback;
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: CORS_HEADERS,
      body: '',
    };
  }

  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers: { ...CORS_HEADERS, Allow: 'GET,OPTIONS' },
      body: '',
    };
  }

  const baseUrl = getBaseUrl(event);
  const latestVersion = String(process.env.APP_LATEST_VERSION || '1.0.0').trim();
  const mandatory = parseBool(process.env.APP_UPDATE_MANDATORY, false);
  const message = typeof process.env.APP_UPDATE_MESSAGE === 'string' ? process.env.APP_UPDATE_MESSAGE : 'A new version is available. Please update to continue.';

  const explicitUrl = String(process.env.APP_UPDATE_URL || '').trim();
  const rawApkPath = String(process.env.APP_UPDATE_APK_PATH || '/updates/MovieFlix-latest.apk');
  const apkPath = rawApkPath.startsWith('/') ? rawApkPath : `/${rawApkPath}`;

  const url = explicitUrl || (baseUrl ? `${baseUrl}${apkPath}` : apkPath);

  return jsonResponse(200, {
    latestVersion,
    mandatory,
    url,
    message,
  });
};
