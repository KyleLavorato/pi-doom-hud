/**
 * Cost carry-over: a session's accumulated usage, written into a markdown
 * document so another session can resume the HUD's cost stats from it.
 *
 * The contract is deliberately small and public, because this ships in the npm
 * package and anything driving it (a handoff skill, a script, a human) has to be
 * able to reason about it from the README alone:
 *
 *   1. A document opts in by containing the marker line CARRY_MARKER.
 *   2. When the HUD sees that document written or edited, it keeps the marker
 *      and puts one fenced CARRY_FENCE block directly under it, replacing any
 *      block already there. Stamping is idempotent: same totals in, same bytes
 *      out, so a re-write never duplicates the block.
 *   3. When another session reads a document containing a CARRY_FENCE block, the
 *      HUD adopts those totals unless a guard says otherwise (see
 *      adoptDecision).
 *
 * Everything here is pure: strings and plain objects in, strings and plain
 * objects out. No pi imports, no filesystem, so the checks can drive it directly.
 */

/** Marker line that opts a document in. Kept in the document after stamping. */
export const CARRY_MARKER = "<!-- doom-hud:carry -->";
/** Info-string tag that identifies the fenced block. */
export const CARRY_FENCE = "doom-hud-carry";
/** Custom session entry type the adopted totals are persisted as. */
export const CARRY_CUSTOM_TYPE = "doom-hud:carry";
/** Format version. A block with any other version is rejected, not guessed at. */
export const CARRY_VERSION = 1;

/** Per-bucket spend in USD, mirroring pi's usage cost fields. */
export interface CarryCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Includes subagent spend, so this can exceed the four buckets above. */
	total: number;
}

/** The four disjoint token buckets plus their spend. */
export interface CarryUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: CarryCost;
}

/** What the fenced block holds. */
export interface CarryPayload {
	v: number;
	/** ISO timestamp of the session that produced the block. */
	capturedAt: string;
	/** Session id of the producer, used to stop a session adopting its own block. */
	sessionId: string;
	/** provider/model of the producing session, informational only. */
	model?: string;
	usage: CarryUsage;
}

/** What the custom session entry holds: the block plus where it came from. */
export interface CarryEntryData extends CarryPayload {
	adoptedFrom?: string;
	adoptedAt?: string;
}

/** An all-zero usage, used as the tombstone that `/doomhud carry clear` appends. */
export function zeroUsage(): CarryUsage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function count(value: unknown): number {
	return finite(value) ?? 0;
}

/**
 * Coerce anything shaped roughly like a usage object into a CarryUsage, or null
 * when it cannot be read at all. Lenient on missing buckets (older or hand-edited
 * blocks count as zero) and strict on the container shape.
 */
export function normalizeCarryUsage(raw: unknown): CarryUsage | null {
	if (!raw || typeof raw !== "object") return null;
	const usage = raw as Record<string, unknown>;
	const cost = (usage.cost ?? {}) as Record<string, unknown>;
	if (typeof cost !== "object" || cost === null) return null;
	return {
		input: count(usage.input),
		output: count(usage.output),
		cacheRead: count(usage.cacheRead),
		cacheWrite: count(usage.cacheWrite),
		cost: {
			input: count(cost.input),
			output: count(cost.output),
			cacheRead: count(cost.cacheRead),
			cacheWrite: count(cost.cacheWrite),
			total: count(cost.total),
		},
	};
}

/** Render the fenced block. Pretty-printed, because a human may read the doc. */
export function formatCarryBlock(payload: CarryPayload): string {
	const body = {
		v: payload.v,
		capturedAt: payload.capturedAt,
		sessionId: payload.sessionId,
		...(payload.model ? { model: payload.model } : {}),
		usage: payload.usage,
	};
	return ["```json " + CARRY_FENCE, JSON.stringify(body, null, 2), "```"].join("\n");
}

/** An opening or closing code fence: three or more backticks or tildes. */
const FENCE_RE = /^\s*(`{3,}|~{3,})(.*)$/;

interface DocumentScan {
	/** Line indexes of marker lines that are not inside a code fence. */
	markers: number[];
	/** Fenced carry blocks at the top level, as inclusive line ranges. */
	blocks: { start: number; end: number }[];
}

/**
 * Walk a document once, tracking code fences.
 *
 * This matters more than it looks: the README, and any document explaining this
 * feature, contains an example marker and an example block inside a fence. If
 * those counted, editing the README would stamp a real block into it and reading
 * it would adopt a made-up total. Only what sits outside a fence is real, and a
 * carry block nested inside another fence is documentation, not data.
 */
export function scanDocument(text: string): DocumentScan {
	const lines = text.split(/\r?\n/);
	const markers: number[] = [];
	const blocks: { start: number; end: number }[] = [];
	let open: { char: string; length: number; carry: boolean; start: number } | null = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const fence = FENCE_RE.exec(line);
		if (open) {
			// A fence closes only on its own character, at least as long, with no
			// info string of its own (CommonMark), so a ```` wrapper closes on ````.
			if (fence && fence[1]![0] === open.char && fence[1]!.length >= open.length && fence[2]!.trim() === "") {
				if (open.carry) blocks.push({ start: open.start, end: i });
				open = null;
			}
			continue;
		}
		if (fence) {
			open = {
				char: fence[1]![0]!,
				length: fence[1]!.length,
				carry: fence[2]!.includes(CARRY_FENCE),
				start: i,
			};
			continue;
		}
		if (line.trim() === CARRY_MARKER) markers.push(i);
	}
	return { markers, blocks };
}

/**
 * Read the first carry block out of a document. Returns null for anything that
 * is not a well-formed current-version block, so a malformed or future-version
 * block is ignored rather than half-applied.
 */
export function parseCarryBlock(text: string): CarryPayload | null {
	// Most reads are ordinary files. Skip the line walk when the tag is absent.
	if (!text.includes(CARRY_FENCE)) return null;
	const lines = text.split(/\r?\n/);
	const block = scanDocument(text).blocks[0];
	if (!block) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(lines.slice(block.start + 1, block.end).join("\n"));
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const data = parsed as Record<string, unknown>;
	if (finite(data.v) !== CARRY_VERSION) return null;
	const usage = normalizeCarryUsage(data.usage);
	if (!usage) return null;
	return {
		v: CARRY_VERSION,
		capturedAt: typeof data.capturedAt === "string" ? data.capturedAt : "",
		sessionId: typeof data.sessionId === "string" ? data.sessionId : "",
		...(typeof data.model === "string" ? { model: data.model } : {}),
		usage,
	};
}

/**
 * Whether two payloads record the same totals. The capture timestamp is
 * deliberately not compared: it is provenance, not data, and comparing it would
 * make every stamp look like a change and rewrite the document every time.
 */
function sameCarry(a: CarryPayload, b: CarryPayload): boolean {
	if (a.sessionId !== b.sessionId) return false;
	if ((a.model ?? "") !== (b.model ?? "")) return false;
	const [ua, ub] = [a.usage, b.usage];
	return (
		ua.input === ub.input &&
		ua.output === ub.output &&
		ua.cacheRead === ub.cacheRead &&
		ua.cacheWrite === ub.cacheWrite &&
		ua.cost.input === ub.cost.input &&
		ua.cost.output === ub.cost.output &&
		ua.cost.cacheRead === ub.cost.cacheRead &&
		ua.cost.cacheWrite === ub.cost.cacheWrite &&
		ua.cost.total === ub.cost.total
	);
}

/** Whether a document opted in by containing the marker line outside a fence. */
export function hasCarryMarker(text: string): boolean {
	if (!text.includes(CARRY_MARKER)) return false;
	return scanDocument(text).markers.length > 0;
}

/**
 * Put the block under the first marker line, replacing any block already there.
 *
 * The marker stays in the document on purpose: it is the anchor, so a later edit
 * to the same document refreshes the block instead of leaving a stale total, and
 * a document that only ever had the marker can be stamped at any time.
 */
export function stampCarry(text: string, payload: CarryPayload): { text: string; changed: boolean } {
	const crlf = text.includes("\r\n");
	const lines = text.split("\n").map((line) => (crlf && line.endsWith("\r") ? line.slice(0, -1) : line));
	const scan = scanDocument(crlf ? lines.join("\r\n") : lines.join("\n"));
	const markerAt = scan.markers[0];
	if (markerAt === undefined) return { text, changed: false };
	const block = formatCarryBlock(payload).split("\n");

	// Skip blank lines between the marker and a block left by an earlier stamp.
	let anchor = markerAt + 1;
	while (anchor < lines.length && lines[anchor]!.trim() === "") anchor++;
	const existing = scan.blocks.find((candidate) => candidate.start === anchor);
	if (existing) {
		const previous = parseCarryBlock(lines.slice(existing.start, existing.end + 1).join("\n"));
		// Same totals, same document: leave the block (and its timestamp) alone.
		if (previous && sameCarry(previous, payload)) return { text, changed: false };
		lines.splice(existing.start, existing.end - existing.start + 1, ...block);
		return { text: joinLines(lines, crlf), changed: true };
	}
	lines.splice(markerAt + 1, 0, ...block);
	return { text: joinLines(lines, crlf), changed: true };
}

function joinLines(lines: string[], crlf: boolean): string {
	return crlf ? lines.join("\r\n") : lines.join("\n");
}

/** The carried spend, which is what the CARRY row shows. */
export function carryCostTotal(payload: CarryPayload | CarryEntryData | null | undefined): number {
	return finite(payload?.usage?.cost?.total) ?? 0;
}

export type AdoptDecision = "adopt" | "same-session" | "already-adopted";

/**
 * Whether a read block should be adopted.
 *
 * One carry per session, which is what makes the guards meaningful: a document
 * read twice must not double the total, and a session must not adopt a block it
 * produced itself. `/doomhud carry clear` appends a zeroed entry, which counts as
 * "already adopted", so a clear stays cleared even if the document is read again.
 */
export function adoptDecision(
	payload: CarryPayload,
	currentSessionId: string | undefined,
	alreadyAdopted: boolean,
): AdoptDecision {
	if (alreadyAdopted) return "already-adopted";
	if (payload.sessionId && currentSessionId && payload.sessionId === currentSessionId) return "same-session";
	return "adopt";
}
