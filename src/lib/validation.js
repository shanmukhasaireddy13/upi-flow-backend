const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VPA_PATTERN = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z]{2,64}$/;
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const ORDER_ID_PATTERN = /^ord_[A-Za-z0-9_-]{10,64}$/;
const REFERENCE_PATTERN = /^[A-Za-z0-9]{8,24}$/;
const PRIVATE_HOST_PATTERN = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[?::1\]?|169\.254\.)/i;

const MIN_AMOUNT = 1;
const MAX_AMOUNT = 100000;

/**
 * Returns the amount as a 2-decimal string, or null when it is not a valid INR amount.
 */
function parseAmount(value) {
  const number = typeof value === 'number' ? value : Number(String(value ?? '').replace(/,/g, ''));
  if (!Number.isFinite(number) || number < MIN_AMOUNT || number > MAX_AMOUNT) return null;
  const paise = Math.round(number * 100);
  if (Math.abs(paise - number * 100) > 1e-6) return null;
  return (paise / 100).toFixed(2);
}

function parseString(value, max, { optional = false } = {}) {
  if (value === undefined || value === null || value === '') return optional ? '' : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed && !optional) return null;
  return trimmed.length > max ? null : trimmed;
}

function isEmail(value) {
  return typeof value === 'string' && value.length <= 254 && EMAIL_PATTERN.test(value);
}

function isVpa(value) {
  return typeof value === 'string' && VPA_PATTERN.test(value);
}

function isFamPayVpa(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim().toLowerCase();
  return VPA_PATTERN.test(trimmed) && trimmed.endsWith('@fam');
}

function isHexColor(value) {
  return typeof value === 'string' && HEX_COLOR_PATTERN.test(value);
}

function isOrderId(value) {
  return typeof value === 'string' && ORDER_ID_PATTERN.test(value);
}

function isPaymentReference(value) {
  return typeof value === 'string' && REFERENCE_PATTERN.test(value);
}

/**
 * Validates browser redirect URLs for success_url and cancel_url.
 * Supports {ORDER_ID} and {CHECKOUT_SESSION_ID} template parameters.
 */
function isValidRedirectUrl(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048) return false;
  const testUrl = trimmed
    .replace(/\{ORDER_ID\}/g, 'ord_placeholder')
    .replace(/\{CHECKOUT_SESSION_ID\}/g, 'cs_placeholder');
  try {
    const parsed = new URL(testUrl);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Webhook and logo URLs must be HTTPS. Plain HTTP is allowed only for localhost outside production,
 * and private network addresses are rejected so merchants cannot point webhooks at internal services.
 */
function isSafeOutboundUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch (err) {
    return false;
  }
  const isProduction = process.env.NODE_ENV === 'production';
  if (url.protocol === 'https:') return !PRIVATE_HOST_PATTERN.test(url.hostname);
  return url.protocol === 'http:' && !isProduction && url.hostname === 'localhost';
}

module.exports = {
  parseAmount,
  parseString,
  isEmail,
  isVpa,
  isFamPayVpa,
  isHexColor,
  isOrderId,
  isPaymentReference,
  isValidRedirectUrl,
  isSafeOutboundUrl
};
