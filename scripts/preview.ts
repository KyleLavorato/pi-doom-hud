// Renders the HUD bar to a PPM so it can be eyeballed without a real terminal.
// It always renders the quadrant-block face, because the pixel face is a bunch
// of terminal escape sequences and a PPM rasteriser cannot draw those.
//
// Usage: npx tsx scripts/preview.ts [width] [faceName] [outPath] [contextPct]
//   width      bar width in columns (default 120)
//   faceName   e.g. tier3_neutral, tier5_left, dead (default tier3_neutral)
//   outPath    where the PPM goes (default /tmp/hud_preview.ppm)
//   contextPct the context percentage to draw, so the colour thresholds can be
//              eyeballed; pass "null" for the unknown-usage state (default 45)
//
// pi-tui is handed to extensions by pi at runtime and is not on node's search
// path from this directory, so point node at a copy first. Running the
// typecheck/dev install (`npm install`) gives you node_modules with the real
// packages, which covers it:
//   npm install
//   npx tsx scripts/preview.ts 120 tier3_neutral /tmp/hud_preview.ppm 45
//   open /tmp/hud_preview.ppm
import { loadFrames, renderHudBar } from "../extensions/doom-hud/index.ts";
import type { HudData } from "../extensions/doom-hud/index.ts";
import { writeFileSync } from "node:fs";

const width = parseInt(process.argv[2] || "120", 10);
const faceName = process.argv[3] || "tier3_neutral";
const outPath = process.argv[4] || "/tmp/hud_preview.ppm";
const pctArg = process.argv[5];
const usagePct = pctArg === undefined ? 45 : pctArg === "null" ? null : Number(pctArg);
const frames = await loadFrames();
const hud: HudData = {
	health: 100 - (usagePct ?? 0), usagePct, window: 200_000, cost: 1.694,
	stats: [
		{ label: "CACHE", value: "98%" },
		{ label: "IN", value: "18.4k" },
		{ label: "OUT", value: "534" },
		{ label: "BLENDED", value: "$1.203" },
	],
	model: "anthropic/claude-opus-4-5[high]",
	modelId: "claude-opus-4-5", thinking: "high", provider: "anthropic",
	branch: "main", dir: "my-project",
};

const lines = renderHudBar(frames, hud, false, width, faceName);
const H = lines.length;
// Realistic cell proportions (a terminal cell is ~2x taller than wide).
const CW = 7, CH = 14;
const Wpx = width * CW, Hpx = H * CH;
const buf = Buffer.alloc(Wpx * Hpx * 3);

/** Blit a colour into a cell pixel. */
const setPx = (x: number, y: number, r: number, g: number, b: number) => {
	if (x < 0 || y < 0 || x >= Wpx || y >= Hpx) return;
	const o = (y * Wpx + x) * 3;
	buf[o] = r; buf[o + 1] = g; buf[o + 2] = b;
};

// Split a line into SGR tokens and printable characters.
function tok(line: string): { s: boolean; c: string }[] {
	const t: { s: boolean; c: string }[] = [];
	let i = 0;
	while (i < line.length) {
		if (line[i] === "\x1b" && line[i + 1] === "[") {
			const m = /^\x1b\[([0-9;]*)m/.exec(line.slice(i));
			if (m) { t.push({ s: true, c: m[1]! }); i += m[0].length; continue; }
			i += 2; continue;
		}
		t.push({ s: false, c: line[i]! });
		i++;
	}
	return t;
}

for (let y = 0; y < H; y++) {
	const ts = tok(lines[y]!);
	let fg: [number, number, number] = [170, 170, 170];
	let bg: [number, number, number] = [18, 18, 20];
	let col = 0;
	for (const t of ts) {
		if (t.s) {
			const c = t.c;
			if (c.startsWith("38;2;")) { const p = c.split(";"); fg = [+p[2]!, +p[3]!, +p[4]!]; }
			else if (c.startsWith("48;2;")) { const p = c.split(";"); bg = [+p[2]!, +p[3]!, +p[4]!]; }
			else if (c === "0") { fg = [170, 170, 170]; bg = [18, 18, 20]; }
			continue;
		}
		const ch = t.c;
		const code = ch.codePointAt(0) ?? 0;
		// Quadrant/half-block glyphs: 2x2 subpixel mask, bit order TL, TR, BL, BR.
		const MASK: Record<string, number> = {
			" ": 0b0000, "\u2598": 0b0001, "\u259d": 0b0010, "\u2580": 0b0011,
			"\u2596": 0b0100, "\u258c": 0b0101, "\u259e": 0b0110, "\u259b": 0b0111,
			"\u2597": 0b1000, "\u259a": 0b1001, "\u2590": 0b1010, "\u259c": 0b1011,
			"\u2584": 0b1100, "\u2599": 0b1101, "\u259f": 0b1110, "\u2588": 0b1111,
		};
		const mask = MASK[ch];
		for (let dx = 0; dx < CW; dx++) {
			for (let dy = 0; dy < CH; dy++) {
				let r: number, g: number, b: number;
				if (mask !== undefined) {
					const bit = 1 << ((dy < CH / 2 ? 0 : 2) + (dx < CW / 2 ? 0 : 1));
					[r, g, b] = (mask & bit) ? fg : bg;
				} else if (code === 0x2588) {
					[r, g, b] = fg;
				} else {
					// Text: rough mark so digits and labels are visible.
					[r, g, b] = dy > CH / 2 - 2 && dy < CH / 2 + 2 ? fg : bg;
				}
				setPx(col * CW + dx, y * CH + dy, r, g, b);
			}
		}
		col++;
		if (col >= width) break;
	}
}

writeFileSync(outPath, Buffer.concat([Buffer.from(`P6\n${Wpx} ${Hpx}\n255\n`), buf]));
console.error(`wrote ${outPath} (${Wpx}x${Hpx}), ${H} lines`);
