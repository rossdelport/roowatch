import { ERROR_CODES, ScraperError } from "./errors.js";

const MICROS = 1_000_000n;
const BYTES_PER_GB = 1_000_000_000n;

export function ceilDiv(numerator, denominator) {
  return (numerator + denominator - 1n) / denominator;
}

export function proxyCostForBytes(bytes, rateMicrosPerGb) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new TypeError("bytes must be a non-negative safe integer");
  return ceilDiv(BigInt(bytes) * BigInt(rateMicrosPerGb), BYTES_PER_GB);
}

export function convertUsdMicrosToAud(usdMicros, audMicrosPerUsd) {
  return ceilDiv(BigInt(usdMicros) * BigInt(audMicrosPerUsd), MICROS);
}

export function costForBytes(config, bytes) {
  const trafficMicros = proxyCostForBytes(bytes, config.proxyCostMicrosPerGb);
  const fixedMicros = BigInt(config.proxyFixedMicrosPerCheck || 0);
  const supplierMicros = trafficMicros + fixedMicros;
  const audMicros = config.proxyCostCurrency === "USD"
    ? convertUsdMicrosToAud(supplierMicros, config.audMicrosPerUsd)
    : supplierMicros;

  return {
    supplierMicros,
    trafficMicros,
    fixedMicros,
    supplierCurrency: config.proxyCostCurrency,
    audMicros,
    audRateMicros: config.proxyCostCurrency === "USD" ? BigInt(config.audMicrosPerUsd) : undefined
  };
}

export function estimatedMaxCostAudMicros(config) {
  const proxy = costForBytes(config, config.reservationTransferBytes);
  return proxy.audMicros + BigInt(config.vpsCostAudMicrosPerCheck);
}

export function assertReservation(job, config) {
  const required = estimatedMaxCostAudMicros(config);
  const reserved = BigInt(job.maxCostAudMicros);
  if (reserved < required) {
    throw new ScraperError(
      ERROR_CODES.RESERVATION_TOO_LOW,
      "The server reservation is below the worker cost guard",
      { requiredAudMicros: required.toString(), reservedAudMicros: reserved.toString() }
    );
  }
  return required;
}

export function serialiseCost(config, bytes) {
  const cost = costForBytes(config, bytes);
  return {
    amountMicros: Number(cost.supplierMicros),
    currency: cost.supplierCurrency,
    trafficAmountMicros: Number(cost.trafficMicros),
    fixedAmountMicros: Number(cost.fixedMicros),
    ...(cost.audRateMicros === undefined ? {} : { audRateMicros: Number(cost.audRateMicros) })
  };
}

export function serialiseZeroCost(config) {
  return {
    amountMicros: 0,
    currency: config.proxyCostCurrency,
    trafficAmountMicros: 0,
    fixedAmountMicros: 0,
    ...(config.proxyCostCurrency === "USD" ? { audRateMicros: config.audMicrosPerUsd } : {})
  };
}
