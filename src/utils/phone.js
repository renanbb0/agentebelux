function digitsOnly(value) {
  return String(value ?? '').replace(/\D/g, '');
}

function normalizeWhatsAppPhone(value) {
  let digits = digitsOnly(value);
  if (!digits) return null;

  while (digits.startsWith('00')) digits = digits.slice(2);
  while (digits.startsWith('0')) digits = digits.slice(1);

  if (digits.length === 10 || digits.length === 11) {
    digits = `55${digits}`;
  }

  if (digits.length < 12 || digits.length > 15) return null;
  return digits;
}

function isAdminPhone(phone, adminPhones) {
  const normalized = normalizeWhatsAppPhone(phone);
  if (!normalized) return false;
  if (!Array.isArray(adminPhones) || adminPhones.length === 0) return false;
  return adminPhones.some((adminPhone) => normalizeWhatsAppPhone(adminPhone) === normalized);
}

module.exports = { digitsOnly, normalizeWhatsAppPhone, isAdminPhone };
