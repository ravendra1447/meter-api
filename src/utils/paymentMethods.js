const OPTIONS = {
  upi: 'UPI',
  card: 'Card',
  netbanking: 'Net Banking',
  wallet: 'Wallet',
  cash: 'Cash',
};

const ALLOWED = Object.keys(OPTIONS);
const DEFAULT = ['upi', 'card', 'netbanking', 'wallet'];

function normalize(methods) {
  if (!Array.isArray(methods) || methods.length === 0) return null;
  const filtered = [...new Set(methods.filter((m) => typeof m === 'string' && ALLOWED.includes(m)))];
  return filtered.length ? filtered : null;
}

function resolved(stored) {
  const normalized = normalize(stored);
  if (normalized) return normalized;
  if (typeof stored === 'string') {
    try {
      const parsed = JSON.parse(stored);
      const fromJson = normalize(parsed);
      if (fromJson) return fromJson;
    } catch (_) {}
  }
  return [...DEFAULT];
}

function tenantMayPayWith(stored, method) {
  return resolved(stored).includes(method);
}

function toJson(methods) {
  const normalized = normalize(methods);
  return normalized ? JSON.stringify(normalized) : null;
}

function parseRow(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (_) {
      return null;
    }
  }
  return null;
}

module.exports = {
  OPTIONS,
  ALLOWED,
  DEFAULT,
  normalize,
  resolved,
  tenantMayPayWith,
  toJson,
  parseRow,
};
