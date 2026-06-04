const PRICE_SCALE = 1_000_000;
const SHARE_SCALE = 1_000_000;
const STORED_MATRIX_SCALE = 1_000;
const DEFAULT_SHARES = 100;
export const HOLD_EXPIRY = "HOLD_EXPIRY";
const EPSILON = 1e-9;
const STORED_MATRIX_KEYS = ["buyShares", "pnl", "sellShares"];
const COMPACT_MATRIX_KEYS = {
  buyShares: "b",
  pnl: "p",
  sellShares: "s",
};

export const BACKTEST_INTERVAL_MINUTES = {
  "1h": 60,
  "15m": 15,
  "5m": 5,
};

export const BUY_PRICE_MICROS = Array.from({ length: 99 }, (_, index) => (index + 1) * 10_000);
export const SELL_PRICE_MICROS = [...BUY_PRICE_MICROS, HOLD_EXPIRY];
export const BUY_PRICE_LABELS = BUY_PRICE_MICROS.map(formatPriceMicros);
export const SELL_PRICE_LABELS = [
  ...BUY_PRICE_MICROS.map(formatPriceMicros),
  HOLD_EXPIRY,
];

export function formatPriceMicros(value) {
  return (Number(value) / PRICE_SCALE).toFixed(2);
}

export function priceToMicros(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number * PRICE_SCALE);
}

export function sharesToMicros(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number * SHARE_SCALE);
}

export function normalizePerspective(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["yes", "y", "up", "long"].includes(normalized)) return "yes";
  if (["no", "n", "down", "short"].includes(normalized)) return "no";
  return normalized;
}

export function normalizeQuoteType(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "ask" || normalized === "sell") return "ask";
  if (normalized === "bid" || normalized === "buy") return "bid";
  return normalized;
}

export function normalizeBacktestMatch(match = {}) {
  const executedAt = match.executed_at || match.executedAt || null;
  const priceMicros = Number(match.price_micros ?? match.priceMicros ?? priceToMicros(match.price));
  const sharesMicros = Number(match.shares_micros ?? match.sharesMicros ?? sharesToMicros(match.shares));
  return {
    dedupeHash: match.dedupe_hash || match.dedupeHash || null,
    elapsedSeconds: Number(match.elapsed_seconds ?? match.elapsedSeconds ?? 0),
    executedAt,
    outcome: normalizePerspective(match.outcome),
    priceMicros: Number.isFinite(priceMicros) ? priceMicros : 0,
    quoteType: normalizeQuoteType(match.quote_type ?? match.quoteType),
    shares: Number.isFinite(sharesMicros) ? sharesMicros / SHARE_SCALE : 0,
  };
}

export function normalizeBacktestMarket(market = {}) {
  return {
    endsAt: market.ends_at || market.endsAt || null,
    interval: market.interval || null,
    marketId: String(market.market_id ?? market.marketId ?? market.id ?? ""),
    slug: market.slug || "",
    startsAt: market.starts_at || market.startsAt || null,
    winner: normalizePerspective(market.winner),
  };
}

export function normalizedCutoffMinutes(cutoffMinutes, interval) {
  const requested = Math.max(1, Math.floor(Number(cutoffMinutes) || 1));
  const maxMinutes = BACKTEST_INTERVAL_MINUTES[interval] || requested;
  return Math.min(requested, maxMinutes);
}

function byExecutionTime(left, right) {
  const leftMs = Date.parse(left.executedAt || "");
  const rightMs = Date.parse(right.executedAt || "");
  const safeLeft = Number.isFinite(leftMs) ? leftMs : 0;
  const safeRight = Number.isFinite(rightMs) ? rightMs : 0;
  return safeLeft - safeRight;
}

function emptyArray() {
  return Array(BUY_PRICE_MICROS.length * SELL_PRICE_MICROS.length).fill(0);
}

export function createEmptyBacktestMatrix() {
  return {
    buyShares: emptyArray(),
    pnl: emptyArray(),
    sellShares: emptyArray(),
  };
}

function addCell(matrix, index, result) {
  matrix.buyShares[index] += result.buyShares;
  matrix.pnl[index] += result.pnl;
  matrix.sellShares[index] += result.sellShares;
}

function normalizeMatchesForPerspective(matches, perspective) {
  const normalizedPerspectiveValue = normalizePerspective(perspective);
  return matches
    .map(normalizeBacktestMatch)
    .filter((match) => match.outcome === normalizedPerspectiveValue && match.shares > EPSILON)
    .sort(byExecutionTime);
}

export function addBacktestMatrices(target, source) {
  for (const key of STORED_MATRIX_KEYS) {
    const targetValues = target[key];
    const sourceValues = source?.[key] || [];
    for (let index = 0; index < targetValues.length; index += 1) {
      targetValues[index] += Number(sourceValues[index] || 0);
    }
  }
  return target;
}

function roundMatrix(matrix) {
  for (const key of STORED_MATRIX_KEYS) {
    matrix[key] = matrix[key].map((value) => Number(value.toFixed(6)));
  }
  return matrix;
}

function simulateBacktestCellWithNormalizedMatches({
  buyPriceMicros,
  cutoffMinutes,
  interval,
  market,
  normalizedMatches = [],
  perspective,
  sellPriceMicros,
  sharesPerMarket = DEFAULT_SHARES,
} = {}) {
  const normalizedMarket = normalizeBacktestMarket(market);
  const cutoffSeconds = normalizedCutoffMinutes(cutoffMinutes, interval || normalizedMarket.interval) * 60;
  const normalizedPerspectiveValue = normalizePerspective(perspective);

  let buyRemaining = sharesPerMarket;
  let inventory = 0;
  let buyShares = 0;
  let sellShares = 0;
  let cost = 0;
  let sellProceeds = 0;

  for (const match of normalizedMatches) {
    if (
      buyRemaining > EPSILON &&
      match.quoteType === "ask" &&
      match.elapsedSeconds >= 0 &&
      match.elapsedSeconds < cutoffSeconds &&
      match.priceMicros <= buyPriceMicros
    ) {
      const filled = Math.min(buyRemaining, match.shares);
      buyRemaining -= filled;
      inventory += filled;
      buyShares += filled;
      cost += filled * (buyPriceMicros / PRICE_SCALE);
    }

    if (
      sellPriceMicros !== HOLD_EXPIRY &&
      inventory > EPSILON &&
      match.quoteType === "bid" &&
      match.priceMicros >= sellPriceMicros
    ) {
      const filled = Math.min(inventory, match.shares);
      inventory -= filled;
      sellShares += filled;
      sellProceeds += filled * (sellPriceMicros / PRICE_SCALE);
    }
  }

  const settlementShares = normalizedMarket.winner === normalizedPerspectiveValue ? inventory : 0;
  const settlementPayout = settlementShares;
  const payout = sellProceeds + settlementPayout;

  return {
    buyShares,
    cost,
    payout,
    pnl: payout - cost,
    sellShares,
    settlementShares,
  };
}

export function simulateBacktestCell({
  buyPriceMicros,
  cutoffMinutes,
  interval,
  market,
  matches = [],
  perspective,
  sellPriceMicros,
  sharesPerMarket = DEFAULT_SHARES,
} = {}) {
  return simulateBacktestCellWithNormalizedMatches({
    buyPriceMicros,
    cutoffMinutes,
    interval,
    market,
    normalizedMatches: normalizeMatchesForPerspective(matches, perspective),
    perspective,
    sellPriceMicros,
    sharesPerMarket,
  });
}

export function buildBacktestMatrix({
  cutoffMinutes = 1,
  interval,
  markets = [],
  perspective,
  sharesPerMarket = DEFAULT_SHARES,
} = {}) {
  const matrix = createEmptyBacktestMatrix();

  for (const row of markets) {
    const market = normalizeBacktestMarket(row.market || row);
    const matches = row.matches || [];
    const effectiveInterval = interval || market.interval;
    const normalizedMatches = normalizeMatchesForPerspective(matches, perspective);

    for (let sellIndex = 0; sellIndex < SELL_PRICE_MICROS.length; sellIndex += 1) {
      const sellPriceMicros = SELL_PRICE_MICROS[sellIndex];
      for (let buyIndex = 0; buyIndex < BUY_PRICE_MICROS.length; buyIndex += 1) {
        const buyPriceMicros = BUY_PRICE_MICROS[buyIndex];
        const cellIndex = sellIndex * BUY_PRICE_MICROS.length + buyIndex;
        addCell(matrix, cellIndex, simulateBacktestCellWithNormalizedMatches({
          buyPriceMicros,
          cutoffMinutes,
          interval: effectiveInterval,
          market,
          normalizedMatches,
          perspective,
          sellPriceMicros,
          sharesPerMarket,
        }));
      }
    }
  }

  return roundMatrix(matrix);
}

export function serializeBacktestMatrix(matrix) {
  const scale = STORED_MATRIX_SCALE;
  const compactArray = (values) => {
    const source = values || [];
    return Array.from({ length: BUY_PRICE_MICROS.length * SELL_PRICE_MICROS.length }, (_, index) => {
      const value = Number(source[index] || 0);
      return Number.isFinite(value) ? Math.round(value * scale) : 0;
    });
  };
  return JSON.stringify({
    m: {
      b: compactArray(matrix?.buyShares),
      p: compactArray(matrix?.pnl),
      s: compactArray(matrix?.sellShares),
    },
    scale,
    version: 2,
  });
}

function normalizeMatrixFields(fields) {
  if (!Array.isArray(fields) || !fields.length) return STORED_MATRIX_KEYS;
  const requested = fields.filter((field) => STORED_MATRIX_KEYS.includes(field));
  return requested.length ? requested : STORED_MATRIX_KEYS;
}

function extractJsonArrayProperty(text, property) {
  const needle = `"${property}":[`;
  const start = text.indexOf(needle);
  if (start < 0) return null;
  const arrayStart = start + needle.length - 1;
  let depth = 0;
  for (let index = arrayStart; index < text.length; index += 1) {
    const char = text[index];
    if (char === "[") depth += 1;
    if (char === "]") {
      depth -= 1;
      if (depth === 0) return text.slice(arrayStart, index + 1);
    }
  }
  return null;
}

function parseCompactScale(text) {
  const match = /"scale":([0-9.]+)/.exec(text);
  const scale = match ? Number(match[1]) : STORED_MATRIX_SCALE;
  return Number.isFinite(scale) && scale > 0 ? scale : STORED_MATRIX_SCALE;
}

function expandStoredArray(values, scale) {
  const source = Array.isArray(values) ? values : [];
  return Array.from({ length: BUY_PRICE_MICROS.length * SELL_PRICE_MICROS.length }, (_, index) => {
    const number = Number(source[index] || 0);
    return Number.isFinite(number) ? number / scale : 0;
  });
}

function parseCompactMatrixPayloadFields(text, fields) {
  if (!text.includes('"version":2') || !text.includes('"m"')) return null;
  const scale = parseCompactScale(text);
  const result = {};
  for (const field of fields) {
    const property = COMPACT_MATRIX_KEYS[field];
    const arrayText = property ? extractJsonArrayProperty(text, property) : null;
    if (!arrayText) return null;
    result[field] = expandStoredArray(JSON.parse(arrayText), scale);
  }
  return result;
}

export function parseBacktestMatrixPayload(value, options = {}) {
  const fields = normalizeMatrixFields(options.fields);
  if (typeof value === "string" && fields.length < STORED_MATRIX_KEYS.length) {
    const compact = parseCompactMatrixPayloadFields(value, fields);
    if (compact) return compact;
  }

  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (parsed?.version === 2 && parsed?.m) {
    const scale = Number(parsed.scale || STORED_MATRIX_SCALE);
    const result = {};
    for (const field of fields) {
      result[field] = expandStoredArray(parsed.m[COMPACT_MATRIX_KEYS[field]], scale);
    }
    return result;
  }
  const matrix = parsed?.matrix || parsed || {};
  const result = {};
  for (const field of fields) {
    result[field] = matrix[field] || emptyArray();
  }
  return result;
}

export function summarizeBacktestMatrix(matrix) {
  const pnl = matrix?.pnl || [];
  return {
    bestPnl: pnl.length ? Math.max(...pnl) : 0,
    cells: pnl.length,
    worstPnl: pnl.length ? Math.min(...pnl) : 0,
  };
}
