/**
 * Smoke boot: sobe o servidor em PORT temporário, faz GET /, valida
 * `status: online`, mata o processo. Exit 0 se OK, 1 se falhar.
 *
 * Não depende de credenciais reais — apenas valida que o boot não quebra
 * e que o handler raiz responde. Não toca em /webhook.
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const PORT = process.env.SMOKE_PORT || '3999';
const BOOT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;
const POLL_MAX_RETRIES = Math.floor(BOOT_TIMEOUT_MS / POLL_INTERVAL_MS);

const REPO_ROOT = path.resolve(__dirname, '..');

const proc = spawn('node', ['index.js'], {
  cwd: REPO_ROOT,
  env: { ...process.env, PORT },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let booted = false;
let cleaned = false;

function cleanup(exitCode) {
  if (cleaned) return;
  cleaned = true;
  try { proc.kill(); } catch { /* ignore */ }
  setTimeout(() => process.exit(exitCode), 200);
}

proc.stdout.on('data', (d) => process.stdout.write(d));
proc.stderr.on('data', (d) => process.stderr.write(d));
proc.on('exit', (code) => {
  if (!booted) {
    process.stderr.write(`\n✗ Servidor saiu antes do smoke completar (exit=${code})\n`);
    cleanup(1);
  }
});

function probe(retries) {
  const req = http.request({
    hostname: '127.0.0.1', port: PORT, path: '/', method: 'GET', timeout: 2000,
  }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => {
      try {
        const json = JSON.parse(body);
        if (res.statusCode === 200 && json.status === 'online') {
          booted = true;
          process.stdout.write(`\n✓ Smoke OK — status=online, activeSessions=${json.activeSessions ?? 0}\n`);
          cleanup(0);
        } else {
          throw new Error(`status code ${res.statusCode}, body=${body.slice(0, 200)}`);
        }
      } catch (e) {
        retryOrFail(retries, e);
      }
    });
  });
  req.on('error', (err) => retryOrFail(retries, err));
  req.on('timeout', () => { req.destroy(); retryOrFail(retries, new Error('timeout')); });
  req.end();
}

function retryOrFail(retries, err) {
  if (retries > 0) {
    setTimeout(() => probe(retries - 1), POLL_INTERVAL_MS);
  } else {
    process.stderr.write(`\n✗ Smoke falhou após ${POLL_MAX_RETRIES} tentativas: ${err.message}\n`);
    cleanup(1);
  }
}

setTimeout(() => probe(POLL_MAX_RETRIES), 1500);
setTimeout(() => {
  if (!booted) {
    process.stderr.write(`\n✗ Smoke timeout (${BOOT_TIMEOUT_MS}ms)\n`);
    cleanup(1);
  }
}, BOOT_TIMEOUT_MS + 2000);
