const WEI_DECIMALS = 18;

function decimalFromWeiString(raw) {
  const padded = raw.padStart(WEI_DECIMALS + 1, "0");
  const whole = padded.slice(0, -WEI_DECIMALS) || "0";
  const fraction = padded.slice(-WEI_DECIMALS).replace(/0+$/g, "");
  return Number(fraction ? `${whole}.${fraction}` : whole);
}

function parsePositionAmount(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return 0;
  if (/^\d+$/.test(raw) && raw.length >= WEI_DECIMALS - 1) {
    const parsedWei = decimalFromWeiString(raw);
    return Number.isFinite(parsedWei) ? parsedWei : 0;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function redeemableWonPositions(positions = []) {
  return (Array.isArray(positions) ? positions : []).filter((position) => {
    const amount = parsePositionAmount(position?.amount ?? position?.shares);
    return amount > 0
      && String(position?.market?.status || "").toUpperCase() === "RESOLVED"
      && String(position?.market?.tradingStatus || "").toUpperCase() === "CLOSED"
      && String(position?.outcome?.status || "").toUpperCase() === "WON";
  });
}

export async function redeemWonPositions({ adapter, positions = [] } = {}) {
  if (!adapter || typeof adapter.redeemPosition !== "function") return [];
  const results = [];

  for (const position of redeemableWonPositions(positions)) {
    const marketId = position?.market?.id ?? position?.marketId ?? null;
    const outcomeName = position?.outcome?.name ?? position?.outcomeName ?? null;
    try {
      const response = await adapter.redeemPosition(position);
      results.push({ marketId, outcomeName, success: Boolean(response?.success) });
    } catch (error) {
      results.push({
        error: error?.shortMessage || error?.message || String(error),
        marketId,
        outcomeName,
        success: false,
      });
    }
  }

  return results;
}
