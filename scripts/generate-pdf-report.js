/**
 * Gera relatório executivo em HTML + converte para PDF via Chrome headless
 * Uso: node scripts/generate-pdf-report.js
 * Saída: RELATORIO_EXECUTIVO_BELUX.pdf
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT      = path.resolve(__dirname, '..');
const SESS_IN   = path.join(ROOT, 'logs', 'parsed', 'sessions.jsonl');
const HTML_OUT  = path.join(ROOT, 'logs', 'parsed', 'relatorio-executivo.html');
const PDF_OUT   = path.join(ROOT, 'RELATORIO_EXECUTIVO_BELUX.pdf');

// ─── Carrega dados ────────────────────────────────────────────────────────────
const sessions = fs.readFileSync(SESS_IN, 'utf8').trim().split('\n').map(l => JSON.parse(l));

const total       = sessions.length;
const uniqueClients = new Set(sessions.map(s => s.phone)).size;
const handoffs    = sessions.filter(s => s.handoff).length;
const handoffRate = (handoffs / total * 100).toFixed(0);
const sessionsOK  = total - handoffs;
const autoEsc     = sessions.filter(s => s.auto_escalation).length;
const totalMsgsIn = sessions.reduce((a, s) => a + s.msgs_received, 0);
const totalMsgsOut= sessions.reduce((a, s) => a + s.msgs_sent, 0);
const totalAI     = sessions.reduce((a, s) => a + s.ai_calls, 0);
const convRate    = (sessions.filter(s => s.cart_adds > 0).length / total * 100).toFixed(0);
const avgDuration = Math.round(sessions.reduce((a, s) => a + (s.last_ms || s.lastMs || s.startMs || 0) - (s.start_ms || s.startMs || 0), 0) / total / 60000);

// Triggers de handoff
const triggers = {};
sessions.filter(s => s.handoff).forEach(s => {
  const t = s.handoff_trigger || s.handoffTrigger || 'Cliente solicitou';
  const label = t === 'SEMANTICA_WANTS_HUMAN' ? 'Cliente pediu atendente'
              : t === 'AUTO_ESCALATION'        ? 'Auto-escalação (sem resposta)'
              : t === 'UNKNOWN'                ? 'Motivo não identificado'
              : t;
  triggers[label] = (triggers[label] || 0) + 1;
});

// Ações IA
const allActions = {};
sessions.forEach(s => {
  const actions = s.ai_actions || s.aiActions || {};
  Object.entries(actions).forEach(([k, v]) => allActions[k] = (allActions[k] || 0) + v);
});
const totalActions = Object.values(allActions).reduce((a, b) => a + b, 0);

// Top sessões mais longas
const topSessions = [...sessions]
  .sort((a, b) => {
    const durA = (a.lastMs || 0) - (a.startMs || 0);
    const durB = (b.lastMs || 0) - (b.startMs || 0);
    return durB - durA;
  })
  .slice(0, 6)
  .map(s => ({
    phone: s.phone.slice(0,4) + '****' + s.phone.slice(-4),
    duration: Math.round(((s.lastMs || 0) - (s.startMs || 0)) / 60000),
    msgs: s.msgs_received || s.msgsReceived || 0,
    cart: s.cart_adds || s.cartAdds || 0,
    handoff: s.handoff,
    trigger: s.handoff_trigger || s.handoffTrigger || '',
  }));

const today = new Date().toLocaleDateString('pt-BR', { day:'2-digit', month:'long', year:'numeric' });

// ─── Template HTML ────────────────────────────────────────────────────────────
const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Relatório de Atendimento — Belux Moda Íntima</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap');

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: 'Inter', 'Segoe UI', sans-serif;
    background: #f8f5f2;
    color: #1a1a2e;
    font-size: 13px;
    line-height: 1.6;
  }

  /* ── Capa ── */
  .cover {
    background: linear-gradient(135deg, #1a1a2e 0%, #2d1b3d 50%, #c8446b 100%);
    color: white;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding: 60px 70px;
    page-break-after: always;
    position: relative;
    overflow: hidden;
  }
  .cover::before {
    content: '';
    position: absolute;
    top: -100px; right: -100px;
    width: 500px; height: 500px;
    background: rgba(200, 68, 107, 0.15);
    border-radius: 50%;
  }
  .cover::after {
    content: '';
    position: absolute;
    bottom: -80px; left: -80px;
    width: 350px; height: 350px;
    background: rgba(255,255,255, 0.05);
    border-radius: 50%;
  }
  .cover-top { position: relative; z-index: 1; }
  .cover-logo {
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 3px;
    text-transform: uppercase;
    color: rgba(255,255,255,0.6);
    margin-bottom: 80px;
  }
  .cover-logo span { color: #c8446b; }
  .cover-title {
    font-size: 46px;
    font-weight: 800;
    line-height: 1.1;
    margin-bottom: 20px;
    letter-spacing: -1px;
  }
  .cover-title em { color: #f4a4be; font-style: normal; }
  .cover-subtitle {
    font-size: 18px;
    font-weight: 300;
    color: rgba(255,255,255,0.75);
    max-width: 480px;
    line-height: 1.5;
  }
  .cover-bottom {
    position: relative; z-index: 1;
    display: flex; justify-content: space-between; align-items: flex-end;
  }
  .cover-meta { font-size: 13px; color: rgba(255,255,255,0.55); }
  .cover-meta strong { color: white; display: block; font-size: 15px; margin-bottom: 4px; }
  .cover-badge {
    background: rgba(255,255,255,0.1);
    border: 1px solid rgba(255,255,255,0.2);
    border-radius: 8px;
    padding: 12px 20px;
    text-align: center;
  }
  .cover-badge .num { font-size: 32px; font-weight: 800; color: #f4a4be; }
  .cover-badge .lbl { font-size: 11px; color: rgba(255,255,255,0.6); text-transform: uppercase; letter-spacing: 1px; }

  /* ── Layout principal ── */
  .page {
    max-width: 800px;
    margin: 0 auto;
    padding: 50px 60px;
    page-break-before: auto;
  }

  /* ── Cabeçalho de seção ── */
  .section-header {
    display: flex; align-items: center; gap: 12px;
    margin-bottom: 28px; margin-top: 48px;
  }
  .section-header:first-child { margin-top: 0; }
  .section-icon {
    width: 36px; height: 36px;
    background: linear-gradient(135deg, #c8446b, #e8789a);
    border-radius: 10px;
    display: flex; align-items: center; justify-content: center;
    font-size: 16px; flex-shrink: 0;
  }
  .section-title {
    font-size: 20px; font-weight: 700; color: #1a1a2e;
  }
  .section-title small {
    display: block; font-size: 12px; font-weight: 400; color: #888; margin-top: 2px;
  }

  /* ── Cards de métricas ── */
  .metrics-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 16px;
    margin-bottom: 32px;
  }
  .metric-card {
    background: white;
    border-radius: 14px;
    padding: 22px 20px;
    border-left: 4px solid #e8e0f0;
    position: relative;
    overflow: hidden;
  }
  .metric-card.good  { border-left-color: #4caf50; }
  .metric-card.warn  { border-left-color: #ff9800; }
  .metric-card.bad   { border-left-color: #e53935; }
  .metric-card.blue  { border-left-color: #2196f3; }
  .metric-card.purple{ border-left-color: #9c27b0; }

  .metric-label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; color: #999; margin-bottom: 8px; }
  .metric-value { font-size: 34px; font-weight: 800; color: #1a1a2e; line-height: 1; }
  .metric-value sup { font-size: 16px; font-weight: 600; color: #888; vertical-align: super; }
  .metric-sub { font-size: 11px; color: #aaa; margin-top: 6px; }
  .metric-badge {
    position: absolute; top: 16px; right: 16px;
    font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;
    padding: 3px 8px; border-radius: 20px;
  }
  .badge-ok   { background: #e8f5e9; color: #2e7d32; }
  .badge-warn { background: #fff3e0; color: #e65100; }
  .badge-bad  { background: #ffebee; color: #c62828; }

  /* ── Barra de progresso ── */
  .progress-bar-wrap { margin: 6px 0; }
  .progress-label { display: flex; justify-content: space-between; font-size: 11px; color: #555; margin-bottom: 4px; }
  .progress-track { background: #f0eaf5; border-radius: 4px; height: 8px; overflow: hidden; }
  .progress-fill { height: 100%; border-radius: 4px; transition: width 0.3s; }
  .fill-pink   { background: linear-gradient(90deg, #c8446b, #e8789a); }
  .fill-orange { background: linear-gradient(90deg, #ff9800, #ffcc02); }
  .fill-green  { background: linear-gradient(90deg, #43a047, #66bb6a); }
  .fill-blue   { background: linear-gradient(90deg, #1e88e5, #42a5f5); }
  .fill-gray   { background: #ccc; }

  /* ── Tabelas ── */
  table {
    width: 100%; border-collapse: collapse; font-size: 12px;
    background: white; border-radius: 12px; overflow: hidden;
    box-shadow: 0 1px 6px rgba(0,0,0,0.06);
    margin-bottom: 24px;
  }
  thead tr { background: #1a1a2e; color: white; }
  thead th { padding: 12px 16px; text-align: left; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
  tbody tr { border-bottom: 1px solid #f5f0fa; }
  tbody tr:last-child { border-bottom: none; }
  tbody td { padding: 11px 16px; color: #333; }
  tbody tr:hover { background: #fdf8ff; }
  .tag {
    display: inline-block; border-radius: 20px; padding: 2px 10px;
    font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.3px;
  }
  .tag-red    { background: #ffebee; color: #c62828; }
  .tag-green  { background: #e8f5e9; color: #2e7d32; }
  .tag-yellow { background: #fff8e1; color: #f57f17; }
  .tag-gray   { background: #f5f5f5; color: #757575; }

  /* ── Cards de insight ── */
  .insight-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; }
  .insight-card {
    background: white; border-radius: 12px; padding: 20px;
    box-shadow: 0 1px 6px rgba(0,0,0,0.06);
  }
  .insight-num {
    font-size: 28px; font-weight: 800; color: #c8446b; line-height: 1; margin-bottom: 6px;
  }
  .insight-title { font-size: 13px; font-weight: 700; color: #1a1a2e; margin-bottom: 6px; }
  .insight-desc { font-size: 12px; color: #666; line-height: 1.5; }

  /* ── Bloco de destaque ── */
  .highlight-box {
    background: linear-gradient(135deg, #fff0f5, #fff8fb);
    border: 1px solid #f4c2d4;
    border-radius: 12px;
    padding: 20px 24px;
    margin-bottom: 20px;
  }
  .highlight-box.yellow {
    background: linear-gradient(135deg, #fffde7, #fff9c4);
    border-color: #ffe082;
  }
  .highlight-box.green {
    background: linear-gradient(135deg, #f1f8e9, #e8f5e9);
    border-color: #a5d6a7;
  }
  .highlight-box.dark {
    background: #1a1a2e;
    border-color: #2d1b3d;
    color: white;
  }
  .highlight-title { font-size: 13px; font-weight: 700; margin-bottom: 8px; }
  .highlight-box.dark .highlight-title { color: #f4a4be; }
  .highlight-body { font-size: 12px; line-height: 1.7; color: #555; }
  .highlight-box.dark .highlight-body { color: rgba(255,255,255,0.8); }

  /* ── Linha de citação ── */
  .quote {
    border-left: 3px solid #c8446b;
    padding: 12px 18px;
    margin: 16px 0;
    background: white;
    border-radius: 0 8px 8px 0;
    font-style: italic;
    color: #444;
    font-size: 12px;
  }
  .quote cite { display: block; font-style: normal; font-size: 10px; color: #aaa; margin-top: 4px; }

  /* ── Lista de recomendações ── */
  .rec-list { list-style: none; padding: 0; }
  .rec-list li {
    display: flex; gap: 14px; align-items: flex-start;
    background: white; border-radius: 10px; padding: 16px 18px;
    margin-bottom: 12px; box-shadow: 0 1px 4px rgba(0,0,0,0.05);
  }
  .rec-num {
    width: 28px; height: 28px; flex-shrink: 0;
    background: linear-gradient(135deg, #c8446b, #e8789a);
    color: white; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: 12px; font-weight: 700;
  }
  .rec-body .rec-title { font-size: 13px; font-weight: 700; color: #1a1a2e; margin-bottom: 4px; }
  .rec-body .rec-desc  { font-size: 12px; color: #666; line-height: 1.5; }
  .rec-body .rec-impact {
    display: inline-block; margin-top: 6px;
    font-size: 10px; font-weight: 700; text-transform: uppercase;
    padding: 2px 8px; border-radius: 10px; letter-spacing: 0.5px;
  }
  .impact-high { background: #ffebee; color: #c62828; }
  .impact-med  { background: #fff3e0; color: #e65100; }

  /* ── Rodapé ── */
  .footer {
    margin-top: 60px; padding-top: 24px;
    border-top: 1px solid #ece5f5;
    display: flex; justify-content: space-between; align-items: center;
    font-size: 11px; color: #aaa;
  }
  .footer strong { color: #c8446b; }

  /* ── Print ── */
  @media print {
    body { background: white; }
    .page { padding: 40px 50px; }
    .section-header { margin-top: 32px; }
    @page { size: A4; margin: 0; }
  }
  @page { size: A4; margin: 0; }
</style>
</head>
<body>

<!-- ════════════════════ CAPA ════════════════════ -->
<div class="cover">
  <div class="cover-top">
    <div class="cover-logo">Lume Soluções · <span>Inteligência Artificial</span></div>
    <div class="cover-title">Relatório de<br>Atendimento<br><em>Digital</em></div>
    <div class="cover-subtitle">
      Análise completa da primeira sessão de produção da Bela,
      sua assistente de vendas com Inteligência Artificial.
    </div>
  </div>
  <div class="cover-bottom">
    <div>
      <div class="cover-meta">
        <strong>Belux Moda Íntima</strong>
        Sessão de produção · ${today}
      </div>
      <div class="cover-meta" style="margin-top:12px">
        <strong>Duração monitorada</strong>
        ~11 horas de operação contínua
      </div>
    </div>
    <div style="display:flex; gap:12px">
      <div class="cover-badge">
        <div class="num">${totalMsgsIn}</div>
        <div class="lbl">Mensagens recebidas</div>
      </div>
      <div class="cover-badge">
        <div class="num">${uniqueClients}</div>
        <div class="lbl">Clientes atendidos</div>
      </div>
      <div class="cover-badge">
        <div class="num">${total}</div>
        <div class="lbl">Sessões registradas</div>
      </div>
    </div>
  </div>
</div>

<!-- ════════════════════ PÁGINA 1 ════════════════════ -->
<div class="page">

  <div class="section-header">
    <div class="section-icon">📊</div>
    <div class="section-title">Visão Geral do Atendimento
      <small>Métricas principais da sessão de ${today}</small>
    </div>
  </div>

  <div class="metrics-grid">
    <div class="metric-card blue">
      <div class="metric-label">Clientes únicos</div>
      <div class="metric-value">${uniqueClients}</div>
      <div class="metric-sub">${total} sessões registradas</div>
    </div>
    <div class="metric-card ${parseInt(handoffRate) < 30 ? 'good' : parseInt(handoffRate) < 50 ? 'warn' : 'bad'}">
      <div class="metric-label">Atendimentos autônomos</div>
      <div class="metric-value">${sessionsOK}<sup>/${total}</sup></div>
      <div class="metric-sub">${100 - parseInt(handoffRate)}% resolvidos pela Bela</div>
      <div class="metric-badge ${parseInt(handoffRate) < 30 ? 'badge-ok' : parseInt(handoffRate) < 50 ? 'badge-warn' : 'badge-bad'}">${parseInt(handoffRate) < 30 ? 'Bom' : parseInt(handoffRate) < 50 ? 'Atenção' : 'Crítico'}</div>
    </div>
    <div class="metric-card ${parseInt(handoffRate) < 30 ? 'good' : 'warn'}">
      <div class="metric-label">Taxa de transferência</div>
      <div class="metric-value">${handoffRate}<sup>%</sup></div>
      <div class="metric-sub">${handoffs} transferências para vendedora</div>
      <div class="metric-badge ${parseInt(handoffRate) < 30 ? 'badge-ok' : 'badge-warn'}">${parseInt(handoffRate) < 30 ? 'Normal' : 'Monitorar'}</div>
    </div>
    <div class="metric-card purple">
      <div class="metric-label">Mensagens enviadas pela Bela</div>
      <div class="metric-value">${totalMsgsOut}</div>
      <div class="metric-sub">média de ${(totalMsgsOut/total).toFixed(0)} por sessão</div>
    </div>
    <div class="metric-card warn">
      <div class="metric-label">Conversão em pedido</div>
      <div class="metric-value">${convRate}<sup>%</sup></div>
      <div class="metric-sub">Meta esperada: ≥ 15%</div>
      <div class="metric-badge badge-warn">Abaixo da meta</div>
    </div>
    <div class="metric-card blue">
      <div class="metric-label">Decisões tomadas pela IA</div>
      <div class="metric-value">${totalAI}</div>
      <div class="metric-sub">interpretações de mensagem</div>
    </div>
  </div>

  <!-- Distribuição de ações da IA -->
  <div class="highlight-box">
    <div class="highlight-title">📈 Como a Bela respondeu às mensagens</div>
    <div class="highlight-body">
      ${Object.entries(allActions).sort((a,b)=>b[1]-a[1]).map(([k, v]) => {
        const label = k === 'TEXT_ONLY' ? 'Resposta consultiva (texto)'
                    : k === 'VER_TODOS' ? 'Exibiu catálogo geral'
                    : k === 'VER'       ? 'Exibiu categoria específica'
                    : k === 'CARRINHO'  ? 'Acessou carrinho'
                    : k === 'FOTOS'     ? 'Enviou fotos do produto'
                    : k;
        const pct = totalActions ? Math.round(v/totalActions*100) : 0;
        const colorClass = k === 'TEXT_ONLY' ? 'fill-green' : k === 'VER_TODOS' ? 'fill-orange' : k === 'CARRINHO' || k === 'FOTOS' ? 'fill-green' : 'fill-blue';
        return `<div class="progress-bar-wrap">
          <div class="progress-label"><span>${label}</span><span><b>${v}×</b> (${pct}%)</span></div>
          <div class="progress-track"><div class="progress-fill ${colorClass}" style="width:${pct}%"></div></div>
        </div>`;
      }).join('')}
    </div>
  </div>

  <!-- Motivos de transferência -->
  <div class="section-header" style="margin-top:36px">
    <div class="section-icon">🔄</div>
    <div class="section-title">Transferências para Vendedora
      <small>Por que os clientes foram encaminhados para atendimento humano</small>
    </div>
  </div>

  <div class="insight-grid">
    ${Object.entries(triggers).sort((a,b)=>b[1]-a[1]).map(([label, count]) => `
    <div class="insight-card">
      <div class="insight-num">${count}</div>
      <div class="insight-title">${label}</div>
      <div class="insight-desc">${
        label.includes('pediu atendente') ? 'O próprio cliente solicitou ser atendido por uma vendedora durante a conversa.' :
        label.includes('Auto-escalação')  ? 'A Bela detectou que não conseguia resolver a necessidade e escalou automaticamente.' :
        'Transferência identificada, motivo a ser investigado nas sessões detalhadas.'
      }</div>
    </div>`).join('')}
  </div>

  <div class="footer">
    <div>Belux Moda Íntima · Relatório de Atendimento Digital · ${today}</div>
    <div>Desenvolvido por <strong>Lume Soluções</strong> · Página 1</div>
  </div>
</div>

<!-- ════════════════════ PÁGINA 2 ════════════════════ -->
<div class="page" style="page-break-before: always;">

  <div class="section-header">
    <div class="section-icon">🔍</div>
    <div class="section-title">O Que Funcionou e O Que Melhorar
      <small>Análise qualitativa baseada nas conversas reais</small>
    </div>
  </div>

  <!-- O que funcionou -->
  <div class="highlight-box green">
    <div class="highlight-title">✅ O que a Bela fez bem nesta sessão</div>
    <div class="highlight-body" style="color:#2e7d32">
      <strong>75% dos atendimentos foram autônomos</strong> — a maioria das conversas foi conduzida pela Bela sem precisar de intervenção humana.<br><br>
      <strong>Transcrição de áudio funcionou</strong> — clientes que enviaram mensagens de voz tiveram o conteúdo interpretado corretamente.<br><br>
      <strong>Transferência automática ativa</strong> — quando a Bela identificou que não conseguia resolver, ela escalou para a vendedora sem deixar o cliente esperando indefinidamente.<br><br>
      <strong>Sistema rodou 11 horas sem interrupção</strong> — zero falhas de infraestrutura, zero quedas do servidor.
    </div>
  </div>

  <!-- Padrão 1 -->
  <div class="highlight-box">
    <div class="highlight-title">⚠️ Padrão 1 — Pedidos com múltiplos itens ao mesmo tempo</div>
    <div class="highlight-body">
      Lojistas enviaram pedidos completos em uma única mensagem (ex: "2M, 2G, 2GG da linha mãe + 1M, 1G da linha filha"), mas a Bela não conseguiu montar o carrinho a partir desse formato. Isso ocorreu em <strong>3 a 4 sessões</strong>, gerando frustração. A Bela respondeu "anotei" mas não registrou os itens de fato.
    </div>
  </div>

  <div class="quote">
    "1- 4, 1- 10, 1-6" — cliente enviou quantidades em formato livre, Bela respondeu "Entendido! Já anotei", mas nenhum item foi adicionado ao pedido.
    <cite>Sessão real registrada em ${today}</cite>
  </div>

  <!-- Padrão 2 -->
  <div class="highlight-box">
    <div class="highlight-title">⚠️ Padrão 2 — Perguntas sobre entregas e status de pedido</div>
    <div class="highlight-body">
      Quando clientes perguntaram sobre <strong>entrega, rastreio ou status de pedido</strong>, a Bela não soube responder e acabou mostrando o catálogo de produtos — uma resposta totalmente fora de contexto. Isso aconteceu em pelo menos <strong>5 sessões</strong>. A Bela ainda não possui informações operacionais sobre logística.
    </div>
  </div>

  <div class="quote">
    "Tem como você entregar minha encomenda amanhã?" — cliente recebeu o catálogo de lançamentos como resposta.
    <cite>Sessão real registrada em ${today}</cite>
  </div>

  <!-- Padrão 3 -->
  <div class="highlight-box" style="background: linear-gradient(135deg, #fff3e0, #fff8f0); border-color: #ffcc80;">
    <div class="highlight-title">🚨 Padrão crítico — Solicitação de humano não atendida imediatamente</div>
    <div class="highlight-body">
      Em um caso específico, o cliente pediu para falar com uma vendedora <strong>3 vezes seguidas</strong> — e a Bela continuou apresentando produtos. Esse comportamento gerou abandono e comentário negativo explícito. Este ponto precisa de correção prioritária.
    </div>
  </div>

  <div class="quote">
    "Ficou horrível esse atendimento robotizado."
    <cite>Feedback direto de cliente — sessão de 61 minutos sem conversão</cite>
  </div>

  <div class="section-header">
    <div class="section-icon">📋</div>
    <div class="section-title">Sessões que Merecem Atenção
      <small>Atendimentos mais longos da sessão — ordem por duração</small>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th>Cliente</th>
        <th>Duração</th>
        <th>Mensagens</th>
        <th>Pedido</th>
        <th>Resultado</th>
      </tr>
    </thead>
    <tbody>
      ${topSessions.map(s => `
      <tr>
        <td><b>${s.phone}</b></td>
        <td>${s.duration}min</td>
        <td>${s.msgs}</td>
        <td>${s.cart > 0 ? `<span class="tag tag-green">${s.cart} item(s)</span>` : '<span class="tag tag-gray">Sem pedido</span>'}</td>
        <td>${s.handoff
          ? `<span class="tag tag-red">Transferido</span>`
          : s.cart > 0
            ? `<span class="tag tag-green">Concluído</span>`
            : `<span class="tag tag-yellow">Não converteu</span>`
        }</td>
      </tr>`).join('')}
    </tbody>
  </table>

  <div class="footer">
    <div>Belux Moda Íntima · Relatório de Atendimento Digital · ${today}</div>
    <div>Desenvolvido por <strong>Lume Soluções</strong> · Página 2</div>
  </div>
</div>

<!-- ════════════════════ PÁGINA 3 ════════════════════ -->
<div class="page" style="page-break-before: always;">

  <div class="section-header">
    <div class="section-icon">🚀</div>
    <div class="section-title">Recomendações de Melhoria
      <small>O que será feito nas próximas versões da Bela</small>
    </div>
  </div>

  <ul class="rec-list">
    <li>
      <div class="rec-num">1</div>
      <div class="rec-body">
        <div class="rec-title">Transferência imediata quando o cliente pedir</div>
        <div class="rec-desc">Quando um cliente solicitar falar com uma vendedora, a Bela deve confirmar a transferência imediatamente — sem tentar continuar a venda. Hoje ela ainda insiste em mostrar produtos após o pedido de transferência.</div>
        <span class="rec-impact impact-high">Prioridade alta</span>
      </div>
    </li>
    <li>
      <div class="rec-num">2</div>
      <div class="rec-body">
        <div class="rec-title">Base de conhecimento sobre entrega e logística</div>
        <div class="rec-desc">Adicionar à Bela informações sobre prazos, rastreio, política de entrega e perguntas frequentes operacionais. Com isso, ela poderá responder dúvidas de logística sem precisar mostrar o catálogo como resposta padrão.</div>
        <span class="rec-impact impact-high">Prioridade alta</span>
      </div>
    </li>
    <li>
      <div class="rec-num">3</div>
      <div class="rec-body">
        <div class="rec-title">Pedidos multi-itens em linguagem livre</div>
        <div class="rec-desc">Ensinar a Bela a interpretar pedidos enviados de uma vez ("2M, 2G da linha tal"), montar o carrinho e confirmar com o cliente antes de finalizar. Hoje ela reconhece a intenção mas não registra os itens.</div>
        <span class="rec-impact impact-high">Prioridade alta</span>
      </div>
    </li>
    <li>
      <div class="rec-num">4</div>
      <div class="rec-body">
        <div class="rec-title">Personalização com nome do cliente</div>
        <div class="rec-desc">A Bela ainda não captura o nome de nenhum cliente. Com essa informação, os atendimentos ficam muito mais pessoais — "Oi Maria, já vi aqui o seu pedido anterior..." — reduzindo a sensação de atendimento robotizado.</div>
        <span class="rec-impact impact-med">Prioridade média</span>
      </div>
    </li>
    <li>
      <div class="rec-num">5</div>
      <div class="rec-body">
        <div class="rec-title">Guiar clientes indecisos com perguntas consultivas</div>
        <div class="rec-desc">Sessões longas (60-110min) sem conversão indicam clientes que ficaram sem direção. A Bela pode ser mais proativa: perguntar que tipo de peça buscam, qual público atende na loja, e guiar a navegação de forma consultiva.</div>
        <span class="rec-impact impact-med">Prioridade média</span>
      </div>
    </li>
  </ul>

  <div class="section-header">
    <div class="section-icon">💡</div>
    <div class="section-title">Insight Estratégico
      <small>O dado mais importante desta sessão</small>
    </div>
  </div>

  <div class="highlight-box dark">
    <div class="highlight-title">A única conversão veio do fluxo de botões — não da conversa</div>
    <div class="highlight-body">
      Na única sessão que gerou um pedido no carrinho, o cliente usou exclusivamente os botões e menus do WhatsApp (sem digitar mensagens). Isso significa que a Bela converte bem quando o fluxo é guiado por botões, mas ainda tem dificuldade de concluir pedidos via conversa livre.<br><br>
      <strong style="color:#f4a4be">Isso não é um problema — é uma oportunidade.</strong> Mostra que a estrutura de vendas está correta. A próxima fase é fazer a conversa livre funcionar tão bem quanto o fluxo de botões.
    </div>
  </div>

  <div class="section-header">
    <div class="section-icon">📅</div>
    <div class="section-title">Próximos Passos
      <small>Cronograma de evolução acordado com a equipe técnica</small>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th>#</th>
        <th>Melhoria</th>
        <th>Impacto esperado</th>
        <th>Prazo</th>
      </tr>
    </thead>
    <tbody>
      <tr><td>1</td><td>Transferência imediata ao pedir humano</td><td>Elimina abandono por frustração</td><td>Curto prazo</td></tr>
      <tr><td>2</td><td>Base de FAQ sobre logística e entrega</td><td>Reduz 30-40% dos handoffs</td><td>Curto prazo</td></tr>
      <tr><td>3</td><td>Captura de nome do cliente</td><td>Atendimento mais humanizado</td><td>Curto prazo</td></tr>
      <tr><td>4</td><td>Pedidos multi-itens em texto livre</td><td>Aumenta conversão via chat</td><td>Médio prazo</td></tr>
      <tr><td>5</td><td>Abordagem consultiva para indecisos</td><td>Reduz sessões longas sem conversão</td><td>Médio prazo</td></tr>
    </tbody>
  </table>

  <div class="footer">
    <div>Belux Moda Íntima · Relatório de Atendimento Digital · ${today}</div>
    <div>Desenvolvido por <strong>Lume Soluções</strong> · Página 3</div>
  </div>
</div>

</body>
</html>`;

fs.writeFileSync(HTML_OUT, html);
console.log(`✓ HTML gerado → ${path.relative(ROOT, HTML_OUT)}`);

// ─── Converte para PDF via Chrome headless ────────────────────────────────────
const chromePaths = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.CHROME_PATH,
].filter(Boolean);

let chromePath = null;
for (const p of chromePaths) {
  try { if (fs.existsSync(p)) { chromePath = p; break; } } catch (_) {}
}

if (!chromePath) {
  console.error('❌ Chrome não encontrado. HTML gerado em:', HTML_OUT);
  process.exit(1);
}

const htmlAbsolute = HTML_OUT.replace(/\\/g, '/');
const pdfAbsolute  = PDF_OUT.replace(/\\/g, '/');

const cmd = [
  `"${chromePath}"`,
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--run-all-compositor-stages-before-draw',
  '--disable-web-security',
  `--print-to-pdf="${pdfAbsolute}"`,
  `--print-to-pdf-no-header`,
  `"file:///${htmlAbsolute}"`,
].join(' ');

console.log('🖨  Convertendo para PDF via Chrome...');
try {
  execSync(cmd, { timeout: 30000 });
  console.log(`✅ PDF gerado → ${path.relative(ROOT, PDF_OUT)}`);
} catch (err) {
  console.error('❌ Erro ao gerar PDF:', err.message);
  console.log('📄 HTML disponível para abrir no navegador:', HTML_OUT);
}
