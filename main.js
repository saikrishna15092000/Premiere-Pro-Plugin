"use strict";

const ppro = require("premierepro");
const core = globalThis.EasyRecordCore;

// ponytail: effects and parameters are found by their English display names.
// Switch to match names once the Inspect report confirms them (also fixes non-English UI).
const ROUND_PATTERNS = [/^rounded crop$/i];
const SHADOW_PATTERNS = [/^drop shadow$/i];

const statusEl = document.getElementById("status");
const reportEl = document.getElementById("report");

function setStatus(text, isError) {
	statusEl.textContent = text;
	statusEl.className = isError ? "error" : "";
}

function readGroup(group) {
	const values = {};
	for (const input of document.querySelectorAll(`[data-group="${group}"]`)) {
		values[input.dataset.key] = input.type === "checkbox" ? input.checked : Number(input.value);
	}
	return values;
}

async function getContext() {
	const project = await ppro.Project.getActiveProject();
	if (!project) throw new Error("Open a project first.");
	const sequence = await project.getActiveSequence();
	if (!sequence) throw new Error("Open a sequence first.");
	const selection = await sequence.getSelection();
	const items = await selection.getTrackItems();
	const clips = items.filter((item) => item instanceof ppro.VideoClipTrackItem);
	if (!clips.length) throw new Error("Select at least one video clip.");
	return { project, clips };
}

function transact(project, label, build) {
	let ok = false;
	project.lockedAccess(() => {
		ok = project.executeTransaction(build, label);
	});
	if (!ok) throw new Error(`Premiere rejected: ${label}`);
}

async function findEffect(patterns, what) {
	const [matchNames, displayNames] = await Promise.all([
		ppro.VideoFilterFactory.getMatchNames(),
		ppro.VideoFilterFactory.getDisplayNames(),
	]);
	const effect = core.findEffect(matchNames, displayNames, patterns);
	if (!effect) throw new Error(`No "${what}" effect found. Click Inspect and send the report.`);
	return effect;
}

async function findComponent(clip, test) {
	const chain = await clip.getComponentChain();
	for (let i = 0; i < chain.getComponentCount(); i += 1) {
		const component = chain.getComponentAtIndex(i);
		if (await test(component)) return component;
	}
	return null;
}

// Returns the clip's copy of the effect, adding it first if the clip does not have it.
async function ensureEffect(project, clip, effect) {
	const isIt = async (component) => (await component.getMatchName()) === effect.matchName;
	const existing = await findComponent(clip, isIt);
	if (existing) return existing;
	const chain = await clip.getComponentChain();
	const created = await ppro.VideoFilterFactory.createComponent(effect.matchName);
	// The shadow has to sit before Rounded Crop, or the crop cuts it off. Rounded Crop is appended,
	// so it always lands after an existing shadow; only a new shadow needs inserting.
	let before = -1;
	if (effect.matchName === "AE.ADBE Drop Shadow") {
		for (let i = 0; i < chain.getComponentCount() && before === -1; i += 1) {
			if ((await chain.getComponentAtIndex(i).getMatchName()) === "AE.Impact_Crop_FX") before = i;
		}
	}
	transact(project, `Easy Record: add ${effect.displayName}`, (action) => {
		action.addAction(before === -1 ? chain.createAppendComponentAction(created) : chain.createInsertComponentAction(created, before));
	});
	const added = await findComponent(clip, isIt);
	if (!added) throw new Error(`${effect.displayName} was not added to the clip.`);
	return added;
}

function paramNames(component) {
	const names = [];
	for (let i = 0; i < component.getParamCount(); i += 1) {
		names.push(component.getParam(i).displayName);
	}
	return names;
}

function setAction(param, value) {
	const keyValue = Array.isArray(value) ? new ppro.PointF(value[0], value[1]) : value;
	return param.createSetValueAction(param.createKeyframe(keyValue), true);
}

// Sets each value on the effect parameter with the same (exact, lower-cased) name.
async function applyEffect({ project, clips }, patterns, what, values, label) {
	const effect = await findEffect(patterns, what);
	for (const clip of clips) {
		const component = await ensureEffect(project, clip, effect);
		const names = paramNames(component).map((name) => String(name).trim().toLowerCase());
		const sets = [];
		// Every match, not just the first: Rounded Crop keeps a hidden second copy of Left/Right/Top/Bottom.
		names.forEach((name, index) => {
			if (name in values) sets.push([component.getParam(index), values[name]]);
		});
		if (!sets.length) throw new Error(`${what} has none of the expected parameters. Click Inspect.`);
		transact(project, label, (action) => {
			for (const [param, value] of sets) action.addAction(setAction(param, value));
		});
	}
}

function applyFrame(context) {
	const values = readGroup("frame");
	values.offset = core.cropOffset(values);
	return applyEffect(context, ROUND_PATTERNS, "Rounded Crop", values, "Easy Record: crop and corners");
}

async function applyPadding({ project, clips }) {
	const { padding, base } = readGroup("padding");
	if (!(base > 0)) throw new Error("Base scale must be above 0.");
	// ponytail: absolute scale from the Base scale box, not the clip's current scale.
	// Set Base scale to whatever makes the clip fill the frame (e.g. 50 for 4K in 1080p).
	const scale = core.paddingToScale(base, padding);
	for (const clip of clips) await setMotion(project, clip, "scale", scale, "Easy Record: padding");
}

// The clip's built-in Motion parameter with this (lower-case) name.
async function motionParam(clip, key) {
	const motion = await findComponent(clip, async (component) => {
		const matchName = await component.getMatchName();
		return matchName === "AE.ADBE Motion" || (await component.getDisplayName()) === "Motion";
	});
	if (!motion) throw new Error("Clip has no Motion effect.");
	const index = paramNames(motion).findIndex((name) => String(name).trim().toLowerCase() === key);
	if (index === -1) throw new Error(`Motion has no ${key} parameter.`);
	return motion.getParam(index);
}

async function setMotion(project, clip, key, value, label) {
	const param = await motionParam(clip, key);
	transact(project, label, (action) => action.addAction(setAction(param, value)));
}

// X/Y in percent of the frame (50/50 = centre, 100/100 = clip centre on the bottom-right corner).
async function applyPosition({ project, clips }) {
	const { x, y } = readGroup("position");
	for (const clip of clips) {
		// ponytail: assumes Premiere's 0-1 position (what UXP reports); refuses pixels rather than guess the frame size
		const current = await readValue(await motionParam(clip, "position"));
		if (Number(current?.x ?? current?.[0]) > 2) throw new Error("Motion Position is in pixels here. Click Inspect and send me the report.");
		await setMotion(project, clip, "position", [x / 100, y / 100], "Easy Record: position");
	}
}

function applyShadow(context) {
	const values = readGroup("shadow");
	values.opacity *= 2.55; // Premiere stores Drop Shadow opacity as 0-255, not percent
	return applyEffect(context, SHADOW_PATTERNS, "Drop Shadow", values, "Easy Record: shadow");
}

// ---- Auto zoom from an OBS cursor data file ----

const ROUNDED_CROP = "AE.Impact_Crop_FX";
const DROP_SHADOW = "AE.ADBE Drop Shadow";
const MOTION = "AE.ADBE Motion";
const AUTO_LABEL = "Auto: the cursor file next to each recording";
let manualCursorData = null; // a hand-picked file overrides automatic matching

const seconds = (time) => Number(time && time.seconds) || 0;

async function readValue(param) {
	try {
		return (await param.getStartValue())?.value?.value ?? null;
	} catch (_error) {
		return null;
	}
}

async function chooseCursorFile() {
	const file = await require("uxp").storage.localFileSystem.getFileForOpening({ types: ["jsonl"] });
	if (!file) return;
	manualCursorData = core.parseCursorFile(await file.read());
	document.getElementById("cursorFileName").textContent = `${file.name} (${manualCursorData.clicks.length} clicks)`;
}

function useAutoCursorFile() {
	manualCursorData = null;
	document.getElementById("cursorFileName").textContent = AUTO_LABEL;
}

// Finds "<recording>.recordly.cursor.jsonl" beside the clip's media file.
async function loadCursorFileFor(clip, cache) {
	const item = ppro.ClipProjectItem.cast(await clip.getProjectItem());
	const mediaPath = item && (await item.getMediaFilePath());
	if (!mediaPath) throw new Error("A selected clip has no media file. Use Choose file.");
	const path = mediaPath.replace(/\.[^.\\/]+$/, "") + ".recordly.cursor.jsonl";
	if (!cache.has(path)) {
		const fs = require("fs");
		let text;
		try {
			text = await fs.readFile(path, { encoding: "utf-8" });
		} catch (_error) {
			try {
				text = await fs.readFile("file:/" + path.replace(/\\/g, "/"), { encoding: "utf-8" });
			} catch (_error2) {
				throw new Error(`No cursor file found at ${path}. Use Choose file. Nothing was changed.`);
			}
		}
		cache.set(path, core.parseCursorFile(text));
	}
	return cache.get(path);
}

// Current numeric values of the named parameters on one of the clip's effects, or null if it has none.
async function readEffectValues(clip, matchName, keys) {
	const component = await findComponent(clip, async (c) => (await c.getMatchName()) === matchName);
	if (!component) return null;
	const names = paramNames(component).map((name) => String(name).trim().toLowerCase());
	const values = {};
	for (const key of keys) {
		const index = names.indexOf(key);
		values[key] = index === -1 ? 0 : Number(await readValue(component.getParam(index))) || 0;
	}
	return values;
}

// The clip's current crop as 0-1 fractions, so zooms stay inside the cropped picture.
async function readCrop(clip) {
	const crop = (await readEffectValues(clip, ROUNDED_CROP, ["left", "right", "top", "bottom"])) || {};
	return { left: (crop.left || 0) / 100, right: (crop.right || 0) / 100, top: (crop.top || 0) / 100, bottom: (crop.bottom || 0) / 100 };
}

async function chainMatchNames(chain) {
	const names = [];
	for (let i = 0; i < chain.getComponentCount(); i += 1) {
		names.push(await chain.getComponentAtIndex(i).getMatchName());
	}
	return names;
}

// Removes the clip's Transform effects, then (if there are keys) adds a fresh one
// ahead of Rounded Crop so the picture zooms inside the frame, and keyframes it.
async function zoomClip(project, clip, transform, keys, blur) {
	let chain = await clip.getComponentChain();
	let names = await chainMatchNames(chain);
	const old = names.flatMap((name, i) => (name === transform.matchName ? [chain.getComponentAtIndex(i)] : []));
	if (old.length) {
		transact(project, "Easy Record: remove old zoom", (action) => {
			for (const component of old) action.addAction(chain.createRemoveComponentAction(component));
		});
	}
	if (!keys.length) return;

	chain = await clip.getComponentChain();
	names = await chainMatchNames(chain);
	let index = names.indexOf(ROUNDED_CROP);
	if (index === -1) index = names.indexOf(DROP_SHADOW);
	const created = await ppro.VideoFilterFactory.createComponent(transform.matchName);
	transact(project, "Easy Record: add zoom", (action) => {
		action.addAction(
			index === -1 ? chain.createAppendComponentAction(created) : chain.createInsertComponentAction(created, index),
		);
	});

	chain = await clip.getComponentChain();
	const component = chain.getComponentAtIndex(index === -1 ? chain.getComponentCount() - 1 : index);
	if ((await component.getMatchName()) !== transform.matchName) {
		throw new Error("The zoom effect did not land where expected. Undo and send me the Inspect report.");
	}
	const paramList = paramNames(component).map((name) => String(name).trim().toLowerCase());
	const position = component.getParam(paramList.indexOf("position"));
	const scaleIndex = paramList.indexOf("scale") !== -1 ? paramList.indexOf("scale") : paramList.indexOf("scale height");
	const scale = component.getParam(scaleIndex);
	if (!position || !scale) throw new Error("Transform has no Position/Scale parameters. Click Inspect.");

	// Work from the effect's own resting values, so this holds whether Premiere
	// reports position as 0-1 or in pixels.
	const basePosition = await readValue(position);
	const baseX = Number(basePosition?.x ?? basePosition?.[0]);
	const baseY = Number(basePosition?.y ?? basePosition?.[1]);
	const baseScale = Number(await readValue(scale));
	if (![baseX, baseY, baseScale].every(Number.isFinite)) {
		throw new Error("Could not read Transform's starting values. Click Inspect.");
	}

	const times = keys.map((key) => ppro.TickTime.createWithSeconds(key.t));
	// Motion blur: Transform's own shutter, which only blurs while the zoom is moving.
	// Premiere 27 reports the "Use Composition's Shutter Angle" checkbox with a blank name; it is
	// the parameter right before Shutter Angle.
	const shutterAngle = paramList.indexOf("shutter angle");
	let useSequenceShutter = paramList.findIndex((name) => name.startsWith("use composition"));
	if (useSequenceShutter === -1 && shutterAngle > 0 && !paramList[shutterAngle - 1]) useSequenceShutter = shutterAngle - 1;
	transact(project, "Easy Record: zoom keyframes", (action) => {
		if (blur > 0 && useSequenceShutter !== -1 && shutterAngle !== -1) {
			action.addAction(setAction(component.getParam(useSequenceShutter), false));
			action.addAction(setAction(component.getParam(shutterAngle), blur));
		}
		action.addAction(position.createSetTimeVaryingAction(true));
		action.addAction(scale.createSetTimeVaryingAction(true));
		keys.forEach((key, i) => {
			const positionKey = position.createKeyframe(new ppro.PointF(baseX * (key.x / 0.5), baseY * (key.y / 0.5)));
			positionKey.position = times[i];
			action.addAction(position.createAddKeyframeAction(positionKey));
			const scaleKey = scale.createKeyframe(baseScale * key.scale);
			scaleKey.position = times[i];
			action.addAction(scale.createAddKeyframeAction(scaleKey));
		});
	});
	// ponytail: plain Bezier. Plugins only get LINEAR, HOLD, BEZIER and TIME modes (Inspect,
	// Premiere 27); Ease In / Ease Out and handle shapes are not exposed, so easing is done by hand.
	transact(project, "Easy Record: smooth zoom", (action) => {
		for (const time of times) {
			for (const param of [position, scale]) {
				action.addAction(param.createSetInterpolationAtKeyframeAction(time, ppro.Constants.InterpolationMode.BEZIER, true));
			}
		}
	});
}

async function applyZoom({ project, clips }) {
	const settings = readGroup("zoom");
	const fileCache = new Map();
	const zoom = settings.zoom / 100;
	const transition = settings.transition / 1000;
	if (!(zoom > 1) || !(transition > 0) || !(settings.hold >= 0)) {
		throw new Error("Zoom must be above 100, transition above 0, hold 0 or more.");
	}
	const transform = await findEffect([/^transform$/i], "Transform");

	// Check every clip before changing any of them.
	const jobs = [];
	for (const clip of clips) {
		const speed = Number(await clip.getSpeed());
		const reversed = Boolean(Number(await clip.isSpeedReversed()));
		if (reversed || (Math.abs(speed - 1) > 0.001 && Math.abs(speed - 100) > 0.01)) {
			throw new Error("Auto zoom needs normal-speed, forward clips. Nothing was changed.");
		}
		const inPoint = seconds(await clip.getInPoint());
		const duration = seconds(await clip.getDuration());
		const cursorData = manualCursorData || (await loadCursorFileFor(clip, fileCache));
		if (inPoint + duration > cursorData.durationSeconds + 1) {
			throw new Error("A selected clip runs past the end of the cursor data. Wrong file? Nothing was changed.");
		}
		const keys = core.buildZoomKeys({
			events: settings.trigger === 1 ? core.findSettles(cursorData.points) : cursorData.clicks,
			points: cursorData.points,
			follow: settings.follow,
			inPoint,
			duration,
			zoom,
			transition,
			hold: settings.hold,
			crop: await readCrop(clip),
		});
		jobs.push({ clip, keys });
	}
	for (const job of jobs) await zoomClip(project, job.clip, transform, job.keys, settings.blur);
	const zoomed = jobs.filter((job) => job.keys.length).length;
	return `Zooms added to ${zoomed} of ${jobs.length} clip(s).`;
}

// Turns animation off on every keyframed parameter of every effect on the selected clips,
// leaving each one at the value it had at the start of the clip.
async function removeKeyframes({ project, clips }) {
	let count = 0;
	for (const clip of clips) {
		const startTime = await clip.getInPoint();
		const chain = await clip.getComponentChain();
		const jobs = [];
		for (let c = 0; c < chain.getComponentCount(); c += 1) {
			const component = chain.getComponentAtIndex(c);
			for (let p = 0; p < component.getParamCount(); p += 1) {
				const param = component.getParam(p);
				if (!param.isTimeVarying()) continue;
				let value = null;
				try {
					const read = await param.getValueAtTime(startTime);
					value = read?.value?.value ?? read?.value ?? null;
					if (value && typeof value === "object" && "x" in value) value = [value.x, value.y];
				} catch (_error) {
					// unreadable: the parameter keeps whatever Premiere leaves it at
				}
				jobs.push({ param, value });
			}
		}
		if (!jobs.length) continue;
		transact(project, "Easy Record: remove keyframes", (action) => {
			for (const { param, value } of jobs) {
				action.addAction(param.createSetTimeVaryingAction(false));
				if (value !== null) action.addAction(setAction(param, value));
			}
		});
		count += jobs.length;
	}
	return count ? `Removed keyframes from ${count} parameter(s).` : "The selected clips have no keyframes.";
}

const APPLY = { frame: applyFrame, padding: applyPadding, position: applyPosition, shadow: applyShadow };

let busy = false;

async function run(task) {
	busy = true;
	try {
		const context = await getContext();
		const message = await task(context);
		setStatus(message || `Applied to ${context.clips.length} clip(s).`);
	} catch (error) {
		setStatus(error.message || String(error), true);
	} finally {
		busy = false;
	}
}

function refreshLabel(input) {
	if (input.type === "range" && input.nextElementSibling) input.nextElementSibling.textContent = input.value;
}

// Shows the first selected clip's current values on the sliders (without applying anything).
async function syncFromSelection() {
	if (busy) return;
	try {
		const clip = (await getContext()).clips[0];
		const show = (group, key, value) => {
			const input = document.querySelector(`[data-group="${group}"][data-key="${key}"]`);
			if (!Number.isFinite(value)) return;
			input.value = String(Math.round(Math.min(Math.max(value, Number(input.min)), Number(input.max))));
			refreshLabel(input);
		};
		const frame = (await readEffectValues(clip, ROUNDED_CROP, ["left", "right", "top", "bottom", "roundness"])) || {};
		for (const key of ["left", "right", "top", "bottom", "roundness"]) show("frame", key, frame[key] || 0);
		const motion = await readEffectValues(clip, MOTION, ["scale"]);
		// Base scale = the clip's Motion Scale as it is now, so padding shrinks from what you see.
		// ponytail: an already padded clip reads back as its smaller scale with 0 padding
		if (motion) {
			document.querySelector('[data-key="base"]').value = String(Math.round(motion.scale * 100) / 100);
			show("padding", "padding", 0);
		}
		const position = await motionParam(clip, "position").then(readValue).catch(() => null);
		show("position", "x", 100 * Number(position?.x ?? position?.[0]));
		show("position", "y", 100 * Number(position?.y ?? position?.[1]));
		const shadow = await readEffectValues(clip, DROP_SHADOW, ["softness", "opacity"]);
		show("shadow", "softness", shadow ? shadow.softness : 0);
		show("shadow", "opacity", shadow ? shadow.opacity / 2.55 : 50);
	} catch (_error) {
		// nothing selected or unreadable: leave the sliders as they are
	}
}

// Dumps what Premiere actually exposes, so names and value ranges can be confirmed.
async function inspect({ clips }) {
	const [matchNames, displayNames] = await Promise.all([
		ppro.VideoFilterFactory.getMatchNames(),
		ppro.VideoFilterFactory.getDisplayNames(),
	]);
	const report = {
		availableEffects: matchNames
			.map((matchName, i) => ({ matchName, displayName: displayNames[i] }))
			.filter((effect) => /round|crop|shadow/i.test(`${effect.matchName} ${effect.displayName}`)),
		clipEffects: [],
		interpolationModes: { ...ppro.Constants.InterpolationMode },
	};
	const chain = await clips[0].getComponentChain();
	for (let i = 0; i < chain.getComponentCount(); i += 1) {
		const component = chain.getComponentAtIndex(i);
		const params = [];
		for (let p = 0; p < component.getParamCount(); p += 1) {
			const param = component.getParam(p);
			let value = null;
			try {
				value = (await param.getStartValue())?.value?.value ?? null;
			} catch (_error) {
				// some parameters have no readable value
			}
			params.push({ name: param.displayName, value });
		}
		report.clipEffects.push({
			matchName: await component.getMatchName(),
			displayName: await component.getDisplayName(),
			params,
		});
	}
	reportEl.hidden = false;
	reportEl.value = JSON.stringify(report, null, 2);
}

document.getElementById("chooseCursorFile").addEventListener("click", () => {
	chooseCursorFile().catch((error) => setStatus(error.message || String(error), true));
});
document.getElementById("autoCursorFile").addEventListener("click", useAutoCursorFile);
document.getElementById("generateZoom").addEventListener("click", () => run(applyZoom));
document.getElementById("removeKeyframes").addEventListener("click", () => run(removeKeyframes));

// Keep the sliders showing the selected clip: on Premiere's selection event where available,
// and whenever the mouse comes back into the panel as a fallback.
try {
	ppro.EventManager.addGlobalEventListener(ppro.Constants.SequenceEvent.SELECTION_CHANGED, syncFromSelection, false);
} catch (_error) {
	// older builds: the mouseenter fallback below still covers it
}
document.body.addEventListener("mouseenter", syncFromSelection);
syncFromSelection();

// Zoom settings only take effect on Generate, so they are left out of the live sliders.
for (const input of document.querySelectorAll('[data-group]:not([data-group="zoom"])')) {
	refreshLabel(input);
	input.addEventListener("input", () => refreshLabel(input));
	// "change" fires on release, so each drag is one undo step per clip.
	input.addEventListener("change", () => run(APPLY[input.dataset.group]));
}
document.getElementById("inspect").addEventListener("click", () => run(inspect));

// ---- Presets: named sets of the crop, frame, padding and shadow values ----
// Kept in the panel's own storage on this computer. Picking one applies it to the selected clips.
const presetList = document.getElementById("presetList");
const presetName = document.getElementById("presetName");
const LOOK_INPUTS = '[data-group]:not([data-group="zoom"])';

function loadPresets() {
	try {
		return JSON.parse(localStorage.getItem("easyRecordPresets")) || {};
	} catch (_error) {
		return {};
	}
}

function showPresets() {
	const names = Object.keys(loadPresets()).sort();
	presetList.innerHTML = "";
	const add = (value, text) => {
		const option = document.createElement("option");
		option.value = value;
		option.textContent = text;
		presetList.appendChild(option);
	};
	add("", names.length ? `Apply a preset (${names.length} saved)` : "No presets saved yet");
	for (const name of names) add(name, name);
	presetList.value = "";
}

document.getElementById("savePreset").addEventListener("click", () => {
	const name = presetName.value.trim();
	if (!name) return setStatus("Type a name for the preset first.", true);
	const values = {};
	for (const input of document.querySelectorAll(LOOK_INPUTS)) values[`${input.dataset.group}.${input.dataset.key}`] = Number(input.value);
	const presets = loadPresets();
	presets[name] = values; // same name = overwrite
	localStorage.setItem("easyRecordPresets", JSON.stringify(presets));
	presetName.value = "";
	showPresets();
	setStatus(`Saved preset "${name}".`);
});

presetList.addEventListener("change", () => {
	const name = presetList.value;
	const values = loadPresets()[name];
	if (!values) return;
	for (const input of document.querySelectorAll(LOOK_INPUTS)) {
		const value = values[`${input.dataset.group}.${input.dataset.key}`];
		if (value !== undefined) input.value = String(value);
		refreshLabel(input);
	}
	presetName.value = name; // handy for re-saving an edited version under the same name
	run(async (context) => {
		await applyFrame(context);
		await applyPadding(context);
		await applyPosition(context);
		await applyShadow(context);
		return `Applied preset "${name}" to ${context.clips.length} clip(s).`;
	}).then(showPresets); // back to the prompt, so the same preset can be picked again
});

document.getElementById("deletePreset").addEventListener("click", () => {
	const name = presetName.value.trim();
	const presets = loadPresets();
	if (!presets[name]) return setStatus("Pick a preset (or type its name), then click Delete.", true);
	delete presets[name];
	localStorage.setItem("easyRecordPresets", JSON.stringify(presets));
	presetName.value = "";
	showPresets();
	setStatus(`Deleted preset "${name}".`);
});

showPresets();
