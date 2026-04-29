/**
 * generate-log-report.js
 * Gera um PDF com o estudo completo do log belux-20260427-1333.log
 * Usage: node tools/generate-log-report.js
 */

'use strict';

const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const OUT_PATH = path.join(__dirname, '..', 'logs', 'relatorio-20260427.pdf');

// ── Paleta de cores ──────────────────────────────────────────────────────────
const C = {
  primary:   '#1a1a2e',   // azul-noite (cabeçalho)
  accent:    '#e94560',   // vermelho-rosa (destaques)
  ok:        '#27ae60',   // verde
  warn:      '#f39c12',   // laranja
  error:     '#e74c3c',   // vermelho
  info:      '#2980b9',   // azul
  light:     '#ecf0f1',   // cinza-claro (fundo de tabela)
  mid:       '#bdc3c7',   // cinza médio
  dark:      '#2c3e50',   // cinza-escuro (texto)
  white:     '#ffffff',
};

// ── Dados do relatório ───────────────────────────────────────────────────────
const REPORT = {
  title:    'Relatório de Análise de Log',
  subtitle: 'Agente Belux — Sessão 27/04/2026',
  file:     'belux-20260427-1333.log',
  period:   '13:33 – 23:33 (10 horas de operação contínua)',

  summary: [
    { label: 'Mensagens recebidas (MSG Received)',  value: '~1.048 eventos processados' },
    { label: 'Sessões de clientes distintas',        value: '~14 sessões abertas' },
    { label: 'Pedidos fechados com PDF',             value: '3 (16:55 · 17:47 · 20:59)' },
    { label: 'ImageMatch bem-sucedido',              value: '~30+ identificações' },
    { label: 'Erros críticos (ERROR)',               value: '8 ocorrências' },
    { label: 'Alertas (WARN)',                       value: '~20 ocorrências' },
    { label: 'Reinicializações do servidor',         value: '0' },
  ],

  timeline: [
    { time: '13:33', icon: '🚀', label: 'Boot do servidor', detail: 'Warmup WooCommerce (5 categorias), sync incremental, TTS carregado.' },
    { time: '13:38', icon: '✅', label: 'Primeira sessão real', detail: 'Cliente entrou pelo Gate, escolheu lançamentos, catálogo enviado (~30 cards). BuyDebounce capturou clique do botão Separar. Grade semântica detectada às 13:43.' },
    { time: '13:47', icon: '↗️', label: 'Handoff humano solicitado', detail: 'Cliente escolheu "Resolver problema" — desvio para vendedora humana.' },
    { time: '13:51', icon: '⚠️', label: 'Race condition — Gate 3x', detail: '3 fotos sem legenda chegaram antes da sessão ser criada; cada uma disparou o Gate separadamente. Bug leve de concorrência.' },
    { time: '13:57', icon: '✅', label: 'Grade via produto citado', detail: 'Cliente enviou grade em quote-reply de produto (FSM idle). Processado corretamente pelo parser de grade citada.' },
    { time: '13:58', icon: '⚠️', label: 'FecharPedido + foto ambígua + 503 Gemini', detail: 'Foto não reconhecida → FSM texto ambíguo → passou para IA → Gemini 503. Fallback interativo (BuyDebounce) cobriu o gap. Cliente completou compra normalmente.' },
    { time: '14:15', icon: '⚠️', label: 'Falha pontual no ImageMatcher (FecharPedido)', detail: 'gemini-2.5-flash-lite retornou 503 para 1 foto. Demais identificadas corretamente.' },
    { time: '14:20', icon: '⚠️', label: 'Preços divergentes na mesma referência', detail: 'Dois itens do mesmo produto com preços distintos no carrinho. Indica variante com preço diferente do produto mãe no catálogo WooCommerce.' },
    { time: '14:28', icon: '✅', label: 'Sessão intensiva — fotos com grade (nosso teste)', detail: 'Luciana Góes enviou foto com legenda "Mãe: 2M 2G 1GG / filha 2M 2G 2GG 2XGG" → ImageMatch + Grade multi-variante. Em seguida, 4 fotos simultâneas processadas pelo inlineProduct flow.' },
    { time: '14:59', icon: '❌', label: 'ProductResolve null — 5 ocorrências', detail: 'WooCommerce retornou null para 5 IDs de produto. Produtos removidos ou variantes descontinuadas sendo pedidas por clientes com histórico antigo.' },
    { time: '16:55', icon: '✅', label: 'FecharPedido completo #1 — PDF gerado', detail: 'PDF enviado ao admin (2x) e ao cliente. Handoff encerrado com sucesso.' },
    { time: '16:56', icon: '❌', label: 'TTS começa a falhar', detail: '"Fallback to text — INVESTIGAR CAUSA". Erros de axios nas chamadas ElevenLabs. Provável esgotamento de créditos ou rotação de API key. Bot degradou para texto sem voz pelo restante do dia.' },
    { time: '17:34', icon: '✅', label: 'ImageMatcher com retry 503', detail: '"[ImageMatcher] 503 — aguardando antes de retry". Lógica de retry funcionou — produto identificado na segunda tentativa.' },
    { time: '17:47', icon: '✅', label: 'FecharPedido completo #2 — PDF gerado', detail: 'formatOrderSummaryForSeller falhou → usado fallback texto. PDF enviado mesmo assim.' },
    { time: '20:37', icon: '⚠️', label: 'Compound detectado — JSON malformado', detail: 'Compound flow ativado no FecharPedido. Gemini retornou structured output inválido → fallback handoff humano.' },
    { time: '20:54', icon: '⚠️', label: 'Compound flood — 18 mensagens em 2s', detail: 'Reconexão de cliente disparou 18+ eventos simultâneos, todos detectados como compound, resetando o timer a cada um. Debounce estabilizou. Bela pediu esclarecimento. JSON malformado novamente → fallback.' },
    { time: '20:59', icon: '✅', label: 'FecharPedido completo #3 — PDF gerado', detail: 'Pedido finalizado apesar dos erros de compound. PDF entregue.' },
    { time: '22:29', icon: '⚠️', label: 'extractTextFromEvent retornou vazio', detail: 'Evento não-foto sem texto (provavelmente reaction ou status). Descartado corretamente.' },
    { time: '23:33', icon: '🟢', label: 'CatalogSync — último registro', detail: 'Sync incremental concluído. 0 produtos novos. Servidor ainda ativo.' },
  ],

  bugs: [
    {
      severity: 'ALTA',
      color: C.error,
      title: 'TTS ElevenLabs falha a partir das 16:56',
      log: '[TTS] Fallback to text — INVESTIGAR CAUSA (créditos, API key, formato de áudio)',
      impact: 'Bot perdeu voz por ~7h. Toda resposta enviada como texto simples. Experiência degradada.',
      fix: 'Verificar créditos ElevenLabs. Confirmar validade da API key. Considerar fallback para Gemini TTS como segunda opção.',
    },
    {
      severity: 'MÉDIA',
      color: C.warn,
      title: 'Compound JSON malformado — 2 ocorrências',
      log: '[Compound] JSON malformado no structured output — fallback handoff',
      impact: 'Compound não resolvido automaticamente. Cliente caiu em handoff humano desnecessariamente.',
      fix: 'Reforçar o prompt do structured output com instrução explícita de formato JSON e exemplo de schema. Adicionar schema validation com `responseMimeType: "application/json"` e `responseSchema`.',
    },
    {
      severity: 'MÉDIA',
      color: C.warn,
      title: 'ProductResolve null — WooCommerce',
      log: '[ProductResolve] API WooCommerce retornou null para este ID',
      impact: '5 ocorrências em 14:59. Grade processada no produto errado (FSM anterior) quando ID inválido.',
      fix: 'Logar o ID específico. Implementar varredura periódica no Supabase para detectar IDs que não existem mais no WooCommerce.',
    },
    {
      severity: 'MÉDIA',
      color: C.warn,
      title: 'formatOrderSummaryForSeller falha',
      log: '[Gemini] formatOrderSummaryForSeller falhou / total esperado ausente',
      impact: 'Resumo da vendedora fica no formato de fallback (menos legível). 2 pedidos afetados.',
      fix: 'Revisar o prompt do `generateOrderSummary`. Garantir que o contexto de `totalGeral` é passado corretamente.',
    },
    {
      severity: 'BAIXA',
      color: C.info,
      title: 'Gate disparado 3x simultâneo',
      log: '[Gate] Enviando menu inicial de escolha (3x em <100ms)',
      impact: 'Cliente recebe 3 menus de boas-vindas quando envia múltiplas fotos antes da sessão ser criada.',
      fix: 'Adicionar lock de criação de sessão (ou debounce de 200ms) antes de enviar o Gate.',
    },
    {
      severity: 'BAIXA',
      color: C.info,
      title: 'replyText sem replyToMessageId',
      log: '[Z-API] replyText chamado SEM replyToMessageId — fallback para sendText',
      impact: 'Resposta enviada sem citação. Cliente perde contexto visual de qual produto foi respondido.',
      fix: 'Rastrear a origem nos casos que chamam `replyText` sem `messageId`. Corrigir passagem do `messageId` em processamento de fotos com incerteza.',
    },
    {
      severity: 'BAIXA',
      color: C.info,
      title: 'Preços divergentes na mesma referência',
      log: '[FecharPedido] Preços divergentes na mesma referência — revisar catálogo',
      impact: 'Carrinho pode mostrar total inconsistente para o cliente.',
      fix: 'Revisar no WooCommerce produtos que têm preço de variante diferente do preço base. Normalizar na importação.',
    },
  ],

  positives: [
    '✅  10 horas de uptime contínuo sem reinicialização',
    '✅  3 pedidos fechados com PDF gerado e entregue',
    '✅  ImageMatch funcionou consistentemente para fotos com legenda',
    '✅  Grade multi-variante (Mãe/Filha) processada corretamente',
    '✅  BuyDebounce cobriu falha de IA (Gemini 503) transparentemente',
    '✅  Retry 503 do ImageMatcher funcionou — sem perda de dados',
    '✅  Compound flow ativo em produção (mesmo com JSON malformado, degradou com elegância)',
    '✅  Grade via produto citado (quote-reply) funcionou',
    '✅  CatalogSync incremental rodou a cada hora sem falhas',
    '✅  Fix foto-sem-legenda validado: fotos passam para ImageMatch sem exigir legenda',
  ],
};

// ── Gerador PDF ──────────────────────────────────────────────────────────────

function createPDF() {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 50, bottom: 50, left: 50, right: 50 },
    bufferPages: true,
    info: {
      Title:   REPORT.title,
      Author:  'Claude Code — Lume Soluções',
      Subject: 'Análise de Log — Agente Belux',
    },
  });

  doc.pipe(fs.createWriteStream(OUT_PATH));

  // ── Helpers ────────────────────────────────────────────────────────────────
  const W = doc.page.width - 100; // largura útil

  function sectionTitle(text) {
    doc.moveDown(0.5);
    doc.rect(50, doc.y, W, 24).fill(C.primary);
    doc.fillColor(C.white).fontSize(11).font('Helvetica-Bold')
       .text(text, 58, doc.y - 19, { width: W - 16, lineBreak: false });
    doc.moveDown(1.2);
    doc.fillColor(C.dark);
  }

  function pill(text, color, x, y) {
    const tw = doc.widthOfString(text, { fontSize: 8 });
    const pw = tw + 10;
    const ph = 13;
    doc.roundedRect(x, y - 1, pw, ph, 3).fill(color);
    doc.fillColor(C.white).fontSize(8).font('Helvetica-Bold')
       .text(text, x + 5, y + 1, { lineBreak: false });
    doc.fillColor(C.dark).font('Helvetica');
    return pw + 6;
  }

  function hline(y, color = C.mid) {
    doc.moveTo(50, y).lineTo(50 + W, y).strokeColor(color).lineWidth(0.5).stroke();
  }

  // ── Capa ───────────────────────────────────────────────────────────────────
  doc.rect(0, 0, doc.page.width, 200).fill(C.primary);
  doc.fillColor(C.accent).fontSize(9).font('Helvetica-Bold')
     .text('LUME SOLUÇÕES · AGENTE BELUX', 50, 55, { align: 'center', width: W });
  doc.fillColor(C.white).fontSize(22).font('Helvetica-Bold')
     .text(REPORT.title, 50, 75, { align: 'center', width: W });
  doc.fillColor(C.mid).fontSize(12).font('Helvetica')
     .text(REPORT.subtitle, 50, 108, { align: 'center', width: W });

  // Badge arquivo
  const badgeW = 260;
  const badgeX = (doc.page.width - badgeW) / 2;
  doc.roundedRect(badgeX, 135, badgeW, 22, 4).fill('#2c3e50');
  doc.fillColor(C.mid).fontSize(9).font('Helvetica')
     .text(`📄 ${REPORT.file}`, badgeX + 10, 140, { width: badgeW - 20, align: 'center' });

  doc.moveDown(8);
  doc.fillColor(C.mid).fontSize(9)
     .text(`Período: ${REPORT.period}`, { align: 'center' });
  doc.moveDown(0.3);
  doc.fillColor(C.mid).fontSize(9)
     .text(`Gerado em: ${new Date().toLocaleString('pt-BR')}`, { align: 'center' });

  // ── Sumário Executivo ──────────────────────────────────────────────────────
  doc.addPage();
  sectionTitle('  1. SUMÁRIO EXECUTIVO');

  const colW = (W - 10) / 2;
  let row = 0;
  for (const item of REPORT.summary) {
    const col = row % 2;
    const x = 50 + col * (colW + 10);
    const y = doc.y;
    if (col === 0 && row > 0) doc.moveDown(0.2);

    const bgColor = row % 4 < 2 ? C.light : C.white;
    doc.rect(x, y, colW, 28).fill(bgColor);
    doc.fillColor(C.dark).fontSize(8).font('Helvetica')
       .text(item.label, x + 8, y + 4, { width: colW - 16 });
    doc.fillColor(C.primary).fontSize(10).font('Helvetica-Bold')
       .text(item.value, x + 8, y + 14, { width: colW - 16 });

    row++;
    if (col === 1) doc.y += 30;
  }
  if (REPORT.summary.length % 2 !== 0) doc.y += 30;

  doc.moveDown(1);

  // ── Timeline ──────────────────────────────────────────────────────────────
  sectionTitle('  2. TIMELINE DE EVENTOS');

  for (const ev of REPORT.timeline) {
    if (doc.y > doc.page.height - 100) doc.addPage();

    const startY = doc.y;

    // Bolinha de hora
    doc.circle(65, startY + 7, 5).fill(
      ev.icon.includes('✅') ? C.ok :
      ev.icon.includes('❌') ? C.error :
      ev.icon.includes('⚠️') ? C.warn :
      C.info
    );

    // Hora
    doc.fillColor(C.mid).fontSize(8).font('Helvetica-Bold')
       .text(ev.time, 75, startY + 3, { width: 35, lineBreak: false });

    // Título do evento
    doc.fillColor(C.primary).fontSize(9.5).font('Helvetica-Bold')
       .text(ev.label, 115, startY + 3, { width: W - 70 });

    // Detalhe
    const detailY = doc.y + 1;
    doc.fillColor(C.dark).fontSize(8).font('Helvetica')
       .text(ev.detail, 115, detailY, { width: W - 70 });

    doc.moveDown(0.6);
    hline(doc.y);
    doc.moveDown(0.4);
  }

  // ── Bugs e Alertas ─────────────────────────────────────────────────────────
  doc.addPage();
  sectionTitle('  3. BUGS E ALERTAS IDENTIFICADOS');

  for (const bug of REPORT.bugs) {
    if (doc.y > doc.page.height - 130) doc.addPage();

    const bY = doc.y;
    // Faixa lateral colorida
    doc.rect(50, bY, 4, 72).fill(bug.color);

    // Severidade pill
    const pillX = 62;
    const pw = pill(bug.severity, bug.color, pillX, bY + 2);

    // Título
    doc.fillColor(C.primary).fontSize(10).font('Helvetica-Bold')
       .text(bug.title, pillX + pw + 4, bY + 2, { width: W - pillX - pw - 10 });

    // Log
    doc.rect(62, bY + 18, W - 12, 14).fill('#f5f5f5');
    doc.fillColor('#666').fontSize(7.5).font('Courier')
       .text(bug.log, 67, bY + 22, { width: W - 22 });

    // Impacto
    doc.fillColor(C.dark).fontSize(8.5).font('Helvetica-Bold')
       .text('Impacto: ', 62, bY + 38, { continued: true })
       .font('Helvetica').text(bug.impact, { width: W - 18 });

    // Fix
    doc.fillColor(C.ok).font('Helvetica-Bold').fontSize(8.5)
       .text('Fix sugerido: ', 62, doc.y + 1, { continued: true })
       .fillColor(C.dark).font('Helvetica').text(bug.fix, { width: W - 18 });

    doc.moveDown(1);
    hline(doc.y, C.light);
    doc.moveDown(0.5);
  }

  // ── Destaques Positivos ────────────────────────────────────────────────────
  doc.addPage();
  sectionTitle('  4. DESTAQUES POSITIVOS');
  doc.moveDown(0.3);

  for (const pos of REPORT.positives) {
    if (doc.y > doc.page.height - 60) doc.addPage();
    const py = doc.y;
    doc.rect(50, py, W, 22).fill(doc.y % 44 < 22 ? '#f0fdf4' : C.white);
    doc.fillColor(C.ok).fontSize(9.5).font('Helvetica')
       .text(pos, 58, py + 6, { width: W - 16 });
    doc.y = py + 24;
  }

  // ── Recomendações Prioritárias ─────────────────────────────────────────────
  doc.addPage();
  sectionTitle('  5. RECOMENDAÇÕES PRIORITÁRIAS');

  const recs = [
    { prio: '#1', color: C.error, action: 'Verificar créditos ElevenLabs', detail: 'TTS falhou a partir das 16:56 por ~7h. Checar saldo em elevenlabs.io e renovar. Avaliar fallback para Gemini TTS (já em uso no ImageMatcher).' },
    { prio: '#2', color: C.error, action: 'Corrigir Compound structured output', detail: 'Adicionar `responseSchema` explícito na chamada Gemini do Compound. Garantir que o modelo retorna JSON com schema fixo. Logar o texto bruto quando JSON.parse falhar.' },
    { prio: '#3', color: C.warn, action: 'Rastrear ProductResolve null', detail: 'Incluir o ID do produto no log de [ProductResolve] null. Criar script de varredura no Supabase para detectar IDs obsoletos e removê-los do índice de embeddings.' },
    { prio: '#4', color: C.warn, action: 'Revisar preços divergentes no catálogo', detail: 'Identificar produtos com preço de variante diferente do preço mãe no WooCommerce. Normalizar via woocommerce.js na importação.' },
    { prio: '#5', color: C.info, action: 'Debounce de criação de sessão (Gate 3x)', detail: 'Adicionar mutex ou debounce de 200ms na criação de sessão para evitar Gate triplicado quando múltiplas fotos chegam simultâneas.' },
  ];

  for (const r of recs) {
    if (doc.y > doc.page.height - 80) doc.addPage();
    const ry = doc.y;
    doc.rect(50, ry, W, 52).fill(C.light);
    doc.rect(50, ry, 40, 52).fill(r.color);
    doc.fillColor(C.white).fontSize(13).font('Helvetica-Bold')
       .text(r.prio, 50, ry + 16, { width: 40, align: 'center' });
    doc.fillColor(C.primary).fontSize(10).font('Helvetica-Bold')
       .text(r.action, 100, ry + 6, { width: W - 58 });
    doc.fillColor(C.dark).fontSize(8.5).font('Helvetica')
       .text(r.detail, 100, ry + 22, { width: W - 58 });
    doc.y = ry + 58;
    doc.moveDown(0.3);
  }

  // ── Rodapé ─────────────────────────────────────────────────────────────────
  const pages = doc.bufferedPageRange();
  for (let i = 0; i < pages.count; i++) {
    doc.switchToPage(i);
    const footerY = doc.page.height - 30;
    hline(footerY - 5, C.mid);
    doc.fillColor(C.mid).fontSize(8).font('Helvetica')
       .text(`Agente Belux · Lume Soluções · Análise de Log 27/04/2026`, 50, footerY, { width: W - 60 })
       .text(`Pág. ${i + 1} / ${pages.count}`, 50, footerY, { width: W, align: 'right' });
  }

  doc.end();
  return OUT_PATH;
}

const out = createPDF();
console.log(`PDF gerado: ${out}`);
