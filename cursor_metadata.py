"""OBS Phase 1: write Recordly cursor/click metadata beside recordings."""

import ctypes
import json
import os
import threading
import uuid
from ctypes import wintypes

import obspython as obs


SCHEMA = "recordly.cursor/1"
SM_CXSCREEN = 0
SM_CYSCREEN = 1
CURSOR_SHOWING = 1
MONITORINFOF_PRIMARY = 1
VK_LBUTTON = 0x01
VK_RBUTTON = 0x02
VK_MBUTTON = 0x04
VK_XBUTTON1 = 0x05
VK_XBUTTON2 = 0x06


class CursorInfo(ctypes.Structure):
	_fields_ = [
		("cbSize", wintypes.DWORD),
		("flags", wintypes.DWORD),
		("hCursor", wintypes.HANDLE),
		("ptScreenPos", wintypes.POINT),
	]


class MonitorInfoEx(ctypes.Structure):
	_fields_ = [
		("cbSize", wintypes.DWORD),
		("rcMonitor", wintypes.RECT),
		("rcWork", wintypes.RECT),
		("dwFlags", wintypes.DWORD),
		("szDevice", wintypes.WCHAR * 32),
	]


MonitorEnumProc = ctypes.WINFUNCTYPE(
	wintypes.BOOL,
	wintypes.HANDLE,
	wintypes.HDC,
	ctypes.POINTER(wintypes.RECT),
	wintypes.LPARAM,
)


user32 = ctypes.WinDLL("user32", use_last_error=True)
user32.GetPhysicalCursorPos.argtypes = [ctypes.POINTER(wintypes.POINT)]
user32.GetPhysicalCursorPos.restype = wintypes.BOOL
user32.GetCursorInfo.argtypes = [ctypes.POINTER(CursorInfo)]
user32.GetCursorInfo.restype = wintypes.BOOL
user32.GetAsyncKeyState.argtypes = [ctypes.c_int]
user32.GetAsyncKeyState.restype = wintypes.SHORT
user32.GetMonitorInfoW.argtypes = [
	wintypes.HANDLE,
	ctypes.POINTER(MonitorInfoEx),
]
user32.GetMonitorInfoW.restype = wintypes.BOOL
user32.EnumDisplayMonitors.argtypes = [
	wintypes.HDC,
	ctypes.POINTER(wintypes.RECT),
	MonitorEnumProc,
	wintypes.LPARAM,
]
user32.EnumDisplayMonitors.restype = wintypes.BOOL

lock = threading.RLock()
recording = False
paused = False
output = None
sidecar_file = None
video_path = ""
temp_path = ""
fps_num = 60
fps_den = 1
last_frame = -1
fallback_frame = 0
previous_buttons = 0
lines_since_flush = 0
configured_monitor = None
active_monitor = None


def script_description():
	return (
		"Writes Recordly cursor and click metadata beside normal OBS recordings.\n\n"
		"Choose the same display used by OBS Display Capture. "
		"Phase 1 supports one full-display capture filling the canvas. "
		"It never records keyboard input."
	)


def enumerate_monitors():
	monitors = []

	@MonitorEnumProc
	def collect(handle, _device_context, _rectangle, _data):
		info = MonitorInfoEx(cbSize=ctypes.sizeof(MonitorInfoEx))
		if user32.GetMonitorInfoW(handle, ctypes.byref(info)):
			monitors.append(
				{
					"device": info.szDevice,
					"left": int(info.rcMonitor.left),
					"top": int(info.rcMonitor.top),
					"right": int(info.rcMonitor.right),
					"bottom": int(info.rcMonitor.bottom),
					"primary": bool(info.dwFlags & MONITORINFOF_PRIMARY),
				}
			)
		return True

	user32.EnumDisplayMonitors(None, None, collect, 0)
	if not monitors:
		monitors.append(
			{
				"device": r"\\.\DISPLAY1",
				"left": 0,
				"top": 0,
				"right": max(1, user32.GetSystemMetrics(SM_CXSCREEN)),
				"bottom": max(1, user32.GetSystemMetrics(SM_CYSCREEN)),
				"primary": True,
			}
		)
	return sorted(monitors, key=lambda monitor: (not monitor["primary"], monitor["device"]))


def monitor_for_device(device):
	monitors = enumerate_monitors()
	for monitor in monitors:
		if monitor["device"] == device:
			return monitor
	return next((monitor for monitor in monitors if monitor["primary"]), monitors[0])


def monitor_label(monitor):
	width = monitor["right"] - monitor["left"]
	height = monitor["bottom"] - monitor["top"]
	primary = " (Primary)" if monitor["primary"] else ""
	return (
		f'{monitor["device"]} — {width}×{height} at '
		f'({monitor["left"]}, {monitor["top"]}){primary}'
	)


def script_properties():
	properties = obs.obs_properties_create()
	monitor_property = obs.obs_properties_add_list(
		properties,
		"capture_monitor",
		"Captured display",
		obs.OBS_COMBO_TYPE_LIST,
		obs.OBS_COMBO_FORMAT_STRING,
	)
	for monitor in enumerate_monitors():
		obs.obs_property_list_add_string(
			monitor_property,
			monitor_label(monitor),
			monitor["device"],
		)
	return properties


def script_defaults(settings):
	default_monitor = monitor_for_device("")
	obs.obs_data_set_default_string(
		settings,
		"capture_monitor",
		default_monitor["device"],
	)


def script_update(settings):
	global configured_monitor
	device = obs.obs_data_get_string(settings, "capture_monitor")
	monitor = monitor_for_device(device)
	with lock:
		configured_monitor = monitor.copy()
	print(f'[recordly-cursor] Captured display: {monitor_label(monitor)}')


def sidecar_path(path):
	return os.path.splitext(path)[0] + ".recordly.cursor.jsonl"


def write_record(record, flush=False):
	global lines_since_flush
	if sidecar_file is None:
		return
	sidecar_file.write(json.dumps(record, separators=(",", ":")) + "\n")
	lines_since_flush += 1
	if flush or lines_since_flush >= 30:
		sidecar_file.flush()
		lines_since_flush = 0


def frame_time_us(frame):
	return round(frame * 1_000_000 * fps_den / fps_num) if fps_num else 0


def current_frame():
	global fallback_frame
	if output is not None:
		try:
			return max(0, int(obs.obs_output_get_total_frames(output)))
		except Exception:
			pass
	fallback_frame += 1
	return fallback_frame


def button_state():
	buttons = 0
	pressed_since_last_poll = 0
	for virtual_key, bit in (
		(VK_LBUTTON, 1),
		(VK_RBUTTON, 2),
		(VK_MBUTTON, 4),
		(VK_XBUTTON1, 8),
		(VK_XBUTTON2, 16),
	):
		state = user32.GetAsyncKeyState(virtual_key)
		if state & 0x8000:
			buttons |= bit
		if state & 0x0001:
			pressed_since_last_poll |= bit
	return buttons, pressed_since_last_poll


def interaction_for(buttons, old_buttons, pressed_since_last_poll):
	pressed = (buttons & ~old_buttons) | pressed_since_last_poll
	released = old_buttons & ~buttons
	if pressed & 1:
		return "click"
	if pressed & 2:
		return "right-click"
	if pressed & 4:
		return "middle-click"
	if released & 7:
		return "mouseup"
	return None


def sample_cursor():
	global last_frame, previous_buttons
	with lock:
		if not recording or sidecar_file is None:
			return
		if paused:
			previous_buttons, _pressed_since_last_poll = button_state()
			return
		frame = current_frame()
		buttons, pressed_since_last_poll = button_state()
		interaction = interaction_for(buttons, previous_buttons, pressed_since_last_poll)
		previous_buttons = buttons
		point = wintypes.POINT()
		if not user32.GetPhysicalCursorPos(ctypes.byref(point)):
			return
		if active_monitor is None:
			return
		left = active_monitor["left"]
		top = active_monitor["top"]
		right = active_monitor["right"]
		bottom = active_monitor["bottom"]
		if not (left <= point.x < right and top <= point.y < bottom):
			return
		if frame == last_frame and interaction is None:
			return
		width = max(1, right - left)
		height = max(1, bottom - top)
		cursor_info = CursorInfo(cbSize=ctypes.sizeof(CursorInfo))
		visible = bool(
			user32.GetCursorInfo(ctypes.byref(cursor_info))
			and cursor_info.flags & CURSOR_SHOWING
		)
		record = {
			"type": "point",
			"frame": frame,
			"tUs": frame_time_us(frame),
			"u": min(1.0, max(0.0, (point.x - left) / width)),
			"v": min(1.0, max(0.0, (point.y - top) / height)),
			"screenX": int(point.x),
			"screenY": int(point.y),
			"buttons": buttons,
			"visible": visible,
		}
		if interaction:
			record["interaction"] = interaction
		write_record(record, flush=interaction is not None)
		last_frame = frame


def start_recording():
	global recording, paused, output, sidecar_file, video_path, temp_path
	global fps_num, fps_den, last_frame, fallback_frame, previous_buttons
	global lines_since_flush, configured_monitor, active_monitor
	with lock:
		if recording:
			return
		path = obs.obs_frontend_get_current_record_output_path()
		if not path:
			print("[recordly-cursor] OBS did not provide the recording path")
			return
		video = obs.obs_video_info()
		if not obs.obs_get_video_info(video):
			print("[recordly-cursor] OBS video information is unavailable")
			return
		video_path = str(path)
		temp_path = sidecar_path(video_path) + ".tmp"
		try:
			sidecar_file = open(temp_path, "w", encoding="utf-8", newline="\n")
		except OSError as error:
			print(f"[recordly-cursor] Could not create {temp_path}: {error}")
			return
		output = obs.obs_frontend_get_recording_output()
		fps_num = max(1, int(video.fps_num))
		fps_den = max(1, int(video.fps_den))
		if configured_monitor is None:
			configured_monitor = monitor_for_device("")
		active_monitor = configured_monitor.copy()
		last_frame = -1
		fallback_frame = 0
		previous_buttons, _pressed_since_last_poll = button_state()
		lines_since_flush = 0
		paused = False
		recording = True
		write_record(
			{
				"type": "header",
				"schema": SCHEMA,
				"recordingId": str(uuid.uuid4()),
				"width": int(video.output_width),
				"height": int(video.output_height),
				"fpsNum": fps_num,
				"fpsDen": fps_den,
				"captureDevice": active_monitor["device"],
				"captureX": active_monitor["left"],
				"captureY": active_monitor["top"],
				"captureWidth": active_monitor["right"] - active_monitor["left"],
				"captureHeight": active_monitor["bottom"] - active_monitor["top"],
			},
			flush=True,
		)
		interval_ms = max(8, round(1000 * fps_den / fps_num))
		obs.timer_add(sample_cursor, interval_ms)
		print(f"[recordly-cursor] Capturing metadata for {video_path}")


def close_incomplete():
	global recording, paused, output, sidecar_file
	obs.timer_remove(sample_cursor)
	with lock:
		recording = False
		paused = False
		if sidecar_file is not None:
			sidecar_file.flush()
			sidecar_file.close()
			sidecar_file = None
		if output is not None:
			obs.obs_output_release(output)
			output = None


def stop_recording():
	global recording, paused, output, sidecar_file, video_path, temp_path
	obs.timer_remove(sample_cursor)
	with lock:
		if not recording:
			return
		frame = current_frame()
		write_record(
			{"type": "end", "frames": frame, "durationUs": frame_time_us(frame)},
			flush=True,
		)
		recording = False
		paused = False
		sidecar_file.close()
		sidecar_file = None
		if output is not None:
			obs.obs_output_release(output)
			output = None
		last_recording = obs.obs_frontend_get_last_recording()
		final_path = sidecar_path(str(last_recording or video_path))
		try:
			os.replace(temp_path, final_path)
			print(f"[recordly-cursor] Wrote {final_path}")
		except OSError as error:
			print(f"[recordly-cursor] Final rename failed; recover {temp_path}: {error}")


def set_paused(value):
	global paused
	with lock:
		if not recording or paused == value:
			return
		paused = value
		frame = current_frame()
		write_record(
			{
				"type": "pause" if value else "resume",
				"frame": frame,
				"tUs": frame_time_us(frame),
			},
			flush=True,
		)


def frontend_event(event):
	if event == obs.OBS_FRONTEND_EVENT_RECORDING_STARTED:
		start_recording()
	elif event == obs.OBS_FRONTEND_EVENT_RECORDING_PAUSED:
		set_paused(True)
	elif event == obs.OBS_FRONTEND_EVENT_RECORDING_UNPAUSED:
		set_paused(False)
	elif event == obs.OBS_FRONTEND_EVENT_RECORDING_STOPPED:
		stop_recording()


def script_load(settings):
	script_update(settings)
	obs.obs_frontend_add_event_callback(frontend_event)
	print("[recordly-cursor] Phase 1 script loaded")


def script_unload():
	obs.obs_frontend_remove_event_callback(frontend_event)
	close_incomplete()
