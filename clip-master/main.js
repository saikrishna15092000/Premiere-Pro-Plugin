"use strict";

const ppro = require("premierepro");
const core = globalThis.ClipMasterCore;

const statusEl = document.getElementById("status");
const reportEl = document.getElementById("report");
const cutsEl = document.getElementById("cuts");
const applyButton = document.getElementById("apply");

const seconds = (time) => Number(time && time.seconds);
const tick = (value) => ppro.TickTime.createWithSeconds(value);
const round = (value) => Math.round(value * 1000) / 1000;
const NEAR = 0.02; // seconds: two times this close count as the same spot

function setStatus(text, isError) {
	statusEl.textContent = text;
	statusEl.className = isError ? "error" : "";
}

function log(text) {
	reportEl.value += `${text}\n`;
}

function transact(project, label, build) {
	let ok = false;
	project.lockedAccess(() => {
		ok = project.executeTransaction(build, label);
	});
	if (!ok) throw new Error(`Premiere rejected: ${label}`);
}

const isAudio = (item) => item instanceof ppro.AudioClipTrackItem;

async function clipsOn(track) {
	return (await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)) || [];
}

async function trackOf(sequence, item) {
	const index = await item.getTrackIndex();
	return isAudio(item) ? sequence.getAudioTrack(index) : sequence.getVideoTrack(index);
}

async function allClips(sequence) {
	const clips = [];
	for (let i = 0; i < (await sequence.getVideoTrackCount()); i += 1) clips.push(...(await clipsOn(await sequence.getVideoTrack(i))));
	for (let i = 0; i < (await sequence.getAudioTrackCount()); i += 1) clips.push(...(await clipsOn(await sequence.getAudioTrack(i))));
	return clips;
}

function timecode(value) {
	const minutes = Math.floor(value / 60);
	return `${minutes}:${(value - minutes * 60).toFixed(1).padStart(4, "0")}`;
}

// ---- Find cuts ----

let plan = null; // { project, sequence, slots: [{ name, items, inPoint, outPoint, start, cuts }] }

function readOptions() {
	const options = {
		pauses: document.getElementById("pauses").checked,
		minPause: Number(document.getElementById("minPause").value),
		pad: Number(document.getElementById("pad").value),
		fillers: document.getElementById("fillers").checked,
		repeats: document.getElementById("repeats").checked,
	};
	if (!(options.minPause > 0) || !(options.pad >= 0) || options.pad * 2 >= options.minPause) {
		throw new Error("The quiet kept around speech must be less than half the pause length.");
	}
	return options;
}

async function analyze() {
	const options = readOptions();
	const project = await ppro.Project.getActiveProject();
	if (!project) throw new Error("Open a project first.");
	const sequence = await project.getActiveSequence();
	if (!sequence) throw new Error("Open a sequence first.");
	const selected = (await (await sequence.getSelection()).getTrackItems()).filter(
		(item) => item instanceof ppro.VideoClipTrackItem || isAudio(item),
	);
	if (!selected.length) throw new Error("Select at least one clip.");

	// Everything selected that starts at the same spot is one slot and gets identical cuts: a
	// clip's own video and audio, plus any recordings stacked above or below it (camera + screen
	// recorded together). One transcript drives them all. Ends may differ.
	const slots = new Map();
	for (const item of selected) {
		const speed = Number(await item.getSpeed());
		if (Boolean(Number(await item.isSpeedReversed())) || (Math.abs(speed - 1) > 0.001 && Math.abs(speed - 100) > 0.01)) {
			throw new Error("Clip Master needs normal-speed, forward clips.");
		}
		const start = seconds(await item.getStartTime());
		const key = String(round(start));
		if (!slots.has(key)) slots.set(key, { items: [], start, end: 0 });
		slots.get(key).items.push(item);
		slots.get(key).end = Math.max(slots.get(key).end, seconds(await item.getEndTime()));
	}
	const ordered = [...slots.values()].sort((a, b) => a.start - b.start);
	ordered.forEach((slot, i) => {
		if (i && slot.start < ordered[i - 1].end - NEAR) {
			throw new Error("Stacked clips must start at the same point. Razor them together at the start, then try again.");
		}
	});

	// A clip left unselected under or over a slot would fall out of sync once the slot is cut.
	const isSelected = async (clip) => {
		for (const item of selected) {
			if (isAudio(item) === isAudio(clip) && (await item.getTrackIndex()) === (await clip.getTrackIndex()) &&
				Math.abs(seconds(await item.getStartTime()) - seconds(await clip.getStartTime())) < NEAR) return true;
		}
		return false;
	};
	for (const clip of await allClips(sequence)) {
		const clipStart = seconds(await clip.getStartTime());
		const clipEnd = seconds(await clip.getEndTime());
		for (const slot of ordered) {
			if (clipStart < slot.end - NEAR && clipEnd > slot.start + NEAR && !(await isSelected(clip))) {
				const lane = `${isAudio(clip) ? "A" : "V"}${(await clip.getTrackIndex()) + 1}`;
				throw new Error(`A clip on ${lane} at ${timecode(clipStart)} overlaps the selection but is not selected. Select it too, or it would go out of sync.`);
			}
		}
	}

	plan = { project, sequence, slots: [] };
	for (const slot of ordered) {
		// The transcript comes from the first clip that has one; audio is checked first.
		slot.items.sort((a, b) => Number(isAudio(b)) - Number(isAudio(a)));
		const names = [];
		let json = "";
		for (let i = 0; i < slot.items.length && !json; i += 1) {
			const projectItem = ppro.ClipProjectItem.cast(await slot.items[i].getProjectItem());
			if (!projectItem) continue;
			if (!names.includes(projectItem.name)) names.push(projectItem.name);
			try {
				json = await ppro.Transcript.exportToJSON(projectItem);
			} catch (_error) {
				json = "";
			}
			if (json) slot.items.unshift(...slot.items.splice(i, 1)); // cutSlot reads in points from items[0]
		}
		for (const item of slot.items) {
			const projectItem = await item.getProjectItem();
			if (projectItem && !names.includes(projectItem.name)) names.push(projectItem.name);
		}
		slot.name = names.join(" + ") || "clip";
		if (!json) throw new Error(`"${slot.name}" has no transcript. Transcribe it in the Text panel first.`);
		slot.inPoint = seconds(await slot.items[0].getInPoint());
		slot.outPoint = slot.inPoint + (slot.end - slot.start); // in the transcript clip's own time
		slot.cuts = core
			.findCuts(core.flattenWords(JSON.parse(json)), slot.inPoint, slot.outPoint, options)
			.map((cut) => ({ ...cut, checked: true }));
		plan.slots.push(slot);
	}
	renderPlan();
	const total = plan.slots.reduce((sum, slot) => sum + slot.cuts.length, 0);
	return total ? `Found ${total} section(s). Untick any you want to keep, then click Cut.` : "Nothing to remove with these settings.";
}

function renderPlan() {
	cutsEl.innerHTML = "";
	for (const slot of plan.slots) {
		const heading = document.createElement("div");
		heading.className = "clip";
		heading.textContent = `${slot.name} at ${timecode(slot.start)}`;
		cutsEl.appendChild(heading);
		for (const cut of slot.cuts) {
			const row = document.createElement("div");
			row.className = "cut";
			const box = document.createElement("input");
			box.type = "checkbox";
			box.checked = true;
			box.addEventListener("change", () => {
				cut.checked = box.checked;
				refreshApplyButton();
			});
			const text = document.createElement("span");
			// times are shown as they sit on the timeline right now
			const at = slot.start + (cut.from - slot.inPoint);
			text.textContent = ` ${timecode(at)}  ${(cut.to - cut.from).toFixed(1)}s  ${cut.kind}: ${cut.label}`;
			row.appendChild(box);
			row.appendChild(text);
			cutsEl.appendChild(row);
		}
	}
	refreshApplyButton();
}

function refreshApplyButton() {
	const count = plan ? plan.slots.reduce((sum, slot) => sum + slot.cuts.filter((cut) => cut.checked).length, 0) : 0;
	applyButton.disabled = count === 0;
	applyButton.textContent = count ? `Cut ${count} section(s)` : "Cut";
}

// ---- Cut the timeline ----
// Premiere gives plugins no razor. A clip is cut into pieces by duplicating it once per extra
// piece (parked past the end of the sequence), trimming every copy to its piece, and moving
// the pieces together. Each track item is handled on its own, video and audio alike.
//
// All timeline maths is in whole ticks (Premiere's exact time unit) on whole sequence frames.
// Seconds as decimals drift by a hair, which leaves clips off the frame grid or overlapping.

const TICKS_PER_SECOND = 254016000000;
const NEAR_TICKS = NEAR * TICKS_PER_SECOND;
const ticksOf = (time) => Number(time.ticks);
const asSeconds = (ticks) => (ticks / TICKS_PER_SECOND).toFixed(3);

// A TickTime for an exact whole number of ticks. Negative values are used to move left.
function tickTime(ticks) {
	const whole = Math.round(ticks);
	if (whole >= 0) return ppro.TickTime.createWithTicks(String(whole));
	const attempts = [
		() => ppro.TickTime.createWithTicks(String(whole)),
		() => ppro.TickTime.createWithTicks("0").subtract(ppro.TickTime.createWithTicks(String(-whole))),
	];
	for (const attempt of attempts) {
		try {
			const time = attempt();
			if (Number(time.ticks) === whole) return time;
		} catch (_error) {
			// try the next way
		}
	}
	return ppro.TickTime.createWithSeconds(whole / TICKS_PER_SECOND); // moveTo re-checks and corrects
}

// Moves each item so it starts exactly at its target tick. Video first, then audio with positions
// re-read, so audio that already followed its linked video is not moved twice. Repeats until
// nothing is off, which also mops up any inexact move.
async function moveTo(project, entries, label) {
	for (let pass = 0; pass < 3; pass += 1) {
		let moved = false;
		for (const audioWave of [false, true]) {
			const moves = [];
			for (const entry of entries.filter((candidate) => isAudio(candidate.item) === audioWave)) {
				const shift = entry.target - ticksOf(await entry.item.getStartTime());
				if (shift !== 0) moves.push({ item: entry.item, shift });
			}
			if (!moves.length) continue;
			moved = true;
			transact(project, label, (action) => {
				for (const move of moves) action.addAction(move.item.createMoveAction(tickTime(move.shift)));
			});
		}
		if (!moved) return;
	}
}

// Returns how many seconds were removed from this slot.
async function cutSlot(project, sequence, slot, frameTicks) {
	const frame = frameTicks / TICKS_PER_SECOND;
	const first = slot.items[0];
	if (Math.abs(seconds(await first.getInPoint()) - slot.inPoint) > NEAR) {
		throw new Error(`"${slot.name}" changed since Find cuts. Click Find cuts again.`);
	}
	const kept = core.keptRanges(slot.cuts.filter((cut) => cut.checked), slot.inPoint, slot.outPoint, frame);
	if (!kept.length) {
		log(`${slot.name}: every part would be removed, so it was left alone.`);
		return 0;
	}

	// Kept pieces as whole frames counted from the clip's in point; `at` is where each lands.
	let placed = 0;
	const pieces = kept.map((range) => {
		const piece = { from: Math.round((range.from - slot.inPoint) / frame), to: Math.round((range.to - slot.inPoint) / frame), at: placed };
		placed += piece.to - piece.from;
		return piece;
	});

	// Each selected track item (the video, each audio) and the pieces it has material for.
	const startTicks = ticksOf(await first.getStartTime());
	const tracks = [];
	let slotEnd = 0;
	for (const item of slot.items) {
		const start = ticksOf(await item.getStartTime());
		const end = ticksOf(await item.getEndTime());
		if (Math.abs(start - startTicks) > NEAR_TICKS) throw new Error(`"${slot.name}" changed since Find cuts. Click Find cuts again.`);
		const ownFrames = (end - start) / frameTicks; // audio is often a few frames shorter than video
		tracks.push({ item, start, end, inTicks: ticksOf(await item.getInPoint()), ownFrames, own: pieces.filter((piece) => ownFrames - piece.from >= 2) });
		slotEnd = Math.max(slotEnd, end);
	}
	const longest = Math.max(...tracks.map((track) => track.ownFrames));
	if (pieces.length === 1 && pieces[0].from === 0 && pieces[0].to >= longest - 1) return 0;

	// Everything after this clip, on every track, will close up by the amount removed.
	// ponytail: clips on other tracks that overlap this one are not rippled; fine for a
	// single-recording timeline, needs sync-lock style handling for layered edits.
	const later = [];
	for (const item of await allClips(sequence)) {
		const itemStart = ticksOf(await item.getStartTime());
		if (itemStart >= slotEnd - NEAR_TICKS) later.push({ item, from: itemStart });
	}
	later.sort((a, b) => a.from - b.from);

	// 1. Park one copy per extra piece past the end of the sequence, on whole frames.
	const parkBase = (Math.ceil(ticksOf(await sequence.getEndTime()) / frameTicks) + 600) * frameTicks;
	const parkAt = (index) => parkBase + (index - 1) * (Math.ceil(longest) + 60) * frameTicks;
	// Premiere keeps each track's clips in a list and does not re-sort it when a plugin moves one
	// clip past another; the timeline then flickers and will not play. So nothing may ever jump
	// over another clip: the clips after this one step out beyond the parking area first (last
	// clip first), the copies are made in the space between, and everything closes up leftwards.
	if (later.length) {
		const lift = parkAt(Math.max(...tracks.map((track) => track.own.length)) + 1) - slotEnd;
		for (const item of later) item.target = item.from + lift;
		await moveTo(project, [...later].reverse(), "Clip Master: make room");
	}
	const editor = ppro.SequenceEditor.getEditor(sequence);
	if (tracks.some((track) => track.own.length > 1)) {
		transact(project, "Clip Master: duplicate", (action) => {
			for (const track of tracks) {
				for (let i = 1; i < track.own.length; i += 1) {
					action.addAction(editor.createCloneTrackItemAction(track.item, tickTime(parkAt(i) - track.start), 0, 0, true, false));
				}
			}
		});
	}
	log(`${slot.name}: duplicated`);

	// 2. Find every copy before changing anything else.
	const entries = []; // one per piece per track item
	for (const track of tracks) {
		if (!track.own.length) continue;
		const add = (item, piece, base) => {
			const reachesEnd = piece.to >= track.ownFrames - 1e-6;
			const endTicks = reachesEnd ? base + (track.end - track.start) : base + piece.to * frameTicks;
			entries.push({
				item,
				piece,
				trimEnd: reachesEnd ? null : endTicks,
				inPoint: piece.from > 0 ? track.inTicks + piece.from * frameTicks : null,
				target: startTicks + piece.at * frameTicks,
				length: endTicks - base - piece.from * frameTicks,
			});
		};
		add(track.item, track.own[0], track.start);
		const onTrack = await clipsOn(await trackOf(sequence, track.item));
		for (let i = 1; i < track.own.length; i += 1) {
			let copy = null;
			for (const candidate of onTrack) {
				if (Math.abs(ticksOf(await candidate.getStartTime()) - parkAt(i)) < NEAR_TICKS) copy = candidate;
			}
			if (!copy) throw new Error("A duplicated clip did not appear where expected. Press Ctrl+Z once, then send me the log.");
			add(copy, track.own[i], parkAt(i));
		}
	}

	// 3. Trim each to its piece: end first, then the head (which keeps the end where it is).
	const ends = entries.filter((entry) => entry.trimEnd !== null);
	if (ends.length) {
		transact(project, "Clip Master: trim ends", (action) => {
			for (const entry of ends) action.addAction(entry.item.createSetEndAction(tickTime(entry.trimEnd)));
		});
	}
	const heads = entries.filter((entry) => entry.inPoint !== null);
	if (heads.length) {
		transact(project, "Clip Master: trim starts", (action) => {
			for (const entry of heads) action.addAction(entry.item.createSetInPointAction(tickTime(entry.inPoint)));
		});
	}
	log(`${slot.name}: trimmed`);

	// 4. Bring the pieces together, then close the gap behind them.
	await moveTo(project, entries, "Clip Master: join pieces");
	const newEnd = Math.max(...entries.map((entry) => entry.target + entry.length));
	const removedTicks = Math.round((slotEnd - newEnd) / frameTicks) * frameTicks;
	for (const item of later) item.target = item.from - removedTicks;
	await moveTo(project, later, "Clip Master: close gap");

	// 5. Check every piece really is where it should be, and say so in the log.
	let wrong = 0;
	for (const entry of entries) {
		const start = ticksOf(await entry.item.getStartTime());
		const length = ticksOf(await entry.item.getEndTime()) - start;
		if (start !== entry.target || Math.abs(length - entry.length) > 1) {
			wrong += 1;
			log(
				`  MISPLACED ${isAudio(entry.item) ? "audio" : "video"} piece: wanted start ${asSeconds(entry.target)} length ${asSeconds(entry.length)},` +
					` got start ${asSeconds(start)} length ${asSeconds(length)} (off by ${start - entry.target} ticks)`,
			);
		}
	}
	log(`${slot.name}: ${pieces.length} piece(s) kept, ${asSeconds(removedTicks)}s removed, ${entries.length} track pieces checked, ${wrong} misplaced.`);
	if (wrong) throw new Error(`${wrong} piece(s) did not land where expected. Press Ctrl+Z until the clip is whole again and send me the log.`);
	return removedTicks / TICKS_PER_SECOND;
}

// Writes every clip on every track to the log (start-end and source in point, in seconds),
// and flags anything suspicious: overlapping clips, or clips starting off the frame grid.
async function dumpTimeline(sequence, frameTicks, title) {
	const sequenceEnd = ticksOf(await sequence.getEndTime());
	log(`-- ${title}; sequence ends at ${asSeconds(sequenceEnd)}`);
	let lastEnd = 0;
	const lanes = [];
	for (let i = 0; i < (await sequence.getVideoTrackCount()); i += 1) lanes.push([`V${i + 1}`, await sequence.getVideoTrack(i)]);
	for (let i = 0; i < (await sequence.getAudioTrackCount()); i += 1) lanes.push([`A${i + 1}`, await sequence.getAudioTrack(i)]);
	for (const [name, track] of lanes) {
		const items = [];
		for (const item of await clipsOn(track)) {
			items.push({ start: ticksOf(await item.getStartTime()), end: ticksOf(await item.getEndTime()), inPoint: ticksOf(await item.getInPoint()) });
		}
		if (!items.length) continue;
		const shuffled = items.some((item, index) => index && item.start < items[index - 1].start);
		items.sort((a, b) => a.start - b.start);
		if (shuffled) log(`!! ${name}: Premiere lists these clips OUT OF ORDER`);
		lastEnd = Math.max(lastEnd, ...items.map((item) => item.end));
		const flags = [];
		items.forEach((item, index) => {
			if (index && item.start < items[index - 1].end) flags.push(`OVERLAP at ${asSeconds(item.start)}`);
			if (item.start % frameTicks !== 0) flags.push(`OFF-FRAME start ${asSeconds(item.start)}`);
			if (item.end <= item.start) flags.push(`EMPTY at ${asSeconds(item.start)}`);
		});
		log(`${name} (${items.length} clips)${flags.length ? ` !! ${flags.join("; ")}` : " ok"}`);
		log(`   ${items.map((item) => `${asSeconds(item.start)}-${asSeconds(item.end)}@${asSeconds(item.inPoint)}`).join(" | ")}`);
	}
	// Premiere's own idea of where the sequence ends should match the last clip.
	if (Math.abs(sequenceEnd - lastEnd) > frameTicks) log(`!! TIMELINE BROKEN: last clip ends at ${asSeconds(lastEnd)} but Premiere says ${asSeconds(sequenceEnd)}`);
}

async function applyPlan() {
	if (!plan) throw new Error("Click Find cuts first.");
	const { project, sequence } = plan;
	const rate = (await sequence.getSettings()).getVideoFrameRate().value;
	if (!(rate > 1)) throw new Error("Could not read the sequence frame rate.");
	const frameTicks = Math.round(TICKS_PER_SECOND / rate);
	reportEl.value = "";
	log(`Clip Master ${require("uxp").versions.plugin} | ${rate} fps | ${frameTicks} ticks per frame`);
	let removed = 0;
	// Slots run left to right; each one re-reads its own position, since earlier cuts shift it.
	await dumpTimeline(sequence, frameTicks, "before");
	try {
		for (const slot of plan.slots) removed += await cutSlot(project, sequence, slot, frameTicks);
	} finally {
		await dumpTimeline(sequence, frameTicks, "after");
	}
	plan = null;
	cutsEl.innerHTML = "";
	refreshApplyButton();
	return `Removed ${removed.toFixed(1)}s. Each stage is its own undo step, so press Ctrl+Z several times to go back.`;
}

async function run(task) {
	try {
		setStatus("Working...");
		setStatus(await task());
	} catch (error) {
		log(`STOPPED: ${error.message || error}`);
		setStatus(error.message || String(error), true);
	}
}

document.getElementById("analyze").addEventListener("click", () => run(analyze));
applyButton.addEventListener("click", () => run(applyPlan));
