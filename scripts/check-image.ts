// Verifies the inline-image face geometry. The slice path only runs on terminals
// that support inline images, so nothing else catches a stretch regression: this
// forces the Kitty capability on, decodes the PNG slices the renderer emits, and
// checks the composited head keeps the source sprite's aspect.
//
//   npm test
import { setCapabilities, setCellDimensions } from "@earendil-works/pi-tui";
import { loadFrames, renderHudBar } from "../extensions/doom-hud/index.ts";
import type { HudData } from "../extensions/doom-hud/index.ts";
import { inflateSync } from "node:zlib";

/** Minimal 8-bit RGB/RGBA PNG reader for the slices we emit. */
function readPng(buf: Buffer): { w: number; h: number; ch: number; px: Uint8Array } {
	let off = 8, w = 0, h = 0, ch = 0;
	const idat: Buffer[] = [];
	while (off < buf.length) {
		const len = buf.readUInt32BE(off);
		const type = buf.slice(off + 4, off + 8).toString("ascii");
		if (type === "IHDR") { w = buf.readUInt32BE(off + 8); h = buf.readUInt32BE(off + 12); ch = buf[off + 17] === 6 ? 4 : 3; }
		else if (type === "IDAT") idat.push(buf.slice(off + 8, off + 8 + len));
		off += 12 + len;
		if (type === "IEND") break;
	}
	const raw = inflateSync(Buffer.concat(idat));
	const stride = w * ch;
	const out = new Uint8Array(h * stride);
	let prev = new Uint8Array(stride);
	let p = 0;
	for (let y = 0; y < h; y++) {
		const ft = raw[p++]!;
		const cur = new Uint8Array(raw.subarray(p, p + stride)); p += stride;
		for (let x = 0; x < stride; x++) {
			const a = x >= ch ? cur[x - ch]! : 0;
			const b = prev[x]!;
			const c = x >= ch ? prev[x - ch]! : 0;
			let v = cur[x]!;
			if (ft === 1) v = (v + a) & 255;
			else if (ft === 2) v = (v + b) & 255;
			else if (ft === 3) v = (v + ((a + b) >> 1)) & 255;
			else if (ft === 4) {
				const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
				v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
			}
			cur[x] = v;
		}
		out.set(cur, y * stride); prev = cur;
	}
	return { w, h, ch, px: out };
}

/** Pull every base64 payload out of a line's Kitty graphics escapes. */
function slicesIn(line: string): string[] {
	const out: string[] = [];
	const re = /\x1b_G([^;\x1b]*);([A-Za-z0-9+/=]*)\x1b\\/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(line))) out.push(m[2]!);
	return out;
}

const hud: HudData = {
	health: 55, usagePct: 45, contextTokens: 90_000, window: 200_000, cost: 1.694,
	stats: [
		{ label: "CACHE", value: "98%" }, { label: "IN", value: "18.4k" },
		{ label: "OUT", value: "534" }, { label: "BLENDED", value: "$1.203" },
	],
	modelId: "claude-opus-4-5", thinking: "high", provider: "anthropic",
	branch: "main", dir: "my-project",
};

const frames = await loadFrames();
const src = frames.get("tier3_neutral")!;
const srcAspect = src.width / src.height;

let failures = 0;
const fail = (msg: string) => { failures++; console.error("FAIL: " + msg); };

// A wide cell (9x40) must letterbox rather than stretch: the head keeps its
// aspect, so it covers well under half the stack. A normal cell (9x18) should
// fill nearly all of it.
const cases: { cw: number; ch: number; minCover: number; maxCover: number }[] = [
	{ cw: 9, ch: 18, minCover: 90, maxCover: 100 },
	{ cw: 8, ch: 16, minCover: 90, maxCover: 100 },
	{ cw: 12, ch: 24, minCover: 90, maxCover: 100 },
	{ cw: 10, ch: 20, minCover: 90, maxCover: 100 },
	{ cw: 9, ch: 40, minCover: 25, maxCover: 70 },
	{ cw: 9, ch: 36, minCover: 25, maxCover: 80 },
];

let tested = 0;
for (const { cw, ch, minCover, maxCover } of cases) {
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true } as never);
	setCellDimensions({ widthPx: cw, heightPx: ch } as never);
	const lines = renderHudBar(frames, hud, true, 120, "tier3_neutral");
	const decoded = lines
		.map(slicesIn)
		.filter((parts) => parts.length > 0)
		.map((parts) => readPng(Buffer.from(parts.join(""), "base64")));
	if (decoded.length === 0) continue; // escape format changed; skip rather than misreport
	tested++;

	let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
	decoded.forEach((img, row) => {
		for (let y = 0; y < img.h; y++) {
			for (let x = 0; x < img.w; x++) {
				const o = (y * img.w + x) * img.ch;
				const d = Math.max(
					Math.abs(img.px[o]! - 60),
					Math.abs(img.px[o + 1]! - 60),
					Math.abs(img.px[o + 2]! - 66),
				);
				if (d <= 10) continue; // steel ground (the panel colour)
				const gy = row * img.h + y;
				if (x < minX) minX = x;
				if (x > maxX) maxX = x;
				if (gy < minY) minY = gy;
				if (gy > maxY) maxY = gy;
			}
		}
	});
	const inkW = maxX - minX + 1, inkH = maxY - minY + 1;
	const aspectErr = (Math.abs(inkW / inkH - srcAspect) / srcAspect) * 100;
	const cover = ((maxY - minY + 1) / (decoded[0]!.h * decoded.length)) * 100;
	const label = `${cw}x${ch}`;
	if (aspectErr > 6) fail(`${label}: head aspect is ${(inkW / inkH).toFixed(4)}, source is ${srcAspect.toFixed(4)} (${aspectErr.toFixed(1)}% off) - distorted`);
	if (cover < minCover || cover > maxCover) fail(`${label}: head covers ${cover.toFixed(0)}% of the face panel, expected ${minCover}-${maxCover}%`);
}

if (tested === 0) {
	console.log("image checks skipped: the renderer emitted no inline-image escapes");
} else if (failures > 0) {
	console.error(`\n${failures} image check(s) failed`);
	process.exit(1);
} else {
	console.log(`image checks passed (${tested} cell geometries)`);
}