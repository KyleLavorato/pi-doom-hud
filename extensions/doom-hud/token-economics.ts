export interface TokenUsageCounts {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
}

/** Total prompt tokens, including uncached input and cache read/write tokens. */
export function promptTokenCount(input: number, cacheRead: number, cacheWrite: number): number {
    return input + cacheRead + cacheWrite;
}

/** Match Pi's session totals by summing its four disjoint token categories. */
export function billedTokenCount(usage: TokenUsageCounts): number {
    const safe = (value: number | undefined): number =>
        typeof value === "number" && Number.isFinite(value) ? value : 0;
    return safe(usage.input) + safe(usage.output) + safe(usage.cacheRead) + safe(usage.cacheWrite);
}

/** Effective USD rate per million provider-reported billed tokens. */
export function blendedCostPerMillion(costUsd: number, totalTokens: number): number {
    return totalTokens > 0 ? (costUsd / totalTokens) * 1_000_000 : 0;
}

/**
 * A cost-only reading, such as OTHER or CARRY, padded so its dollars land in the
 * same column as the bucket rows above it. Those put a token count in the first
 * column; without this padding a cost-only row sits a column to the left of every
 * amount beside it, which is the misalignment the bar promises not to have.
 */
export function costColumnValue(tokenColumnWidth: number, amountUsd: number): string {
    return `${' '.repeat(Math.max(0, tokenColumnWidth) + 1)}$${amountUsd.toFixed(3)}`;
}
