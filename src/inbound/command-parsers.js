const { normalizeWhatsAppPhone } = require('../utils/phone');

function parseBelaPauseCommand(text) {
  const raw = String(text || '').trim();
  const match = raw.match(/^(pausar|ativar|reativar)\s+bela\s+(.+)$/i);
  if (!match) return null;

  const targetPhone = normalizeWhatsAppPhone(match[2]);
  if (!targetPhone) return null;

  return {
    action: match[1].toLowerCase() === 'pausar' ? 'pause' : 'resume',
    targetPhone,
  };
}

function parseTrackingCommand(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  let body = raw;
  let isSlash = false;

  const slashMatch = raw.match(/^\/rastreio\b\s*(.*)$/i);
  if (slashMatch) {
    isSlash = true;
    body = slashMatch[1].trim();
    if (!body) return null;
  } else if (!/\b(rastreio|rastrear)\b/i.test(raw)) {
    return null;
  }

  const phoneMatch = body.match(/(\+?\d[\d\s().-]{8,})/);
  if (!phoneMatch) return isSlash ? { error: 'invalid_phone' } : null;

  const targetPhone = normalizeWhatsAppPhone(phoneMatch[0]);
  if (!targetPhone) return { error: 'invalid_phone' };

  // Código de rastreio: último token alfanumérico (pode ter "-") com pelo menos
  // um dígito e 5+ caracteres alfanuméricos. Exige dígito para evitar capturar
  // palavras como "codigo", "para", "envia" etc.
  const afterPhone = body.slice(phoneMatch.index + phoneMatch[0].length);
  const tokens = afterPhone.match(/[A-Z0-9][A-Z0-9-]*/gi) || [];
  const codeCandidate = tokens
    .reverse()
    .find((t) => /\d/.test(t) && t.replace(/-/g, '').length >= 5);

  if (!codeCandidate) return isSlash ? { error: 'invalid_code' } : null;

  const trackingCode = codeCandidate.toUpperCase();
  return { targetPhone, trackingCode };
}

module.exports = { parseBelaPauseCommand, parseTrackingCommand };
