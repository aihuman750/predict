const WEI_DECIMALS = 18;
const EPSILON = 1e-12;

function round(value, decimals = 6) {
  return Number(Number(value || 0).toFixed(decimals));
}

export function weiToNumber(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return 0;
  if (!/^\d+$/.test(raw)) {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  const padded = raw.padStart(WEI_DECIMALS + 1, "0");
  const whole = padded.slice(0, -WEI_DECIMALS) || "0";
  const fraction = padded.slice(-WEI_DECIMALS).replace(/0+$/g, "");
  const parsed = Number(fraction ? `${whole}.${fraction}` : whole);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizedOutcomeName(value) {
  return String(value || "").trim().toLowerCase();
}

function primaryMarket(category = {}) {
  return Array.isArray(category.markets) ? category.markets[0] : category.market;
}

function marketOutcomes(category = {}) {
  const market = primaryMarket(category);
  const outcomes = Array.isArray(market?.outcomes) ? market.outcomes : [];
  const names = outcomes.map((outcome) => outcome?.name).filter(Boolean);
  return names.length > 0 ? names : ["Up", "Down"];
}

function winningOutcome(category = {}) {
  const market = primaryMarket(category);
  if (market?.resolution?.status === "WON" && market.resolution.name) {
    return market.resolution.name;
  }
  const won = (Array.isArray(market?.outcomes) ? market.outcomes : [])
    .find((outcome) => outcome?.status === "WON");
  return won?.name || null;
}

function matchOutcomeName(match = {}) {
  return match.taker?.outcome?.name
    ?? match.makers?.find((maker) => maker?.outcome?.name)?.outcome?.name
    ?? null;
}

function inBuyWindow(match, startMs, windowMs) {
  const executedAtMs = Date.parse(match?.executedAt);
  return Number.isFinite(executedAtMs)
    && executedAtMs >= startMs
    && executedAtMs < startMs + windowMs;
}

function matchExecutedAtMs(match = {}) {
  const executedAtMs = Date.parse(match.executedAt);
  return Number.isFinite(executedAtMs) ? executedAtMs : null;
}

function isPassiveBuyCandidate(match, { buyPrice, startMs, windowMs }) {
  if (!inBuyWindow(match, startMs, windowMs)) return false;
  if (String(match?.taker?.quoteType || "").toLowerCase() !== "ask") return false;
  return weiToNumber(match?.priceExecuted) <= buyPrice + EPSILON;
}

function isPassiveSellCandidate(match, { sellPrice }) {
  if (String(match?.taker?.quoteType || "").toLowerCase() !== "bid") return false;
  return weiToNumber(match?.priceExecuted) >= sellPrice - EPSILON;
}

function sortMatchesByExecution(matches = []) {
  return matches
    .map((match, index) => ({ index, match, executedAtMs: matchExecutedAtMs(match) }))
    .filter((row) => row.executedAtMs != null)
    .sort((a, b) => a.executedAtMs - b.executedAtMs || a.index - b.index)
    .map((row) => row.match);
}

export function simulateMarketStrategy({
  buyPrice = 0.01,
  buyWindowMinutes = 10,
  market = {},
  matches = [],
  sharesPerOutcome = 101,
} = {}) {
  const marketRecord = primaryMarket(market);
  const startMs = Date.parse(market.startsAt);
  const windowMs = buyWindowMinutes * 60 * 1000;
  const winner = winningOutcome(market);
  const outcomes = marketOutcomes(market);
  const candidateVolumeByOutcome = Object.fromEntries(outcomes.map((outcome) => [outcome, 0]));
  let candidateEvents = 0;

  for (const match of matches) {
    if (!isPassiveBuyCandidate(match, { buyPrice, startMs, windowMs })) continue;
    const outcome = outcomes.find((name) => normalizedOutcomeName(name) === normalizedOutcomeName(matchOutcomeName(match)));
    if (!outcome) continue;
    candidateEvents += 1;
    candidateVolumeByOutcome[outcome] += weiToNumber(match.amountFilled);
  }

  const fills = outcomes
    .map((outcome) => {
      const candidateShares = candidateVolumeByOutcome[outcome] || 0;
      const shares = Math.min(sharesPerOutcome, candidateShares);
      if (shares <= EPSILON) return null;
      const won = normalizedOutcomeName(outcome) === normalizedOutcomeName(winner);
      return {
        candidateShares: round(candidateShares),
        cost: round(shares * buyPrice),
        outcome,
        payout: round(won ? shares : 0),
        pnl: round((won ? shares : 0) - shares * buyPrice),
        shares: round(shares),
        won,
      };
    })
    .filter(Boolean);

  const filledShares = fills.reduce((sum, fill) => sum + fill.shares, 0);
  const winShares = fills.filter((fill) => fill.won).reduce((sum, fill) => sum + fill.shares, 0);
  const lossShares = filledShares - winShares;
  const cost = fills.reduce((sum, fill) => sum + fill.cost, 0);
  const payout = fills.reduce((sum, fill) => sum + fill.payout, 0);
  const pnl = payout - cost;

  return {
    attemptedOrders: outcomes.length,
    candidateEvents,
    candidateFillVolume: round(Object.values(candidateVolumeByOutcome).reduce((sum, value) => sum + value, 0)),
    cost: round(cost),
    endsAt: market.endsAt || null,
    filledOrders: fills.length,
    filledShares: round(filledShares),
    fills,
    lossShares: round(lossShares),
    marketId: marketRecord?.id ?? market.id ?? null,
    payout: round(payout),
    pnl: round(pnl),
    slug: market.slug || null,
    startsAt: market.startsAt || null,
    title: market.title || marketRecord?.title || "",
    winShares: round(winShares),
    winningOutcome: winner,
  };
}

export function buildBacktestSummary(results = []) {
  const totals = {
    attemptedOrders: 0,
    candidateFillVolume: 0,
    cost: 0,
    filledMarkets: 0,
    filledOrders: 0,
    filledShares: 0,
    lossShares: 0,
    marketCount: results.length,
    payout: 0,
    pnl: 0,
    winShares: 0,
  };

  for (const result of results) {
    totals.attemptedOrders += result.attemptedOrders || 0;
    totals.candidateFillVolume += result.candidateFillVolume || 0;
    totals.cost += result.cost || 0;
    totals.filledOrders += result.filledOrders || 0;
    totals.filledShares += result.filledShares || 0;
    totals.lossShares += result.lossShares || 0;
    totals.payout += result.payout || 0;
    totals.pnl += result.pnl || 0;
    totals.winShares += result.winShares || 0;
    if ((result.filledOrders || 0) > 0) totals.filledMarkets += 1;
  }

  const winRateByFilledOrderPct = totals.filledOrders > 0
    ? (totals.winShares / totals.filledShares) * 100
    : 0;
  const roiPct = totals.cost > 0 ? (totals.pnl / totals.cost) * 100 : 0;

  return {
    attemptedOrders: totals.attemptedOrders,
    candidateFillVolume: round(totals.candidateFillVolume),
    cost: round(totals.cost),
    filledMarkets: totals.filledMarkets,
    filledOrders: totals.filledOrders,
    filledShares: round(totals.filledShares),
    lossShares: round(totals.lossShares),
    marketCount: totals.marketCount,
    payout: round(totals.payout),
    pnl: round(totals.pnl),
    roiPct: round(roiPct, 2),
    winRateByFilledOrderPct: round(winRateByFilledOrderPct, 2),
    winShares: round(totals.winShares),
  };
}

export function simulateMarketRoundTripStrategy({
  buyPrice = 0.05,
  buyWindowMinutes = 5,
  market = {},
  matches = [],
  sellPrice = 0.1,
  sharesPerOutcome = 101,
} = {}) {
  const marketRecord = primaryMarket(market);
  const startMs = Date.parse(market.startsAt);
  const windowMs = buyWindowMinutes * 60 * 1000;
  const winner = winningOutcome(market);
  const outcomes = marketOutcomes(market);
  const stateByOutcome = Object.fromEntries(outcomes.map((outcome) => [outcome, {
    boughtShares: 0,
    buyCandidateShares: 0,
    buyEvents: [],
    buyRemaining: sharesPerOutcome,
    inventoryShares: 0,
    sellCandidateShares: 0,
    sellEvents: [],
    soldShares: 0,
  }]));

  for (const match of sortMatchesByExecution(matches)) {
    const outcome = outcomes.find((name) => normalizedOutcomeName(name) === normalizedOutcomeName(matchOutcomeName(match)));
    if (!outcome) continue;
    const amount = weiToNumber(match.amountFilled);
    if (amount <= EPSILON) continue;
    const state = stateByOutcome[outcome];

    if (isPassiveBuyCandidate(match, { buyPrice, startMs, windowMs })) {
      state.buyCandidateShares += amount;
      const shares = Math.min(state.buyRemaining, amount);
      if (shares > EPSILON) {
        state.buyRemaining -= shares;
        state.boughtShares += shares;
        state.inventoryShares += shares;
        state.buyEvents.push({
          executedAt: match.executedAt,
          price: round(weiToNumber(match.priceExecuted)),
          shares: round(shares),
        });
      }
    }

    if (state.inventoryShares > EPSILON && isPassiveSellCandidate(match, { sellPrice })) {
      state.sellCandidateShares += amount;
      const shares = Math.min(state.inventoryShares, amount);
      if (shares > EPSILON) {
        state.inventoryShares -= shares;
        state.soldShares += shares;
        state.sellEvents.push({
          executedAt: match.executedAt,
          price: round(weiToNumber(match.priceExecuted)),
          shares: round(shares),
        });
      }
    }
  }

  const fills = outcomes
    .map((outcome) => {
      const state = stateByOutcome[outcome];
      if (state.boughtShares <= EPSILON) return null;
      const unsoldSharesForOutcome = Math.max(0, state.boughtShares - state.soldShares);
      const won = normalizedOutcomeName(outcome) === normalizedOutcomeName(winner);
      const sellProceedsForOutcome = state.soldShares * sellPrice;
      const settlementPayoutForOutcome = won ? unsoldSharesForOutcome : 0;
      const costForOutcome = state.boughtShares * buyPrice;
      return {
        boughtShares: round(state.boughtShares),
        buyCandidateShares: round(state.buyCandidateShares),
        buyEvents: state.buyEvents,
        cost: round(costForOutcome),
        outcome,
        payout: round(sellProceedsForOutcome + settlementPayoutForOutcome),
        pnl: round(sellProceedsForOutcome + settlementPayoutForOutcome - costForOutcome),
        sellCandidateShares: round(state.sellCandidateShares),
        sellEvents: state.sellEvents,
        sellProceeds: round(sellProceedsForOutcome),
        settlementPayout: round(settlementPayoutForOutcome),
        soldShares: round(state.soldShares),
        unsoldShares: round(unsoldSharesForOutcome),
        won,
      };
    })
    .filter(Boolean);

  const boughtShares = fills.reduce((sum, fill) => sum + fill.boughtShares, 0);
  const cost = fills.reduce((sum, fill) => sum + fill.cost, 0);
  const soldShares = fills.reduce((sum, fill) => sum + fill.soldShares, 0);
  const unsoldShares = fills.reduce((sum, fill) => sum + fill.unsoldShares, 0);
  const sellProceeds = fills.reduce((sum, fill) => sum + fill.sellProceeds, 0);
  const settlementPayout = fills.reduce((sum, fill) => sum + fill.settlementPayout, 0);
  const payout = sellProceeds + settlementPayout;
  const pnl = payout - cost;

  return {
    attemptedOrders: outcomes.length,
    boughtShares: round(boughtShares),
    buyCandidateFillVolume: round(Object.values(stateByOutcome).reduce((sum, state) => sum + state.buyCandidateShares, 0)),
    cost: round(cost),
    endsAt: market.endsAt || null,
    filledOrders: fills.length,
    fills,
    marketId: marketRecord?.id ?? market.id ?? null,
    payout: round(payout),
    pnl: round(pnl),
    sellCandidateFillVolume: round(Object.values(stateByOutcome).reduce((sum, state) => sum + state.sellCandidateShares, 0)),
    sellProceeds: round(sellProceeds),
    settlementPayout: round(settlementPayout),
    slug: market.slug || null,
    soldShares: round(soldShares),
    startsAt: market.startsAt || null,
    title: market.title || marketRecord?.title || "",
    unsoldShares: round(unsoldShares),
    winningOutcome: winner,
  };
}

export function buildRoundTripBacktestSummary(results = []) {
  const totals = {
    attemptedOrders: 0,
    boughtShares: 0,
    buyCandidateFillVolume: 0,
    cost: 0,
    filledMarkets: 0,
    filledOrders: 0,
    marketCount: results.length,
    payout: 0,
    pnl: 0,
    sellCandidateFillVolume: 0,
    sellFilledMarkets: 0,
    sellProceeds: 0,
    soldShares: 0,
    settlementPayout: 0,
    unsoldShares: 0,
  };

  for (const result of results) {
    totals.attemptedOrders += result.attemptedOrders || 0;
    totals.boughtShares += result.boughtShares || 0;
    totals.buyCandidateFillVolume += result.buyCandidateFillVolume || 0;
    totals.cost += result.cost || 0;
    totals.filledOrders += result.filledOrders || 0;
    totals.payout += result.payout || 0;
    totals.pnl += result.pnl || 0;
    totals.sellCandidateFillVolume += result.sellCandidateFillVolume || 0;
    totals.sellProceeds += result.sellProceeds || 0;
    totals.soldShares += result.soldShares || 0;
    totals.settlementPayout += result.settlementPayout || 0;
    totals.unsoldShares += result.unsoldShares || 0;
    if ((result.filledOrders || 0) > 0) totals.filledMarkets += 1;
    if ((result.soldShares || 0) > 0) totals.sellFilledMarkets += 1;
  }

  return {
    attemptedOrders: totals.attemptedOrders,
    boughtShares: round(totals.boughtShares),
    buyCandidateFillVolume: round(totals.buyCandidateFillVolume),
    cost: round(totals.cost),
    filledMarkets: totals.filledMarkets,
    filledOrders: totals.filledOrders,
    marketCount: totals.marketCount,
    payout: round(totals.payout),
    pnl: round(totals.pnl),
    roiPct: totals.cost > 0 ? round((totals.pnl / totals.cost) * 100, 2) : 0,
    sellCandidateFillVolume: round(totals.sellCandidateFillVolume),
    sellFilledMarkets: totals.sellFilledMarkets,
    sellProceeds: round(totals.sellProceeds),
    soldShares: round(totals.soldShares),
    settlementPayout: round(totals.settlementPayout),
    unsoldShares: round(totals.unsoldShares),
  };
}

export function compareBacktestPrices({
  buyPrices = [],
  buyWindowMinutes = 10,
  marketRuns = [],
  sharesPerOutcome = 101,
} = {}) {
  return buyPrices.map((buyPrice) => {
    const resultRows = marketRuns.map((run) => ({
      ...simulateMarketStrategy({
        buyPrice,
        buyWindowMinutes,
        market: run.market,
        matches: run.matches,
        sharesPerOutcome,
      }),
      matchPages: run.matchPages,
      matchRows: run.matchRows,
    }));
    return {
      buyPrice,
      resultRows,
      summary: buildBacktestSummary(resultRows),
    };
  });
}
