// Pure helpers (no Premiere calls) so they can be checked with: node core.js
(function () {
	"use strict";

	const norm = (text) => String(text || "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

	// Premiere's transcript export -> flat word list with times in source seconds.
	// Entries with no text or tagged "disfluency" are hesitations ("um", stalls), not words.
	function flattenWords(transcript) {
		const words = [];
		for (const segment of transcript.segments || []) {
			for (const word of segment.words || []) {
				words.push({
					text: String(word.text || ""),
					start: word.start,
					end: word.start + word.duration,
					eos: Boolean(word.eos),
					filler: !norm(word.text) || (word.tags || []).includes("disfluency"),
				});
			}
		}
		return words.sort((a, b) => a.start - b.start);
	}

	const sameWords = (a, b) => a.length === b.length && a.every((token, i) => token.key === b[i].key);
	const textOf = (tokens) => tokens.slice(0, 14).map((token) => token.text).join(" ") + (tokens.length > 14 ? " …" : "");

	// Proposes sections to remove from source range [inPoint, outPoint].
	// options: { pauses, minPause, pad, fillers, repeats }
	// Returns [{ from, to, kind: "pause" | "hesitation" | "repeat", label }] sorted by time.
	function findCuts(words, inPoint, outPoint, options) {
		const inRange = words.filter((word) => word.end > inPoint && word.start < outPoint);
		const spoken = inRange.filter((word) => !word.filler).map((word) => ({ ...word, key: norm(word.text) }));
		let cuts = [];

		if (options.pauses) {
			const add = (from, to, gap) => cuts.push({ from, to, kind: "pause", label: `${gap.toFixed(1)}s` });
			let previousEnd = null;
			for (const word of spoken) {
				const gapStart = previousEnd === null ? inPoint : previousEnd;
				const gap = word.start - gapStart;
				// keep `pad` of quiet next to each word so speech is not clipped
				if (gap >= options.minPause) add(previousEnd === null ? inPoint : gapStart + options.pad, word.start - options.pad, gap);
				previousEnd = word.end;
			}
			if (previousEnd !== null && outPoint - previousEnd >= options.minPause) add(previousEnd + options.pad, outPoint, outPoint - previousEnd);
		}

		if (options.fillers) {
			for (const word of inRange.filter((entry) => entry.filler)) {
				// A stall that sits in a pause is handled by the pause cut, which leaves breathing room.
				if (cuts.some((cut) => cut.kind === "pause" && cut.from < word.end && cut.to > word.start)) continue;
				cuts.push({ from: word.start, to: word.end, kind: "hesitation", label: word.text || "um / stall" });
			}
		}

		if (options.repeats) {
			// Restarts: the speaker begins again with the same words. Everything from the first
			// attempt up to the restart goes. Two shapes count:
			//  - said twice back to back, 2+ words ("this is, this is", or a whole sentence again)
			//  - abandoned partway then restarted after a pause, 3+ matching opening words
			//    ("if it can catch this on the ... if it can catch only the last part")
			// ponytail: single repeated words ("the the") are left alone; "very very" is too often intended.
			// A deliberate list ("we need to test, we need to ship") can match; the review list is the guard.
			const RESTART_SPAN = 25; // how many words ahead to look for the restart
			const RESTART_PAUSE = 0.3; // seconds of silence that marks an abandoned attempt
			const RESTART_PHRASE = 5; // this many identical words in a row is a restart even with no pause
			const RETAKE_WINDOW = 90; // seconds: how far back an earlier take of the same line can be
			// Same opening word and mostly the same words in any order: a reworded second attempt
			// ("it is taking only 55 credits" ... "it is only taking 55 credits").
			const reworded = (i, j) => {
				const size = Math.min(j - i, 8, spoken.length - j);
				if (size < 4 || spoken[i].key !== spoken[j].key) return false;
				const pool = spoken.slice(j, j + size).map((token) => token.key);
				let hits = 0;
				for (const token of spoken.slice(i, i + size)) {
					const at = pool.indexOf(token.key);
					if (at === -1) continue;
					pool.splice(at, 1);
					hits += 1;
				}
				return hits >= 0.75 * size;
			};
			for (let i = 0; i < spoken.length; ) {
				// The last take is the keeper: look as far ahead as RETAKE_WINDOW and restart at the
				// LAST place the same opening comes back, so every earlier attempt goes in one cut.
				// Far-apart takes need RESTART_PHRASE identical words; the looser rules only apply nearby.
				let restart = -1;
				for (let j = i + 2; j < spoken.length && spoken[j].start - spoken[i].start <= RETAKE_WINDOW; j += 1) {
					let shared = 0;
					while (i + shared < j && j + shared < spoken.length && spoken[i + shared].key === spoken[j + shared].key) shared += 1;
					const backToBack = shared === j - i;
					const paused = spoken[j].start - spoken[j - 1].end >= RESTART_PAUSE;
					const near = j <= i + RESTART_SPAN && (backToBack || (paused && (shared >= 3 || reworded(i, j))));
					if (shared >= RESTART_PHRASE || near) restart = j;
				}
				if (restart === -1) {
					i += 1;
					continue;
				}
				const dropped = spoken.slice(i, restart);
				for (const token of dropped) token.dropped = true;
				cuts.push({ from: spoken[i].start, to: spoken[restart].start, kind: "repeat", label: textOf(dropped) });
				i = restart;
			}
			// Retakes: a sentence that starts the same way as the one after it. Keep the later take.
			// ponytail: compares opening words only; a reworded retake needs smarter (AI) matching.
			const sentences = [[]];
			for (const token of spoken) {
				sentences[sentences.length - 1].push(token);
				if (token.eos) sentences.push([]);
			}
			const full = sentences.filter((sentence) => sentence.length);
			for (let i = 0; i + 1 < full.length; i += 1) {
				const a = full[i].filter((token) => !token.dropped);
				const b = full[i + 1].filter((token) => !token.dropped);
				let shared = 0;
				while (shared < a.length && shared < b.length && a[shared].key === b[shared].key) shared += 1;
				if (shared >= 4 || (shared >= 2 && shared >= 0.6 * Math.min(a.length, b.length))) {
					cuts.push({ from: full[i][0].start, to: full[i + 1][0].start, kind: "repeat", label: textOf(full[i]) });
					for (const token of full[i]) token.dropped = true;
				}
			}
		}

		cuts = cuts
			.map((cut) => ({ ...cut, from: Math.max(cut.from, inPoint), to: Math.min(cut.to, outPoint) }))
			.filter((cut) => cut.to - cut.from >= 0.1);
		// A cut sitting wholly inside a bigger one (a pause inside a removed take) is just noise in the list.
		cuts = cuts.filter((cut) => !cuts.some((other) => other !== cut && other.from <= cut.from && other.to >= cut.to && other.to - other.from > cut.to - cut.from));
		cuts.sort((a, b) => a.from - b.from);
		// A gap between two cuts with no kept word in it is leftover quiet (the pad kept before a take
		// or "um" that then got removed). Stretch the later cut back over it so no silent sliver survives.
		const voice = [...spoken.filter((token) => !token.dropped), ...(options.fillers ? [] : inRange.filter((word) => word.filler))];
		let reach = null;
		for (const cut of cuts) {
			if (reach !== null && cut.from > reach && !voice.some((word) => word.end > reach && word.start < cut.from)) cut.from = reach;
			reach = Math.max(reach ?? cut.to, cut.to);
		}
		return cuts;
	}

	// What stays after removing `cuts` from [inPoint, outPoint], with edges on whole frames.
	// Returns [{ from, to }] in source seconds; pieces shorter than 2 frames are dropped.
	function keptRanges(cuts, inPoint, outPoint, frame) {
		const snap = (time) => inPoint + Math.round((time - inPoint) / frame) * frame;
		const kept = [];
		let position = inPoint;
		for (const cut of [...cuts].sort((a, b) => a.from - b.from)) {
			const from = Math.max(snap(cut.from), inPoint);
			const to = Math.min(snap(cut.to), outPoint);
			if (to <= position) continue;
			if (from - position >= 2 * frame - 1e-9) kept.push({ from: position, to: from });
			position = Math.max(position, to);
		}
		if (outPoint - position >= 2 * frame - 1e-9) kept.push({ from: position, to: outPoint });
		return kept;
	}

	globalThis.ClipMasterCore = { flattenWords, findCuts, keptRanges };

	if (typeof module !== "undefined" && typeof require === "function" && require.main === module) {
		const assert = require("node:assert");
		const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
		// builds a transcript from "word@start" items, 0.3s each; "." ends a sentence; "~@t+len" is a hesitation
		const make = (spec) => ({
			segments: [{
				words: spec.split(" ").map((entry) => {
					const [text, at] = entry.split("@");
					if (text === "~") return { text: "", start: Number(at.split("+")[0]), duration: Number(at.split("+")[1]), eos: false, tags: ["disfluency"] };
					return { text, start: Number(at), duration: 0.3, eos: text.endsWith("."), tags: [] };
				}),
			}],
		});
		const all = { pauses: true, minPause: 0.6, pad: 0.15, fillers: true, repeats: true };

		// pause between words, lead-in and tail silence
		let words = flattenWords(make("hello@1 there@1.3 friend.@3"));
		let cuts = findCuts(words, 0, 5, { ...all, repeats: false });
		assert.deepStrictEqual(cuts.map((c) => c.kind), ["pause", "pause", "pause"]);
		near(cuts[0].from, 0); near(cuts[0].to, 0.85);
		near(cuts[1].from, 1.75); near(cuts[1].to, 2.85);
		near(cuts[2].from, 3.45); near(cuts[2].to, 5);

		// hesitation: listed on its own when short, swallowed by the pause when it sits in one
		words = flattenWords(make("so@0 ~@0.3+0.4 we@0.7 go.@1 ~@1.3+1.5 next@2.8 thing.@3.1"));
		cuts = findCuts(words, 0, 3.4, { ...all, repeats: false });
		assert.deepStrictEqual(cuts.map((c) => [c.kind, c.from, c.to]), [["hesitation", 0.3, 0.7], ["pause", 1.45, 2.65]]);

		// the user's real sample: stutter restarts, then the first take is dropped as a retake
		words = flattenWords(make(
			"This@1 is@1.3 just@1.6 a@1.9 test@2.2 sounds.@2.5 " +
			"This@4 is,@4.3 this@4.6 is@4.9 this@5.2 is@5.5 just@5.8 a@6.1 test@6.4 again.@6.7"));
		cuts = findCuts(words, 0, 7, { ...all, pauses: false });
		assert.deepStrictEqual(cuts.map((c) => [c.kind, c.from, c.to]), [["repeat", 1, 5.2]]);
		// reworded second attempt after a pause (words swapped)
		words = flattenWords(make(
			"it@0 is@0.3 taking@0.6 only@0.9 55@1.2 credits,@1.5 which@1.8 is,@2.1 " +
			"it@3 is@3.3 only@3.6 taking@3.9 55@4.2 credits,@4.5 which@4.8 is@5.1 good.@5.4"));
		assert.deepStrictEqual(findCuts(words, 0, 5.7, { ...all, pauses: false }).map((c) => [c.kind, c.from, c.to]), [["repeat", 0, 3]]);
		// three takes of one line, far apart: only the last survives
		const takes = [
			"okay while we wait for it to generate in this video",
			...Array.from({ length: 30 }, (_, n) => `filler${n}`),
			"while we wait for it to generate you might have",
			...Array.from({ length: 30 }, (_, n) => `other${n}`),
			"okay while we wait for it to generate you might already.",
		].join(" ").split(" ");
		words = flattenWords(make(takes.map((word, n) => `${word}@${(n * 0.3).toFixed(1)}`).join(" ")));
		cuts = findCuts(words, 0, takes.length * 0.3, { ...all, pauses: false });
		assert.deepStrictEqual(cuts.map((c) => [c.kind, c.from]), [["repeat", 0]]);
		near(cuts[0].to, takes.lastIndexOf("okay") * 0.3);
		// a phrase said again after another sentence, with no pause
		words = flattenWords(make(
			"a@0 lot@0.3 of@0.6 ads@0.9 these@1.2 days.@1.5 I@1.8 mean@2.1 look.@2.4 " +
			"a@2.7 lot@3 of@3.3 ads@3.6 these@3.9 days.@4.2 I@4.5 dont@4.8 know.@5.1"));
		assert.deepStrictEqual(findCuts(words, 0, 5.4, { ...all, pauses: false }).map((c) => [c.kind, c.from, c.to]), [["repeat", 0, 2.7]]);
		// a whole 9-word sentence said twice inside one sentence (comma, no full stop between)
		words = flattenWords(make(
			"Let's@0 say@0.3 if@0.6 I@0.9 want@1.2 to@1.5 repeat@1.8 this@2.1 sentence,@2.4 " +
			"let's@3 say@3.3 if@3.6 I@3.9 want@4.2 to@4.5 repeat@4.8 this@5.1 sentence.@5.4"));
		assert.deepStrictEqual(findCuts(words, 0, 5.7, { ...all, pauses: false }).map((c) => [c.kind, c.from, c.to]), [["repeat", 0, 3]]);
		// a false start: abandoned, pause, restarted with the same opening words
		const falseStart = (restartAt) => flattenWords(make(
			"If@0 it@0.3 can@0.6 catch@0.9 this@1.2 on@1.5 the@1.8 " +
			["if", "it", "can", "catch", "only", "the", "last."].map((word, n) => `${word}@${(restartAt + n * 0.3).toFixed(1)}`).join(" ")));
		assert.deepStrictEqual(findCuts(falseStart(2.7), 0, 5, { ...all, pauses: false }).map((c) => [c.kind, c.from, c.to]), [["repeat", 0, 2.7]]);
		// ...but the same words with no pause before them are treated as normal speech
		assert.deepStrictEqual(findCuts(falseStart(2.1), 0, 5, { ...all, pauses: false }), []);
		// lead-in silence then a removed false start: no 0.15s silent sliver left between the two cuts
		words = flattenWords(make(
			"If@2 it@2.3 can@2.6 catch@2.9 this@3.2 on@3.5 the@3.8 if@4.7 it@5 can@5.3 catch@5.6 only@5.9 the@6.2 last.@6.5"));
		assert.deepStrictEqual(keptRanges(findCuts(words, 0, 6.8, all), 0, 6.8, 0.01).map((range) => range.from.toFixed(2)), ["4.70"]);
		// two different sentences are left alone
		words = flattenWords(make("We@0 open@0.3 the@0.6 file.@0.9 Then@1.2 we@1.5 save@1.8 it.@2.1"));
		assert.deepStrictEqual(findCuts(words, 0, 2.4, { ...all, pauses: false }), []);
		// only the part of the recording this clip shows is considered
		words = flattenWords(make("a@0 b@0.3 c.@5 d@5.3"));
		assert.deepStrictEqual(findCuts(words, 4.9, 5.7, all), []);

		// kept ranges: frame-snapped complement, overlapping cuts merged, slivers dropped
		const kept = keptRanges([{ from: 1.01, to: 2.02 }, { from: 1.5, to: 3 }, { from: 3.05, to: 4 }], 0, 5, 0.1);
		assert.strictEqual(kept.length, 2);
		near(kept[0].from, 0); near(kept[0].to, 1); near(kept[1].from, 4); near(kept[1].to, 5);
		assert.deepStrictEqual(keptRanges([], 2, 5, 0.1), [{ from: 2, to: 5 }]);
		assert.deepStrictEqual(keptRanges([{ from: 0, to: 9 }], 2, 5, 0.1), []);
		console.log("core.js ok");
	}
})();
