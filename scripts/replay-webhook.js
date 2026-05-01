/**
 * Replay: faz POST /webhook para cada fixture em tests/_fixtures/replay-payloads.json,
 * captura status code + body, e grava em tests/_fixtures/replay-output.json.
 *
 * Uso:
 *   - Servidor precisa estar rodando (npm start ou npm run smoke em outro terminal).
 *   - Depois: npm run replay
 *
 * Para gerar a baseline: rodar antes de qualquer mudança e renomear:
 *   mv tests/_fixtures/replay-output.json tests/_fixtures/replay-output.baseline.json
 *
 * Para validar regressão: rodar de novo e diff:
 *   diff tests/_fixtures/replay-output.json tests/_fixtures/replay-output.baseline.json
 *
 * NOTA: Esta versão usa payloads SINTÉTICOS válidos no formato Z-API. Ela valida
 * o roteamento do webhook (status code, ack imediato), mas não cobre todos os
 * caminhos de FSM. Antes da Fase 8/11 (FSM/dispatcher), capturar payloads reais
 * via instrumentação temporária do /webhook.
 */
const fs = require('fs');
const http = require('http');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(REPO_ROOT, 'tests', '_fixtures', 'replay-payloads.json');
const OUTPUT = path.join(REPO_ROOT, 'tests', '_fixtures', 'replay-output.json');

const HOST = process.env.REPLAY_HOST || '127.0.0.1';
const PORT = process.env.REPLAY_PORT || process.env.PORT || '3000';

function postWebhook(payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({
      hostname: HOST,
      port: PORT,
      path: '/webhook',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: 5000,
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

(async () => {
  if (!fs.existsSync(FIXTURES)) {
    process.stderr.write(`✗ Fixtures não encontradas: ${FIXTURES}\n`);
    process.exit(1);
  }

  const fixtures = JSON.parse(fs.readFileSync(FIXTURES, 'utf8'));
  const results = [];

  for (const f of fixtures) {
    process.stdout.write(`▶ ${f.name}\n`);
    try {
      const r = await postWebhook(f.payload);
      results.push({ name: f.name, status: r.status, body: r.body });
      process.stdout.write(`  → status=${r.status} body=${r.body.slice(0, 80)}\n`);
    } catch (e) {
      results.push({ name: f.name, error: e.message });
      process.stdout.write(`  ✗ ${e.message}\n`);
    }
  }

  fs.writeFileSync(OUTPUT, JSON.stringify(results, null, 2) + '\n');
  process.stdout.write(`\n✓ Output: ${OUTPUT}\n`);
})();
