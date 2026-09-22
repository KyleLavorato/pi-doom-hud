// Invariant checks for the bar renderer. Not shipped in the npm package; this is
// a dev harness so a layout regression fails loudly instead of showing up as a
// ragged bar on someone's terminal.
//
//   npm test
import { loadFrames, renderHudBar } from "../extensions/doom-hud/index.ts";
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
		stats: [
			{ label: "CACHE", value: "98%" },
			{ label: "IN", value: "18.4k" },
			{ label: "OUT", value: "534" },
			{ label: "BLENDED", value: "$1.203" },
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

if (frames.size === 0) fail("no face frames loaded");
for (const t of [1, 2, 3, 4, 5]) {
	for (const kind of ["left", "neutral", "right", "focus"]) {
		const name = `tier${t}_${kind}`;
		if (!frames.has(name)) fail(`missing frame ${name}`);
	}
}
if (!frames.has("dead")) fail("missing frame dead");

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
// it, and its four readings must be legible whenever it is shown.
{
	const strip = (lines: string[]) => lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
	const narrow = strip(renderHudBar(frames, hudWith(45, 200_000, 1.694), false, 100, "tier3_neutral"));
	if (narrow.includes("CACHE")) fail("stats tile shown at 100 columns, where it cannot fit its values");
	if (!narrow.includes("TOKENS") || !narrow.includes("COST")) fail("headline tiles missing at 100 columns");
	const wide = strip(renderHudBar(frames, hudWith(45, 200_000, 1.694), false, 140, "tier3_neutral"));
	for (const needle of ["CACHE", "98%", "18.4k", "534", "$1.203"]) {
		if (!wide.includes(needle)) fail(`stats reading \"${needle}\" missing at 140 columns`);
	}
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