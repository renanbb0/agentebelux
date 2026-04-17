/**
 * Monitor em Tempo Real — Agente Belux
 *
 * Cliente Socket.IO que conecta ao Agente rodando em http://localhost:3000
 * e mostra logs coloridos por categoria em um TUI híbrido:
 *   - Header fixo com contadores (sessões ativas, handoffs, erros)
 *   - Stream de logs abaixo
 *
 * READ-ONLY: não altera nada no Agente nem no banco.
 *
 * Uso:
 *   node .agent/scripts/monitor_tempo_real.js [--url=http://localhost:3000]
 *
 * Teclas:
 *   q  — sair
 *   c  — limpar stream
 *   p  — pausar/retomar render
 */

const blessed = require('blessed');
const { io } = require('socket.io-client');

// ── CLI ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name, def) {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : def;
}
const AGENT_URL = getArg('url', process.env.AGENT_URL || 'http://localhost:3000');
const REFRESH_MS = parseInt(getArg('refresh', '5000'), 10);
const MAX_LINES = parseInt(getArg('buffer', '500'), 10);

// ── Estado ───────────────────────────────────────────────────────────────
const state = {
  connected: false,
  activeSessions: 0,
  handoffsSession: 0,
  errorsSession: 0,
  warnsSession: 0,
  paused: false,
  lastEventAt: null,
};

// ── TUI ──────────────────────────────────────────────────────────────────
const screen = blessed.screen({
  smartCSR: true,
  title: 'Agente Belux — Monitor',
  fullUnicode: true,
});

const header = blessed.box({
  top: 0,
  left: 0,
  width: '100%',
  height: 3,
  tags: true,
  border: { type: 'line' },
  style: { border: { fg: 'cyan' } },
});

const stream = blessed.log({
  top: 3,
  left: 0,
  width: '100%',
  height: '100%-6',
  tags: true,
  border: { type: 'line' },
  scrollable: true,
  alwaysScroll: true,
  mouse: true,
  keys: true,
  scrollbar: { ch: ' ', style: { bg: 'grey' } },
  style: { border: { fg: 'grey' } },
});

const footer = blessed.box({
  bottom: 0,
  left: 0,
  width: '100%',
  height: 3,
  tags: true,
  border: { type: 'line' },
  content: '  {bold}[q]{/bold} sair   {bold}[c]{/bold} limpar   {bold}[p]{/bold} pausar/retomar   {bold}[↑↓]{/bold} scroll',
  style: { border: { fg: 'grey' } },
});

screen.append(header);
screen.append(stream);
screen.append(footer);

screen.key(['q', 'C-c'], () => {
  try { socket.close(); } catch (_) {}
  process.exit(0);
});

screen.key(['c'], () => {
  stream.setContent('');
  screen.render();
});

screen.key(['p'], () => {
  state.paused = !state.paused;
  renderHeader();
});

// ── Render header ────────────────────────────────────────────────────────
function colorDot(ok) {
  return ok ? '{green-fg}●{/green-fg}' : '{red-fg}●{/red-fg}';
}

function renderHeader() {
  const line1 = `  ${colorDot(state.connected)} {bold}Agente Belux{/bold} — ${AGENT_URL}` +
    (state.paused ? '   {yellow-fg}[PAUSADO]{/yellow-fg}' : '');
  const line2 = `  Sessões ativas: {bold}${state.activeSessions}{/bold}   │   ` +
    `Handoffs (sessão): {yellow-fg}${state.handoffsSession}{/yellow-fg}   │   ` +
    `Warns: {yellow-fg}${state.warnsSession}{/yellow-fg}   │   ` +
    `Erros: {red-fg}${state.errorsSession}{/red-fg}`;
  header.setContent(`${line1}\n${line2}`);
  screen.render();
}

// ── Append log line ──────────────────────────────────────────────────────
function pad2(n) { return String(n).padStart(2, '0'); }
function fmtTime(ts) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

const TYPE_COLORS = {
  fsm:     'cyan',
  webhook: 'yellow',
  ai:      'magenta',
  send:    'green',
  system:  'white',
  warn:    'yellow',
  error:   'red',
};

function formatMsg(message, data) {
  if (message === null || message === undefined) return '';
  if (typeof message === 'string') return message;
  try { return JSON.stringify(message); } catch (_) { return String(message); }
}

let buffered = 0;
function appendLog(ev) {
  const ts = fmtTime(ev.timestamp || Date.now());
  const type = (ev.type || 'system').toLowerCase();
  const color = TYPE_COLORS[type] || 'white';
  const tag = type.toUpperCase().padEnd(7);
  const msg = formatMsg(ev.message, ev.data);
  const stateHint = ev.state ? ` {grey-fg}[${ev.state}]{/grey-fg}` : '';
  const line = `{grey-fg}${ts}{/grey-fg} {${color}-fg}${tag}{/${color}-fg} ${msg}${stateHint}`;

  if (!state.paused) {
    stream.log(line);
    buffered++;
    if (buffered > MAX_LINES) {
      // blessed.log gerencia scroll; para truncar, limpar tudo quando excede muito
      if (buffered > MAX_LINES * 2) {
        stream.setContent('');
        buffered = 0;
      }
    }
  }

  // Contadores (independem de pausa)
  if (type === 'error') state.errorsSession++;
  else if (type === 'warn') state.warnsSession++;
  if (typeof ev.message === 'string' && ev.message.includes('executeHandoff concluído')) {
    state.handoffsSession++;
  }
  state.lastEventAt = Date.now();
}

// ── Socket.IO client ─────────────────────────────────────────────────────
const socket = io(AGENT_URL, {
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  transports: ['websocket', 'polling'],
});

socket.on('connect', () => {
  state.connected = true;
  appendLog({ timestamp: Date.now(), type: 'system', message: `Conectado a ${AGENT_URL}` });
  renderHeader();
});

socket.on('disconnect', (reason) => {
  state.connected = false;
  appendLog({ timestamp: Date.now(), type: 'warn', message: `Desconectado: ${reason} — tentando reconectar…` });
  renderHeader();
});

socket.on('connect_error', (err) => {
  state.connected = false;
  appendLog({ timestamp: Date.now(), type: 'error', message: `Falha ao conectar: ${err.message}` });
  renderHeader();
});

socket.on('log', (ev) => {
  appendLog(ev);
  // Re-render header em baixa frequência
});

// ── Polling /  para sessões ativas ───────────────────────────────────────
async function pollStatus() {
  try {
    const res = await fetch(AGENT_URL + '/', { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const json = await res.json();
      state.activeSessions = json.activeSessions ?? 0;
    }
  } catch (_) {
    // silencioso — desconexão já é exibida pelo socket
  }
  renderHeader();
}
pollStatus();
setInterval(pollStatus, REFRESH_MS);

// Refresh visual do header a cada segundo (para manter estado consistente)
setInterval(renderHeader, 1000);

renderHeader();
screen.render();
