// Invariant checks for the bar renderer. Not shipped in the npm package; this is
// a dev harness so a layout regression fails loudly instead of showing up as a
// ragged bar on someone's terminal.
//
//   npm test
import { loadFrames, renderHudBar } from "../extensions/doom-hud/index.ts";
import { billedTokenCount, blendedCostPerMillion, promptTokenCount } from "../extensions/doom-hud/token-economics.ts";
import type { HudData } from "../extensions/doom-hud/index.ts";

/** Strip SGR/mode escapes and count visible columns (every glyph used is width 1). */
function visible(line: string): number {
	return [...line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "")].length;
}

function hudWith(usagePct: number | null, window: number, cost: number): HudData {
	return {
		health: 100 - (usagePct ?? 0),
		usagePct,
		contextTokens: usagePct == null ? null : Math.round(window * (usagePct / 100)),
		window,
		cost,
		costDelta: 0.02,
		stats: [
			{ label: "CACHE", value: " 326k", deltaTokens: 32_000},
			{ label: "CACHE READ", value: "37.2m $0.372", deltaCost: 0.005 },
			{ label: "CACHE WRITE", value: " 467k $0.058", deltaCost: 0.001 },
			{ label: "IN", value: " 264k $0.026", deltaCost: 0.012 },
			{ label: "OUT", value: " 251k $0.125", deltaCost: 0.002 },
			{ label: "BLENDED", value: "$0.015/M" },
		],
		modelId: "claude-opus-4-5-extended-thinking",
		thinking: "xhigh",
		provider: "anthropic",
		branch: "feature/some-rather-long-branch-name",
		dir: "pi-doom-hud",
	};
}

const frames = await loadFrames();
let failures = 0;
const fail = (msg: string) => {
	failures++;
	console.error("FAIL: " + msg);
};

// Blended price uses all four Pi usage buckets. Counts and component costs
// remain separate so the session total can be checked from the displayed rows.
{
	const promptTokens = promptTokenCount(100, 700, 50);
	if (promptTokens !== 850) fail(`prompt token count is ${promptTokens}, want 850`);
	const total = billedTokenCount({ input: 100, output: 200, cacheRead: 700, cacheWrite: 50 });
	if (total !== 1_050) fail(`billed token count is ${total}, want 1050`);
	const usageCost = 0.0021;
	const blended = blendedCostPerMillion(usageCost, total);
	if (Math.abs(blended - 2) > 1e-9) fail(`blended rate is $${blended}, want $2.000 per million tokens`);
	const recoveredCost = blended * total / 1_000_000;
	if (Math.abs(recoveredCost - usageCost) > 1e-12) fail(`displayed token total recovers $${recoveredCost}, want $${usageCost}`);
	const partialTotal = billedTokenCount({ input: 100, output: 200, cacheRead: 700 });
	if (partialTotal !== 1_000) fail(`partial billed token count is ${partialTotal}, want 1000`);
}

if (frames.size === 0) fail("no face frames loaded");
for (const t of [1, 2, 3, 4, 5]) {
	for (const kind of ["left", "neutral", "right", "focus"]) {
		const name = `tier${t}_${kind}`;
		if (!frames.has(name)) fail(`missing frame ${name}`);
	}
}
if (!frames.has("dead")) fail("missing frame dead");

// The text fallback should use only full-width upper-half blocks, not the old
// quadrant mosaics. This keeps one independent horizontal sample per cell.
{
	const textFace = renderHudBar(frames, hudWith(45, 200_000, 1.694), false, 120, "tier3_neutral");
	if (!textFace.some((line) => line.includes("▀"))) fail("text fallback did not render half-block face pixels");
	const faceAnsi = textFace.join("");
	if (!faceAnsi.includes("191;148;130")) fail("text fallback did not soften the eye highlights");
	if (faceAnsi.includes("255;244;224")) fail("text fallback eye highlights are too white");
	if (textFace.some((line) => /[▖▗▘▙▚▛▜▝▞▟▄▌▐]/u.test(line))) {
		fail("text fallback still contains quadrant-block face pixels");
	}
}

const faces = ["tier1_left", "tier1_neutral", "tier3_right", "tier5_focus", "dead"];
const huds: HudData[] = [
	hudWith(45, 200_000, 1.694),
	hudWith(null, 1_048_576, 0),
	hudWith(99, 128_000, 123.456),
	hudWith(0, 8_192, 0.001),
];

// One model id with no dashes to hard-cut and one with many tiny segments, so
// both the wrap and the mid-word backstop are exercised.
const longId = hudWith(50, 200_000, 0.5);
longId.modelId = "averyveryverylongmodelidentifierwithnobreaksatall";
huds.push(longId);
const chunkyId = hudWith(50, 200_000, 0.5);
chunkyId.modelId = "a-b-c-d-e-f-g-h-i-j-k-l-m-n-o-p";
huds.push(chunkyId);

// Every line of a bar must be the same visible width, never wider than the
// terminal (pi-tui throws otherwise), and exactly as wide as the renderer was
// asked for. Below the 60-column floor the bar stands down entirely instead of
// spilling.
const MIN_W = 60;
for (let width = 24; width <= 260; width++) {
	for (const face of faces) {
		for (const hud of huds) {
			const lines = renderHudBar(frames, hud, false, width, face);
			if (width < MIN_W) {
				if (lines.length !== 0) fail(`width ${width}: bar should stand down below ${MIN_W} columns, got ${lines.length} lines`);
				continue;
			}
			if (lines.length !== 13) fail(`width ${width} face ${face}: ${lines.length} lines, want 13`);
			const widths = lines.map(visible);
			for (let i = 0; i < widths.length; i++) {
				if (widths[i] !== width) {
					fail(`width ${width} face ${face} cost ${hud.cost} usage ${hud.usagePct}: line ${i} is ${widths[i]} columns, want ${width}`);
					break;
				}
			}
		}
	}
}

// Wide characters in names must not break the layout: the grid is addressed by
// character, so a CJK path or an emoji in the model id has to be replaced rather
// than silently pushing the row past the terminal width.
{
	const wide = hudWith(50, 200_000, 0.5);
	wide.modelId = "模型-超長名稱-with-emoji-😀";
	wide.dir = "目录名";
	wide.branch = "feature/ブランチ";
	wide.provider = "日本語プロバイダ";
	wide.stats[0]!.value = "99%";
	wide.stats[1]!.label = "入力";
	for (const width of [60, 80, 120, 200]) {
		const lines = renderHudBar(frames, wide, false, width, "tier3_neutral");
		for (let i = 0; i < lines.length; i++) {
			if (visible(lines[i]!) !== width) fail(`wide-char HUD at width ${width}: line ${i} is ${visible(lines[i]!)} columns`);
		}
	}
}

// An unknown-width HUD (no cost yet, no usage) must still render.
{
	const lines = renderHudBar(frames, hudWith(null, 0, 0), false, 120, "tier1_neutral");
	if (visible(lines[0]!) !== 120) fail("zero-window HUD rendered the wrong width");
}

// The stats tile is dropped rather than squeezed when the terminal cannot hold
// it, and its token/cost breakdown must be legible whenever it is shown.
{
	const stripLine = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
	const strip = (lines: string[]) => lines.map(stripLine).join("\n");
	const narrow = strip(renderHudBar(frames, hudWith(45, 200_000, 1.694), false, 100, "tier3_neutral"));
	if (narrow.includes("CACHE READ")) fail("stats tile shown at 100 columns, where it cannot fit its values");
	if (!narrow.includes("TOKENS") || !narrow.includes("COST")) fail("headline tiles missing at 100 columns");
	const wideLines = renderHudBar(frames, hudWith(45, 200_000, 1.694), false, 140, "tier3_neutral");
	const wide = strip(wideLines);
	for (const needle of ["CACHE", "326k", "CACHE READ", "37.2m", "$0.372", "CACHE WRITE", "467k", "$0.058", "IN", "264k", "$0.026", "OUT", "251k", "$0.125", "BLENDED", "$0.015/M"]) {
		if (!wide.includes(needle)) fail(`stats reading \"${needle}\" missing at 140 columns`);
	}
	const statLines = wideLines.map(stripLine);
	const dollarColumns = ["$0.372", "$0.058", "$0.026", "$0.125"].map((marker) => {
		const line = statLines.find((candidate) => candidate.includes(marker));
		return line ? line.indexOf(marker) : -1;
	});
	if (dollarColumns.some((column) => column < 0) || new Set(dollarColumns).size !== 1) {
		fail(`token bucket cost values are not aligned: ${dollarColumns.join(",")}`);
	}
	const tokenEnds = ["326k", "37.2m", "467k", "264k", "251k"].map((token) => {
		const line = statLines.find((candidate) => candidate.includes(token));
		return line ? line.indexOf(token) + token.length : -1;
	});
	if (tokenEnds.some((column) => column < 0) || new Set(tokenEnds).size !== 1) {
		fail(`token counts are not right-aligned: ${tokenEnds.join(",")}`);
	}
	const compact = renderHudBar(frames, hudWith(45, 200_000, 1.694), false, 120, "tier3_neutral").map(stripLine).join("");
	if (compact.includes("(+$0.012)") || compact.includes("(+$0.020)")) fail("turn deltas shown when the stats tile is compacted");
	const roomy = renderHudBar(frames, hudWith(45, 200_000, 1.694), false, 260, "tier3_neutral").map(stripLine).join("");
	if (!roomy.includes("(+32k)")) fail("per-turn cache-write token delta missing when the stats tile has room");
	if (!roomy.includes("(+$0.012)")) fail("per-turn input delta missing when the stats tile has room");
	if (!roomy.includes("(+$0.020)")) fail("per-turn COST delta missing when the panel has room");
}

// The inline-image path must not throw outside a real terminal (where pi-tui
// reports no image support, this falls through to the block face).
for (const face of faces) {
	const lines = renderHudBar(frames, huds[0]!, true, 120, face);
	if (lines.length !== 13) fail(`image-face path for ${face}: ${lines.length} lines, want 13`);
}

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log(`render checks passed (${faces.length} faces x ${huds.length} HUD states x widths 24-260)`);