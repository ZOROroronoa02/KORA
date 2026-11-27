const MAX_DATABASE_INTEGER = 9_223_372_036_854_775_807n;

function roundPositiveRatio(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator;
}

export function purchaseLineTotalPaise(quantityMilli: bigint, unitCostPaise: bigint): bigint {
  if (quantityMilli <= 0n || quantityMilli > MAX_DATABASE_INTEGER) {
    throw new RangeError("Purchase quantity must be a positive supported integer in milli-units.");
  }
  if (unitCostPaise < 0n || unitCostPaise > MAX_DATABASE_INTEGER) {
    throw new RangeError("Unit cost must be a non-negative supported integer in paise.");
  }

  const lineTotalPaise = roundPositiveRatio(quantityMilli * unitCostPaise, 1_000n);
  if (lineTotalPaise > MAX_DATABASE_INTEGER) {
    throw new RangeError("Purchase line total exceeds the supported paise range.");
  }
  return lineTotalPaise;
}

export function purchaseTotalPaise(lines: Array<{ quantityMilli: bigint; unitCostPaise: bigint }>): bigint {
  if (lines.length < 1 || lines.length > 100) throw new RangeError("A receipt must contain 1–100 purchase lines.");
  const total = lines.reduce((sum, line) => sum + purchaseLineTotalPaise(line.quantityMilli, line.unitCostPaise), 0n);
  if (total > MAX_DATABASE_INTEGER) throw new RangeError("Purchase total exceeds the supported paise range.");
  return total;
}

export function movingWeightedAverageUnitCostPaise(input: {
  quantityBeforeMilli: bigint;
  unitCostBeforePaise: bigint;
  quantityReceivedMilli: bigint;
  landedUnitCostPaise: bigint;
}): bigint {
  const { quantityBeforeMilli, unitCostBeforePaise, quantityReceivedMilli, landedUnitCostPaise } = input;
  if (quantityBeforeMilli < -MAX_DATABASE_INTEGER || quantityBeforeMilli > MAX_DATABASE_INTEGER) {
    throw new RangeError("Current stock is outside the supported quantity range.");
  }
  if (unitCostBeforePaise < 0n || unitCostBeforePaise > MAX_DATABASE_INTEGER) {
    throw new RangeError("Current unit cost is outside the supported paise range.");
  }
  if (quantityReceivedMilli <= 0n || quantityReceivedMilli > MAX_DATABASE_INTEGER) {
    throw new RangeError("Received quantity must be a positive supported integer in milli-units.");
  }
  if (landedUnitCostPaise < 0n || landedUnitCostPaise > MAX_DATABASE_INTEGER) {
    throw new RangeError("Landed unit cost is outside the supported paise range.");
  }

  // Negative stock represents an uncosted shortage. A receipt first clears that
  // shortage; only positive on-hand stock contributes to the moving average.
  const valuedQuantityBefore = quantityBeforeMilli > 0n ? quantityBeforeMilli : 0n;
  const totalValuedQuantity = valuedQuantityBefore + quantityReceivedMilli;
  const weightedValue = valuedQuantityBefore * unitCostBeforePaise + quantityReceivedMilli * landedUnitCostPaise;
  return roundPositiveRatio(weightedValue, totalValuedQuantity);
}

export function nextStockQuantity(quantityBeforeMilli: bigint, quantityReceivedMilli: bigint): bigint {
  if (quantityBeforeMilli < -MAX_DATABASE_INTEGER || quantityBeforeMilli > MAX_DATABASE_INTEGER) {
    throw new RangeError("Current stock is outside the supported quantity range.");
  }
  if (quantityReceivedMilli < 0n || quantityReceivedMilli > MAX_DATABASE_INTEGER) {
    throw new RangeError("Received quantity is outside the supported quantity range.");
  }
  const nextQuantity = quantityBeforeMilli + quantityReceivedMilli;
  if (nextQuantity > MAX_DATABASE_INTEGER) throw new RangeError("Resulting stock exceeds the supported quantity range.");
  return nextQuantity;
}
