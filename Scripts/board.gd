extends Node2D

# Everything drawn in world space: the board, the capital, the companies.
# Text is NOT drawn here. It lives in overlay.gd in screen space, because a label
# parented to a scaling body is what produced every label bug this project had.

const GRID: float = 250.0
const DOT_RADIUS: float = 10.0

# 🔴 The mark is lifted off centre and the valuation sits under it, because the
# two used to be drawn on the same spot: a real company logo is full-contrast art,
# not the faint monogram watermark it replaced, and "$3M" printed across the
# Anthropic mark was unreadable in both directions. overlay.gd draws the text at
# the matching offsets; MARK_LIFT is shared so they cannot drift apart.
const MARK_SCALE: float = 0.60
const MARK_LIFT: float = 0.17

var main: Node


func _ready() -> void:
	main = get_parent()
	z_index = -1
	# 🔴 Company marks are 256x256 and a startup wears one at about 50 screen px.
	# On plain linear filtering that is a point sample every fifth texel, and the
	# mark sparkles as the company moves. The textures carry mipmaps (set in
	# the project's importer_defaults); this is the half that uses them.
	texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR_WITH_MIPMAPS


func _blob_colour(i: int) -> Color:
	return Color.from_hsv(fmod(float(i) * 0.137 + 0.03, 1.0), 0.68, 0.93)


func _dot_colour(i: int) -> Color:
	return Color.from_hsv(fmod(float(i) * 0.083 + 0.5, 1.0), 0.55, 0.96)


# One tapering ribbon: a strip of quads with per-vertex colour, so the renderer
# interpolates the fade across each quad and the gradient is smooth.
#
# This replaced a stack of nine overlapping discs. Discs cannot taper — every one
# of them is round — so the tail came out as a lumpy smear with a scalloped edge,
# which is what the first playtest said did not look nice.
func _taper(from: Vector2, dir: Vector2, length: float, w0: float,
		col: Color, steps: int, fade: float) -> void:
	var side := Vector2(-dir.y, dir.x)
	for i in range(steps):
		var t0: float = float(i) / float(steps)
		var t1: float = float(i + 1) / float(steps)
		var a0: float = col.a * pow(1.0 - t0, fade)
		var a1: float = col.a * pow(1.0 - t1, fade)
		var h0: float = w0 * (1.0 - t0)
		var h1: float = w0 * (1.0 - t1)
		var p0: Vector2 = from + dir * (length * t0)
		var p1: Vector2 = from + dir * (length * t1)
		draw_polygon(
			PackedVector2Array([p0 + side * h0, p1 + side * h1,
				p1 - side * h1, p0 - side * h0]),
			PackedColorArray([
				Color(col.r, col.g, col.b, a0), Color(col.r, col.g, col.b, a1),
				Color(col.r, col.g, col.b, a1), Color(col.r, col.g, col.b, a0)]))


# The sprint streak: a comet tail behind a company burning cash to run.
#
# Drawn from the CURRENT velocity rather than from a ring buffer of past
# positions. A position history has to be tuned per blob size — a $2B company
# moves 2.7 units a frame and a startup moves 7.5, so one sampling distance gives
# a stubby smear at one end and nothing at all at the other. Sized off the radius
# instead, the tail is always about three body-lengths whoever is wearing it.
func _streak(p: Vector2, r: float, c: Color, vel: Vector2) -> void:
	if vel.length_squared() < 1.0:
		return
	var back: Vector2 = -vel.normalized()
	var side := Vector2(-back.y, back.x)
	# Two layers of the company's own colour. The wide, faint one softens the
	# sides, which draw_polygon gives no anti-aliasing of its own; the tighter one
	# is the body of the tail. A glance then says WHO is running, not just that
	# somebody is.
	_taper(p, back, r * 3.9, r * 1.02, Color(c.r, c.g, c.b, 0.26), 7, 1.9)
	_taper(p, back, r * 3.2, r * 0.80, Color(c.r, c.g, c.b, 0.46), 7, 1.5)
	# Three hard highlights inside it. The soft ribbon alone reads as a blur;
	# these are what make it read as SPEED. Measured at $1B, where the blob is
	# 34 px on screen, an earlier version at 0.30 alpha was almost invisible.
	_taper(p + side * (r * 0.44), back, r * 4.4, r * 0.11, Color(1, 1, 1, 0.60), 3, 1.0)
	_taper(p - side * (r * 0.44), back, r * 4.4, r * 0.11, Color(1, 1, 1, 0.60), 3, 1.0)
	_taper(p + back * (r * 0.30), back, r * 5.0, r * 0.14, Color(1, 1, 1, 0.40), 3, 1.0)


func _view_rect() -> Rect2:
	var inv := get_viewport_transform().affine_inverse()
	var r: Rect2 = inv * Rect2(Vector2.ZERO, get_viewport_rect().size)
	return r.grow(120.0)


func _draw() -> void:
	if main == null:
		return
	var view := _view_rect()
	var world: float = main.world_size
	# How many screen pixels one world unit is worth. The logo cap below is the
	# only thing that needs it, and it needs the REAL transform, not the camera's
	# target zoom, or the cap is wrong for the frames the camera is still easing.
	var zoom: float = maxf(get_viewport_transform().get_scale().x, 0.0001)

	draw_rect(Rect2(Vector2.ZERO, Vector2(world, world)), Color(0.96, 0.97, 0.98), true)

	# A grid is the only thing that tells you that you are moving when the screen
	# is otherwise empty, and on a 6500 unit board most of it is empty.
	var grid_col := Color(0.86, 0.89, 0.92)
	var x: float = floor(max(view.position.x, 0.0) / GRID) * GRID
	while x <= min(view.end.x, world):
		draw_line(Vector2(x, max(view.position.y, 0.0)), Vector2(x, min(view.end.y, world)), grid_col, 1.0)
		x += GRID
	var y: float = floor(max(view.position.y, 0.0) / GRID) * GRID
	while y <= min(view.end.y, world):
		draw_line(Vector2(max(view.position.x, 0.0), y), Vector2(min(view.end.x, world), y), grid_col, 1.0)
		y += GRID
	draw_rect(Rect2(Vector2.ZERO, Vector2(world, world)), Color(0.78, 0.55, 0.20), false, 6.0)

	# Capital. Culled to the view: thousands of dots, most of them off screen.
	var pos: PackedVector2Array = main.dot_pos
	var col: PackedByteArray = main.dot_col
	for i in range(pos.size()):
		var p: Vector2 = pos[i]
		if not view.has_point(p):
			continue
		draw_circle(p, DOT_RADIUS, _dot_colour(int(col[i]) if i < col.size() else 0))

	# Smallest company first, so a takeover target is never hidden under the
	# company about to take it. The order is computed once per snapshot in
	# main.gd, not once per frame here.
	for id in main.draw_order:
		var rec = main.blobs.get(id, null)
		if rec == null:
			continue
		var p: Vector2 = rec["pos"]
		var r: float = main.blob_radius * float(rec["scale"])
		if not view.grow(r).has_point(p):
			continue
		var c: Color = _blob_colour(main.colour_of(id))
		if rec.get("boost", false):
			_streak(p, r, c, rec.get("vel", Vector2.ZERO))
		draw_circle(p, r, c)
		var skin = main.skins.get(id, null)
		if skin != null:
			# The mark is already round: the pack is rendered as a disc and
			# login.js clips an upload to a circle before encoding it, so there is
			# no mask shader and no per-blob material here.
			#
			# 🔴 The cap is the whole fix for "the logo goes blurry when the ball
			# grows". It is arithmetic, not a hope about resolution: the on-screen
			# size can never exceed the texture's own pixel count, so the mark is
			# never magnified, at any valuation, on any screen. At MAX_SCALE that
			# is a 256 px mark on a 600 px ball, which reads as a badge.
			var cap: float = float(skin.get_width()) * 0.5 / zoom
			var s: float = minf(r * MARK_SCALE, cap)
			var at: Vector2 = p + Vector2(0.0, -r * MARK_LIFT)
			draw_texture_rect(skin, Rect2(at - Vector2(s, s), Vector2(s * 2.0, s * 2.0)), false)
		if id == main.my_id:
			draw_arc(p, r + 3.0, 0.0, TAU, 48, Color(1, 1, 1, 0.95), 4.0, true)
		else:
			draw_arc(p, r, 0.0, TAU, 40, c.darkened(0.35), 2.5, true)
		# A newly founded company cannot be taken for three seconds. Say so on the
		# board, or being ignored by a rival looks like a collision bug.
		if rec.get("safe", false):
			draw_arc(p, r + 9.0, 0.0, TAU, 56, Color(0.18, 0.78, 0.36, 0.85), 3.0, true)
