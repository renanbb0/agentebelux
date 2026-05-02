function getPublicBaseUrl(req) {
  const configured = process.env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, '');
  if (configured) return configured;

  const forwardedProto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http')
    .split(',')[0]
    .trim();
  const forwardedHost = String(
    req.headers['x-forwarded-host'] ||
    req.get?.('host') ||
    req.headers.host ||
    `localhost:${process.env.PORT || 3000}`
  )
    .split(',')[0]
    .trim();

  return `${forwardedProto}://${forwardedHost}`;
}

function buildPublicAssetUrl(req, assetPath) {
  const safe = String(assetPath || '');
  const normalizedPath = safe.startsWith('/') ? safe : `/${safe}`;
  return `${getPublicBaseUrl(req)}${normalizedPath}`;
}

module.exports = { getPublicBaseUrl, buildPublicAssetUrl };
