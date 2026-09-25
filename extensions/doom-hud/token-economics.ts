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
