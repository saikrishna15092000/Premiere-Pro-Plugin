// Runs the real cutting code from main.js against a fake Premiere timeline whose trim, move and
// duplicate commands behave the way the test panel measured them. Run with: node test-cut.js
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const TPS = 254016000000;
const FRAME = TPS / 60;

class TickTime {
	constructor(ticks) { this.ticks = String(ticks); this.seconds = ticks / TPS; }
	static createWithTicks(text) { return new TickTime(Number(text)); }
	static createWithSeconds(value) { return new TickTime(Math.round(value * TPS)); }
	subtract(other) { return new TickTime(Number(this.ticks) - Number(other.ticks)); }
}
class Item {
	constructor(track, start, end, inPoint) { Object.assign(this, { track, start, end, inPoint }); }
	async getStartTime() { return new TickTime(this.start); }
	async getEndTime() { return new TickTime(this.end); }
	async getInPoint() { return new TickTime(this.inPoint); }
	async getTrackIndex() { return this.track.index; }
	createSetEndAction(time) { return () => { this.end = Number(time.ticks); }; }
	createSetInPointAction(time) {
		// measured: the end stays put, the start moves right
		return () => { this.start += Number(time.ticks) - this.inPoint; this.inPoint = Number(time.ticks); };
	}
	createMoveAction(time) { return () => { this.start += Number(time.ticks); this.end += Number(time.ticks); }; }
}
class VideoClipTrackItem extends Item {}
class AudioClipTrackItem extends Item {}
const track = (index) => ({ index, items: [], async getTrackItems() { return this.items; } });

const video = track(0);
const screen = track(1); // V2: a screen recording made at the same time, stacked above
const audio = track(0);
const sequence = {
	async getVideoTrackCount() { return 2; },
	async getAudioTrackCount() { return 1; },
	async getVideoTrack(i) { return [video, screen][i]; },
	async getAudioTrack() { return audio; },
	async getEndTime() { return new TickTime(Math.max(...[...video.items, ...screen.items, ...audio.items].map((item) => item.end))); },
};
const project = {
	lockedAccess(task) { task(); },
	executeTransaction(build) {
		const actions = [];
		build({ addAction: (action) => actions.push(action) });
		for (const action of actions) action();
		return true;
	},
};
const ppro = {
	TickTime,
	VideoClipTrackItem,
	AudioClipTrackItem,
	Constants: { TrackItemType: { CLIP: 1 } },
	SequenceEditor: {
		getEditor: () => ({
			createCloneTrackItemAction: (item, offset) => () => {
				const copy = new item.constructor(item.track, item.start + Number(offset.ticks), item.end + Number(offset.ticks), item.inPoint);
				// assumed: Premiere files a new clip in time order, but never re-sorts after a move
				const after = item.track.items.findIndex((other) => other.start > copy.start);
				item.track.items.splice(after === -1 ? item.track.items.length : after, 0, copy);
			},
		}),
	},
};

// Load main.js with a stand-in page and Premiere.
const stub = () => ({ addEventListener() {}, appendChild() {}, value: "", textContent: "", checked: true });
globalThis.document = { getElementById: stub, createElement: stub };
globalThis.require = (name) => (name === "premierepro" ? ppro : name === "uxp" ? { versions: { plugin: "test" } } : require(name));
vm.runInThisContext(fs.readFileSync(path.join(__dirname, "core.js"), "utf8"));
vm.runInThisContext(fs.readFileSync(path.join(__dirname, "main.js"), "utf8"));

(async () => {
	// Shaped like the recording that glitched: 60 fps, 725.367s of video, audio 3 frames shorter,
	// plus another clip (video and audio) sitting right after it.
	const videoEnd = 43522 * FRAME;
	const audioEnd = Math.round(725.312 * TPS);
	const main = new VideoClipTrackItem(video, 0, videoEnd, 0);
	const sound = new AudioClipTrackItem(audio, 0, audioEnd, 0);
	const nextVideo = new VideoClipTrackItem(video, videoEnd, videoEnd + 600 * FRAME, 0);
	const nextAudio = new AudioClipTrackItem(audio, videoEnd, videoEnd + 600 * FRAME, 0);
	// the screen recording started 5s earlier, so its in point is 5s further into its file
	const shot = new VideoClipTrackItem(screen, 0, videoEnd, 5 * TPS);
	video.items.push(main, nextVideo);
	screen.items.push(shot);
	audio.items.push(sound, nextAudio);

	// 40 awkward, off-frame cuts spread through the clip, including the very start and the very end.
	const cuts = [{ from: 0, to: 1.2345, checked: true }, { from: 700.123, to: 725.367, checked: true }];
	for (let i = 1; i <= 38; i += 1) cuts.push({ from: i * 18 + 0.0071 * i, to: i * 18 + 4.4444 + 0.013 * i, checked: i !== 7 });
	const slot = { name: "test", items: [main, sound, shot], inPoint: 0, outPoint: 725.367, cuts };

	const removed = await cutSlot(project, sequence, slot, FRAME);

	for (const [name, list, next] of [["video", video.items, nextVideo], ["audio", audio.items, nextAudio]]) {
		// the track's own list is still in time order: no clip ever jumped over another
		list.forEach((item, index) => assert.ok(!index || item.start >= list[index - 1].start, `${name}: list order broken at ${index}`));
		const pieces = list.filter((item) => item !== next).sort((a, b) => a.start - b.start);
		assert.strictEqual(pieces.length, 38, `${name}: 38 pieces`);
		assert.strictEqual(pieces[0].start, 0, `${name}: starts at 0`);
		for (const [index, piece] of pieces.entries()) {
			assert.strictEqual(piece.start % FRAME, 0, `${name} piece ${index} starts on a frame`);
			assert.ok(piece.end > piece.start, `${name} piece ${index} has length`);
			// no gaps and no overlaps: each piece begins exactly where the previous one ends
			if (index) assert.strictEqual(piece.start, pieces[index - 1].end, `${name} piece ${index} butts up to the previous`);
		}
		// the following clip closed up against the last piece, and nothing is left parked far away
		assert.strictEqual(next.start, pieces[pieces.length - 1].end, `${name}: next clip closed the gap`);
		assert.ok(Math.max(...list.map((item) => item.end)) <= next.end, `${name}: nothing left past the end`);
	}
	// video and audio pieces line up one to one, with the same picture/sound under them
	const sortByStart = (list) => [...list].sort((a, b) => a.start - b.start);
	sortByStart(video.items).forEach((piece, index) => {
		const partner = sortByStart(audio.items)[index];
		assert.strictEqual(piece.start, partner.start, `piece ${index}: audio and video start together`);
		if (piece !== nextVideo) assert.strictEqual(piece.inPoint, partner.inPoint, `piece ${index}: audio and video show the same moment`);
	});
	// the stacked screen recording was cut at exactly the same timeline points, 5s ahead in its file
	const screenPieces = sortByStart(screen.items);
	const cameraPieces = sortByStart(video.items).filter((item) => item !== nextVideo);
	assert.strictEqual(screenPieces.length, cameraPieces.length, "screen: same number of pieces");
	screenPieces.forEach((piece, index) => {
		assert.strictEqual(piece.start, cameraPieces[index].start, `screen piece ${index}: starts with the camera`);
		assert.strictEqual(piece.end, cameraPieces[index].end, `screen piece ${index}: ends with the camera`);
		assert.strictEqual(piece.inPoint - cameraPieces[index].inPoint, 5 * TPS, `screen piece ${index}: stays in sync`);
	});
	assert.ok(Math.abs(removed - (videoEnd - nextVideo.start + 0) / TPS) < 1e-6);
	console.log(`test-cut ok: ${removed.toFixed(2)}s removed, 38 pieces per track, frame-aligned, no gaps or overlaps`);
})().catch((error) => {
	console.error(error);
	process.exit(1);
});
