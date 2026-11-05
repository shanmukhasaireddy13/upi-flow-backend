const dns = require('dns').promises;
const net = require('net');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VPA_PATTERN = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z]{2,64}$/;
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const ORDER_ID_PATTERN = /^ord_[A-Za-z0-9_-]{10,64}$/;
const REFERENCE_PATTERN = /^[A-Za-z0-9]{8,24}$/;
const PRIVATE_HOST_PATTERN = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[?::1\]?|169\.254\.)/i;

const AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/;

// Ranges a webhook must never reach once its hostname is resolved.
const BLOCKED_ADDRESSES = new net.BlockList();
[
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]
].forEach(([address, prefix]) => BLOCKED_ADDRESSES.addSubnet(address, prefix, 'ipv4'));
[['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]
  .forEach(([address, prefix]) => BLOCKED_ADDRESSES.addSubnet(address, prefix, 'ipv6'));

const MIN_AMOUNT = 1;
const MAX_METADATA_KEYS = 20;
const MAX_METADATA_BYTES = 4096;
const MAX_AMOUNT = 100000;

/**
 * Returns the amount as a 2-decimal string, or null when it is not a valid INR amount.
 */
function parseAmount(value) {
  // Number() alone also accepts "1e3", "0x10" and arrays like [100], so strings must be plain decimals.
  let number = value;
  if (typeof value === 'string') {
    const cleaned = value.trim().replace(/,/g, '');
    if (!AMOUNT_PATTERN.test(cleaned)) return null;
    number = Number(cleaned);
  }
  if (typeof number !== 'number' || !Number.isFinite(number) || number < MIN_AMOUNT || number > MAX_AMOUNT) return null;
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
    if (parsed.username || parsed.password) return false;
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

/**
 * Resolves the URL's hostname and checks the real addresses. The hostname text alone proves nothing:
 * 127.0.0.1.nip.io and [::ffff:127.0.0.1] both pass a text check and still reach this machine.
 */
async function resolvesToPublicAddress(value) {
  const { hostname } = new URL(value);
  if (process.env.NODE_ENV !== 'production' && hostname === 'localhost') return true;
  const host = hostname.replace(/^\[|\]$/g, '');
  try {
    const addresses = net.isIP(host)
      ? [{ address: host, family: net.isIP(host) }]
      : await dns.lookup(host, { all: true });
    return addresses.length > 0 && addresses.every(({ address, family }) =>
      !BLOCKED_ADDRESSES.check(address, family === 6 ? 'ipv6' : 'ipv4'));
  } catch (err) {
    return false;
  }
}

/**
 * Returns the metadata object, {} when absent, or null when it is not a small JSON object.
 */
function parseMetadata(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  if (Object.keys(value).length > MAX_METADATA_KEYS) return null;
  return Buffer.byteLength(JSON.stringify(value)) <= MAX_METADATA_BYTES ? value : null;
}

module.exports = {
  resolvesToPublicAddress,
  parseMetadata,
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
