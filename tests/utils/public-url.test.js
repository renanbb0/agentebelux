const assert = require('assert');
const { getPublicBaseUrl, buildPublicAssetUrl } = require('../../src/utils/public-url');

// ── getPublicBaseUrl ─────────────────────────────────────────────────────────

// PUBLIC_BASE_URL configurada tem prioridade absoluta
{
  const prev = process.env.PUBLIC_BASE_URL;
  process.env.PUBLIC_BASE_URL = 'https://meudominio.com/';
  assert.strictEqual(getPublicBaseUrl({}), 'https://meudominio.com');  // trailing slash removido
  process.env.PUBLIC_BASE_URL = prev !== undefined ? prev : '';
  if (prev === undefined) delete process.env.PUBLIC_BASE_URL;
}

// x-forwarded headers (proxy reverso / ngrok)
{
  const req = { headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'abc.ngrok.io' } };
  assert.strictEqual(getPublicBaseUrl(req), 'https://abc.ngrok.io');
}

// múltiplos valores no header (pega apenas o primeiro)
{
  const req = { headers: { 'x-forwarded-proto': 'https, http', 'x-forwarded-host': 'a.io, b.io' } };
  assert.strictEqual(getPublicBaseUrl(req), 'https://a.io');
}

// fallback para req.get('host') estilo Express
{
  const req = { headers: {}, protocol: 'http', get: (h) => (h === 'host' ? 'localhost:3000' : null) };
  assert.strictEqual(getPublicBaseUrl(req), 'http://localhost:3000');
}

// fallback para req.headers.host quando req.get não existe
{
  const req = { headers: { host: 'localhost:3001' }, protocol: 'https' };
  assert.strictEqual(getPublicBaseUrl(req), 'https://localhost:3001');
}

// ── buildPublicAssetUrl ──────────────────────────────────────────────────────

{
  const req = { headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'abc.ngrok.io' } };
  assert.strictEqual(buildPublicAssetUrl(req, '/assets/guia.jpg'), 'https://abc.ngrok.io/assets/guia.jpg');
  // path sem barra inicial — deve ser adicionada
  assert.strictEqual(buildPublicAssetUrl(req, 'assets/guia.jpg'), 'https://abc.ngrok.io/assets/guia.jpg');
  // path vazio
  assert.strictEqual(buildPublicAssetUrl(req, ''), 'https://abc.ngrok.io/');
  // path null
  assert.strictEqual(buildPublicAssetUrl(req, null), 'https://abc.ngrok.io/');
}

console.log('✓ public-url');
