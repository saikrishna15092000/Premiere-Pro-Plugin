// Pure helpers (no Premiere calls) so they can be checked with: node core.js
(function () {
	"use strict";



	// First effect whose display name matches any pattern, in pattern order.
	function findEffect(matchNames, displayNames, patterns) {
		for (const pattern of patterns) {
			const index = displayNames.findIndex((name) => pattern.test(String(name || "").trim()));
			if (index !== -1) return { matchName: matchNames[index], displayName: displayNames[index] };
		}
		return null;
	}

	// padding 10% on a clip that fills the frame at base 100 -> scale 90.
	function paddingToScale(base, padding) {
		return base * (1 - padding / 100);
	}

	// Rounded Crop re-centres the kept area with Offset. Measured in Premiere: Top 20 -> Offset [0, 0.1].
	function cropOffset({ left, right, top, bottom }) {
		return [(left - right) / 200, (top - bottom) / 200];
	}

	// Reads the OBS cursor file (one JSON record per line). Returns left clicks as
	// { t: seconds into the recording, u, v: 0-1 position on the captured display }.
	function parseCursorFile(text) {
		const records = String(text).split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
			try {
				return JSON.parse(line);
			} catch (_error) {
				throw new Error(`Cursor file line ${index + 1} is not valid JSON.`);
			}
		});
		const header = records.find((record) => record.type === "header");
		if (!header || !String(header.schema).startsWith("recordly.cursor/")) {
			throw new Error("This is not an OBS cursor data file.");
		}
		// The old OBS script only logged the primary display, so its positions can't be trusted.
		if (!header.captureWidth || !header.captureHeight) {
			throw new Error("This file came from the old OBS script. Reload the script in OBS, pick the captured display, and record again.");
		}
		const raw = records.filter((record) => record.type === "point");
		const end = records.find((record) => record.type === "end");
		const lastUs = end ? end.durationUs : raw.length ? raw[raw.length - 1].tUs : 0;
		const tidy = (point) => ({ t: point.tUs / 1e6, u: point.u, v: point.v });
		return {
			clicks: raw.filter((point) => point.interaction === "click").map(tidy),
			points: raw.map(tidy), // the full cursor path
			durationSeconds: lastUs / 1e6,
		};
	}

	// Moments the cursor arrives somewhere and rests: it stays within `radius` (fraction of
	// the screen) for at least `dwell` seconds. The time given is when it arrived.
	// ponytail: fixed radius/dwell; make them settings if the defaults pick too many or too few.
	function findSettles(points, radius = 0.02, dwell = 0.6) {
		const settles = [];
		let anchor = null;
		let moved = false;
		let emitted = false;
		for (const point of points) {
			if (!anchor || Math.hypot(point.u - anchor.u, point.v - anchor.v) > radius) {
				moved = anchor !== null; // the very first resting spot is not an arrival
				anchor = point;
				emitted = false;
			} else if (moved && !emitted && point.t - anchor.t >= dwell) {
				settles.push({ t: anchor.t, u: anchor.u, v: anchor.v });
				emitted = true;
			}
		}
		return settles;
	}

	// Where the picture's centre must sit (0-1) so focus point f lands in the middle of the
	// visible area [lo, hi] at zoom s, without pulling cropped-away picture into view.
	function axisPosition(f, s, lo, hi) {
		const wanted = (lo + hi) / 2 - s * (f - 0.5);
		return Math.min(Math.max(wanted, hi - s * (hi - 0.5)), lo + s * (0.5 - lo));
	}

	function lerpKey(keys, t) {
		if (t <= keys[0].t) return { ...keys[0], t };
		for (let i = 1; i < keys.length; i += 1) {
			const a = keys[i - 1];
			const b = keys[i];
			if (t <= b.t) {
				const k = (t - a.t) / (b.t - a.t);
				const mix = (name) => a[name] + (b[name] - a[name]) * k;
				return { t, scale: mix("scale"), x: mix("x"), y: mix("y") };
			}
		}
		return { ...keys[keys.length - 1], t };
	}

	// Zoom keyframes for one timeline piece showing source seconds [inPoint, inPoint + duration].
	// Each event (a click or a cursor pause): zoom in over `transition`, stay `hold` seconds, zoom out.
	// Events close together share one zoom and pan between each other. With `follow`, the view
	// instead tracks the cursor path (`points`) for as long as it is zoomed.
	// crop = { left, right, top, bottom } as 0-1 fractions.
	// Returns [{ t (source seconds), scale (1 = none), x, y (0-1 picture-centre position) }], or [] if no zoom.
	const FOLLOW_STEP = 0.3; // seconds between follow keyframes at most
	const FOLLOW_DEADZONE = 0.04; // cursor must move this far (fraction of screen) before the view pans
	function buildZoomKeys({ events, points = [], follow = false, inPoint, duration, zoom, transition, hold, crop }) {
		const outPoint = inPoint + duration;
		const key = (t, scale, focus) => ({
			t,
			scale,
			x: axisPosition(focus ? focus.u : 0.5, scale, crop.left, 1 - crop.right),
			y: axisPosition(focus ? focus.v : 0.5, scale, crop.top, 1 - crop.bottom),
		});
		const groups = [];
		let previous = null;
		for (const event of [...events].sort((a, b) => a.t - b.t)) {
			if (previous && event.t - previous.t < 0.1) continue; // double-click
			if (previous && event.t <= previous.t + hold + 2 * transition) groups[groups.length - 1].push(event);
			else groups.push([event]);
			previous = event;
		}
		if (!groups.length) return [];

		const all = [];
		for (const group of groups) {
			const end = group[group.length - 1].t + hold;
			let focus = group[0];
			all.push(key(focus.t - transition, 1, null), key(focus.t, zoom, focus));
			// Pan to `next`, starting `lead` seconds before it arrives rather than drifting the whole gap.
			const panTo = (next, lead) => {
				if (next.t - lead > focus.t) all.push(key(next.t - lead, zoom, focus));
				all.push(key(next.t, zoom, next));
				focus = next;
			};
			if (follow) {
				for (const point of points) {
					if (point.t >= end - 0.05) break;
					if (point.t < focus.t + FOLLOW_STEP) continue;
					if (Math.hypot(point.u - focus.u, point.v - focus.v) >= FOLLOW_DEADZONE) panTo(point, FOLLOW_STEP);
				}
			} else {
				for (const event of group.slice(1)) panTo(event, transition);
			}
			all.push(key(end, zoom, focus), key(end + transition, 1, null));
		}

		// ponytail: edge keys are straight-line interpolated, so a zoom cut mid-transition
		// eases slightly differently from the uncut one. Exact curve sampling if it ever shows.
		const inside = all.filter((k) => k.t > inPoint + 0.001 && k.t < outPoint - 0.001);
		const keys = [lerpKey(all, inPoint), ...inside, lerpKey(all, outPoint)];
		return keys.some((k) => k.scale > 1.0001) ? keys : [];
	}

	const core = { findEffect, paddingToScale, cropOffset, parseCursorFile, findSettles, axisPosition, buildZoomKeys };
	globalThis.EasyRecordCore = core;

	if (typeof module !== "undefined" && typeof require === "function" && require.main === module) {
		const assert = require("node:assert");
		const patterns = [/^rounded crop$/i];
		assert.deepStrictEqual(
			findEffect(["a", "b", "c"], ["Crop", "Rounded Crop", "Drop Shadow"], patterns),
			{ matchName: "b", displayName: "Rounded Crop" },
		);
		assert.strictEqual(findEffect(["a"], ["Crop"], patterns), null);
		assert.strictEqual(paddingToScale(100, 10), 90);
		assert.strictEqual(paddingToScale(50, 20), 40);
		assert.deepStrictEqual(cropOffset({ left: 0, right: 0, top: 20, bottom: 0 }), [0, 0.1]);
		assert.deepStrictEqual(cropOffset({ left: 10, right: 30, top: 5, bottom: 5 }), [-0.1, 0]);

		const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
		const file = [
			'{"type":"header","schema":"recordly.cursor/1","captureWidth":2560,"captureHeight":1440}',
			
			'{"type":"point","tUs":1000000,"u":0.2,"v":0.3}',
			'{"type":"point","tUs":5000000,"u":0.9,"v":0.5,"interaction":"click"}',
			'{"type":"point","tUs":5200000,"u":0.9,"v":0.5,"interaction":"mouseup"}',
			'{"type":"end","frames":600,"durationUs":20000000}',
		].join("\n");
		const parsed = parseCursorFile(file);
		assert.deepStrictEqual(parsed.clicks, [{ t: 5, u: 0.9, v: 0.5 }]);
		assert.strictEqual(parsed.points.length, 3);
		assert.strictEqual(parsed.durationSeconds, 20);
		assert.throws(() => parseCursorFile('{"type":"point"}'), /not an OBS cursor/);
		assert.throws(() => parseCursorFile('{"type":"header","schema":"recordly.cursor/1"}'), /old OBS script/);

		// no zoom -> centred; centre focus -> centred; edge focus -> clamped so no empty edge shows
		near(axisPosition(0.9, 1, 0, 1), 0.5);
		near(axisPosition(0.5, 2, 0, 1), 0.5);
		near(axisPosition(0.9, 2, 0, 1), 0);
		// left 20% cropped: unzoomed stays put, and the cropped strip never slides into view
		near(axisPosition(0.3, 1, 0.2, 1), 0.5);
		near(axisPosition(0.2, 2, 0.2, 1), 0.8);

		const noCrop = { left: 0, right: 0, top: 0, bottom: 0 };
		const opts = { zoom: 2, transition: 0.5, hold: 1, crop: noCrop };
		const click = { t: 5, u: 0.5, v: 0.5 };
		// whole zoom inside the piece: flat, in, peak, hold end, out, flat
		const whole = buildZoomKeys({ ...opts, events: [click], inPoint: 0, duration: 10 });
		assert.deepStrictEqual(whole.map((k) => [k.t, k.scale]), [[0, 1], [4.5, 1], [5, 2], [6, 2], [6.5, 1], [10, 1]]);
		// piece cut from the middle of the hold: stays zoomed the whole way
		const mid = buildZoomKeys({ ...opts, events: [click], inPoint: 5.2, duration: 0.5 });
		assert.deepStrictEqual(mid.map((k) => k.scale), [2, 2]);
		// piece with no zoom in it: nothing to write
		assert.deepStrictEqual(buildZoomKeys({ ...opts, events: [click], inPoint: 7, duration: 2 }), []);
		assert.deepStrictEqual(buildZoomKeys({ ...opts, events: [], inPoint: 0, duration: 2 }), []);
		// two close clicks share one zoom (no zoom-out between them)
		const pair = buildZoomKeys({ ...opts, events: [click, { t: 6.8, u: 0.9, v: 0.5 }], inPoint: 0, duration: 10 });
		assert.deepStrictEqual(pair.map((k) => [k.t, k.scale]), [[0, 1], [4.5, 1], [5, 2], [6.3, 2], [6.8, 2], [7.8, 2], [8.3, 1], [10, 1]]);
		near(pair[3].x, 0.5);
		near(pair[4].x, 0);

		// cursor path: rests at A (start, ignored), moves, rests at B from t=2, moves, passes C without resting
		const path = [];
		for (let t = 0; t <= 1; t += 0.1) path.push({ t, u: 0.1, v: 0.1 });
		path.push({ t: 1.5, u: 0.5, v: 0.5 });
		for (let t = 2; t <= 4; t += 0.1) path.push({ t, u: 0.8, v: 0.8 });
		path.push({ t: 4.2, u: 0.3, v: 0.3 }, { t: 4.4, u: 0.6, v: 0.2 });
		assert.deepStrictEqual(findSettles(path), [{ t: 2, u: 0.8, v: 0.8 }]);

		// follow: zoomed from the click at 5 until 8; the cursor moves at 6.5, so the view pans then
		const trail = [{ t: 5.5, u: 0.5, v: 0.5 }, { t: 6.5, u: 0.5, v: 0.9 }, { t: 6.6, u: 0.5, v: 0.91 }, { t: 9, u: 0.1, v: 0.1 }];
		const followed = buildZoomKeys({ ...opts, hold: 3, events: [click], points: trail, follow: true, inPoint: 0, duration: 10 });
		assert.deepStrictEqual(followed.map((k) => [k.t, k.scale]), [[0, 1], [4.5, 1], [5, 2], [6.2, 2], [6.5, 2], [8, 2], [8.5, 1], [10, 1]]);
		near(followed[3].y, 0.5);
		near(followed[4].y, 0);
		console.log("core.js ok");
	}
})();
