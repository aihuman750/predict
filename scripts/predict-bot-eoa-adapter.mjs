const API_BASE = "https://api.predict.fun";
const WEI_DECIMALS = 18;
const WEI = 10n ** BigInt(WEI_DECIMALS);

function requiredEnv(env, names) {
  const missing = names.filter((name) => !String(env[name] || "").trim());
  if (missing.length > 0) throw new Error(`missing_eoa_adapter_env:${missing.join(",")}`);
}

function predictUrl(apiBase, pathname) {
  return new URL(pathname, apiBase);
}

function serializeJson(value) {
  return JSON.stringify(value, (_key, item) => (
    typeof item === "bigint" ? item.toString() : item
  ));
}

async function readPredictJson(response, failurePrefix) {
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(formatPredictError(failurePrefix, response.status, payload));
  if (payload?.success === false) {
    throw new Error(formatPredictError(failurePrefix, payload?.data?.code ?? payload?.code ?? "api_failed", payload));
  }
  return payload;
}

function firstSafeString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function formatPredictError(prefix, statusOrCode, payload) {
  const code = firstSafeString(payload?.data?.code, payload?.code);
  const message = firstSafeString(payload?.data?.message, payload?.message, payload?.error);
  const parts = [`${prefix}:${statusOrCode}`];
  if (code && code !== String(statusOrCode)) parts.push(code);
  if (message && message !== code) parts.push(message);
  return parts.join(":");
}

function authHeaders(config, jwt) {
  return {
    Authorization: `Bearer ${jwt}`,
    "Content-Type": "application/json; charset=utf-8",
    "x-api-key": config.apiKey,
  };
}

export function readEoaAdapterConfig(env = process.env) {
  requiredEnv(env, [
    "PREDICT_BOT_API_KEY",
    "PREDICT_BOT_RPC_URL",
    "PREDICT_BOT_WALLET_PRIVATE_KEY",
  ]);

  return {
    apiBase: env.PREDICT_BOT_API_BASE || API_BASE,
    apiKey: env.PREDICT_BOT_API_KEY,
    jwt: env.PREDICT_BOT_JWT || "",
    rpcUrl: env.PREDICT_BOT_RPC_URL,
    walletPrivateKey: env.PREDICT_BOT_WALLET_PRIVATE_KEY,
  };
}

export function decimalToWei(value) {
  const text = String(value);
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error(`invalid_decimal:${text}`);
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > WEI_DECIMALS) throw new Error(`too_many_decimal_places:${text}`);
  const paddedFraction = fraction.padEnd(WEI_DECIMALS, "0");
  return BigInt(whole) * WEI + BigInt(paddedFraction || "0");
}

function amountToWei(value) {
  const text = String(value ?? "").trim();
  if (!text) return 0n;
  if (/^\d+$/.test(text) && text.length >= WEI_DECIMALS - 1) return BigInt(text);
  return decimalToWei(text);
}

function sideForAction(action, Side) {
  if (action.type === "place_buy") return Side.BUY;
  if (action.type === "place_sell") return Side.SELL;
  throw new Error(`unsupported_order_action:${action.type}`);
}

function assertOrderAction(action) {
  if (!action?.outcomeTokenId) throw new Error("missing_outcome_token_id");
  if (!Number.isFinite(Number(action.price))) throw new Error("missing_order_price");
  if (!Number.isFinite(Number(action.shares))) throw new Error("missing_order_shares");
}

export async function buildSignedLimitOrder({ action, builder, Side }) {
  assertOrderAction(action);
  const side = sideForAction(action, Side);
  const pricePerShareWei = decimalToWei(action.price);
  const quantityWei = decimalToWei(action.shares);
  const amounts = builder.getLimitOrderAmounts({
    pricePerShareWei,
    quantityWei,
    side,
  });
  const order = builder.buildOrder("LIMIT", {
    feeRateBps: BigInt(action.feeRateBps ?? 0),
    makerAmount: amounts.makerAmount,
    side,
    takerAmount: amounts.takerAmount,
    tokenId: action.outcomeTokenId,
  });
  const typedData = builder.buildTypedData(order, {
    isNegRisk: Boolean(action.isNegRisk),
    isYieldBearing: Boolean(action.isYieldBearing),
  });
  const signedOrder = await builder.signTypedDataOrder(typedData);
  const hash = signedOrder.hash ?? builder.buildTypedDataHash(typedData);
  return {
    isMinAmountOut: Boolean(amounts.isMinAmountOut),
    order: { ...signedOrder, hash },
    pricePerShare: String(pricePerShareWei),
    slippageBps: String(amounts.slippageBps ?? 0n),
  };
}

export function buildRedeemPositionsOptions(position = {}) {
  const conditionId = position?.market?.conditionId ?? position?.conditionId;
  const indexSet = Number(position?.outcome?.indexSet ?? position?.indexSet);
  if (!conditionId) throw new Error("missing_redeem_condition_id");
  if (![1, 2].includes(indexSet)) throw new Error("invalid_redeem_index_set");

  const options = {
    conditionId,
    indexSet,
    isNegRisk: Boolean(position?.market?.isNegRisk ?? position?.isNegRisk),
    isYieldBearing: Boolean(position?.market?.isYieldBearing ?? position?.isYieldBearing),
  };
  if (options.isNegRisk) {
    options.amount = amountToWei(position?.amount ?? position?.shares);
  }
  return options;
}

export async function requestEoaJwt(config, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const Wallet = deps.Wallet ?? (await import("ethers")).Wallet;
  if (typeof fetchImpl !== "function") throw new Error("fetch_required");

  const messageResponse = await fetchImpl(predictUrl(config.apiBase, "/v1/auth/message"), {
    headers: { "x-api-key": config.apiKey },
  });
  const messagePayload = await readPredictJson(messageResponse, "predict_auth_message_failed");
  const message = messagePayload?.data?.message;
  if (!message) throw new Error("predict_auth_message_missing");

  const wallet = new Wallet(config.walletPrivateKey);
  const signature = await wallet.signMessage(message);
  const tokenResponse = await fetchImpl(predictUrl(config.apiBase, "/v1/auth"), {
    body: serializeJson({
      message,
      signature,
      signer: wallet.address,
    }),
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "x-api-key": config.apiKey,
    },
    method: "POST",
  });
  const tokenPayload = await readPredictJson(tokenResponse, "predict_auth_token_failed");
  const token = tokenPayload?.data?.token;
  if (!token) throw new Error("predict_auth_token_missing");
  return token;
}

async function fetchConnectedAccount(config, fetchImpl, jwt) {
  const response = await fetchImpl(predictUrl(config.apiBase, "/v1/account"), {
    headers: {
      accept: "application/json",
      Authorization: `Bearer ${jwt}`,
      "x-api-key": config.apiKey,
    },
  });
  const payload = await readPredictJson(response, "predict_account_failed");
  return payload?.data ?? payload;
}

async function fetchOrdersByStatus(config, fetchImpl, jwt, status, maxPages = 5) {
  const orders = [];
  let cursor = null;

  for (let page = 0; page < maxPages; page += 1) {
    const url = predictUrl(config.apiBase, "/v1/orders");
    url.searchParams.set("first", "100");
    url.searchParams.set("status", status);
    if (cursor) url.searchParams.set("after", cursor);
    const response = await fetchImpl(url, {
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${jwt}`,
        "x-api-key": config.apiKey,
      },
    });
    const payload = await readPredictJson(response, "predict_orders_failed");
    const rows = Array.isArray(payload) ? payload : payload?.data ?? [];
    orders.push(...rows);
    cursor = payload?.cursor || null;
    if (!cursor || rows.length === 0) break;
  }

  return orders;
}

async function fetchOpenOrders(config, fetchImpl, jwt) {
  return fetchOrdersByStatus(config, fetchImpl, jwt, "OPEN", 5);
}

async function fetchFilledOrders(config, fetchImpl, jwt) {
  return fetchOrdersByStatus(config, fetchImpl, jwt, "FILLED", 10);
}

async function fetchPositions(config, fetchImpl, accountAddress) {
  if (!accountAddress) return [];
  const response = await fetchImpl(predictUrl(config.apiBase, `/v1/positions/${encodeURIComponent(accountAddress)}`), {
    headers: {
      accept: "application/json",
      "x-api-key": config.apiKey,
    },
  });
  const payload = await readPredictJson(response, "predict_positions_failed");
  return Array.isArray(payload) ? payload : payload?.data ?? [];
}

export async function fetchEoaAccountSnapshot(config, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const getJwt = deps.getJwt ?? (() => (
    config.jwt ? Promise.resolve(config.jwt) : requestEoaJwt(config, { fetch: fetchImpl })
  ));
  if (typeof fetchImpl !== "function") throw new Error("fetch_required");

  const jwt = await getJwt();
  const account = await fetchConnectedAccount(config, fetchImpl, jwt);
  const accountAddress = account?.address ? String(account.address) : "";
  const [filledOrders, openOrders, positions] = await Promise.all([
    fetchFilledOrders(config, fetchImpl, jwt),
    fetchOpenOrders(config, fetchImpl, jwt),
    fetchPositions(config, fetchImpl, accountAddress),
  ]);
  return { accountAddress, filledOrders, openOrders, positions };
}

export async function makeDefaultBuilderContext(config) {
  const [
    { JsonRpcProvider, Wallet },
    { ChainId, OrderBuilder, Side },
  ] = await Promise.all([
    import("ethers"),
    import("@predictdotfun/sdk"),
  ]);
  const provider = new JsonRpcProvider(config.rpcUrl);
  const signer = new Wallet(config.walletPrivateKey).connect(provider);
  const builder = await OrderBuilder.make(ChainId.BnbMainnet, signer);
  return { builder, Side };
}

export function createEoaLiveAdapter(config = readEoaAdapterConfig(), deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const getBuilderContext = deps.getBuilderContext ?? (() => makeDefaultBuilderContext(config));
  const getJwt = deps.getJwt ?? (() => (
    config.jwt ? Promise.resolve(config.jwt) : requestEoaJwt(config, { fetch: fetchImpl })
  ));
  let builderContextPromise;
  let jwtPromise;

  if (typeof fetchImpl !== "function") throw new Error("fetch_required");

  async function builderContext() {
    builderContextPromise ??= Promise.resolve(getBuilderContext());
    return builderContextPromise;
  }

  async function jwt() {
    jwtPromise ??= Promise.resolve(getJwt());
    return jwtPromise;
  }

  return {
    async loadAccountSnapshot() {
      return fetchEoaAccountSnapshot(config, { fetch: fetchImpl, getJwt: jwt });
    },

    async placeOrder(action) {
      const [{ builder, Side }, token] = await Promise.all([builderContext(), jwt()]);
      const signed = await buildSignedLimitOrder({ action, builder, Side });
      const response = await fetchImpl(predictUrl(config.apiBase, "/v1/orders"), {
        body: serializeJson({
          data: {
            isMinAmountOut: signed.isMinAmountOut,
            isPostOnly: true,
            order: signed.order,
            pricePerShare: signed.pricePerShare,
            selfTradePrevention: "CANCEL_MAKER",
            slippageBps: signed.slippageBps,
            strategy: "LIMIT",
          },
        }),
        headers: authHeaders(config, token),
        method: "POST",
      });
      const payload = await readPredictJson(response, "predict_create_order_failed");
      return payload?.data ?? payload;
    },

    async cancelOrder(action) {
      if (!action?.orderId) throw new Error("missing_order_id");
      const token = await jwt();
      const response = await fetchImpl(predictUrl(config.apiBase, "/v1/orders/remove"), {
        body: serializeJson({ data: { ids: [action.orderId] } }),
        headers: authHeaders(config, token),
        method: "POST",
      });
      const payload = await readPredictJson(response, "predict_remove_order_failed");
      return payload?.data ?? payload;
    },

    async redeemPosition(position) {
      const { builder } = await builderContext();
      return builder.redeemPositions(buildRedeemPositionsOptions(position));
    },
  };
}
