// Invariant checks for cost carry-over. Not shipped in the npm package; this is
// a dev harness so a broken document contract, a duplicate stamp, or a
// double-counted total fails loudly instead of quietly inflating someone's COST.
//
//   npm test
import { readFile } from "node:fs/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CARRY_CUSTOM_TYPE,
	CARRY_MARKER,
	CARRY_VERSION,
	adoptDecision,
	carryCostTotal,
	formatCarryBlock,
	hasCarryMarker,
	parseCarryBlock,
	stampCarry,
	zeroUsage,
	type CarryEntryData,
	type CarryPayload,
	type CarryUsage,
} from "../extensions/doom-hud/cost-carry.ts";
import { activeCarry, carryUsageFrom, sumSessionUsage } from "../extensions/doom-hud/index.ts";
import { billedTokenCount, blendedCostPerMillion, costColumnValue } from "../extensions/doom-hud/token-economics.ts";

let failures = 0;
const fail = (msg: string) => {
	failures++;
	console.error("FAIL: " + msg);
};
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

function usage(overrides: Partial<CarryUsage> = {}): CarryUsage {
	return {
		input: 412_000,
		output: 18_000,
		cacheRead: 9_300_000,
		cacheWrite: 210_000,
		cost: { input: 1.24, output: 0.54, cacheRead: 0.93, cacheWrite: 0.42, total: 3.41 },
		...overrides,
	};
}

function payload(overrides: Partial<CarryPayload> = {}): CarryPayload {
	return {
		v: CARRY_VERSION,
		capturedAt: "2026-09-24T21:03:00.000Z",
		sessionId: "producer-session",
		model: "anthropic/claude-sonnet-4-5",
		usage: usage(),
		...overrides,
	};
}

const blockCount = (text: string) => text.split("doom-hud-carry").length - 1;

// The block has to survive a write/read cycle exactly: a document is a file on
// disk, so anything the parser cannot recover is data loss.
{
	const original = payload();
	const text = formatCarryBlock(original);
	const parsed = parseCarryBlock(text);
	if (!parsed) {
		fail("formatted block did not parse");
	} else {
		if (parsed.sessionId !== original.sessionId) fail(`sessionId roundtrip: ${parsed.sessionId}`);
		if (parsed.capturedAt !== original.capturedAt) fail(`capturedAt roundtrip: ${parsed.capturedAt}`);
		if (parsed.model !== original.model) fail(`model roundtrip: ${parsed.model}`);
		if (parsed.usage.input !== original.usage.input) fail("input tokens roundtrip");
		if (parsed.usage.cost.total !== original.usage.cost.total) fail("cost total roundtrip");
	}
	const noModel = parseCarryBlock(formatCarryBlock(payload({ model: undefined })));
	if (noModel && noModel.model !== undefined) fail("missing model should stay missing");
	if (!noModel) fail("block without a model did not parse");
}

// A block the HUD should refuse: a future version, broken JSON, or a missing
// usage object must all read as "no block", never as a partial adoption.
{
	const future = formatCarryBlock(payload()).replace('"v": 1', '"v": 99');
	if (parseCarryBlock(future) !== null) fail("a future version block was accepted");
	if (parseCarryBlock("```json doom-hud-carry\n{not json}\n```") !== null) fail("broken JSON was accepted");
	if (parseCarryBlock("```json doom-hud-carry\n{\"v\":1}\n```") !== null) fail("a block without usage was accepted");
	if (parseCarryBlock("no block here") !== null) fail("a document without a block parsed as one");
	if (parseCarryBlock("```json doom-hud-carry\n{\"v\":1,\"usage\":{}}\n```") === null) fail("a minimal block was rejected");
	const partial = parseCarryBlock("```json doom-hud-carry\n{\"v\":1,\"usage\":{\"input\":5}}\n```");
	if (!partial || partial.usage.input !== 5 || partial.usage.output !== 0 || partial.usage.cost.total !== 0) {
		fail("missing buckets should normalize to zero");
	}
}

// The marker is the opt-in. Only a line that is exactly the marker counts, so a
// document that merely mentions it in prose is left alone.
{
	if (!hasCarryMarker(`# Doc\n\n${CARRY_MARKER}\n`)) fail("marker line not detected");
	if (hasCarryMarker("the `<!-- doom-hud:carry -->` marker is documented here")) fail("prose mention counted as a marker");
	if (hasCarryMarker("# Doc\n\nno marker\n")) fail("plain document reported a marker");
}

// Stamping: marker kept, one block, and a second stamp of the same totals is a
// no-op. The no-op matters because the HUD stamps on every write and edit, and a
// timestamp-only rewrite would fight the agent for the file.
{
	const doc = `# Handoff\n\nBody.\n\n${CARRY_MARKER}\n`;
	const first = stampCarry(doc, payload());
	if (!first.changed) fail("first stamp reported no change");
	if (!first.text.includes(CARRY_MARKER)) fail("stamp removed the marker");
	if (blockCount(first.text) !== 1) fail(`first stamp wrote ${blockCount(first.text)} blocks`);
	if (!first.text.startsWith("# Handoff\n\nBody.\n\n")) fail("stamp disturbed the document body");
	if (!first.text.trimEnd().endsWith("```")) fail("stamp did not close the block");

	const second = stampCarry(first.text, payload({ capturedAt: "2026-09-24T22:00:00.000Z" }));
	if (second.changed) fail("re-stamping identical totals rewrote the document");
	if (second.text !== first.text) fail("re-stamping identical totals changed the bytes");
	if (blockCount(second.text) !== 1) fail("re-stamping duplicated the block");

	const updated = stampCarry(first.text, payload({ usage: usage({ input: 500_000 }) }));
	if (!updated.changed) fail("new totals did not refresh the block");
	if (blockCount(updated.text) !== 1) fail("refreshing the block duplicated it");
	const refreshed = parseCarryBlock(updated.text);
	if (!refreshed || refreshed.usage.input !== 500_000) fail("refreshed block did not carry the new totals");
	if (!updated.text.includes(CARRY_MARKER)) fail("refresh removed the marker");
}

// A stale block from an older HUD, with a blank line between marker and block,
// is replaced rather than appended to.
{
	const stale = `# Doc\n\n${CARRY_MARKER}\n\n\`\`\`json doom-hud-carry\n{"v":1,"sessionId":"old","usage":{}}\n\`\`\`\n\nTail.\n`;
	const stamped = stampCarry(stale, payload());
	if (blockCount(stamped.text) !== 1) fail(`stale block was not replaced, ${blockCount(stamped.text)} blocks`);
	if (!stamped.text.includes("Tail.")) fail("stale block replacement dropped the document tail");
	const parsed = parseCarryBlock(stamped.text);
	if (!parsed || parsed.sessionId !== "producer-session") fail("stale block replacement kept the old payload");
}

// A document without the marker is never touched, even if it already holds a
// block. Stamping is opt-in only.
{
	const noMarker = "```json doom-hud-carry\n{\"v\":1,\"usage\":{}}\n```\n";
	const result = stampCarry(noMarker, payload());
	if (result.changed) fail("stamped a document that never opted in");
	if (result.text !== noMarker) fail("unmarked document bytes changed");
}

// CRLF documents keep their line endings.
{
	const crlf = `# Doc\r\n\r\n${CARRY_MARKER}\r\n`;
	const stamped = stampCarry(crlf, payload());
	if (!stamped.text.includes("\r\n")) fail("CRLF document lost its line endings");
	if (stamped.text.replace(/\r\n/g, "").includes("\n")) fail("CRLF document gained bare LF line endings");
}

// A document that merely documents the feature must never trigger it. The
// README carries both an example marker and an example block, and both sit
// inside fences, so the real file is the best regression test there is: if these
// two assertions ever fail, editing the README stamps a block into it and reading
// it adopts a made-up total.
{
	const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
	if (hasCarryMarker(readme)) fail("the README's fenced marker example was read as an opt-in");
	if (parseCarryBlock(readme) !== null) fail("the README's fenced block example was read as real data");
	const docs = readme.replace(/`{3,}/g, "");
	if (!docs.includes(CARRY_MARKER) || !docs.includes("doom-hud-carry")) {
		fail("the README no longer documents the marker and the block tag");
	}
	// A nested block is documentation too: ````  fences only close on ```` .
	const nested = `# Doc\n\n\`\`\`\`markdown\n${CARRY_MARKER}\n\`\`\`json doom-hud-carry\n{"v":1,"usage":{}}\n\`\`\`\n\`\`\`\`\n`;
	if (hasCarryMarker(nested)) fail("a marker inside a fence counted as an opt-in");
	if (parseCarryBlock(nested) !== null) fail("a block nested inside a fence was read as real data");
	// An unclosed fence is not a block either.
	if (parseCarryBlock("```json doom-hud-carry\n{\"v\":1,\"usage\":{}}\n") !== null) fail("an unclosed block was accepted");
	// The stamp must still work next to a documented example, leaving the example
	// alone and filling only the real marker.
	const withExample = `# Doc\n\n\`\`\`markdown\n${CARRY_MARKER}\n\`\`\`\n\n${CARRY_MARKER}\n`;
	const stamped = stampCarry(withExample, payload());
	if (blockCount(stamped.text) !== 1) fail(`example next to a real marker produced ${blockCount(stamped.text)} blocks`);
	if (!stamped.text.includes("```markdown")) fail("stamping rewrote the documented example fence");
}

// The adopt guards: one carry per session, and never your own block.
{
	const p = payload();
	if (adoptDecision(p, "producer-session", false) !== "same-session") fail("a session adopted its own block");
	if (adoptDecision(p, "other-session", true) !== "already-adopted") fail("a second carry was adopted");
	if (adoptDecision(p, "other-session", false) !== "adopt") fail("a fresh carry was not adopted");
	if (adoptDecision(payload({ sessionId: "" }), "other-session", false) !== "adopt") fail("a block without a session id was not adopted");
}

// Aggregation: the carried usage folds into the same accumulators as live usage,
// so the bucket rows continue and BLENDED spans both sessions. The gap between a
// carry's cost.total and its buckets (subagent spend) has to read as OTHER, the
// same way live subagent spend does.
{
	const live = {
		type: "message",
		message: {
			role: "assistant",
			usage: {
				input: 100,
				output: 50,
				cacheRead: 1_000,
				cacheWrite: 10,
				cost: { input: 0.1, output: 0.05, cacheRead: 0.01, cacheWrite: 0.002, total: 0.162 },
			},
		},
	};
	const carryEntry = {
		type: "custom",
		customType: CARRY_CUSTOM_TYPE,
		data: {
			v: CARRY_VERSION,
			capturedAt: "2026-09-24T21:03:00.000Z",
			sessionId: "producer-session",
			usage: {
				input: 400,
				output: 20,
				cacheRead: 9_000,
				cacheWrite: 200,
				// total includes 0.07 of subagent spend that no bucket covers.
				cost: { input: 0.4, output: 0.02, cacheRead: 0.09, cacheWrite: 0.04, total: 0.62 },
			},
		},
	};
	const subagentCost = 0.03;
	const totals = sumSessionUsage([live, carryEntry], subagentCost);

	if (totals.tokensIn !== 500) fail(`IN tokens are ${totals.tokensIn}, want 500 (carry folded in)`);
	if (totals.tokensOut !== 70) fail(`OUT tokens are ${totals.tokensOut}, want 70`);
	if (totals.cacheRead !== 10_000) fail(`cache-read tokens are ${totals.cacheRead}, want 10000`);
	if (totals.cacheWrite !== 210) fail(`cache-write tokens are ${totals.cacheWrite}, want 210`);
	if (!near(totals.tokenCost, 0.782)) fail(`usage cost is ${totals.tokenCost}, want 0.782`);
	if (!near(totals.cost, 0.812)) fail(`COST is ${totals.cost}, want 0.812 (usage + subagent)`);
	if (totals.latestCacheRead !== 1_000) fail(`CACHE is ${totals.latestCacheRead}, want the live 1000, not the carry`);

	const bucketCost = totals.inputCost + totals.outputCost + totals.cacheReadCost + totals.cacheWriteCost;
	if (!near(bucketCost, 0.712)) fail(`bucket cost is ${bucketCost}, want 0.712`);
	const other = totals.cost - bucketCost;
	if (!near(other, 0.1)) fail(`OTHER is ${other}, want 0.1 (carry gap 0.07 + live subagent 0.03)`);

	const billed = billedTokenCount({
		input: totals.tokensIn,
		output: totals.tokensOut,
		cacheRead: totals.cacheRead,
		cacheWrite: totals.cacheWrite,
	});
	if (billed !== totals.billedTokens) fail(`billed tokens are ${totals.billedTokens}, want ${billed}`);
	const blended = blendedCostPerMillion(totals.tokenCost, totals.billedTokens);
	const recovered = (blended * totals.billedTokens) / 1_000_000;
	if (!near(recovered, totals.tokenCost)) fail(`BLENDED does not recover the usage cost: ${recovered} vs ${totals.tokenCost}`);

	// A handoff written from this session has to record the cumulative total, so a
	// chain of handoffs keeps accumulating instead of resetting to the last hop.
	const next = carryUsageFrom(totals, subagentCost);
	if (next.input !== 500 || next.cacheRead !== 10_000) fail("stamped usage did not include the adopted carry");
	if (!near(next.cost.total, 0.812)) fail(`stamped cost total is ${next.cost.total}, want 0.812`);
}

// The latest carry entry wins, which is what lets `carry clear` supersede an
// adopted carry by appending a zeroed entry instead of rewriting the session.
{
	const adopted = {
		type: "custom",
		customType: CARRY_CUSTOM_TYPE,
		data: { v: CARRY_VERSION, capturedAt: "", sessionId: "a", usage: usage() },
	};
	if (!near(carryCostTotal(activeCarry([adopted])), 3.41)) fail("an adopted carry was not read back");
	const cleared = {
		type: "custom",
		customType: CARRY_CUSTOM_TYPE,
		data: { v: CARRY_VERSION, capturedAt: "", sessionId: "a", usage: zeroUsage() },
	};
	if (carryCostTotal(activeCarry([adopted, cleared])) !== 0) fail("a zeroed entry did not supersede the adopted carry");
	const second = {
		type: "custom",
		customType: CARRY_CUSTOM_TYPE,
		data: { v: CARRY_VERSION, capturedAt: "", sessionId: "b", usage: usage({ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 9.5 } }) },
	};
	if (!near(carryCostTotal(activeCarry([adopted, second])), 9.5)) fail("the newest carry did not win");
	if (activeCarry([]) !== null) fail("an empty session reported a carry");
	if (activeCarry([{ type: "custom", customType: "something-else", data: {} }]) !== null) fail("another extension's entry was read as a carry");
}

// A cleared carry must not paint a CARRY row.
{
	const cleared = {
		type: "custom",
		customType: CARRY_CUSTOM_TYPE,
		data: { v: CARRY_VERSION, capturedAt: "", sessionId: "a", usage: zeroUsage() },
	};
	const totals = sumSessionUsage([cleared], 0);
	if (carryCostTotal(totals.carry) !== 0) fail("a cleared carry still reported spend");
	if (totals.cost !== 0) fail("a cleared carry changed COST");
}

// A cost-only row has to sit in the same column as the bucket rows, which print
// a token count first. Padding is the whole trick, so it gets its own check.
{
	for (const width of [0, 3, 5, 7]) {
		const bucket = `${"9".repeat(width)} $0.372`;
		const costOnly = costColumnValue(width, 1.113);
		if (bucket.length !== costOnly.length) {
			fail(`cost-only row is ${costOnly.length} chars, bucket row is ${bucket.length} at token width ${width}`);
		}
		if (bucket.indexOf("$") !== costOnly.indexOf("$")) {
			fail(`cost-only dollar at ${costOnly.indexOf("$")}, bucket dollar at ${bucket.indexOf("$")}`);
		}
	}
	if (costColumnValue(5, 1.113) !== "      $1.113") fail(`cost column value is "${costColumnValue(5, 1.113)}"`);
}

// End-to-end wiring: drive the real extension factory with a fake pi and a fake
// context, then fire the events pi would fire. The pure functions above cannot
// catch a hook registered on the wrong tool name, a missing guard, or a stamp
// written to the wrong file, and those are the failures that would ship.
{
	const dir = await mkdtemp(join(tmpdir(), "doom-hud-carry-"));
	let currentSession = "this-session";
	const appended: { customType: string; data: CarryEntryData }[] = [];
	const handlers = new Map<string, (event: any, ctx: any) => unknown>();
	const entries: any[] = [];
	await (await import("../extensions/doom-hud/index.ts")).default({
		on: (name: string, handler: any) => {
			handlers.set(name, handler);
			return () => {};
		},
		registerCommand: () => {},
		registerEntryRenderer: () => {},
		appendEntry: (customType: string, data: CarryEntryData) => {
			appended.push({ customType, data });
			// Mirror what pi does: the entry joins the session it was appended to.
			entries.push({ type: "custom", customType, data });
		},
	} as any);
	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: dir,
		thinkingLevel: "off",
		model: { id: "claude-sonnet-4-5", provider: "anthropic", contextWindow: 200_000 },
		ui: { notify: () => {}, setFooter: () => {}, setWidget: () => {} },
		getContextUsage: () => ({ percent: 10, tokens: 20_000, contextWindow: 200_000 }),
		sessionManager: {
			getEntries: () => entries,
			getSessionId: () => currentSession,
			getSessionFile: () => join(dir, "session.jsonl"),
		},
	};
	const fire = async (name: string, event: any) => {
		const handler = handlers.get(name);
		if (!handler) {
			fail(`the extension did not register the ${name} handler`);
			return;
		}
		await handler(event, ctx);
	};
	const readEvent = (path: string, text: string) => ({ type: "tool_result", toolName: "read", input: { path }, content: [{ type: "text", text }], isError: false });
	// The real write tool reports the arguments it ran with, so include content:
	// it is what lets the hook skip unmarked documents without reading them.
	const writeEvent = (path: string, content: string) => ({ type: "tool_result", toolName: "write", input: { path, content }, content: [{ type: "text", text: "ok" }], isError: false });

	await fire("session_start", { type: "session_start" });

	// The traffic that matters: a real usage record, so the stamped block has
	// numbers to record.
	entries.push({
		type: "message",
		message: {
			role: "assistant",
			usage: {
				input: 1_000,
				output: 200,
				cacheRead: 5_000,
				cacheWrite: 100,
				cost: { input: 0.01, output: 0.02, cacheRead: 0.005, cacheWrite: 0.001, total: 0.036 },
			},
		},
	});

	// A handoff written by this session is stamped as soon as the write lands.
	const handoff = join(dir, "handoff-demo.md");
	const handoffText = `# Handoff\n\nBody.\n\n${CARRY_MARKER}\n`;
	await writeFile(handoff, handoffText, "utf8");
	await fire("tool_result", writeEvent(handoff, handoffText));
	const stamped = await readFile(handoff, "utf8");
	const stampedBlock = parseCarryBlock(stamped);
	if (!stampedBlock) fail("writing a marked document did not stamp a block");
	else {
		if (stampedBlock.sessionId !== "this-session") fail(`stamped sessionId is ${stampedBlock.sessionId}`);
		if (stampedBlock.usage.input !== 1_000) fail(`stamped input tokens are ${stampedBlock.usage.input}`);
		if (!near(stampedBlock.usage.cost.total, 0.036)) fail(`stamped cost total is ${stampedBlock.usage.cost.total}`);
	}
	if (!stamped.includes(handoffText.trimEnd())) fail("stamping rewrote the handoff body");

	// Writing the same document again with no new spend keeps one block.
	await fire("tool_result", writeEvent(handoff, handoffText));
	if (blockCount(await readFile(handoff, "utf8")) !== 1) fail("a second write duplicated the block");

	// A relative path must resolve against the session cwd, the way the tools do,
	// not against whatever directory the pi process happens to have.
	await writeFile(join(dir, "handoff-rel.md"), `# Rel\n\n${CARRY_MARKER}\n`, "utf8");
	await fire("tool_result", writeEvent("handoff-rel.md", `# Rel\n\n${CARRY_MARKER}\n`));
	if (!parseCarryBlock(await readFile(join(dir, "handoff-rel.md"), "utf8"))) {
		fail("a relative handoff path was not resolved against the session cwd");
	}

	// A document without the marker is never touched, even on write.
	const plain = join(dir, "plain.md");
	await writeFile(plain, "# Plain\n\nNothing to see.\n", "utf8");
	await fire("tool_result", writeEvent(plain, "# Plain\n\nNothing to see.\n"));
	if ((await readFile(plain, "utf8")) !== "# Plain\n\nNothing to see.\n") fail("a document without the marker was rewritten");

	// Reading a block from another session adopts it, once.
	const incoming = join(dir, "incoming.md");
	await writeFile(incoming, formatCarryBlock(payload()) + "\n", "utf8");
	await fire("tool_result", readEvent(incoming, await readFile(incoming, "utf8")));
	if (appended.length !== 1) fail(`reading a carry block appended ${appended.length} entries, want 1`);
	else {
		if (appended[0]!.customType !== CARRY_CUSTOM_TYPE) fail(`appended entry type is ${appended[0]!.customType}`);
		if (appended[0]!.data.adoptedFrom !== incoming) fail("the adopted entry does not record where it came from");
		if (!near(carryCostTotal(appended[0]!.data), 3.41)) fail("the adopted entry carries the wrong total");
	}
	// The loop closes: what the bar would show is the carried spend plus this
	// session's own, in the buckets and in COST.
	{
		const totals = sumSessionUsage(entries, 0);
		if (totals.tokensIn !== 1_000 + 412_000) fail(`resumed IN tokens are ${totals.tokensIn}`);
		if (!near(totals.cost, 0.036 + 3.41)) fail(`resumed COST is ${totals.cost}, want 3.446`);
		if (!near(carryCostTotal(totals.carry), 3.41)) fail(`resumed CARRY row is ${carryCostTotal(totals.carry)}`);
	}
	await fire("tool_result", readEvent(incoming, await readFile(incoming, "utf8")));
	if (appended.length !== 1) fail("reading the same carry block twice adopted it twice");

	// Reading your own block is a no-op, so a session that reads its handoff back
	// does not double its own spend.
	entries.length = 0;
	const own = join(dir, "own.md");
	await writeFile(own, formatCarryBlock(payload({ sessionId: currentSession })) + "\n", "utf8");
	await fire("tool_result", readEvent(own, await readFile(own, "utf8")));
	if (appended.length !== 1) fail("a session adopted its own carry block");

	// A document with no block is just a document.
	await fire("tool_result", readEvent(plain, await readFile(plain, "utf8")));
	if (appended.length !== 1) fail("reading a plain document adopted a carry");

	await fire("session_shutdown", { type: "session_shutdown" });
	await rm(dir, { recursive: true, force: true });
}

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("carry checks passed (format, guards, stamping, aggregation)");
