extends Node2D

# AgarIPO client. It owns no rules: the server decides every position, every
# valuation and every takeover, and this draws what it is told. That is deliberate
# and it is what stops the "the player and the rivals disagreed about who was
# bigger" class of bug, which this project hit twice while the rules lived here.

const SEND_HZ: float = 20.0
const LERP_RATE: float = 14.0

# The company a player wears when they picked no mark and uploaded no photo: the
# AgarIPO mark reversed out of a brand-indigo disc. Preloaded, because it is fed
# into `skins` from a snapshot handler that runs at 20 Hz.
# 🔴 res://brand/, not res://logos/. The Dockerfile asserts that logos/ holds
# exactly one PNG per company in server/companies.json, because index and
# basename are the same number in _pack_logo below. A 51st file there fails the
# build.
const DEFAULT_MARK: Texture2D = preload("res://brand/agaripo-default.png")

@onready var camera: Camera2D = $Camera2D
@onready var board: Node2D = $Board
@onready var screen: Control = $Overlay/Screen

var sock := WebSocketPeer.new()
var joined: bool = false
var my_id: int = 0
var world_size: float = 6500.0
var blob_radius: float = 25.0

# 🔴 Three separate dictionaries, all keyed by company id, and the split matters.
# `blobs` is ONLY what the last snapshot said is on the board. Names, colours and
# logos arrive on their own messages at their own times, so they live beside it.
# When they were stored inside `blobs`, a name arriving while the player was dead
# CREATED a blob at world origin with a default scale, and a phantom company with
# your own name appeared in the corner of the map.
var blobs: Dictionary = {}
var meta: Dictionary = {}   # id -> { name, colour }
var skins: Dictionary = {}  # id -> Texture2D, whatever that company is wearing
# 🔴 An uploaded PNG must outrank a pack logo, and a pack logo arriving later
# must not quietly replace it. The roster is resent every 500 ms, so without this
# an uploaded mark would be overwritten twice a second by whatever index the
# server last had for that company.
var uploaded: Dictionary = {}   # id -> true
# index into the company pack -> Texture2D, loaded once and shared. 50 companies
# ship inside index.pck, so a rival's mark costs nothing on the wire at all.
var logo_cache: Dictionary = {}
var dot_pos: PackedVector2Array = PackedVector2Array()
var dot_col: PackedByteArray = PackedByteArray()
# Ids smallest-company-first, so a takeover target is never hidden under the
# company about to take it. Sorted HERE, when a snapshot lands at 20 Hz, not in
# _draw(): sorting 120 entries behind a freshly allocated lambda sixty times a
# second was pure waste, because the order can only change when the sizes do.
var draw_order: Array = []

# The live market leaders, flat: [id, valuation, id, valuation, ...], richest
# first. It arrives on every fifth snapshot and is drawn down the right hand
# side by overlay.gd. Ids only: the names, colours and marks are already in
# `meta` and `skins`, which carry the WHOLE roster and are never culled to the
# view, so a leader on the far side of the board still has a name here.
var leaders: Array = []

# Companies this player just acquired, oldest first, for the banner overlay.gd
# draws over their ball. Each entry is { name, logo, val, born } with `born` in
# Time.get_ticks_msec(). Capped, because a big company can take several in one
# second and four stacked banners is already the most a screen can say.
var acquired: Array = []
const ACQUIRED_MAX: int = 4

var clock_left: int = 0
var rank: int = 0
var field: int = 0
var my_count: int = 0
var dead: bool = false
var dead_by: String = ""
var dead_at: int = 0
var my_name: String = ""
var status: String = "Connecting to the market"

var _send_accum: float = 0.0
var _retry_in: float = 0.0
var _url: String = ""


func _ready() -> void:
	_url = _socket_url()
	_open()


func _socket_url() -> String:
	if OS.has_feature("web"):
		# Same origin as the page, so there is no second host and no CORS.
		var u = JavaScriptBridge.eval(
			"(location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws'", true)
		if typeof(u) == TYPE_STRING and u != "":
			return u
	return "ws://127.0.0.1:8080/ws"


func _open() -> void:
	sock = WebSocketPeer.new()
	# A join frame can carry an uploaded logo, and the first frame after it carries
	# every dot of capital on the board. The default 64 KB buffer truncates both.
	sock.inbound_buffer_size = 1 << 20
	sock.outbound_buffer_size = 1 << 20
	sock.max_queued_packets = 256
	var err := sock.connect_to_url(_url)
	if err != OK:
		status = "Cannot reach the market"


func _process(delta: float) -> void:
	sock.poll()
	var state := sock.get_ready_state()

	if state == WebSocketPeer.STATE_OPEN:
		while sock.get_available_packet_count() > 0:
			_handle(sock.get_packet().get_string_from_utf8())
		if not joined:
			_try_join()
	elif state == WebSocketPeer.STATE_CLOSED:
		joined = false
		status = "Reconnecting"
		_retry_in -= delta
		if _retry_in <= 0.0:
			_retry_in = 1.5
			_open()

	_interpolate(delta)
	_drive_camera(delta)
	_send_input(delta)
	board.queue_redraw()
	screen.queue_redraw()


# --- handover from the login card ---------------------------------------------
# The proven bridge is "eval reads a plain global". eval calling a function that
# draws to a canvas was tried for the rival logos and never once worked, so
# nothing here does that.
func _try_join() -> void:
	var payload: Dictionary = {}
	if OS.has_feature("web"):
		var raw = JavaScriptBridge.eval("JSON.stringify(window.AGARIPO_PLAYER || null)", true)
		if typeof(raw) != TYPE_STRING or raw == "" or raw == "null":
			return
		var parsed = JSON.parse_string(raw)
		if typeof(parsed) != TYPE_DICTIONARY:
			return
		payload = parsed
	else:
		payload = {"name": "Local Dev", "logo": -1, "skin": ""}

	my_name = String(payload.get("name", "Newco"))
	sock.send_text(JSON.stringify({
		"t": "join",
		"name": my_name,
		# Who to file this round's result under on the global leaderboard: the
		# player id login.js keeps in localStorage. It is also the player's login
		# key, so the game never draws it and never logs it. The SCORE is not in
		# here and never will be: the server computes it from its own simulation,
		# which is the only reason a public leaderboard anyone can join without
		# signing up is worth having.
		"pid": String(payload.get("pid", "")),
		# A picked brand is an INDEX, not an image: the client already owns the
		# pack, so this is one small integer where it used to be a 20 KB PNG.
		# An uploaded photo still travels as a PNG, because only this browser
		# has it.
		"logo": int(payload.get("logo", -1)),
		"skin": String(payload.get("skin", "")),
	}))
	joined = true
	status = "Joining"


# Engine -> browser. The closing table and the acquisition card are built in the
# DOM, not with draw_string: the company marks are already served there as files,
# and a real layout engine is what the difference between "red text on a scrim"
# and a designed card actually costs.
#
# 🔴 The payload crosses as ONE JSON STRING ARGUMENT, never as interpolated
# source. A company name is player input; JSON.stringify of a string produces a
# valid JavaScript string literal, so a name containing a quote or a bracket
# cannot close the literal and start writing code. The browser JSON.parses it and
# writes every name with textContent, so neither end ever builds markup.
func _to_browser(fn: String, payload) -> void:
	if not OS.has_feature("web"):
		return
	var arg: String = "null"
	if payload != null:
		arg = JSON.stringify(JSON.stringify(payload))
	JavaScriptBridge.eval("window.%s && window.%s(%s)" % [fn, fn, arg], true)


func _handle(text: String) -> void:
	var m = JSON.parse_string(text)
	if typeof(m) != TYPE_DICTIONARY:
		return
	match String(m.get("t", "")):
		"welcome":
			my_id = int(m.get("id", 0))
			world_size = float(m.get("world", 6500.0))
			blob_radius = float(m.get("radius", 25.0))
			status = ""
			dead = false
		"dots":
			_load_dots(m.get("d", []), true)
		"s":
			_load_snapshot(m)
		"m":
			_load_meta(m.get("blobs", []))
		"skin":
			_load_skin(int(m.get("id", 0)), String(m.get("png", "")))
		"took":
			acquired.append({
				"name": String(m.get("n", "")),
				"logo": int(m.get("g", -1)),
				"val": String(m.get("v", "")),
				"born": Time.get_ticks_msec(),
			})
			while acquired.size() > ACQUIRED_MAX:
				acquired.pop_front()
		"dead":
			dead = true
			dead_by = String(m.get("by", "a rival"))
			dead_at = int(m.get("at", 0))
			_to_browser("AGARIPO_DEAD", {
				"by": dead_by,
				"val": String(m.get("val", "")),
				"g": int(m.get("g", -1)),
			})
		"respawn":
			dead = false
			my_id = int(m.get("id", my_id))
			_to_browser("AGARIPO_DEAD", null)
		"close":
			_to_browser("AGARIPO_CLOSE", m)
		"reset":
			dead = false
			_to_browser("AGARIPO_CLOSE", null)
			_to_browser("AGARIPO_DEAD", null)
		"full":
			# 🔴 Clearing the handover is what stops this. Setting joined = false on
			# its own made _process call _try_join EVERY FRAME, re-sending the join
			# at 60 fps: megabytes a second up from the browser and the same again
			# of JSON.parse on the server, with the player stuck on the message and
			# no way out but a page reload. Now the login card comes back.
			status = "Every market is busy. Try again in a minute."
			joined = false
			if OS.has_feature("web"):
				JavaScriptBridge.eval(
					"window.AGARIPO_PLAYER=null;"
					+ "var e=document.getElementById('ipo-login');if(e){e.hidden=false;}", true)


func _load_dots(arr, fresh: bool) -> void:
	if typeof(arr) != TYPE_ARRAY:
		return
	if fresh:
		dot_pos.resize(int(arr.size() / 4))
		dot_col.resize(int(arr.size() / 4))
	var i: int = 0
	while i + 3 < arr.size():
		var slot: int = int(arr[i])
		if slot >= dot_pos.size():
			dot_pos.resize(slot + 1)
			dot_col.resize(slot + 1)
		dot_pos[slot] = Vector2(float(arr[i + 1]), float(arr[i + 2]))
		dot_col[slot] = int(arr[i + 3])
		i += 4


func _load_snapshot(m: Dictionary) -> void:
	clock_left = int(m.get("k", 0))
	if m.has("d"):
		_load_dots(m["d"], false)
	if m.has("lb") and typeof(m["lb"]) == TYPE_ARRAY:
		leaders = m["lb"]
	var b = m.get("b", [])
	if typeof(b) != TYPE_ARRAY:
		return
	var seen: Dictionary = {}
	var alive: int = 0
	var i: int = 0
	# Six ints per company: id, x, y, scale x100, valuation count, spawn-protected.
	while i + 5 < b.size():
		var id: int = int(b[i])
		var target := Vector2(float(b[i + 1]), float(b[i + 2]))
		seen[id] = true
		alive += 1
		if not blobs.has(id):
			blobs[id] = {"pos": target, "target": target, "scale": 1.0,
				"count": 0, "safe": false, "boost": false, "vel": Vector2.ZERO}
		var rec: Dictionary = blobs[id]
		# Where it is heading, smoothed. The sprint streak is drawn along this, so
		# a single jittery snapshot must not swing the tail around.
		var step: Vector2 = target - (rec["target"] as Vector2)
		rec["vel"] = (rec["vel"] as Vector2).lerp(step, 0.35)
		rec["target"] = target
		rec["scale"] = float(b[i + 3]) / 100.0
		rec["count"] = int(b[i + 4])
		# 🔴 Int 6 is a BITMASK, not a boolean. Bit 0 spawn-protected, bit 1
		# sprinting. The stride stays 6, which is what stops a cached old client
		# reading the new frame at the wrong width.
		var flags: int = int(b[i + 5])
		rec["safe"] = (flags & 1) != 0
		rec["boost"] = (flags & 2) != 0
		if id == my_id:
			my_count = int(b[i + 4])
		i += 6
	# Rank and field come from the server now. They used to be counted out of the
	# snapshot, which stopped working the moment the snapshot was culled to the
	# view: "rank 1 of 12" when there are 200 companies is worse than no rank.
	rank = int(m.get("r", rank))
	field = int(m.get("f", alive))
	for id in blobs.keys():
		if not seen.has(id):
			blobs.erase(id)
	draw_order = blobs.keys()
	draw_order.sort_custom(_smaller_first)


func _smaller_first(a: int, b: int) -> bool:
	return float((blobs[a] as Dictionary)["scale"]) < float((blobs[b] as Dictionary)["scale"])


func _load_meta(list) -> void:
	if typeof(list) != TYPE_ARRAY:
		return
	var seen: Dictionary = {}
	for entry in list:
		if typeof(entry) != TYPE_DICTIONARY:
			continue
		var id: int = int(entry.get("i", 0))
		seen[id] = true
		meta[id] = {"name": String(entry.get("n", "")), "colour": int(entry.get("c", 0))}
		if not uploaded.has(id):
			var g: int = int(entry.get("g", -1))
			if g >= 0:
				var tex: Texture2D = _pack_logo(g)
				if tex != null:
					skins[id] = tex
			else:
				# 🔴 The AgarIPO mark, NOT erase(). A company with no pack logo and
				# no uploaded photo used to be a bare coloured disc, and both
				# renderers papered over it with two initials drawn at 26% white.
				# Feeding the default skin in HERE means board.gd and overlay.gd
				# need no fallback branch at all: there is always a texture.
				skins[id] = DEFAULT_MARK
	# The meta frame is the complete roster, so anything missing from it has left
	# the lobby for good. Without this, ids accumulate for the life of the tab.
	for id in meta.keys():
		if not seen.has(id):
			meta.erase(id)
			skins.erase(id)
			uploaded.erase(id)


func company_of(id: int) -> String:
	return String((meta.get(id, {}) as Dictionary).get("name", ""))


func colour_of(id: int) -> int:
	return int((meta.get(id, {}) as Dictionary).get("colour", 0))


# A company mark out of the pack baked into index.pck. Loaded once per company
# and shared by every blob wearing it, so the 50 textures are loaded at most
# once each for the life of the tab.
func _pack_logo(index: int) -> Texture2D:
	if logo_cache.has(index):
		return logo_cache[index]
	var path: String = "res://logos/%03d.png" % index
	if not ResourceLoader.exists(path):
		logo_cache[index] = null
		return null
	var tex := load(path) as Texture2D
	logo_cache[index] = tex
	return tex


# The mark a company wears on the board, for anything that is not a live blob:
# a pack logo by index, or the AgarIPO default for a company with none.
func mark_for(logo: int) -> Texture2D:
	if logo >= 0:
		var tex: Texture2D = _pack_logo(logo)
		if tex != null:
			return tex
	return DEFAULT_MARK


# An UPLOADED company logo. One decode path for everybody, so it cannot work for
# the player and silently fail for everyone else, which is what used to happen.
func _load_skin(id: int, data_url: String) -> void:
	if id == 0 or not data_url.begins_with("data:image/png;base64,"):
		return
	var b64: String = data_url.substr(22)
	var bytes := Marshalls.base64_to_raw(b64)
	if bytes.size() == 0 or bytes.size() > 400000:
		return
	var img := Image.new()
	if img.load_png_from_buffer(bytes) != OK:
		return
	if img.get_width() < 8 or img.get_width() > 1024:
		return
	# Same reason the pack has them: a 256 px mark on a $1B startup is about 50
	# screen pixels, and without mipmaps that point-samples every fifth texel and
	# sparkles as the company moves.
	img.generate_mipmaps()
	skins[id] = ImageTexture.create_from_image(img)
	uploaded[id] = true


# --- rendering support --------------------------------------------------------
func _interpolate(delta: float) -> void:
	# Snapshots land 20 times a second; frames are drawn far more often than that.
	#
	# 🔴 Exponential decay, not `delta * RATE`. The linear form is FRAME RATE
	# DEPENDENT: the same scene converges at a different speed at 30 fps and at
	# 144 fps, and clamps to a hard snap below 14 fps. `1 - exp(-rate * dt)` is
	# the same curve at every frame rate.
	var t: float = 1.0 - exp(-LERP_RATE * delta)
	for id in blobs:
		var rec: Dictionary = blobs[id]
		rec["pos"] = (rec["pos"] as Vector2).lerp(rec["target"] as Vector2, t)


func me() -> Dictionary:
	return blobs.get(my_id, {})


func _drive_camera(delta: float) -> void:
	var rec := me()
	if rec.is_empty():
		return
	camera.position = rec["pos"]
	# Pull back as the company grows, so a big blob still sees what is coming.
	var r: float = blob_radius * float(rec["scale"])
	var want: float = clampf(2.6 / (1.0 + r / 150.0), 0.2, 1.35)
	var z: float = lerpf(camera.zoom.x, want, 1.0 - exp(-3.0 * delta))
	camera.zoom = Vector2(z, z)


func _send_input(delta: float) -> void:
	if not joined or sock.get_ready_state() != WebSocketPeer.STATE_OPEN:
		return
	_send_accum += delta
	if _send_accum < 1.0 / SEND_HZ:
		return
	_send_accum = 0.0
	var rec := me()
	if rec.is_empty():
		return
	var aim: Vector2 = get_global_mouse_position() - (rec["pos"] as Vector2)
	sock.send_text(JSON.stringify({
		"t": "in", "dx": aim.x, "dy": aim.y,
		"b": Input.is_mouse_button_pressed(MOUSE_BUTTON_LEFT),
		"v": _view_reach(),
	}))


# How much board this window can see, in world units, so the server can send only
# the companies that fit on it. Only the browser knows its own window size and the
# zoom the camera derived from the blob radius, so only the browser can answer
# this, which is also why the server treats the answer as hostile and clamps it.
# Half the screen DIAGONAL plus a margin, deliberately generous: a company that
# pops in at the edge of the screen is worse than a few extra bytes.
func _view_reach() -> float:
	var vp: Vector2 = get_viewport_rect().size
	var z: float = maxf(camera.zoom.x, 0.05)
	return (vp.length() * 0.5) / z + 400.0
