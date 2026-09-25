/**
 * Doom HUD: a multi-row status bar that graphically mimics the classic Doom
 * HUD, rendered directly below the prompt box.
 *
 * Layout (left → right), each a beveled steel panel:
 *   [TOKENS 1.0m] [CONTEXT 24%] [MODEL id[high]] [FACE] [COST $1.694] [CACHE/CACHE READ/CACHE WRITE/IN/OUT/BLENDED]
 *
 * The Doom Guy face (with its animated eyebrows) sits between the STATUS grid and
 * COST, the classic Doom status-bar position, and reuses the sprite frames +
 * animation. On a terminal with inline-image support
 * (iTerm2, Kitty, Ghostty, WezTerm) it is the real pixel image. Otherwise it
 * falls back to truecolor Unicode half blocks, two vertically stacked pixels per cell.
 *
 * The face is drawn as ONE IMAGE PER BAR ROW, not one image for the whole face,
 * and that detail is the whole trick:
 *
 *   - pi-tui renders line by line and erases each line it repaints. An inline
 *     image is stored in the grid cells it covers, so a face spanning 11 rows
 *     has 11 slices of itself living in rows that also carry panel digits.
 *     Every time a digit changes, that row is erased, taking the face slice on
 *     it with it, and the face only gets redrawn if its own line changed. That
 *     is the striping and clipping you get from drawing the face as one block.
 *   - One image per row means a row only ever carries its own slice, so
 *     repainting a row redraws that slice. Nothing can carve holes in the face.
 *   - pi-tui only tolerates multi-row images when the following lines are empty
 *     (see getKittyImageReservedRows), which a panel bar can never satisfy. A
 *     one-cell-tall image is just a normal line to pi-tui.
 *   - The cursor stays honest: iTerm2 emits a linefeed per row only for a
 *     multi-row image (VT100InlineImageHelper -writeBaseCharacter), so a
 *     one-cell-tall image leaves the cursor on its own line, and it advances
 *     only horizontally, which the next line's \r\n discards anyway.
 *
 * The text fallback uses the Unicode upper-half block (▀), with independent
 * truecolor samples for the top and bottom half of each cell. This follows the
 * same rendering approach as pi-doom and gives each terminal column its own
 * horizontal sample, while keeping each rendered pixel close to square. It also
 * avoids braille's font-dependent, sparse dot patterns.
 *
 * The pixel face is the default where Pi reports image support. Use /doomhud text
 * to switch to the half-block fallback, or /doomhud image to retry the pixel face.
 *
 *   faces/ holds the exact Doom health faces:
 *     tier1..tier5  ×  left / neutral / right / focus
 *     dead.png   → while a compaction is running
 *
 *   There is no separate "fresh" face: an empty context is just full health, so
 *   a new session shows the healthiest tier like any other healthy session.
 * Data mapping (real session stats, from pi's context + session entries).
 * What each panel actually holds:
 *   CONTEXT = context usage %, driving both the display and the face tier
 *   TOKENS  = the model's context window (the capacity CONTEXT is a % of)
 *   MODEL   = the model id (wrapped on "-"), the thinking level on a line
 *             beneath it, and the provider underneath that
 *   COST    = session spend in USD, three decimals, as the big value.
 *             Includes assistant + toolResult usage, compaction and
 *             branch-summary calls, and subagent spend resolved from the
 *             pi-subagents artifacts, so it matches pi's own footer
 *   right tile rows: session-wide token economics, recomputed as the session runs
 *     CACHE   = latest cache-read count plus the last-turn cache-write delta;
 *               this is activity, not the provider's resident cache size.
 *     CACHE READ / CACHE WRITE / IN / OUT = token count plus spend for each bucket
 *     BLENDED = usage cost per million billed tokens; OTHER shows unbucketed spend.
 *
 * Context colours follow pi's footer thresholds: 90%+ red, 70%+ amber,
 * otherwise green, with a dim dash when usage is unknown (right after a
 * compaction, before the next response).
 * The face itself still runs on remaining health (100 − usage), so it degrades
 * as the window fills.
 *
 * The source PNGs have a Doom-cyan background; it's made transparent at load
 * time (including the anti-aliased cyan ring + cool-tint recolor) so no teal
 * halo shows.
 *
 * This extension renders as a single belowEditor widget that owns the whole bar.
 *
 * Commands:
 *   /doomhud        toggle the HUD on/off
 *   /doomhud image  force the real pixel face (where supported)
 *   /doomhud text   force the half-block face
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { encodeKitty, getCapabilities, getCellDimensions, visibleWidth } from "@earendil-works/pi-tui";
import { readFile, readdir } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync, deflateSync } from "node:zlib";
import { execSync } from "node:child_process";
import { billedTokenCount, blendedCostPerMillion } from "./token-economics.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── PNG decoding ─────────────────────────────────────────────────────────────
interface DecodedPng {
	width: number;
	height: number;
	channels: number; // 3 or 4
	data: Uint8Array; // raw RGB/RGBA scanlines
}

function decodePng(buf: Buffer): DecodedPng {
	// Reject anything that is not a PNG up front; the rest of this function
	// trusts the offsets it reads.
	const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	for (let i = 0; i < PNG_SIG.length; i++) {
		if (buf[i] !== PNG_SIG[i]) throw new Error("not a PNG");
	}
	let off = 8;
	let width = 0, height = 0, bitDepth = -1, colorType = -1, interlace = -1;
	const idat: Buffer[] = [];
	while (off + 8 <= buf.length) {
		const len = buf.readUInt32BE(off);
		// Every chunk needs its 12 bytes of length/type/CRC plus the payload.
		if (len > buf.length - off - 12) throw new Error("truncated PNG chunk");
		const type = buf.slice(off + 4, off + 8).toString("ascii");
		if (type === "IHDR") {
			if (len < 13) throw new Error("short IHDR");
			width = buf.readUInt32BE(off + 8);
			height = buf.readUInt32BE(off + 12);
			bitDepth = buf[off + 16]!;
			colorType = buf[off + 17]!;
			interlace = buf[off + 20]!;
		} else if (type === "IDAT") {
			idat.push(buf.slice(off + 8, off + 8 + len));
		}
		off += 12 + len;
		if (type === "IEND") break;
	}
	if (width <= 0 || height <= 0) throw new Error("PNG has no usable dimensions");
	// Only the layouts the face sprites actually use are supported: 8-bit
	// truecolour with or without alpha, and never interlaced. Anything else used
	// to be silently misread as 3-channel data (a palette PNG would decode to
	// garbage), so fail loudly instead.
	if (colorType !== 2 && colorType !== 6) {
		throw new Error(`unsupported PNG colour type ${colorType} (need 2=RGB or 6=RGBA)`);
	}
	if (bitDepth !== 8) {
		throw new Error(`unsupported PNG bit depth ${bitDepth} (need 8)`);
	}
	if (interlace !== 0) {
		throw new Error("interlaced PNGs are not supported");
	}
	const channels = colorType === 6 ? 4 : 3;
	if (idat.length === 0) throw new Error("PNG has no image data");
	const raw = inflateSync(Buffer.concat(idat));
	const bpp = channels;
	const stride = width * bpp;
	// Each scanline carries a leading filter byte.
	if (raw.length < (stride + 1) * height) throw new Error("truncated PNG scanlines");
	const out = Buffer.alloc(height * stride);
	let prev = Buffer.alloc(stride);
	let p = 0;
	for (let y = 0; y < height; y++) {
		const ft = raw[p++]!;
		if (ft > 4) throw new Error(`unsupported PNG filter ${ft}`);
		const cur = Buffer.alloc(stride);
		for (let x = 0; x < stride; x++) {
			const a = x >= bpp ? cur[x - bpp]! : 0;
			const b = prev[x]!;
			const c = x >= bpp ? prev[x - bpp]! : 0;
			let v = raw[p++]!;
			switch (ft) {
				case 0: break;
				case 1: v = (v + a) & 255; break;
				case 2: v = (v + b) & 255; break;
				case 3: v = (v + ((a + b) >> 1)) & 255; break;
				case 4: {
					const pp = a + b - c;
					const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
					const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
					v = (v + pr) & 255; break;
				}
			}
			cur[x] = v;
		}
		cur.copy(out, y * stride);
		prev = cur;
	}
	return { width, height, channels, data: new Uint8Array(out) };
}

// ── Sprite data ──────────────────────────────────────────────────────────────
interface Frame {
	name: string;
	width: number;  // cropped pixel size
	height: number;
	fbPx: number[]; // flat [r,g,b] per pixel
	fbA: number[];  // flat alpha 0-255 per pixel
}

const TIERS = [1, 2, 3, 4, 5] as const;
// The five Doom health bands the face tiers map onto. Only the count is used:
// HEALTHY, HIT, HURT, WOUNDED, CRITICAL.
const BAND_COUNT = 5;
// Bar height in terminal rows. The widget is a *component* widget, so it is NOT
// line-capped to 10 rows, and height is what buys face detail: more bar rows
// means more face rows.
const HUD_ROWS = 13;
// The text fallback is one sample wide per terminal column. A modest horizontal
// stretch gives the compact portrait more of the broad, square Doom status-face
// proportions without changing the image-protocol rendering.
const TEXT_FACE_ASPECT_SCALE = 1.25;

// ── Doom HUD palette ───────────────────────────────────────────────────────
// The classic Doom status bar: dark gunmetal steel panels with a beveled
// rim, bright red digital numbers, and white/grey labels. Rendered with
// 24-bit ANSI truecolor (iTerm2/Kitty support it), so the steel and red read
// exactly like the game.
const HUD = {
	steel: { r: 60, g: 60, b: 66 },       // panel fill
	steelDark: { r: 38, g: 38, b: 44 },   // bevel shadow (bottom/right)
	steelLight: { r: 96, g: 96, b: 104 }, // bevel highlight (top/left)
	steelTex: { r: 55, g: 55, b: 61 },    // speckle shade, for the metal grime
	bg: { r: 24, g: 24, b: 28 },          // gutter between panels
	red: { r: 214, g: 26, b: 20 },        // digital numbers
	white: { r: 224, g: 220, b: 210 },    // labels
	grey: { r: 150, g: 148, b: 142 },     // dim labels / separators
	green: { r: 104, g: 196, b: 88 },     // context comfortable (success)
	amber: { r: 226, g: 156, b: 32 },     // context filling up (warning)
	dim: { r: 108, g: 106, b: 102 },      // no reading at all
	// Doom keeps the headline stats red and the detail counts gold, which is
	// also the hierarchy this bar wants: five big numbers shouting, four small
	// ones informing.
	gold: { r: 232, g: 200, b: 96 },      // detail numbers (the ammo-count yellow)
};

/**
 * Colour for a context-usage percentage. Same thresholds as pi's footer:
 * 90% and up is error/red, 70% and up is warning/amber, anything lower is
 * success/green. A null percent (right after a compaction, before the next
 * response) has no reading at all, so it draws dim there too.
 */
function contextColor(percent: number | null): { r: number; g: number; b: number } {
	if (percent == null) return HUD.dim;
	return percent >= 90 ? HUD.red : percent >= 70 ? HUD.amber : HUD.green;
}

/**
 * True for the Doom-cyan / transparent / near-black background.
 * Also catches the anti-aliased cyan ring at the face edges (green + blue
 * both clearly above red) so no teal halo shows around the face.
 */
function isBg(r: number, g: number, b: number, alpha: number): boolean {
	if (alpha < 8) return true; // fully transparent
	if (r < 8 && g < 8 && b < 8) return true; // near-black
	// Cyan/teal background signature. The Doom bg is cyan (0,255,255) = green
	// and blue both above red. When it blends toward the dark terminal
	// background, blue can dip a touch below green, so we key off GREEN clearly
	// beating red (the cyan's green component), with blue roughly keeping up,
	// and a "not warm" guard so we never eat warm skin (where red is close to
	// green). A teal edge is g>=b>r-ish; skin is r>g>b (red dominates, warm).
	if (g > r + 4 && b > r - 8 && (r - b) < 30 && g >= b - 35) return true;
	return false;
}

/**
 * The interior test: `isBg` without the near-black rule.
 *
 * The backdrop of this art is cyan, not black, so a near-black run *inside* the
 * sprite is the artist's own black, not background. That distinction matters:
 * the tier1 brow arcs contain genuinely black pixels (1,0,0 / 4,3,0 / 7,4,1),
 * and calling those background punches 85 holes through tier1_left's eyebrows
 * and 95 through tier1_right's, while tier2_left has none. The holes show the
 * steel panel through the brow, which is the eroded, speckled look on the tier1
 * faces. The near-black rule still applies along the outline, through
 * isBgAggressive, where a blend toward the dark terminal background really can
 * leave near-black pixels.
 */
function isBgInterior(r: number, g: number, b: number, alpha: number): boolean {
	if (alpha < 8) return true;
	if (g > r + 4 && b > r - 8 && (r - b) < 30 && g >= b - 35) return true;
	return false;
}

/**
 * Aggressive background test, used only along the face outline (within the
 * border margin in loadFace). The remnant pixels there are muddy cyan blends
 * (cyan mixed with the dark terminal bg) where green is the dominant channel
 * and the tone is "cool". Any pixel that is NOT clearly warm skin (red clearly
 * dominating both green and blue) is treated as background. This is safe at
 * the border because the only non-skin pixels there are the cyan blends and
 * dark hair/shadow.
 */
function isBgAggressive(r: number, g: number, b: number, alpha: number): boolean {
	if (alpha < 8) return true;
	if (r < 8 && g < 8 && b < 8) return true;
	// Clearly warm skin: red dominates green AND blue by a comfortable margin.
	// Everything else along the border is cyan-blend or dark → background.
	const warm = r > g + 18 && r > b + 18;
	return !warm;
}

/** A decoded sprite plus the box its content was detected in. */
interface DecodedFace {
	name: string;
	img: DecodedPng;
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

/** The crop box that every frame shares. */
interface FaceBox { x0: number; y0: number; x1: number; y1: number; }

/** Decode a sprite and find its content box (everything that isn't background). */
async function decodeFace(path: string, name: string): Promise<DecodedFace | null> {
	try {
		const img = decodePng(await readFile(path));
		const ch = img.channels;
		let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1;
		for (let y = 0; y < img.height; y++)
			for (let x = 0; x < img.width; x++) {
				const o = (y * img.width + x) * ch;
				if (isBg(img.data[o]!, img.data[o + 1]!, img.data[o + 2]!, ch === 4 ? img.data[o + 3]! : 255)) continue;
				if (x < x0) x0 = x;
				if (x > x1) x1 = x;
				if (y < y0) y0 = y;
				if (y > y1) y1 = y;
			}
		if (x1 < x0 || y1 < y0) return null;
		return { name, img, x0, y0, x1, y1 };
	} catch {
		return null;
	}
}

/**
 * Cut one frame out of a decoded sprite, key the background out, and repair the
 * cool-tinted blend pixels along the outline.
 *
 * Every frame is cut with the SAME box, on purpose. Cropping each frame to its
 * own content box makes the head land a few pixels differently in each one (the
 * detected edges differ by up to six pixels between tiers), so the face visibly
 * shifts and changes size as the brow animates and as the health band changes.
 * One shared box keeps the head nailed in place for every frame.
 */
function cropFace(d: DecodedFace, box: FaceBox): Frame {
	const img = d.img;
	const ch = img.channels;
	const w = box.x1 - box.x0 + 1, h = box.y1 - box.y0 + 1;
	const fbPx = new Array<number>(w * h * 3);
	const fbA = new Array<number>(w * h);
	// Border margin: the muddy cyan-blend pixels live along the face outline
	// (within a few px of the box edge). Inside that margin we use an aggressive
	// "cool tone" test (any pixel that isn't clearly warm skin is treated as
	// background). Deeper inside we use the strict cyan test so we never eat
	// legitimate skin or shadow.
	const MARGIN = 10;
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const sx = box.x0 + x, sy = box.y0 + y;
			const o = (sy * img.width + sx) * ch;
			const r = img.data[o]!, g = img.data[o + 1]!, b = img.data[o + 2]!;
			const a = ch === 4 ? img.data[o + 3]! : 255;
			const di = y * w + x;
			fbPx[di * 3] = r;
			fbPx[di * 3 + 1] = g;
			fbPx[di * 3 + 2] = b;
			const nearEdge = Math.min(x, y, w - 1 - x, h - 1 - y) < MARGIN;
			fbA[di] = (nearEdge ? isBgAggressive(r, g, b, a) : isBgInterior(r, g, b, a)) ? 0 : a;
		}

	// ── Cool-tint recolor ────────────────────────────────────────────────────
	// The source has blend pixels where green or blue edges up above red (olive
	// from cyan mixing toward the dark terminal bg). Some are bright (#7d845f
	// family), some are dark-cool (near-black where blue/green slightly exceed
	// red). These sit where the jaw/hair shadow meets the background, so deleting
	// them would notch the face. Instead we recolor each cool-tinted survivor to
	// the average of its warm neighbors, so it blends into the surrounding
	// skin/shadow. No face pixels are removed. A pixel is "cool-tinted" when green
	// OR blue exceeds red by a real margin; neutral near-black shadows (r≈g≈b) are
	// left alone.
	const isCoolTinted = (r: number, g: number, b: number, a: number): boolean => {
		if (a < 8) return false;
		if (r < 6 && g < 6 && b < 6) return false; // pure black isn't tinted
		// green clearly beats red, OR blue beats red
		if (g >= r + 2) return true;
		if (b >= r + 2) return true;
		// olive: green ≈ red but both well above blue (the #7d845f cast)
		if (g >= r && (r - b) >= 8 && g > b + 4) return true;
		return false;
	};
	// Only the anti-aliased ring where the art meets the background can hold a
	// cyan blend, so that is the only place this repair is allowed to run. The
	// test is far too loose to use on interior pixels: the tier1 eye socket is a
	// dark, faintly blue shadow (28,31,33) that trips it, and replacing it with
	// the average of its neighbours (which include the near-black lash and pupil)
	// stamps a solid 10x4 near-black block over the eye, welding separate lash and
	// pupil shapes into one black mass. That block is the blocky black smudge on
	// the tier1 brow. Gating on distance to the background keeps the ring clean
	// and leaves interior art exactly as it was drawn.
	const RING_RADIUS = 2;
	const nearBg = new Uint8Array(w * h);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			if (fbA[y * w + x] !== 0) continue;
			for (let dy = -RING_RADIUS; dy <= RING_RADIUS; dy++) {
				const ny = y + dy;
				if (ny < 0 || ny >= h) continue;
				for (let dx = -RING_RADIUS; dx <= RING_RADIUS; dx++) {
					const nx = x + dx;
					if (nx < 0 || nx >= w) continue;
					nearBg[ny * w + nx] = 1;
				}
			}
		}
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const di = y * w + x;
			if (fbA[di] === 0) continue; // background
			if (!nearBg[di]) continue; // interior art is never rewritten
			const r = fbPx[di * 3]!, g = fbPx[di * 3 + 1]!, b = fbPx[di * 3 + 2]!;
			if (!isCoolTinted(r, g, b, fbA[di]!)) continue;
			// Average the warm (non-green, non-bg) neighbors.
			let sr = 0, sg = 0, sb = 0, n = 0;
			for (let dy = -1; dy <= 1; dy++)
				for (let dx = -1; dx <= 1; dx++) {
					if (dx === 0 && dy === 0) continue;
					const nx = x + dx, ny = y + dy;
					if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
					const ni = ny * w + nx;
					if (fbA[ni] === 0) continue;
					const nr = fbPx[ni * 3]!, ng = fbPx[ni * 3 + 1]!, nb = fbPx[ni * 3 + 2]!;
					if (isCoolTinted(nr, ng, nb, fbA[ni]!)) continue;
					sr += nr; sg += ng; sb += nb; n++;
				}
			if (n > 0) {
					fbPx[di * 3] = sr / n;
					fbPx[di * 3 + 1] = sg / n;
					fbPx[di * 3 + 2] = sb / n;
				} else {
					// No warm neighbor (isolated): nudge toward brown.
					fbPx[di * 3] = Math.min(255, r + 8);
					fbPx[di * 3 + 1] = Math.max(0, g - 6);
					fbPx[di * 3 + 2] = Math.max(0, b - 4);
				}
		}
	return { name: d.name, width: w, height: h, fbPx, fbA };
}

export async function loadFrames(): Promise<Map<string, Frame>> {
	const dir = join(__dirname, "faces");
	const names: string[] = [
		...TIERS.flatMap((t) => [`tier${t}_left`, `tier${t}_neutral`, `tier${t}_right`, `tier${t}_focus`]),
		"dead",
	];
	const decoded = (await Promise.all(names.map((n) => decodeFace(join(dir, `${n}.png`), n))))
		.filter((d): d is DecodedFace => d !== null);
	const map = new Map<string, Frame>();
	if (decoded.length === 0) return map;
	// One box for every frame: the union of all detected content.
	const box: FaceBox = {
		x0: Math.min(...decoded.map((d) => d.x0)),
		y0: Math.min(...decoded.map((d) => d.y0)),
		x1: Math.max(...decoded.map((d) => d.x1)),
		y1: Math.max(...decoded.map((d) => d.y1)),
	};
	for (const d of decoded) map.set(d.name, cropFace(d, box));
	return map;
}

/**
 * Widest head aspect across the loaded frames. Panels are sized from this
 * rather than from the frame on screen, because the per-frame crop widths
 * differ by a few pixels and a panel that resized mid-animation would shimmy
 * the whole bar sideways.
 */
function stableFaceAspect(frames: Map<string, Frame>): number {
	let aspect = 0;
	for (const f of frames.values()) {
		if (f.height > 0) aspect = Math.max(aspect, f.width / f.height);
	}
	return aspect > 0 ? aspect : 0.8;
}

// git branch per cwd. Cached, because running git on every refresh keeps the
// UI from falling behind in non-repo directories, but entries expire after a
// short TTL so switching branches mid-session is still picked up. Bounded, so
// visiting hundreds of directories over a long session cannot grow it forever.
const GIT_BRANCH_TTL_MS = 30_000;
const GIT_BRANCH_CACHE_MAX = 64;
const gitBranchCache = new Map<string, { branch: string; at: number }>();

/** Doom's exact pain-level formula (st_stuff.c ST_calcPainOffset). */
function bandFor(usage: number): number {
	const health = 100 - usage;
	if (health <= 0) return BAND_COUNT; // no health left: clamp to the worst tier
	const pain = Math.min(BAND_COUNT - 1, Math.max(0, ((100 - health) * 5) / 101 | 0));
	return pain;
}

// ── HUD data ─────────────────────────────────────────────────────────────────
/** The slice of an assistant message's usage this HUD reads. */
interface AssistantUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
}

interface TurnCostDelta {
	input: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
	other: number;
	total: number;
	cacheWriteTokens: number;
}

/** Everything the status bar needs, gathered from the live context + entries. */
export interface HudData {
	health: number;          // 0-100, 100 − context usage % (drives the face tier)
	usagePct: number | null; // 0-100 context usage, or null when unknown
	contextTokens: number | null; // current context occupancy, used for test overrides
	window: number;          // model context window in tokens (the TOKENS tile)
	cost: number;            // session cost USD, the COST tile's big number
	costDelta?: number;      // usage cost from the latest completed agent run
	// Right-hand tile rows: label plus token/cost data, sharing aligned columns.
	stats: { label: string; value: string; deltaCost?: number; deltaTokens?: number }[];
	modelId: string;       // the model id, the MODEL tile's big value (wraps on '-')
	thinking: string;      // thinking level, the MODEL tile's line under the name
	provider: string;      // model provider, the MODEL tile's caption
	branch: string;        // git branch ("" if none)
	dir: string;           // cwd basename
}

function finiteNumber(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Cost accumulated by assistant and nested tool usage in one completed agent run. */
function turnCostDeltaFromMessages(messages: readonly unknown[]): TurnCostDelta | null {
	const delta: TurnCostDelta = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, other: 0, total: 0, cacheWriteTokens: 0 };
	let foundUsage = false;
	for (const item of messages) {
		const message = item as Record<string, any>;
		if (message.role !== "assistant" && message.role !== "toolResult") continue;
		const usage = message.usage as AssistantUsage | undefined;
		if (!usage) continue;
		const writeTokens = finiteNumber(usage.cacheWrite) ?? 0;
		const input = finiteNumber(usage.cost?.input) ?? 0;
		const cacheRead = finiteNumber(usage.cost?.cacheRead) ?? 0;
		const cacheWrite = finiteNumber(usage.cost?.cacheWrite) ?? 0;
		const output = finiteNumber(usage.cost?.output) ?? 0;
		const total = finiteNumber(usage.cost?.total) ?? input + cacheRead + cacheWrite + output;
		delta.input += input;
		delta.cacheRead += cacheRead;
		delta.cacheWrite += cacheWrite;
		delta.output += output;
		delta.other += Math.max(0, total - input - cacheRead - cacheWrite - output);
		delta.total += total;
		delta.cacheWriteTokens += writeTokens;
		foundUsage = true;
	}
	return foundUsage ? delta : null;
}

/**
 * Gather all the live stats the HUD needs. Mirrors pi's footer logic for cost
 * (session entries + subagent artifacts) and adds token/usage/tool/message
 * counts. Everything is guarded so a missing model/usage/branch never throws.
 */
function collectHudData(
	ctx: ExtensionContext,
	entries: readonly unknown[],
	subagentCost: number,
	turnDelta: TurnCostDelta | null = null,
): HudData {
	const usage = ctx.getContextUsage();
	const usagePct = usage?.percent != null ? Math.round(usage.percent) : null;
	const contextTokens = finiteNumber(usage?.tokens) ?? null;
	// The face still runs on remaining health, so unknown usage counts as full
	// health (a fresh window) rather than no health.
	const health = Math.max(0, Math.min(100, 100 - (usagePct ?? 0)));

	// Cumulative session totals. CACHE and BLENDED use the same session window;
	// Pi's footer CH value is per-request and can differ.
	let tokensIn = 0;
	let tokensOut = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let latestCacheRead: number | null = null;
	let billedTokens = 0;
	let inputCost = 0;
	let outputCost = 0;
	let cacheReadCost = 0;
	let cacheWriteCost = 0;
	let cost = 0;
	// Spend and provider-reported token totals from every usage-bearing entry.
	// Subagent spend is separate because its token counts are unavailable here.
	let tokenCost = 0;
	const addUsage = (u: AssistantUsage | undefined): void => {
		if (!u) return;
		const input = finiteNumber(u.input) ?? 0;
		const output = finiteNumber(u.output) ?? 0;
		const cacheReadTokens = finiteNumber(u.cacheRead) ?? 0;
		const cacheWriteTokens = finiteNumber(u.cacheWrite) ?? 0;
		tokensIn += input;
		tokensOut += output;
		cacheRead += cacheReadTokens;
		cacheWrite += cacheWriteTokens;
		billedTokens += billedTokenCount({
			input,
			output,
			cacheRead: cacheReadTokens,
			cacheWrite: cacheWriteTokens,
		});
		const inputCostPart = finiteNumber(u.cost?.input) ?? 0;
		const outputCostPart = finiteNumber(u.cost?.output) ?? 0;
		const cacheReadCostPart = finiteNumber(u.cost?.cacheRead) ?? 0;
		const cacheWriteCostPart = finiteNumber(u.cost?.cacheWrite) ?? 0;
		inputCost += inputCostPart;
		outputCost += outputCostPart;
		cacheReadCost += cacheReadCostPart;
		cacheWriteCost += cacheWriteCostPart;
		tokenCost += finiteNumber(u.cost?.total)
			?? inputCostPart + outputCostPart + cacheReadCostPart + cacheWriteCostPart;
	};
	for (const e of entries) {
		const entry = e as Record<string, any>;
		if (entry.type !== "message") {
			// Compaction and tree-summarisation calls are billed too. pi's footer
			// counts them, so the HUD has to as well or COST silently under-reports
			// every time a long session compacts.
			if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") {
				addUsage(entry.usage as AssistantUsage | undefined);
			}
			continue;
		}
		const msg = entry.message as Record<string, any> | undefined;
		if (msg?.role === "assistant") {
			const assistantUsage = (msg as { usage?: AssistantUsage }).usage;
			addUsage(assistantUsage);
			latestCacheRead = assistantUsage ? finiteNumber(assistantUsage.cacheRead) ?? 0 : null;
		} else if (msg?.role === "toolResult") {
			// Nested tool LLM usage, if pi folded any onto the message.
			addUsage((msg as { usage?: AssistantUsage }).usage);
		}
	}
	cost = tokenCost + subagentCost;

	const window = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	const thinking = ctx.thinkingLevel ?? "off";

	// Show every billed bucket beside its cost so the main COST amount can be
	// audited. Amounts use three decimals to match the COST panel.
	const tokenColumnWidth = Math.max(
		...[tokensIn, cacheRead, cacheWrite, tokensOut].map((n) => fmtUsageTokens(n).length),
	);
	const tokenCostValue = (tokens: number, amount: number): string =>
		`${fmtUsageTokens(tokens).padStart(tokenColumnWidth)} $${amount.toFixed(3)}`;
	const perMillion = blendedCostPerMillion(tokenCost, billedTokens);
	const bucketCost = inputCost + cacheReadCost + cacheWriteCost + outputCost;
	const otherCost = Math.max(0, cost - bucketCost);
	const latestCacheValue = (latestCacheRead == null ? "---" : fmtUsageTokens(latestCacheRead)).padStart(tokenColumnWidth);
	const stats = [
		{ label: "CACHE", value: latestCacheValue, deltaTokens: turnDelta?.cacheWriteTokens },
		{ label: "CACHE READ", value: tokenCostValue(cacheRead, cacheReadCost), deltaCost: turnDelta?.cacheRead },
		{ label: "CACHE WRITE", value: tokenCostValue(cacheWrite, cacheWriteCost), deltaCost: turnDelta?.cacheWrite },
		{ label: "IN", value: tokenCostValue(tokensIn, inputCost), deltaCost: turnDelta?.input },
		{ label: "OUT", value: tokenCostValue(tokensOut, outputCost), deltaCost: turnDelta?.output },
		{ label: "BLENDED", value: perMillion > 0 ? `$${perMillion.toFixed(3)}/M` : "---" },
	];
	if (otherCost > 0.0000005) stats.push({ label: "OTHER", value: `$${otherCost.toFixed(3)}`, deltaCost: turnDelta?.other });

	// The MODEL tile shows the model id, broken on "-", with the thinking level
	// on its own line underneath and the provider beneath that.
	const modelId = ctx.model ? ctx.model.id : "no-model";
	const provider = ctx.model?.provider ?? "";

	// Git branch (best-effort, sync, cheap, guarded). Empty if not a repo.
	// stderr is discarded so a non-repo cwd doesn't spam "fatal: not a git
	// repository" on every refresh, and the result is cached per cwd with a
	// short TTL so a branch switch shows up within half a minute.
	const now = Date.now();
	const cached = gitBranchCache.get(ctx.cwd);
	let branch: string;
	if (cached && now - cached.at < GIT_BRANCH_TTL_MS) {
		branch = cached.branch;
	} else {
		branch = "";
		try {
			branch = execSync("git branch --show-current", {
				cwd: ctx.cwd, encoding: "utf8", timeout: 800,
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
		} catch {
			branch = "";
		}
		gitBranchCache.set(ctx.cwd, { branch, at: now });
		if (gitBranchCache.size > GIT_BRANCH_CACHE_MAX) {
			// Drop the oldest insertion (and any entry already past its TTL).
			for (const [key, entry] of gitBranchCache) {
				if (key !== ctx.cwd && (now - entry.at >= GIT_BRANCH_TTL_MS || gitBranchCache.size > GIT_BRANCH_CACHE_MAX)) {
					gitBranchCache.delete(key);
				}
				if (gitBranchCache.size <= GIT_BRANCH_CACHE_MAX) break;
			}
		}
	}

	return {
		health,
		usagePct,
		contextTokens,
		window,
		cost,
		costDelta: turnDelta?.total,
		stats,
		modelId,
		thinking,
		provider,
		branch,
		dir: basename(ctx.cwd),
	};
}

// ── Subagent cost ────────────────────────────────────────────────────────────
// Each pi-subagents child runs as its own pi process, so its spend never lands
// in this session's entries. The artifacts pi-subagents persists record usage
// per model attempt, so the cost is resolved from those. Without it the HUD's
// COST panel under-reports whenever subagents do any real work.
const subagentCostCache = new Map<string, number>();
/** Runs whose artifacts are missing (cached 0) or currently being read. */
const subagentCostSettled = new Set<string>();
let subagentLoad: Promise<void> | undefined;
/** Session file the caches belong to; a session switch drops stale entries. */
let costSessionFile: string | undefined;
/**
 * Bumped whenever the caches are dropped for a new session. In-flight artifact
 * reads capture it, so a load that started before a session switch cannot write
 * the old session's runs into the new session's totals.
 */
let costGeneration = 0;
/**
 * How many times a run's artifacts are looked for before giving up. An async
 * run's artifact appears a moment after it finishes, but a run whose artifact
 * never arrives must stop being retried on every refresh.
 */
const SUBAGENT_COST_MAX_ATTEMPTS = 5;
const subagentCostAttempts = new Map<string, number>();

/** Sum a child artifact's cost: meta.json records `modelAttempts[].usage.cost`. */
function subagentCostFromArtifact(meta: unknown): number {
	if (!meta || typeof meta !== "object") return 0;
	const attempts = (meta as Record<string, any>).modelAttempts;
	let total = 0;
	for (const attempt of Array.isArray(attempts) ? (attempts as Record<string, any>[]) : []) {
		total += finiteNumber((attempt.usage as Record<string, any> | undefined)?.cost) ?? 0;
	}
	return total;
}

/** Sibling artifacts dir pi-subagents uses for a session file. */
function artifactsDir(sessionFile: string | undefined): string | undefined {
	return sessionFile ? join(dirname(sessionFile), "subagent-artifacts") : undefined;
}

function resetCostCacheForSession(sessionFile: string | undefined): void {
	if (sessionFile === costSessionFile) return;
	costSessionFile = sessionFile;
	costGeneration++;
	subagentCostCache.clear();
	subagentCostSettled.clear();
	subagentCostAttempts.clear();
}

/** Total resolved subagent spend. Read synchronously to build the HUD. */
function subagentCostTotal(): number {
	let total = 0;
	for (const c of subagentCostCache.values()) total += c;
	return total;
}

/**
 * Resolve one run's cost from its artifact(s), then cache it. Never throws: a
 * missing pi-subagents install, a cleaned-up artifact dir or a corrupt file all
 * resolve to 0 rather than breaking the render.
 */
async function resolveRunCost(runId: string, metaPaths: string[]): Promise<number> {
	if (subagentCostCache.has(runId)) return subagentCostCache.get(runId) ?? 0;
	if (subagentCostSettled.has(runId)) return 0;

	// The session can switch while these reads are in flight, in which case the
	// result belongs to a session that is no longer on screen.
	const generation = costGeneration;
	let total = 0;
	let foundAny = false;
	let dirExists = true;
	const read = new Set<string>();
	const readArtifact = async (p: string): Promise<void> => {
		if (read.has(p)) return; // the same artifact can surface twice
		read.add(p);
		try {
			total += subagentCostFromArtifact(JSON.parse(await readFile(p, "utf8")));
			foundAny = true;
		} catch {
			// Ignore unreadable or missing meta.
		}
	};

	// 1. Direct metadata paths recorded on subagent_wait completions for this run.
	for (const p of metaPaths) await readArtifact(p);
	// 2. Fallback: glob the artifacts dir by run id prefix.
	const dir = artifactsDir(costSessionFile);
	if (dir) {
		try {
			for (const name of await readdir(dir)) {
				if (!name.startsWith(runId) || !name.endsWith("meta.json")) continue;
				await readArtifact(join(dir, name));
			}
		} catch {
			dirExists = false; // no artifacts dir -> pi-subagents is not installed
		}
	}

	if (generation !== costGeneration) return 0; // session moved on; drop it

	const attempts = (subagentCostAttempts.get(runId) ?? 0) + 1;
	subagentCostAttempts.set(runId, attempts);
	if (foundAny) {
		subagentCostCache.set(runId, total);
		subagentCostSettled.add(runId);
	} else if ((!dirExists && metaPaths.length === 0) || attempts >= SUBAGENT_COST_MAX_ATTEMPTS) {
		subagentCostSettled.add(runId); // nothing to find, or it is never arriving
	}
	// Otherwise leave it unsettled: an async run may still be writing its artifact.
	return subagentCostCache.get(runId) ?? total;
}

/**
 * Collect candidate subagent runs from session entries, mapping each run id to
 * the direct metadata paths belonging to it.
 */
function collectSubagentRuns(entries: readonly unknown[]): Map<string, string[]> {
	const runMetas = new Map<string, string[]>();
	const pushRun = (id: unknown, metaPath?: string) => {
		if (typeof id !== "string" || !id) return;
		const list = runMetas.get(id) ?? [];
		if (metaPath && !list.includes(metaPath)) list.push(metaPath);
		runMetas.set(id, list);
	};
	for (const e of entries) {
		const entry = e as Record<string, any>;
		if (entry.type !== "message") continue;
		const msg = entry.message as Record<string, any> | undefined;
		if (msg?.role !== "toolResult") continue;
		if (msg.toolName !== "subagent" && msg.toolName !== "subagent_wait") continue;
		const d = msg.details as Record<string, any> | undefined;
		if (!d || typeof d !== "object") continue;
		pushRun(d.runId);
		pushRun(d.asyncId);
		for (const r of Array.isArray(d.results) ? d.results : []) pushRun((r as Record<string, any>)?.runId);
		for (const c of Array.isArray(d.completions) ? d.completions : []) {
			const comp = c as Record<string, any>;
			const metaPath = (comp.results?.[0] as Record<string, any> | undefined)?.artifactPaths?.metadataPath;
			pushRun(comp.runId, typeof metaPath === "string" ? metaPath : undefined);
		}
	}
	return runMetas;
}

/**
 * Fire-and-forget resolution of any not-yet-cached run, then hand control back
 * so the bar can redraw with the new total.
 */
function loadSubagentCosts(entries: readonly unknown[], onDone: () => void): void {
	if (subagentLoad) return; // single-flight
	const runMetas = collectSubagentRuns(entries);
	const pending = [...runMetas.keys()].filter((id) => !subagentCostSettled.has(id) && !subagentCostCache.has(id));
	if (pending.length === 0) return;
	const generation = costGeneration;
	subagentLoad = (async () => {
		for (const id of pending) await resolveRunCost(id, runMetas.get(id) ?? []);
	})().finally(() => {
		subagentLoad = undefined;
		// A session switch while this was running makes the redraw pointless: the
		// new session already rendered its own totals.
		if (generation === costGeneration) onDone();
	});
}

// ── Animation singleton ──────────────────────────────────────────────────────
// The widget factory can be re-called by pi (theme change, reload), which would
// reset the animation. So all animation state and the tick timer live here.
const anim = {
	bandIndex: 0, // 0-4 = tier, 5 = no health left (clamped to tier 5)
	// Brow random-walk: browPos is 0=left, 1=neutral, 2=right. browDir is the
	// direction it's currently moving (1 = rightward, -1 = leftward). From a
	// neutral it rolls 70% turn / 30% continue, so the pattern changes
	// naturally instead of always doing the same L-N-R-N loop.
	browPos: 1,
	browDir: 1,
	browEnteredAt: 0, // when the brow entered its current position (for the hold timer)
	health: 100,
	enabled: true,
	// Prefer the pixel face. When the terminal has no image protocol, renderHudBar
	// automatically uses the half-block fallback; /doomhud text forces it.
	imageFace: true,
	healthOverride: null as number | null,
	overrideContextTokens: null as number | null,
	focusUntil: 0, focusName: "",
	compacting: false,
	timer: null as ReturnType<typeof setInterval> | null,
};

// Base tick interval. Side faces change at this rate. The neutral face
// lingers NEUTRAL_HOLD_MS (3x longer) before the next step, so the brow
// "rests" in the center like the classic Doom hold.
const SIDE_MS = 1520;
const NEUTRAL_MS = SIDE_MS * 3;
// Continue the current direction vs. reverse it, when the brow is at a
// neutral. The user wants turning (reverse) to be the more common outcome,
// so 70% reverse, 30% continue.
const BROW_TURN_CHANCE = 70;
const FOCUS_MIN_MS = 5000, FOCUS_MAX_MS = 15000;
// Chance, per brow step, of holding a "grunt focus" face. 1-in-12 comes round
// roughly every 35 seconds, so it is actually seen. The old 1-in-40 rolled about
// every two minutes, which reads as "never" in practice.
const FOCUS_CHANCE = 1 / 12;

function isSpecialStatic(): boolean {
	return anim.compacting;
}

/**
 * Advance the brow random-walk by one step.
 *  - At an edge (left/right) it must step back toward neutral.
 *  - At neutral it steps one way (toward left or right), choosing 70% to
 *    turn (reverse the current direction) and 30% to keep going. The chosen
 *    direction becomes the new browDir so the next neutral inherits it.
 *  - The neutral frame itself lingers 3x longer than a side frame before the
 *    next step, so the brow rests in the center.
 */
function stepBrow(): void {
	if (anim.browPos === 1) { // neutral → decide which way to go
		// 70% chance to turn (reverse the current direction), 30% to keep
		// going. The chosen direction becomes the new browDir so the next
		// neutral inherits it.
		const turn = Math.floor(Math.random() * 100) < BROW_TURN_CHANCE;
		anim.browDir = turn ? -anim.browDir : anim.browDir;
		anim.browPos = anim.browDir === 1 ? 2 : 0; // step toward right or left
	} else { // at an edge → step back toward neutral
		anim.browPos = 1;
	}
	anim.browEnteredAt = Date.now(); // restart the hold timer for the new position
}

/** Pick the frame name for the current animation state. */
function currentFaceName(): string {
	if (anim.compacting) return "dead";
	// No "fresh" face any more. A context at 0% is simply full health, so it
	// shows the healthiest tier and animates like any other. The band index is
	// clamped so a full context (health 0) shows the most damaged tier rather
	// than falling off the end of the list.
	const band = Math.min(anim.bandIndex, BAND_COUNT - 1);
	if (Date.now() < anim.focusUntil && anim.focusName) return anim.focusName;
	const kind = anim.browPos === 0 ? "left" : anim.browPos === 2 ? "right" : "neutral";
	return `tier${band + 1}_${kind}`;
}

// ── HUD bar layout ────────────────────────────────────────────────────────
// Build a grid of [height x width] cells, each with a foreground and
// background color. Panels are laid left→right; the face occupies the
// tall middle columns.
interface Cell { fg: { r: number; g: number; b: number } | null; bg: { r: number; g: number; b: number }; ch: string; bold?: boolean; }

/** An RGB triple used by the image-to-text renderers. */
type Col = [number, number, number];

function fillPanel(grid: Cell[][], x0: number, y0: number, w: number, h: number): void {
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const gx = x0 + x, gy = y0 + y;
			if (gx < 0 || gy < 0) continue;
			const top = y === 0, bot = y === h - 1, left = x === 0, right = x === w - 1;
			let bg = HUD.steel;
			if (top || left) bg = HUD.steelLight;
			if (bot || right) bg = HUD.steelDark;
			if (top && left) bg = HUD.steelLight;
			if (bot && right) bg = HUD.steelDark;
			// A sparse speckle of the alt shade, positioned by a cheap hash of the
			// absolute coordinates so it is stable frame to frame and continues across
			// panel seams. Roughly one cell in six, which reads as grime on the metal
			// rather than as a regular pattern.
			if (PANEL_TEXTURE && bg === HUD.steel && Math.abs(((gx * 73856093) ^ (gy * 19349663)) % 6) === 0) bg = HUD.steelTex;
			grid[gy]![gx] = { fg: null, bg, ch: " " };
		}
}

/**
 * Write 1-tall text at `(x, y)`. Cells at or past `maxX` are skipped, so a
 * long label on a narrow terminal cannot spill into the neighbouring panel.
 */
function putText(grid: Cell[][], x: number, y: number, text: string, fg: { r: number; g: number; b: number }, maxX = Infinity): void {
	for (let i = 0; i < text.length; i++) {
		const gx = x + i, gy = y;
		if (gx < 0 || gy < 0 || gx >= maxX) continue;
		const c = grid[gy]?.[gx];
		if (c) { c.fg = fg; c.ch = text[i]!; c.bg = HUD.steel; }
	}
}

/**
 * A small bitmap font for the big Doom-style readouts. Each glyph is five rows
 * tall and carries its own width in columns: `1` = filled cell, `0` = empty.
 * Widths vary because the percent sign needs five columns to read as two dots
 * with a slash between them, while a digit is happy at three.
 *
 * Adjacent glyphs are separated by GLYPH_GAP blank columns. Without that gap a
 * run like "180" welds into one slab, because every digit fills both its left
 * and right edge columns.
 */
const GLYPH: Record<string, string[]> = {
	"0": ["111", "101", "101", "101", "111"],
	"1": ["010", "110", "010", "010", "111"],
	"2": ["111", "001", "111", "100", "111"],
	"3": ["111", "001", "111", "001", "111"],
	"4": ["101", "101", "111", "001", "001"],
	"5": ["111", "100", "111", "001", "111"],
	"6": ["111", "100", "111", "101", "111"],
	"7": ["111", "001", "001", "001", "001"],
	"8": ["111", "101", "111", "101", "111"],
	"9": ["111", "101", "111", "001", "111"],
	// Two 2x2 dots with a slash between them. At three columns this collapses
	// into a vertical sliver that reads as part of the number next to it.
	"%": ["11001", "11010", "00100", "01011", "10011"],
	// Unit suffixes, so fmtNum's "18k" and "1.2m" are not drawn as blanks. The m
	// needs three stems to read as an m, and three stems need five columns: at
	// three columns the glyph is a two-stem arch, i.e. an n.
	"k": ["101", "110", "100", "110", "101"],
	"m": ["00000", "11111", "10101", "10101", "10101"],
	// A dollar sign is seven rows tall, one more than the digits, so the bar
	// through the S is visible above and below it. At five rows the bar can only
	// overlap the S's own strokes, which leaves a plain letter S. Column 2 is set
	// in every row, so the stroke is continuous.
	"$": ["00100", "01111", "10100", "01110", "00101", "11110", "00100"],
	"/": ["001", "001", "010", "100", "100"],
	"-": ["000", "000", "111", "000", "000"],
	".": ["000", "000", "000", "000", "010"],
	" ": ["000", "000", "000", "000", "000"],
};

/** Blank columns between adjacent glyphs. */
const GLYPH_GAP = 1;

/** Glyph rows for `ch`; anything unknown draws blank rather than throwing. */
function glyphRows(ch: string): string[] {
	return GLYPH[ch] ?? GLYPH[" "]!;
}

/** Total columns `text` occupies, gaps included. */
function bitmapWidth(text: string): number {
	let w = 0;
	for (const ch of text) w += glyphRows(ch)[0]!.length + GLYPH_GAP;
	return text ? w - GLYPH_GAP : 0;
}

/**
 * Trim `txt` to `maxW` columns for a caption. Trailing whole words go first, so
 * "claude-opus-4 high" degrades to "claude-opus-4" rather than "claude-opus-4 ";
 * only if a single word still overflows do we cut it mid-word.
 */
function fitCaption(txt: string, maxW: number): string {
	if (maxW <= 0) return "";
	if (txt.length <= maxW) return txt;
	let t = txt;
	while (t.length > maxW && t.includes(" ")) t = t.slice(0, t.lastIndexOf(" "));
	return t.slice(0, maxW);
}

/**
 * Split a long model id into as many lines as it needs at the given width,
 * breaking at "-" so a line never cuts through a segment mid-character. Each
 * line keeps as many whole segments as fit (a lone segment narrower than the
 * width stays, but is never split), and the remainder falls to the next line.
 *
 * "maxLines" bounds the count; a single oversized segment is hard-cut rather
 * than split, so the first line always carries as much of the name as it can.
 * A name that fits on one line comes back as that one line, untouched.
 */
function wrapModelName(id: string, maxW: number, maxLines: number): string[] {
	if (maxW <= 0 || maxLines <= 0) return [id];
	const parts = id.split("-");
	const out: string[] = [];
	let cur = "";
	for (const p of parts) {
		const piece = p.length;
		const add = cur ? 1 + piece : piece; // 1 for the joining "-"
		if (cur && cur.length + add > maxW) {
			if (out.length >= maxLines - 1) {
				// Last line is full: fold every remaining segment into it, keeping
				// the first one even if it alone is wider than the panel (a single
				// segment is never split mid-character).
				out[out.length - 1] = cur + "-" + p;
				return out;
			}
			out.push(cur);
			cur = p;
		} else {
			cur = cur ? cur + "-" + p : p;
		}
	}
	if (cur) out.push(cur);
	if (out.length === 0) out.push(id);
	return out;
}

/**
 * Hard-fit a single line of a wrapped model name, for the backstop where even
 * one segment is wider than the panel: cut it mid-character rather than drop it.
 */
function hardFitLine(line: string, maxW: number): string {
	if (maxW <= 0) return "";
	if (line.length <= maxW) return line;
	return line.slice(0, maxW);
}

/**
 * Render `text` as a bitmap-font block, glyphs `GLYPH_GAP` columns apart, with
 * its top-left at `(x, y)`. Filled pixels are `█` in `fg`; empty pixels are left
 * alone so the panel background shows through. Cells outside `[clipX0, clipX1)`
 * are skipped, so a block can never bleed into the panel next door on a narrow
 * terminal. Returns the x just past the last glyph.
 */
function putBitmapText(
	grid: Cell[][], x: number, y: number, text: string, fg: { r: number; g: number; b: number },
	clipX0 = -Infinity, clipX1 = Infinity,
): number {
	let cx = x;
	for (const ch of text) {
		const rows = glyphRows(ch);
		const gw = rows[0]!.length;
		for (let r = 0; r < rows.length; r++) {
			const rowStr = rows[r]!;
			for (let c = 0; c < gw; c++) {
				if (rowStr[c] !== "1") continue;
				const gx = cx + c, gy = y + r;
				if (gx < 0 || gy < 0 || gx < clipX0 || gx >= clipX1) continue;
				const cell = grid[gy]?.[gx];
				if (cell) { cell.fg = fg; cell.ch = "█"; cell.bg = HUD.steel; }
			}
		}
		cx += gw + GLYPH_GAP;
	}
	return cx - GLYPH_GAP;
}

/**
 * Write a value `rows` cells tall (a solid block of the same text), so the
 * big red/white digits read like the Doom digital display instead of a thin
 * 1-tall line. `y` is the top row of the block.
 */
function cellChar(c: Cell): string {
	const bg = c.bg;
	const bold = c.bold ? "\x1b[1m" : "";
	if (c.fg) {
		const f = c.fg;
		return `${bold}\x1b[38;2;${f.r};${f.g};${f.b}m\x1b[48;2;${bg.r};${bg.g};${bg.b}m${c.ch}`;
	}
	return `${bold}\x1b[48;2;${bg.r};${bg.g};${bg.b}m${c.ch}\x1b[0m`;
}

/**
 * Write `text` doubled in height (the same text on two stacked rows) so a name
 * reads as a tile value rather than a tiny label. `y` is the top row.
 */
/** A darkened copy of `fg`, for the shadow that stamps the big digits in. */
function shadeOf(fg: { r: number; g: number; b: number }): { r: number; g: number; b: number } {
	return { r: Math.round(fg.r * 0.32), g: Math.round(fg.g * 0.32), b: Math.round(fg.b * 0.32) };
}

function fmtNum(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
	if (n >= 10_000) return `${Math.round(n / 1000)}k`;
	if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
	return `${n}`;
}

/** Format millions to one decimal and thousands to the nearest whole token unit. */
function fmtUsageTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
	return `${n}`;
}

/**
 * Render the head with Unicode upper-half blocks. Each terminal cell represents
 * two vertically stacked source samples: the top half uses the foreground and
 * the bottom half the background. This gives every terminal column its own
 * horizontal sample and uses both half-cell colors directly.
 */
const blockCache = new Map<string, string[]>();

/**
 * Fit a face onto a `dotW` x `dotH` sample grid, preserving its aspect and
 * centring it. `pixelRatio` is the physical height/width ratio of one sample.
 * For half blocks this is half the terminal cell's height/width ratio.
 */
function fitFace(face: Frame, dotW: number, dotH: number, pixelRatio: number, aspectScale = 1) {
	const srcAspect = (face.height > 0 ? face.width / face.height : 0.8) * aspectScale;
	const want = srcAspect * pixelRatio; // required sample-grid width / height
	let w = dotW, h = dotH;
	if (want < dotW / dotH) w = Math.max(1, Math.round(h * want));
	else h = Math.max(1, Math.round(w / want));
	return { dotW: w, dotH: h, offX: Math.floor((dotW - w) / 2), offY: Math.floor((dotH - h) / 2) };
}

function renderBlockFace(face: Frame, cells: number, rows: number, cellRatio: number, aspectScale: number): string[] {
	const key = `${face.name}|${cells}|${rows}|${cellRatio.toFixed(3)}|${aspectScale.toFixed(3)}`;
	const cached = blockCache.get(key);
	if (cached) return cached;

	const srcW = face.width, srcH = face.height;
	// The face sits in its own steel panel, so transparent pixels take the panel
	// colour, exactly as the inline-image slices do. Using the bar gutter colour
	// here would paint a dark rectangle around the head.
	const ground: Col = [HUD.steel.r, HUD.steel.g, HUD.steel.b];
	const R = (v: number) => Math.round(Math.max(0, Math.min(255, v)));
	const fit = fitFace(face, cells, rows * 2, cellRatio / 2, aspectScale);

	/** Nearest source pixel, composited over the steel panel if translucent. */
	const samplePixel = (x: number, y: number): Col => {
		if (x < 0 || y < 0 || x >= fit.dotW || y >= fit.dotH) return ground;
		// Match pi-doom's top-left nearest-pixel sampling. Center sampling can skip
		// narrow highlights such as the pale eye pixels after a large downscale.
		const sx = Math.min(srcW - 1, Math.floor((x * srcW) / fit.dotW));
		const sy = Math.min(srcH - 1, Math.floor((y * srcH) / fit.dotH));
		const pixel = sy * srcW + sx;
		const alpha = (face.fbA[pixel] ?? 0) / 255;
		if (alpha <= 8 / 255) return ground;
		const i = pixel * 3;
		return [
			face.fbPx[i]! * alpha + ground[0] * (1 - alpha),
			face.fbPx[i + 1]! * alpha + ground[1] * (1 - alpha),
			face.fbPx[i + 2]! * alpha + ground[2] * (1 - alpha),
		];
	};
	/** Gently warm and lighten the sclera pixels without painting them pure white. */
	const softenEyeSclera = (x: number, y: number, color: Col): Col => {
		const nx = (x + 0.5) / fit.dotW;
		const ny = (y + 0.5) / fit.dotH;
		const inEye = ny >= 0.53 && ny <= 0.59
			&& ((nx >= 0.31 && nx <= 0.39) || (nx >= 0.61 && nx <= 0.69));
		const [r, g, b] = color;
		const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
		if (!inEye || r <= g + 20 || r <= b + 20 || luminance <= 45) return color;
		const target: Col = [242, 219, 193];
		const blend = 0.62;
		return [
			Math.round(r * (1 - blend) + target[0] * blend),
			Math.round(g * (1 - blend) + target[1] * blend),
			Math.round(b * (1 - blend) + target[2] * blend),
		];
	};

	const lines: string[] = [];
	for (let ry = 0; ry < rows; ry++) {
		let line = "";
		for (let cx = 0; cx < cells; cx++) {
			const x = cx - fit.offX;
			const topY = ry * 2 - fit.offY;
			const topRgb = softenEyeSclera(x, topY, samplePixel(x, topY)).map(R) as Col;
			const bottomRgb = softenEyeSclera(x, topY + 1, samplePixel(x, topY + 1)).map(R) as Col;
			const bgSeq = `\x1b[48;2;${bottomRgb[0]};${bottomRgb[1]};${bottomRgb[2]}m`;
			if (topRgb.every((v, i) => v === bottomRgb[i])) {
				// A space with a background colour fills the full cell without a glyph.
				line += `${bgSeq} `;
			} else {
				line += `\x1b[38;2;${topRgb[0]};${topRgb[1]};${topRgb[2]}m${bgSeq}▀`;
			}
		}
		line += "\x1b[0m";
		lines.push(line);
	}
	if (blockCache.size > 64) blockCache.clear();
	blockCache.set(key, lines);
	return lines;
}

// ── Inline-image face (iTerm2 / Kitty) ───────────────────────────────────────
// Emitted as one single-row image per bar row. See the header comment: a
// one-cell-tall image is the only shape that composes with a line-diff renderer,
// because it never spans a row it does not own, and it leaves the cursor alone.

const sliceCache = new Map<string, string>();

/** Minimal PNG encoder (8-bit RGBA) for the face slices. */
function encodePngBase64(width: number, height: number, rgba: Uint8Array): string {
	const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const chunk = (type: string, data: Buffer): Buffer => {
		const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
		const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
		let c = 0xffffffff;
		for (const b of td) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
		const crc = Buffer.alloc(4); crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
		return Buffer.concat([len, td, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
	const stride = width * 4;
	const raw = Buffer.alloc((stride + 1) * height);
	for (let y = 0; y < height; y++) {
		raw[y * (stride + 1)] = 0; // filter: none
		Buffer.from(rgba.subarray(y * stride, (y + 1) * stride)).copy(raw, y * (stride + 1) + 1);
	}
	const body = Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
	return body.toString("base64");
}

/**
 * One bar-row of the face as an opaque PNG. Opaque on purpose: it fully covers
 * the cells it is placed on, so it does not matter what pi-tui painted beneath
 * it. The sprite is bilinearly resampled and composited over the steel panel
 * colour where it is transparent.
 */
function faceSlicePng(face: Frame, row: number, rows: number, wpx: number, hpx: number): string {
	const key = `${face.name}|${row}|${rows}|${wpx}|${hpx}`;
	const hit = sliceCache.get(key);
	if (hit !== undefined) return hit;

	const srcW = face.width, srcH = face.height;
	const steel: Col = [HUD.steel.r, HUD.steel.g, HUD.steel.b];
	const rgba = new Uint8Array(wpx * hpx * 4);
	// Keep the head's own aspect. The slice stack is one image, `rows` cells tall,
	// so the fit is computed once for the whole stack (not per row, which would
	// letterbox each row on its own and slice the head into bands) and the
	// remaining space is filled with steel. Fitting by a single scale on both
	// axes matters: whatever the terminal's cell shape, the head is never
	// stretched, it just gets more or less steel around it.
	const totalH = hpx * rows;
	const scale = Math.min(wpx / Math.max(1, srcW), totalH / Math.max(1, srcH));
	const drawW = Math.max(1, Math.round(srcW * scale));
	const drawH = Math.max(1, Math.round(srcH * scale));
	const xOff = Math.floor((wpx - drawW) / 2);
	const yOff = Math.floor((totalH - drawH) / 2);
	// Always interpolate. The source art is a soft render of the original
	// low-res sprites, so its eyebrow and pupil detail lives in the grey
	// transitions, not in hard edges. Nearest-sampling on the way up turns
	// those transitions into hard blocks, which reads as the eyebrows and
	// pupils going solid black. Smooth sampling is what keeps them shaped.
	const clampX = (v: number) => (v < 0 ? 0 : v >= srcW ? srcW - 1 : v);
	const clampY = (v: number) => (v < 0 ? 0 : v >= srcH ? srcH - 1 : v);
	const px = face.fbPx, pa = face.fbA;
	for (let y = 0; y < hpx; y++) {
		const o0 = y * wpx * 4;
		// This row's scanlines in the coordinate space of the whole face.
		const gy = row * hpx + y + 0.5;
		const inDrawY = gy >= yOff && gy < yOff + drawH;
		const sy = (gy - yOff) / scale - 0.5;
		const iyFloor = Math.floor(sy);
		const iy1 = clampY(iyFloor + 1);
		const fy = sy - iyFloor;
		const iy0 = clampY(iyFloor), gy0 = 1 - fy;
		const row0 = iy0 * srcW, row1 = iy1 * srcW;
		for (let x = 0; x < wpx; x++) {
			const o = o0 + x * 4;
			if (!inDrawY || x < xOff || x >= xOff + drawW) {
				rgba[o] = steel[0]!; rgba[o + 1] = steel[1]!; rgba[o + 2] = steel[2]!; rgba[o + 3] = 255;
				continue;
			}
			const sx = (x - xOff + 0.5) / scale - 0.5;
			const ixFloor = Math.floor(sx);
			const ix1 = clampX(ixFloor + 1);
			const fx = sx - ixFloor;
			const ix0 = clampX(ixFloor), gx0 = 1 - fx;
			const w00 = gx0 * gy0, w10 = fx * gy0, w01 = gx0 * fy, w11 = fx * fy;
			const p00 = row0 + ix0, p10 = row0 + ix1, p01 = row1 + ix0, p11 = row1 + ix1;
			const a00 = (pa[p00] ?? 0) / 255, a10 = (pa[p10] ?? 0) / 255;
			const a01 = (pa[p01] ?? 0) / 255, a11 = (pa[p11] ?? 0) / 255;
			const a = a00 * w00 + a10 * w10 + a01 * w01 + a11 * w11;
			// Alpha-weighted average of the four taps, as a 0..255 colour.
			const inv = a > 0.0001 ? 1 / a : 0;
			for (let k = 0; k < 3; k++) {
				const premul = px[p00 * 3 + k]! * a00 * w00 + px[p10 * 3 + k]! * a10 * w10
					+ px[p01 * 3 + k]! * a01 * w01 + px[p11 * 3 + k]! * a11 * w11;
				const over = inv > 0 ? premul * inv : steel[k]!;
				rgba[o + k] = Math.round(over * a + steel[k]! * (1 - a));
			}
			rgba[o + 3] = 255;
		}
	}
	const b64 = encodePngBase64(wpx, hpx, rgba);
	if (sliceCache.size > 256) sliceCache.clear();
	sliceCache.set(key, b64);
	return b64;
}

/**
 * Stable per-row Kitty image id, independent of which face frame is showing.
 * Every frame reuses the same id for a given row, so the terminal replaces that
 * one image slot instead of allocating a fresh resource on every animation
 * step. A new id per frame churns the terminal's image store, and when it fills
 * the slices get dropped or flicker. Reusing the slot bounds it to HUD_ROWS.
 */
function sliceImageId(row: number): number {
	let h = 2166136261;
	h = Math.imul(h ^ (row + 1), 16777619);
	return ((h >>> 0) % 0xfffffffe) + 1;
}

/**
 * Escape that places one row's slice at the cursor, `cells` wide by exactly one
 * cell tall. preserveAspectRatio=0 makes the terminal stretch it to those cells,
 * so a slice can never spill onto a neighbouring row.
 */
function faceSliceSequence(
	protocol: "kitty" | "iterm2",
	b64: string,
	cells: number,
	row: number,
): string {
	if (protocol === "kitty") {
		return encodeKitty(b64, { columns: cells, rows: 1, imageId: sliceImageId(row), moveCursor: false });
	}
	return `\x1b]1337;File=inline=1;size=${Buffer.byteLength(b64, "base64")};width=${cells};height=1;preserveAspectRatio=0:${b64}\x07`;
}

/** Left padding inside the stats tile, so nothing touches the bevel. */
const STAT_PAD = 2;

/**
 * Narrowest terminal the bar stays up in. pi-tui throws when a rendered line is
 * wider than the terminal, so the bar has to fit exactly; below this the panels
 * cannot hold their figures and the bar stands down instead of throwing.
 */
const MIN_HUD_WIDTH = 60;
/** Narrowest a tile is ever squeezed to before the grid simply clips. */
const MIN_PANEL_W = 7;
/** MODEL needs this much to read as a name rather than a smear. */
const MODEL_FLOOR = 12;
/** Width the stats tile wants when the terminal has room for it. */
const LIST_WANT = 36;

/**
 * Force every string the bar draws into single-column characters. The grid is
 * addressed by character, so a wide glyph (CJK, emoji) would occupy one grid
 * cell while taking two terminal columns, pushing the rest of the row out and
 * making the line wider than the terminal. Anything not one column wide becomes
 * "?", which keeps the layout exact for any model id, path, or branch name.
 */
function cells(s: string): string {
	let out = "";
	for (const ch of s) out += visibleWidth(ch) === 1 ? ch : "?";
	return out;
}

function sanitizeHud(hud: HudData): HudData {
	return {
		...hud,
		stats: hud.stats.map((s) => ({ label: cells(s.label), value: cells(s.value), deltaCost: s.deltaCost, deltaTokens: s.deltaTokens })),
		modelId: cells(hud.modelId),
		thinking: cells(hud.thinking),
		provider: cells(hud.provider),
		branch: cells(hud.branch),
		dir: cells(hud.dir),
	};
}

/**
 * Panel texture. `false` gives flat panels. On, it lays a sparse speckle of the
 * alt steel shade over the fill, roughly one cell in six, which reads as grime
 * on the metal. Kept as one switch so the look can be dropped in one edit.
 */
const PANEL_TEXTURE = true;

/**
 * Render the full status bar to ANSI lines. Pure: (frames, hud, imageFace,
 * width, faceName) -> lines, so it can be driven straight from the preview tool.
 * The bar spans the full `width`, in the classic Doom status-bar order: TOKENS,
 * CONTEXT, MODEL, FACE, COST, then the stats tile on the right. Height is fixed,
 * and `imageFace` picks the real pixel face over the block-glyph fallback.
 */
export function renderHudBar(
	frames: Map<string, Frame>,
	hud: HudData,
	imageFace: boolean,
	width: number,
	faceName: string,
): string[] {
	const d = sanitizeHud(hud);
	const caps = getCapabilities();
	const protocol = caps.images === "kitty" ? "kitty" : caps.images === "iterm2" ? "iterm2" : null;
	const useImageFace = imageFace && protocol !== null;
	const faceAspectScale = useImageFace ? 1 : TEXT_FACE_ASPECT_SCALE;
	const H = HUD_ROWS;
	const GAP = 1;
	// pi-tui *throws* (and stops the TUI) if any line is wider than the terminal,
	// so a bar that cannot fit its panels must stand down rather than spill. Below
	// the floor the panels would be squeezed to nothing anyway.
	if (width < MIN_HUD_WIDTH) return [];
	// The value block is 5 rows of bitmap digits with a 1-row label under it.
	// Centre that 7-row block in the band so the panels do not look top-anchored.
	// Row `lblRow + 1` is still inside the panel (inner rows are 2..10), and is
	// used for the secondary cost caption.
	const valRow = Math.max(0, Math.floor((H - 7) / 2));
	const lblRow = valRow + 7;
	// Face sprite (loadFrames already trims each frame to the head). Its aspect
	// sets the panel shape: a face `rows` tall has `2 * rows * aspect` cells
	// across, which keeps the subpixels square and the head unstretched.
	const face = frames.get(faceName) ?? frames.values().next().value;
	const cropAspect = stableFaceAspect(frames) * faceAspectScale;
	let faceRows = H - 2;
	let faceW = Math.max(8, Math.round(faceRows * 2 * cropAspect));
	const maxFaceW = Math.max(12, Math.round(width * 0.22));
	while (faceW > maxFaceW && faceRows > 6) {
		faceRows--;
		faceW = Math.max(8, Math.round(faceRows * 2 * cropAspect));
	}
	const W_FACE = faceW + 2;
	// Panel widths. Every tile states two widths: a *floor*, the point below which
	// it cannot show the figure it exists for, and a *want*, the width at which it
	// looks right. Floors are met first and whatever is left is shared out by how
	// much more each tile wanted, so a narrow terminal squeezes the tiles in
	// proportion to their own content instead of starving one of them.
	const rest = Math.max(0, width - W_FACE - GAP * 5);
	const moneySymW = glyphRows("$")[0]!.length;	const statRows = d.stats.slice(0, 8);
	const formatCostDelta = (amount: number) => `(+$${amount.toFixed(3)})`;
	const formatStatDelta = (row: HudData["stats"][number]): string => {
		if (row.deltaCost !== undefined && row.deltaCost > 0) return formatCostDelta(row.deltaCost);
		if (row.deltaTokens !== undefined && row.deltaTokens > 0) return `(+${fmtUsageTokens(row.deltaTokens)})`;
		return "";
	};
	const deltaWidth = Math.max(0, ...statRows.map((row) => formatStatDelta(row).length));
	const valueW = Math.max(1, ...statRows.map((r) => r.value.length));
	const maxLabel = Math.max(1, ...statRows.map((r) => r.label.length));
	const floors = [
		bitmapWidth(fmtNum(d.window)),                            // TOKENS: its figure
		bitmapWidth("100%"),                                      // CONTEXT: its figure
		MODEL_FLOOR,                                              // MODEL: a readable stub
		moneySymW + GLYPH_GAP + bitmapWidth(d.cost.toFixed(3)),   // COST: its figure
		STAT_PAD * 2 + maxLabel + 1 + valueW,                     // LIST: label + value column
	];
	const wants = [
		floors[0]! + 2,
		floors[1]! + 2,
		MODEL_FLOOR + 2,
		floors[3]! + 2,
		// The stats tile also carries the cwd and branch caption, and branch names
		// run long, so it wants a generous width.
		Math.max(floors[4]!, LIST_WANT),
	];
	// The stats tile is the one tile that is dropped rather than squeezed. Below its
	// floor its four values are unreadable anyway (a single visible character per
	// row), and those columns are far better spent on the headline figures. Dropping
	// it also frees a gutter, so the budget is recomputed for the tiles that remain.
	const showList = rest >= floors[0]! + floors[1]! + floors[2]! + floors[3]! + floors[4]!;
	const keep = showList ? [0, 1, 2, 3, 4] : [0, 1, 2, 3];
	// Elements are the kept tiles plus the face, so there is one gutter between each
	// pair: `keep.length` gutters in total.
	const budget = Math.max(0, width - W_FACE - GAP * keep.length);
	const floorSum = keep.reduce((a, i) => a + floors[i]!, 0);
	const wantSum = keep.reduce((a, i) => a + wants[i]!, 0);
	const w5 = [0, 0, 0, 0, 0];
	if (budget >= wantSum) {
		const surplus = budget - wantSum;
		// Surplus leans to the stats tile and away from TOKENS and COST, which have
		// all the room their centred figures need once they clear their base width.
		const surplusWeights = [0.175, 0.21, 0.19, 0.175, 0.25];
		for (const i of keep) w5[i] = wants[i]! + Math.floor(surplus * surplusWeights[i]!);
	} else if (budget >= floorSum) {
		const slackSum = keep.reduce((a, i) => a + (wants[i]! - floors[i]!), 0);
		const leftover = budget - floorSum;
		for (const i of keep) {
			const slack = wants[i]! - floors[i]!;
			w5[i] = floors[i]! + (slackSum > 0 ? Math.floor((leftover * slack) / slackSum) : 0);
		}
	} else {
		// Narrower than every floor together: squeeze proportionally, and let the
		// trim loop below take any excess out of the widest tiles.
		for (const i of keep) w5[i] = Math.max(MIN_PANEL_W, Math.floor((floors[i]! * budget) / Math.max(1, floorSum)));
	}
	let used = keep.reduce((a, i) => a + w5[i]!, 0);
	while (used > budget) {
		let widest = -1;
		for (const i of keep) if (w5[i]! > MIN_PANEL_W && (widest < 0 || w5[i]! > w5[widest]!)) widest = i;
		if (widest < 0) break; // every tile is at the minimum; the grid clips instead
		w5[widest]!--;
		used--;
	}
	// Rounding leftovers go to the COST tile, so the bar still spans the full
	// width and the slack lands somewhere useful rather than on the stats tile.
	if (budget >= used) w5[3]! += budget - used;
	const [W_AMMO, W_HEALTH, W_ARMS, W_ARMOR, W_LIST] = w5;
	const showDeltas = showList && deltaWidth > 0 && W_LIST >= floors[4]! + deltaWidth + 2;

	// Panel widths, indexed by identity so the drawing code below can keep
	// addressing them by name: 0 TOKENS, 1 CONTEXT, 2 MODEL, 3 COST, 4 stats,
	// 5 FACE.
	const panelW = [W_AMMO, W_HEALTH, W_ARMS, W_ARMOR, W_LIST, W_FACE];
	// Physical left-to-right order, the classic Doom status bar: the face sits
	// between the ARMS grid and ARMOR, with the ammo list off to the right. The
	// stats tile drops off the end when the terminal cannot hold it.
	const LAYOUT = showList ? [0, 1, 2, 5, 3, 4] : [0, 1, 2, 5, 3];
	const xs: number[] = new Array(6).fill(0);
	let x = 0;
	for (let k = 0; k < LAYOUT.length; k++) {
		const i = LAYOUT[k]!;
		xs[i] = x;
		x += panelW[i]!;
		if (k < LAYOUT.length - 1) x += GAP;
	}
	const totalW = Math.min(x, width);

	const grid: Cell[][] = [];
	for (let y = 0; y < H; y++) {
		const row: Cell[] = [];
		for (let x = 0; x < totalW; x++) row.push({ fg: null, bg: HUD.bg, ch: " " });
		grid.push(row);
	}
	const y0 = 0;

	// Helper: center a 5-tall bitmap value in a panel of width `pw` at xs `px`.
	// Centre the 5-row bitmap block in the panel's inner area. On a narrow
	// terminal the block can be wider than the panel, so drop trailing glyphs
	// (the "%" goes first) until it fits, then clip as a backstop. `prefix` is a
	// normal-size mark drawn to the left of the block, vertically centred on it:
	// that is how the dollar sign gets shown, because a five-row glyph cannot
	// carry a bar through its middle and would read as a letter S.
	const putCenteredBig = (px: number, pw: number, txt: string, fg: { r: number; g: number; b: number }) => {
		const inner = Math.max(1, pw - 2);
		let t = txt;
		while (t.length > 1 && bitmapWidth(t) > inner) t = t.slice(0, -1);
		const cx = px + 1 + Math.max(0, Math.floor((inner - bitmapWidth(t)) / 2));
		// A darkened copy one cell down and right, drawn first, so the digits sit
		// on their own shadow like the stamped numbers on the real status bar.
		putBitmapText(grid, cx + 1, valRow + 1, t, shadeOf(fg), px + 1, px + pw - 1);
		putBitmapText(grid, cx, valRow, t, fg, px + 1, px + pw - 1);
	};
	// Money: the amount in the big digits with a full-size dollar sign to their
	// left. The sign is seven rows tall against the digits' five, so it is centred
	// on the digit block by starting one row higher. If the pair will not fit the
	// panel, the sign is dropped before any digit is: a truncated number is worse
	// than a missing currency mark, and the COST label still says what it is.
	const putMoney = (px: number, pw: number, amount: number, fg: { r: number; g: number; b: number }) => {
		const inner = Math.max(1, pw - 2);
		const symW = glyphRows("$")[0]!.length;
		const withSym = (d: string) => symW + GLYPH_GAP + bitmapWidth(d);
		let digits = amount.toFixed(3);
		while (digits.length > 1 && withSym(digits) > inner) digits = digits.slice(0, -1);
		const useSym = withSym(digits) <= inner;
		const total = useSym ? withSym(digits) : bitmapWidth(digits);
		const cx = px + 1 + Math.max(0, Math.floor((inner - total) / 2));
		if (useSym) {
			putBitmapText(grid, cx + 1, valRow, "$", shadeOf(fg), px + 1, px + pw - 1);
			putBitmapText(grid, cx, valRow - 1, "$", fg, px + 1, px + pw - 1);
			putBitmapText(grid, cx + symW + GLYPH_GAP + 1, valRow + 1, digits, shadeOf(fg), px + 1, px + pw - 1);
			putBitmapText(grid, cx + symW + GLYPH_GAP, valRow, digits, fg, px + 1, px + pw - 1);
		} else {
			putBitmapText(grid, cx + 1, valRow + 1, digits, shadeOf(fg), px + 1, px + pw - 1);
			putBitmapText(grid, cx, valRow, digits, fg, px + 1, px + pw - 1);
		}
	};
	// Helper: center a 1-tall label at the bottom of a panel, clipped to the
	// panel's inner width so a long label cannot spill into the next panel.
	const putCenteredLabel = (px: number, pw: number, txt: string, fg: { r: number; g: number; b: number }) => {
		const inner = Math.max(1, pw - 2);
		const cx = px + 1 + Math.max(0, Math.floor((inner - txt.length) / 2));
		putText(grid, cx, lblRow, txt, fg, px + pw - 1);
	};
	// Helper: make a run of already-drawn cells bold, for values that should read
	// heavier than the label beside them.
	const boldRange = (x: number, y: number, n: number) => {
		for (let i = 0; i < n; i++) {
			const cell = grid[y]?.[x + i];
			if (cell) cell.bold = true;
		}
	};
	// Helper: a small caption on its own row, for a secondary value. Fitted to
	// the panel first so it degrades word by word instead of mid-word.
	const putCenteredCaption = (px: number, pw: number, txt: string, fg: { r: number; g: number; b: number }, row: number) => {
		const inner = Math.max(1, pw - 2);
		const t = fitCaption(txt, inner);
		const cx = px + 1 + Math.max(0, Math.floor((inner - t.length) / 2));
		putText(grid, cx, row, t, fg, px + pw - 1);
	};

	// 1. TOKENS (the model's context window, the capacity CONTEXT is a % of)
	fillPanel(grid, xs[0]!, y0, W_AMMO, H);
	putCenteredBig(xs[0]!, W_AMMO, fmtNum(d.window), HUD.red);
	putCenteredLabel(xs[0]!, W_AMMO, "TOKENS", HUD.white);

	// 2. CONTEXT (how full the window is). Colours follow pi's footer:
	// 90%+ red, 70%+ amber, below that green, unknown dim.
	fillPanel(grid, xs[1]!, y0, W_HEALTH, H);
	putCenteredBig(xs[1]!, W_HEALTH, `${d.usagePct ?? "-"}%`, contextColor(d.usagePct));
	putCenteredLabel(xs[1]!, W_HEALTH, "CONTEXT", HUD.white);

	// 3. MODEL: the model id written in red/bold, broken onto as many lines as it
	// needs at "-" boundaries, with the thinking level centred on its own line
	// underneath and the provider beneath that. (A five-row bitmap font has no
	// letters, so a name cannot use the big digit glyphs.) The block is raised
	// as high as the panel lets it so a long name still fits above the label.
	fillPanel(grid, xs[2]!, y0, W_ARMS, H);
	{
		const px = xs[2]!;
		const inner = Math.max(1, W_ARMS - 2);
		// The name lines plus the thinking line, all stacked centred. Only as
		// many model lines as leave room for the thinking line are shown.
		const modelLines = wrapModelName(d.modelId, inner, Math.max(1, lblRow - 1 - valRow)).map((l) => hardFitLine(l, inner));
		const thinking = fitCaption(`[${d.thinking}]`, inner);
		const totalLines = modelLines.length + (thinking ? 1 : 0);
		// Centre the block on the same band the big digits use (valRow..valRow+4)
		// so it reads as level with them, and raise it only when it is too tall
		// to fit above the MODEL label without colliding with that caption.
		const centeredStart = valRow + Math.floor((5 - totalLines) / 2);
		const bottomStart = lblRow - totalLines; // last line sits just above the label
		const startY = Math.max(1, Math.min(centeredStart, bottomStart));
		const centerX = (text: string) => px + 1 + Math.max(0, Math.floor((inner - text.length) / 2));
		let y = startY;
		for (const line of modelLines) {
			if (line) {
				const mx = centerX(line);
				putText(grid, mx, y, line, HUD.red, px + W_ARMS - 1);
				boldRange(mx, y, line.length);
			}
			y++;
		}
		if (thinking) {
			const tx = centerX(thinking);
			putText(grid, tx, y, thinking, HUD.red, px + W_ARMS - 1);
			boldRange(tx, y, thinking.length);
			y++;
		}
	}
	putCenteredLabel(xs[2]!, W_ARMS, "MODEL", HUD.white);
	putCenteredCaption(xs[2]!, W_ARMS, d.provider, HUD.grey, 11);

	const faceOverlay: Record<number, { line: string; x: number; w: number }> = {};
	// Per-row image escapes, for terminals that support inline images.
	const rowImage = new Array<string>(H).fill("");
	// Steel panel behind the face (visible through transparent pixels, and the
	// colour the image slices are composited over).
	if (face) fillPanel(grid, xs[5]!, y0, W_FACE, H);
	if (face) {
		const faceX = xs[5]! + 1;
		const startY = y0 + Math.max(1, Math.floor((H - faceRows) / 2));
		const cellDim = getCellDimensions();
		if (useImageFace && protocol) {
			// One image per face row. See the header comment: a one-cell-tall image
			// is the only shape that survives pi-tui repainting the panel cells that
			// share its rows, and it leaves the cursor on its own line.
			// Match roughly one image pixel per device pixel, but cap it: these slices
			// are re-sent whenever the row changes, and a face row is only ever about
			// 20 device pixels tall, so more resolution is wasted bytes.
		// Encode at the size the slice is actually drawn at. The face art is
		// already about the size of the draw box, so keeping the source at the
		// measured cell size avoids an unnecessary upscale/downscale round trip.
		const sliceScale = 1;
		const cellW = cellDim.widthPx * sliceScale;
		const cellH = cellDim.heightPx * sliceScale;
		const wpx = Math.max(32, Math.min(Math.round(faceW * cellW), 720));
		const hpx = Math.max(16, Math.min(cellH, 40));
			for (let r = 0; r < faceRows; r++) {
				const y = startY + r;
				if (y < 0 || y >= H) continue;
				const b64 = faceSlicePng(face, r, faceRows, wpx, hpx);
				rowImage[y] = `\r\x1b[${faceX}C${faceSliceSequence(protocol, b64, faceW, r)}`;
			}
		} else {
			const cellRatio = cellDim.heightPx / Math.max(1, cellDim.widthPx);
			const faceLines = renderBlockFace(face, faceW, faceRows, cellRatio, faceAspectScale);
			for (let r = 0; r < faceLines.length; r++) {
				const y = startY + r;
				if (y >= H) break;
				faceOverlay[y] = { line: faceLines[r]!, x: faceX, w: faceW };
			}
		}
	}

	// 5. COST (the real session spend, three decimals, with a full-size $)
	fillPanel(grid, xs[3]!, y0, W_ARMOR, H);
	putMoney(xs[3]!, W_ARMOR, d.cost, HUD.red);
	if (showDeltas && d.costDelta !== undefined && d.costDelta > 0) {
		const delta = formatCostDelta(d.costDelta);
		if (delta.length <= W_ARMOR - 2) {
			const dx = xs[3]! + Math.floor((W_ARMOR - delta.length) / 2);
			putText(grid, dx, lblRow - 1, delta, HUD.green, xs[3]! + W_ARMOR - 1);
		}
	}
	putCenteredLabel(xs[3]!, W_ARMOR, "COST", HUD.white);

	// 6. Right tile: the session's token economics, one reading per row with the
	// values right-aligned into a single column, plus the cwd and branch caption.
	// Everything is inset a column from the bevel and the block starts a row down,
	// so no content sits against the tile's border. Skipped entirely when the
	// terminal was too narrow for it (see the panel width allocation above).
	if (showList) {
		fillPanel(grid, xs[4]!, y0, W_LIST, H);
		const listX = xs[4]!;
		// Values remain aligned. Turn deltas get a separate right-hand column, but
		// they are omitted when the compacted panel has no room for that column.
		const deltaSpace = showDeltas ? deltaWidth + 1 : 0;
		const valueXWithoutDelta = listX + Math.max(STAT_PAD + maxLabel + 1, W_LIST - 1 - STAT_PAD - valueW);
		const valueX = showDeltas
			? listX + Math.max(STAT_PAD + maxLabel + 1, W_LIST - 1 - STAT_PAD - valueW - deltaSpace)
			: valueXWithoutDelta;
		const deltaX = valueX + valueW + 1;
		const deltaRight = listX + W_LIST - 1 - STAT_PAD;
		for (let i = 0; i < statRows.length; i++) {
			const row = statRows[i]!;
			// Use consecutive interior rows so the tile can show token buckets,
			// ratios, and cost detail while keeping its caption on the last row.
			const sy = 2 + i;
			if (!grid[sy] || sy >= lblRow) break;
			// The label column stops at the value block, so a long label can never
			// run into the numbers.
			putText(grid, listX + STAT_PAD, sy, row.label, HUD.white, valueX - 1);
			putText(grid, valueX, sy, row.value, HUD.gold);
			boldRange(valueX, sy, row.value.length);
			const delta = formatStatDelta(row);
			if (showDeltas && delta) putText(grid, deltaX, sy, delta, HUD.green, deltaRight + 1);
		}
		// Caption: cwd basename (bold) then the git branch in brackets, drawn in two
		// colours so the branch reads as the part that changes. If both will not fit,
		// keep the directory and drop the branch rather than clipping it in half.
		const innerList = Math.max(1, W_LIST - 3);
		let dirTxt = d.dir;
		let brTxt = d.branch ? `[${d.branch}]` : "";
		const combined = dirTxt + (dirTxt && brTxt ? " " : "") + brTxt;
		if (combined.length > innerList) {
			brTxt = "";
			dirTxt = fitCaption(dirTxt, innerList);
		}
		const sep = dirTxt && brTxt ? " " : "";
		const captionW = dirTxt.length + sep.length + brTxt.length;
		const cx = listX + STAT_PAD + Math.max(0, Math.floor((innerList - STAT_PAD * 2 - captionW) / 2));
		const maxX = listX + W_LIST - 1;
		const capY = lblRow; // same row as the other tiles' titles
		putText(grid, cx, capY, dirTxt, HUD.white, maxX);
		putText(grid, cx + dirTxt.length + sep.length, capY, brTxt, HUD.grey, maxX);
		// Bold the directory, so the mutable branch part reads as secondary.
		boldRange(cx, capY, dirTxt.length);
	}

	// Build row strings: all cells, then optionally splice the text face in, then
	// the row's image escape. Each cell is one visible column, so every line is
	// exactly `totalW` visible columns. For image rows the cells under the face
	// are painted too, which is harmless: the slice is opaque and covers them.
	// Panels to the RIGHT of the face (ARMOR, the ammo list) are painted first and
	// then the image is dropped over its own columns, so they are never covered.
	const out: string[] = [];
	for (let y = 0; y < H; y++) {
		const ov = faceOverlay[y];
		let line = "";
		if (ov) {
			for (let x = 0; x < ov.x; x++) line += cellChar(grid[y]![x]!);
			line += ov.line;
			for (let x = ov.x + ov.w; x < totalW; x++) line += cellChar(grid[y]![x]!);
		} else {
			for (let x = 0; x < totalW; x++) line += cellChar(grid[y]![x]!);
		}
		out.push(line + (rowImage[y] ?? ""));
	}
	return out;
}

// ── The widget component ─────────────────────────────────────────────────────
class DoomHudComponent implements Component {
	tui: TUI;
	private frames: Map<string, Frame>;
	private hud: HudData | null = null;
	// The bar is re-rendered on a 40ms tick, but only the face frame and the
	// stats actually change, so memoise on those plus the width.
	private cacheKey = "";
	private cacheLines: string[] = [];

	constructor(tui: TUI, frames: Map<string, Frame>) {
		this.tui = tui;
		this.frames = frames;
	}

	private setFaceHealth(value: number): void {
		const health = Math.max(0, Math.min(100, Math.round(value)));
		if (health !== anim.health) {
			const newBand = bandFor(100 - health);
			if (newBand !== anim.bandIndex) {
				anim.bandIndex = newBand;
				anim.browPos = 1; anim.browDir = 1; anim.browEnteredAt = Date.now();
				// Any band change retires the focus face: a tier1 glare must not stay
				// on screen after the health has dropped to a worse tier.
				anim.focusUntil = 0; anim.focusName = "";
			}
			anim.health = health;
		}
	}

	/** Update the live stats; the next render picks them up. */
	setHudData(d: HudData) {
		this.hud = d;
		// A test override lasts until the actual context token count changes.
		// That makes `/doomhud 25` useful for inspecting a face without being
		// immediately overwritten by the refresh timer.
		if (anim.healthOverride !== null && anim.overrideContextTokens !== d.contextTokens) {
			anim.healthOverride = null;
			anim.overrideContextTokens = null;
		}
		this.setFaceHealth(anim.healthOverride ?? d.health);
		this.tui.requestRender();
	}

	setHealthOverride(health: number) {
		if (!this.hud) return;
		anim.healthOverride = health;
		anim.overrideContextTokens = this.hud.contextTokens;
		this.setFaceHealth(health);
		this.tui.requestRender();
	}

	clearHealthOverride() {
		anim.healthOverride = null;
		anim.overrideContextTokens = null;
		if (this.hud) this.setFaceHealth(this.hud.health);
		this.tui.requestRender();
	}

	setEnabled(on: boolean) { anim.enabled = on; this.tui.requestRender(); }
	setImageFace(on: boolean) { anim.imageFace = on; this.tui.requestRender(); }

	setCompacting(on: boolean) {
		if (anim.compacting === on) return;
		anim.compacting = on;
		this.tui.requestRender();
	}

	start() {
		if (anim.timer) return;
		anim.timer = setInterval(() => {
			const now = Date.now();
			// Nothing to animate while the bar is hidden behind an overlay, and
			// repainting would fight the modal for the screen.
			if (this.tui.hasOverlay()) return;
			const required = anim.browPos === 1 ? NEUTRAL_MS : SIDE_MS;
			if (now - anim.browEnteredAt >= required && !isSpecialStatic()) {
				anim.browEnteredAt = now;
				// Once in a while the brow holds a dedicated "focus" frame for a
				// few seconds, like the Doom guy glaring at you.
				if (now >= anim.focusUntil && anim.bandIndex < BAND_COUNT) {
					if (Math.random() < FOCUS_CHANCE) {
						anim.focusUntil = now + FOCUS_MIN_MS + Math.random() * (FOCUS_MAX_MS - FOCUS_MIN_MS);
						const ff = `tier${anim.bandIndex + 1}_focus`;
						if (this.frames.has(ff)) anim.focusName = ff;
					}
				}
				stepBrow();
			}
			// this.tui, not the captured one: pi can hand the widget factory a new
			// TUI (theme change, reload), and the old instance must not be painted.
			this.tui.requestRender();
		}, 40);
		anim.timer.unref?.();
	}

	dispose() {}

	static stop() { if (anim.timer) clearInterval(anim.timer); anim.timer = null; }
	static resetTransient() {
		anim.bandIndex = 0; anim.browPos = 1; anim.browDir = 1; anim.browEnteredAt = 0; anim.health = 100;
		anim.healthOverride = null; anim.overrideContextTokens = null;
		anim.focusUntil = 0; anim.focusName = "";
		anim.compacting = false;
	}

	invalidate() { this.cacheKey = ""; }

	render(width: number): string[] {
		if (!anim.enabled || !this.hud) return [];
		// An overlay owns the viewport while it is up and needs the whole height:
		// the ask_user_question modal (and /btw, extension selectors) render as a
		// bottom-anchored overlay sized off the terminal, so a 13-row bar
		// underneath collides with it and swallows its lower lines. Stand down
		// until the overlay closes. The memo cache is deliberately left intact,
		// so the bar comes straight back afterwards without a rebuild.
		if (this.tui.hasOverlay()) return [];
		const faceName = currentFaceName();
		const cell = getCellDimensions();
		const key = `${width}|${anim.imageFace ? 1 : 0}|${cell.widthPx}x${cell.heightPx}|${faceName}|${JSON.stringify(this.hud)}`;
		if (key === this.cacheKey) return this.cacheLines;
		this.cacheLines = renderHudBar(this.frames, this.hud, anim.imageFace, width, faceName);
		this.cacheKey = key;
		return this.cacheLines;
	}
}

// ── Extension entry ──────────────────────────────────────────────────────────
export default async function (pi: ExtensionAPI) {
	const frames = await loadFrames();
	if (frames.size === 0) return; // no frames → no-op

	let active: DoomHudComponent | null = null;
	let ctxRef: ExtensionContext | null = null;
	let lastTurnCostDelta: TurnCostDelta | null = null;

	function refresh() {
		if (!ctxRef || !active) return;
		const entries = ctxRef.sessionManager.getEntries();
		const sessionFile = ctxRef.sessionManager.getSessionFile();
		resetCostCacheForSession(sessionFile);
		const data = collectHudData(ctxRef, entries, subagentCostTotal(), lastTurnCostDelta);
		active.setCompacting(anim.compacting);
		active.setHudData(data);
		// Subagent spend is resolved from artifacts on disk, so it lands a moment
		// after the first paint. Redraw once it does.
		loadSubagentCosts(entries, () => {
			if (!ctxRef || !active) return;
			active.setHudData(collectHudData(ctxRef, ctxRef.sessionManager.getEntries(), subagentCostTotal(), lastTurnCostDelta));
		});
	}

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctxRef = ctx;
		lastTurnCostDelta = null;
		DoomHudComponent.resetTransient();
		// Replace pi's built-in status footer; the HUD already presents its useful stats.
		ctx.ui.setFooter(() => ({ render: () => [], invalidate() {} }));
		ctx.ui.setWidget(
			"doom-hud",
			(tui, _theme) => {
				if (!active) {
					active = new DoomHudComponent(tui, frames);
					active.start();
				}
				active.tui = tui;
				return active;
			},
			{ placement: "belowEditor" },
		);
		setTimeout(refresh, 0);
	});

	// Compaction: show the dead face while it runs. These are the real event
	// names in pi's extension API (session_before_compact / session_compact /
	// session_compact_failed); the old compaction_start / compaction_end names
	// never existed, so the dead face never showed.
	pi.on("session_before_compact", (_e, c) => { ctxRef = c; active?.setCompacting(true); });
	pi.on("session_compact", (_e, c) => { ctxRef = c; active?.setCompacting(false); refresh(); });
	// session_compact_failed was added after the first 0.84 releases. Register it
	// by name so older Pi versions still typecheck and fall back to turn_end for
	// clearing the dead face, while newer versions clear it immediately.
	(pi as { on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => void }).on(
		"session_compact_failed", (_e, c) => { ctxRef = c; active?.setCompacting(false); refresh(); });

	pi.on("agent_start", (_e, c) => { ctxRef = c; lastTurnCostDelta = null; refresh(); });
	pi.on("agent_end", (event, c) => {
		ctxRef = c;
		lastTurnCostDelta = turnCostDeltaFromMessages(event.messages);
		refresh();
	});
	pi.on("message_update", (_e, c) => { ctxRef = c; refresh(); });
	pi.on("message_end", (_e, c) => { ctxRef = c; refresh(); });
	pi.on("tool_execution_end", (_e, c) => { ctxRef = c; refresh(); });
	pi.on("turn_end", (_e, c) => { ctxRef = c; refresh(); });

	const refreshTimer = setInterval(() => {
		if (!active || !ctxRef) return;
		refresh();
	}, 500);
	refreshTimer.unref?.();

	pi.on("session_shutdown", () => {
		DoomHudComponent.stop();
		DoomHudComponent.resetTransient();
		clearInterval(refreshTimer);
		active = null; ctxRef = null;
	});

	pi.registerCommand("doomhud", {
		description: "Toggle the Doom HUD. /doomhud image|text|natural|0-100.",
		handler: async (args, ctx) => {
			const a = (args ?? "").trim().toLowerCase();
			const numericArg = /^[-+]?\d+$/.test(a) ? Number(a) : null;
			if (numericArg !== null) {
				if (!Number.isInteger(numericArg) || numericArg < 0 || numericArg > 100) {
					ctx.ui.notify("Doom HUD: test health must be an integer from 0 to 100", "warning");
				} else if (!active) {
					ctx.ui.notify("Doom HUD: start a TUI session before setting test health", "warning");
				} else {
					active.setHealthOverride(numericArg);
					ctx.ui.notify(`Doom HUD: test health ${numericArg}% until context changes`, "info");
				}
			} else if (a === "natural") {
				active?.clearHealthOverride();
				ctx.ui.notify("Doom HUD: natural context health", "info");
			} else if (a === "image") {
				const caps = getCapabilities();
				if (!caps.images) {
					ctx.ui.notify("Doom HUD: this terminal has no inline-image support", "warning");
				} else {
					active?.setImageFace(true);
					ctx.ui.notify(`Doom HUD: pixel face (${caps.images}, one image per row)`, "info");
				}
			} else if (a === "text") {
				active?.setImageFace(false);
				ctx.ui.notify("Doom HUD: half-block face", "info");
			} else {
				anim.enabled = !anim.enabled;
				active?.setEnabled(anim.enabled);
				ctx.ui.notify(anim.enabled ? "Doom HUD: ON" : "Doom HUD: OFF", "info");
			}
		},
	});

}
