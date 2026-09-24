extends Control

# Every piece of text in the game, drawn in SCREEN space.
#
# 🔴 This is the fix for the label bug that survived three attempts. The old
# labels were Control nodes parented to the blob, counter-scaled by 1/s with the
# font raised by s. Two things then fought each other: anchors_preset = 8 writes
# grow_horizontal/grow_vertical = GROW_DIRECTION_BOTH, so as soon as the text
# outgrew its 128x26 rect the engine enlarged it AND shifted its position up and
# left by half the excess, while pivot_offset stayed on the rect the code had
# ASKED for. The counter-scale then pivoted about a point that was no longer the
# centre, and the error (64 - W/2)(s - 1) grew with the blob.
#
# Nothing here uses the layout system. A screen position is computed, a string is
# measured, and it is drawn centred on that position. It cannot drift, and it is
# rasterised at its final size so it is sharp at every blob size.

# Mirrors board.gd's MARK_LIFT. The valuation is printed just under the mark
# rather than across it; a real logo is opaque art and the two fought.
const VALUATION_DROP: float = 0.44

# The AgarIPO mark, in its two jobs. Preloaded, because _draw runs every frame
# and load() there would hit the resource cache 60 times a second for nothing.
#   WM_MARK      the HUD wordmark's logo, bottom right. LIGHT treatment: the
#                board is #F5F7FA, so the dark tile would be a navy square.
#   DEFAULT_MARK the leaderboard row's fallback disc, for an id on the board
#                whose meta frame has not arrived yet. main.gd puts the same
#                texture into `skins` for any company with no mark of its own.
const WM_MARK: Texture2D = preload("res://brand/agaripo-icon-64-light.png")
const DEFAULT_MARK: Texture2D = preload("res://brand/agaripo-default.png")

# prestocks.com's own palette, read off the live site with getComputedStyle on
# 2026-09-19 rather than picked by eye. The same values deploy/login.css carries.
const INK := Color(0.078, 0.082, 0.310)       # #14154F
const INK_3 := Color(0.322, 0.322, 0.322)     # #525252
# 🔴 #6A7271, NOT the #929AA9 this file first copied across. login.css defines
# that value with the words "never text" printed beside it, and this file then
# used it for the leaderboard's rank numerals at 12px: 2.83:1 on the panel, which
# fails AA outright. The rule travelled between the two files and the reasoning
# did not. #6A7271 on white is 4.93:1 and passes.
const MUTED := Color(0.416, 0.447, 0.443)     # #6A7271, the lightest TEXT allowed
const BRAND := Color(0.384, 0.392, 0.851)     # #6264D9
const BRAND_INK := Color(0.306, 0.314, 0.753) # #4E50C0, every indigo GLYPH
const LINE := Color(0.898, 0.906, 0.922)      # #E5E7EB

# The leaderboard panel, in screen pixels.
const LB_W: float = 236.0
const LB_PAD: float = 12.0
const LB_ROW_H: float = 30.0
const LB_MARK: float = 22.0
const LB_EDGE: float = 16.0

# The takeover banner over the player's own ball. Times are in milliseconds.
const TOAST_LIFE: float = 2400.0
const TOAST_POP: float = 260.0
const TOAST_OUT: float = 520.0
const TOAST_H: float = 54.0
const TOAST_MARK: float = 34.0
const TOAST_GAP: float = 8.0
# Nothing is drawn above this line: it is where the clock and the rank line are.
const TOAST_CEILING: float = 96.0
# #CCF7DE, the price on the banner. 5.9:1 on the #4E50C0 ground.
const TOAST_VAL := Color(0.80, 0.97, 0.87)

var main: Node
var font: Font
var bold: FontVariation
var lb_panel: StyleBoxFlat
var lb_mine: StyleBoxFlat
# One per banner slot, because each banner fades on its own clock and a style box
# carries its colour with it.
var toast_boxes: Array = []


func _ready() -> void:
	main = get_parent().get_parent()
	font = ThemeDB.fallback_font
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	# Built once. A StyleBoxFlat is the only thing in the engine's immediate-mode
	# drawing that does a rounded rectangle; draw_rect has square corners, and a
	# square white panel on this board reads as a debug overlay.
	lb_panel = StyleBoxFlat.new()
	lb_panel.bg_color = Color(1, 1, 1, 0.96)
	lb_panel.set_corner_radius_all(14)
	lb_panel.border_color = Color(LINE.r, LINE.g, LINE.b, 0.95)
	lb_panel.set_border_width_all(1)
	lb_panel.shadow_color = Color(0.05, 0.05, 0.18, 0.12)
	lb_panel.shadow_size = 12
	lb_panel.shadow_offset = Vector2(0, 4)
	lb_mine = StyleBoxFlat.new()
	lb_mine.bg_color = Color(BRAND.r, BRAND.g, BRAND.b, 0.13)
	lb_mine.set_corner_radius_all(7)
	# The engine's own font, emboldened: the one font this project has ever proved
	# renders in a build, so no second font file rides into the .pck.
	bold = FontVariation.new()
	bold.base_font = font
	bold.variation_embolden = 0.8
	for i in range(4):
		var box := StyleBoxFlat.new()
		box.set_corner_radius_all(14)
		box.shadow_size = 10
		box.shadow_offset = Vector2(0, 4)
		toast_boxes.append(box)


# 🔴 This is rules.js valuationText, in GDScript, and the two are checked
# against each other by server/smoke.js. A player reads THIS one off the ball and
# the other one off the closing card, so a difference between them is a game that
# contradicts itself. Billions, not millions: a real pre-IPO board is priced in
# billions and putting SpaceX on screen at $47M said the opposite.
static func valuation_text(count: int) -> String:
	var b: int = 1 + count
	if b < 1000:
		return "$%dB" % b
	return "$%.2fT" % (float(b) / 1000.0)


# 🔴 The halo is a PARAMETER, and the default is only right for one of the two
# jobs this function does. White text on a coloured ball needs the black halo.
# The HUD is dark ink on the board's near-white #F5F7FA, where the black halo
# buys nothing: the clock is already 14.96:1 and the rank line 8.97:1, measured,
# so a 4px black stroke on 15px type only fattened the stems and filled in the
# counters. _wordmark worked this out for itself and said so in a comment, and
# the conclusion was never carried the forty pixels to the rest of the HUD.
func _centred(centre: Vector2, text: String, size: int, col: Color, outline: int = 5,
		halo: Color = Color(0, 0, 0, 0.85)) -> void:
	var w: float = font.get_string_size(text, HORIZONTAL_ALIGNMENT_LEFT, -1, size).x
	var base := Vector2(centre.x - w * 0.5,
		centre.y + (font.get_ascent(size) - font.get_descent(size)) * 0.5)
	if outline > 0:
		draw_string_outline(font, base, text, HORIZONTAL_ALIGNMENT_LEFT, -1, size,
			outline, halo)
	draw_string(font, base, text, HORIZONTAL_ALIGNMENT_LEFT, -1, size, col)


# The HUD's halo: white, thin, and only there to lift the ink off a capital dot
# or the dark out-of-bounds band when the player is pinned against an edge.
const HALO := Color(1, 1, 1, 0.8)


func _draw() -> void:
	if main == null or font == null:
		return
	var view := size
	var xf := get_viewport().get_canvas_transform()
	var zoom: float = xf.get_scale().x

	for id in main.blobs:
		var rec: Dictionary = main.blobs[id]
		var centre: Vector2 = xf * (rec["pos"] as Vector2)
		var r: float = main.blob_radius * float(rec["scale"]) * zoom
		# Too small to read, or off screen entirely.
		if r < 14.0:
			continue
		if centre.x < -r - 200.0 or centre.x > view.x + r + 200.0:
			continue
		if centre.y < -r - 200.0 or centre.y > view.y + r + 200.0:
			continue

		var company: String = main.company_of(id)

		var val_size: int = int(clampf(r * 0.34, 12.0, 46.0))
		_centred(Vector2(centre.x, centre.y + r * VALUATION_DROP),
			valuation_text(int(rec["count"])), val_size, Color(1, 1, 1, 1), 6)

		if company == "":
			continue
		# Always UNDER the disc now. The mark owns the middle of the ball and says
		# who this is at a glance; the name is the caption under it, and putting it
		# inside as well made a three-line stack in a circle.
		var name_size: int = int(clampf(r * 0.26, 11.0, 30.0))
		_centred(Vector2(centre.x, centre.y + r + float(name_size) * 0.95),
			company, name_size, Color(1, 1, 1, 0.96), 5)

	_draw_hud(view)
	_draw_leaderboard(view)
	_draw_acquired(view, xf, zoom)
	# On the web the acquisition card is DOM, drawn by login.js off the bridge in
	# main.gd. Drawing it here as well would stack two cards on one screen. This
	# branch is the local-dev path, where there is no browser to draw anything.
	if main.dead and not OS.has_feature("web"):
		_draw_death(view)


func _draw_hud(view: Vector2) -> void:
	if main.status != "":
		_centred(Vector2(view.x * 0.5, view.y * 0.5), main.status, 22, Color(0.2, 0.2, 0.25), 0)
		return

	var mid: float = view.x * 0.5
	_centred(Vector2(mid, 30.0), "%d:%02d" % [main.clock_left / 60, main.clock_left % 60],
		34, INK, 3, HALO)

	# The name comes from the join, not from the board: a dead company is not in
	# the snapshot, and reading it from there blanked the HUD on death.
	var line: String = "Rank %d of %d   ·   %s   ·   %s" % [
		main.rank, main.field, main.my_name, valuation_text(main.my_count)]
	_centred(Vector2(mid, 62.0), line, 15, INK_3, 3, HALO)

	# No lobby code any more: every player gets their own market, so there is
	# nothing to invite anybody into. What is worth saying is what is out there.
	if main.field > 0:
		_centred(Vector2(mid, 84.0), "%d pre-IPO companies on the board" % main.field,
			13, MUTED, 3, HALO)

	_wordmark(view)

	# 🔴 Say what it COSTS, and say it while it is costing. The old line promised
	# "burn cash and sprint" while nothing burned and no stamina bar was ever
	# drawn, so holding the button changed nothing a player could see and the
	# whole feature read as broken.
	var sprinting: bool = bool((main.me() as Dictionary).get("boost", false))
	# 🔴 Lifted clear of the corners on a narrow window. The music control is a
	# DOM pill in the bottom left and the wordmark is in the bottom right, and at
	# 390 px the sprint line ran underneath both of them: seen in a screenshot at
	# 390x844, not reasoned about. The pill is 38 px tall sitting 10 px off the
	# bottom, so 66 px of clearance leaves a real gap rather than a hairline.
	var lift: float = 66.0 if view.x < 700.0 else 22.0
	var at := Vector2(mid, view.y - lift)
	if sprinting:
		_fitted(at, "SPRINTING  ·  burning 0.5% of your valuation every 2 seconds",
			"SPRINTING  ·  -0.5% every 2s", view.x, 15, Color(0.73, 0.16, 0.16), 3)
	else:
		_fitted(at, "Hold left mouse to sprint  ·  costs 0.5% of your valuation every 2 seconds",
			"Hold left mouse to sprint  ·  -0.5% every 2s", view.x, 13, MUTED, 3)


# draw_string does not wrap and does not clip, so a line wider than the window
# simply runs off both ends and the middle is all you get. Measured first, then
# the short form, then the size drops: the sprint cost is the one number a player
# has to be able to read, so it is never allowed to fall off the screen.
func _fitted(at: Vector2, long: String, short: String, room: float, size: int,
		col: Color, outline: int) -> void:
	var pad: float = 24.0
	if font.get_string_size(long, HORIZONTAL_ALIGNMENT_LEFT, -1, size).x <= room - pad:
		_centred(at, long, size, col, outline, HALO)
		return
	if font.get_string_size(short, HORIZONTAL_ALIGNMENT_LEFT, -1, size).x <= room - pad:
		_centred(at, short, size, col, outline, HALO)
		return
	_centred(at, short, maxi(9, size - 3), col, outline, HALO)


# The same wordmark the login card and the tab icon use: "Agar" in ink beside
# "IPO" reversed out of the brand tag. Drawn once in the corner so the game is
# still branded after the card is gone, and kept quiet enough that it never
# competes with a company label.
# The mark beside the name, and the draw_rect is GONE. The old lockup put "IPO"
# on a square rectangle because draw_rect has no corner radius and a rounded tag
# would have needed a StyleBoxFlat; the mark removes the problem rather than
# solving it. One texture, one string.
#
# The LIGHT treatment, because this sits on the board's near-white #F5F7FA. On
# that ground the white squircle is a 2% lightness step and what a player
# actually sees is the indigo mark with a faint #E5E7EB edge.
func _wordmark(view: Vector2) -> void:
	var size: int = 15
	var w: float = font.get_string_size("AgarIPO", HORIZONTAL_ALIGNMENT_LEFT, -1, size).x
	var mark_px: float = 20.0
	# 🔴 Bottom RIGHT, not bottom left. The music control is a DOM element pinned
	# to the bottom left corner, and two things in one corner is one thing on top
	# of another. Right-aligned off the MEASURED width, so it cannot run off the
	# edge on a narrow window the way a fixed offset would.
	var base := Vector2(view.x - LB_EDGE - w, view.y - 16.0)
	var at := Vector2(base.x - mark_px - 7.0, base.y - mark_px + 3.0)
	draw_texture_rect(WM_MARK, Rect2(at, Vector2(mark_px, mark_px)), false,
		Color(1, 1, 1, 0.92))
	# A WHITE halo, not the black one the rest of the HUD uses. Everything else is
	# drawn over the board, which is near-white; this sits in the bottom corner,
	# and a player pinned against the edge has the dark out-of-bounds area behind
	# it instead. White is invisible on the board and is what makes the dark
	# lettering readable off it.
	draw_string_outline(font, base, "AgarIPO", HORIZONTAL_ALIGNMENT_LEFT, -1, size,
		4, Color(1, 1, 1, 0.75))
	draw_string(font, base, "AgarIPO", HORIZONTAL_ALIGNMENT_LEFT, -1, size,
		Color(0.16, 0.18, 0.22, 0.88))


func _draw_death(view: Vector2) -> void:
	draw_rect(Rect2(Vector2.ZERO, view), Color(0.02, 0.02, 0.03, 0.72), true)
	var mid := Vector2(view.x * 0.5, view.y * 0.46)
	_centred(mid, "Y O U   G O T   A C Q U I R E D", 44, Color(0.72, 0.09, 0.09), 6)
	draw_rect(Rect2(mid.x - 190.0, mid.y + 34.0, 380.0, 2.0), Color(0.68, 0.56, 0.24, 0.9), true)
	_centred(mid + Vector2(0, 62.0),
		"%s took you at %s" % [main.dead_by, valuation_text(main.dead_at)],
		18, Color(0.82, 0.82, 0.85), 4)
	_centred(mid + Vector2(0, 92.0), "Refounding", 15, Color(0.6, 0.6, 0.65), 4)


# --- the live market leaders, down the right hand side -------------------------
#
# 🔴 Drawn HERE and not in the DOM, unlike the closing card and the acquisition
# card. Those are shown once each; this one changes four times a second, and the
# only engine-to-browser path that works in this project is JavaScriptBridge.eval,
# which would mean building and parsing a string of JavaScript several times a
# second for the whole round. The end card can afford that. This cannot.
#
# The panel is sized to the window: ten rows is a desktop luxury and a phone
# would be mostly leaderboard, so it steps down and then stops being drawn. The
# HUD names the player's own rank and valuation at every width, so nothing is
# available ONLY here.
func _rows_for(width: float) -> int:
	if width >= 1000.0:
		return 10
	if width >= 760.0:
		return 6
	if width >= 560.0:
		return 4
	return 0


# draw_string neither wraps nor clips, so an over-long company name simply runs
# out of the panel and across the board. Measured, then cut and suffixed.
func _clipped(text: String, size: int, room: float, f: Font = null) -> String:
	var use: Font = f if f != null else font
	if use.get_string_size(text, HORIZONTAL_ALIGNMENT_LEFT, -1, size).x <= room:
		return text
	# Three periods, not U+2026. The prettier glyph was tried and taken back out:
	# the only font here is ThemeDB.fallback_font, which ships inside the engine,
	# and it has never been rendered in a test build to prove it carries the ellipsis. A
	# missing glyph draws as a .notdef box on the leaderboard of a live build,
	# which is a worse outcome than two extra dots.
	var cut: String = text
	while cut.length() > 1:
		cut = cut.substr(0, cut.length() - 1)
		if use.get_string_size(cut + "...", HORIZONTAL_ALIGNMENT_LEFT, -1, size).x <= room:
			return cut + "..."
	return cut


func _left(at: Vector2, text: String, size: int, col: Color) -> void:
	draw_string(font, Vector2(at.x, at.y + font.get_ascent(size) * 0.78), text,
		HORIZONTAL_ALIGNMENT_LEFT, -1, size, col)


func _right(right_x: float, y: float, text: String, size: int, col: Color) -> void:
	var w: float = font.get_string_size(text, HORIZONTAL_ALIGNMENT_LEFT, -1, size).x
	_left(Vector2(right_x - w, y), text, size, col)


# One row: rank, mark, name, valuation.
func _lb_row(x: float, y: float, id: int, rank_n: int, company: String,
		value: String, is_me: bool) -> void:
	var width: float = LB_W - (LB_PAD * 2.0)
	if is_me:
		draw_style_box(lb_mine, Rect2(x - 5.0, y - 3.0, width + 10.0, LB_ROW_H - 2.0))
		draw_rect(Rect2(x - 5.0, y - 3.0, 3.0, LB_ROW_H - 2.0), BRAND, true)

	_right(x + 15.0, y + 5.0, str(rank_n), 12, BRAND_INK if is_me else MUTED)

	var mark_at := Vector2(x + 22.0, y + (LB_ROW_H - 4.0 - LB_MARK) * 0.5)
	# Always a mark, never initials. main.gd feeds the default AgarIPO disc into
	# `skins` for any company with no logo of its own, so the only way to reach the
	# fallback here is a leaderboard id whose meta frame has not landed yet.
	var tex: Texture2D = main.skins.get(id, DEFAULT_MARK)
	draw_texture_rect(tex, Rect2(mark_at, Vector2(LB_MARK, LB_MARK)), false)

	var val_w: float = font.get_string_size(value, HORIZONTAL_ALIGNMENT_LEFT, -1, 13).x
	var name_x: float = x + 22.0 + LB_MARK + 8.0
	var room: float = (x + width) - val_w - 10.0 - name_x
	_left(Vector2(name_x, y + 4.0), _clipped(company, 13, room), 13,
		BRAND_INK if is_me else INK)
	_right(x + width, y + 4.0, value, 13, BRAND_INK if is_me else INK_3)


func _draw_leaderboard(view: Vector2) -> void:
	if main.status != "":
		return
	# At the bell the market freezes and the DOM closing card takes the whole
	# window. A live leaderboard glowing through its scrim would be two
	# leaderboards on one screen, one of them already out of date.
	if main.clock_left <= 0:
		return
	var want: int = _rows_for(view.x)
	if want <= 0:
		return

	var lb: Array = main.leaders
	var names: Array = []
	var ids: Array = []
	var vals: Array = []
	var me_in_top: bool = false
	var i: int = 0
	while i + 1 < lb.size() and names.size() < want:
		var id: int = int(lb[i])
		var company: String = main.company_of(id)
		var worth: int = int(lb[i + 1])
		i += 2
		# A company can reach the leaders list a frame before its name arrives on
		# the meta channel. A blank row is worse than a shorter list.
		if company == "":
			continue
		if id == main.my_id:
			me_in_top = true
		ids.append(id)
		names.append(company)
		vals.append(valuation_text(worth))
	if names.is_empty():
		return

	var show_me: bool = not me_in_top and not main.dead and main.rank > 0
	var head_h: float = 26.0
	var body_h: float = float(names.size()) * LB_ROW_H
	if show_me:
		body_h += LB_ROW_H + 9.0
	var h: float = LB_PAD + head_h + body_h + LB_PAD - 4.0
	var x: float = view.x - LB_W - LB_EDGE
	var y: float = LB_EDGE
	draw_style_box(lb_panel, Rect2(x, y, LB_W, h))

	var inner: float = x + LB_PAD
	var width: float = LB_W - (LB_PAD * 2.0)
	_left(Vector2(inner, y + LB_PAD - 2.0), "Market leaders", 13, INK)
	_right(x + LB_W - LB_PAD, y + LB_PAD - 1.0, "%d live" % main.field, 11, MUTED)
	var rule_y: float = y + LB_PAD + head_h - 7.0
	draw_rect(Rect2(inner, rule_y, width, 1.0), LINE, true)

	var row_y: float = rule_y + 7.0
	for n in range(names.size()):
		_lb_row(inner, row_y, int(ids[n]), n + 1, String(names[n]), String(vals[n]),
			int(ids[n]) == main.my_id)
		row_y += LB_ROW_H

	# Outside the top rows, so the player's own line is pinned under a divider. A
	# leaderboard that does not contain you is somebody else's leaderboard.
	if show_me:
		draw_rect(Rect2(inner, row_y + 3.0, width, 1.0), LINE, true)
		_lb_row(inner, row_y + 9.0, main.my_id, main.rank, main.my_name,
			valuation_text(main.my_count), true)


# --- "You acquired", over the player's own ball -----------------------------------
#
# A takeover is the whole point of the game, and until this the only sign of one
# was a number going up. The server sends a `took` frame the moment it lands,
# main.gd keeps the last few, and each is drawn here as a banner just above the
# player's ball: it pops in, holds, then rises and fades. Screen space like every
# other string in this file, so it follows the ball at any zoom and stays sharp.
# Newest nearest the ball; older ones are pushed up the stack and cut off before
# they reach the clock.
func _draw_acquired(view: Vector2, xf: Transform2D, zoom: float) -> void:
	var list: Array = main.acquired
	if list.is_empty() or main.status != "":
		return
	var now: float = float(Time.get_ticks_msec())
	# The camera follows the ball, so this is the middle of the window unless the
	# ball is pinned against the edge of the board.
	var anchor := Vector2(view.x * 0.5, view.y * 0.5)
	var r: float = 0.0
	var rec: Dictionary = main.me()
	if not rec.is_empty():
		anchor = xf * (rec["pos"] as Vector2)
		r = main.blob_radius * float(rec["scale"]) * zoom
	var first_y: float = maxf(anchor.y - r - 14.0 - TOAST_H * 0.5,
		TOAST_CEILING + TOAST_H * 0.5)
	var slot: int = 0
	var i: int = list.size() - 1
	while i >= 0 and slot < toast_boxes.size():
		var t: Dictionary = list[i]
		i -= 1
		var age: float = now - float(t["born"])
		if age < 0.0 or age > TOAST_LIFE:
			continue
		var enter: float = clampf(age / TOAST_POP, 0.0, 1.0)
		var out: float = clampf((age - (TOAST_LIFE - TOAST_OUT)) / TOAST_OUT, 0.0, 1.0)
		# Ease-out-back: a little past full size, then settling, which is what reads
		# as a pop rather than a zoom.
		var e: float = enter - 1.0
		var back: float = 1.0 + 2.70158 * e * e * e + 1.70158 * e * e
		var s: float = 0.55 + 0.45 * back
		var alpha: float = minf(1.0, enter * 2.5) * (1.0 - out)
		# 🔴 The ceiling is tested where the banner RESTS, not where its fade has
		# carried it. Tested after the rise, a banner pinned to the ceiling by a big
		# ball broke out of the loop on the first frame of its fade and blinked
		# away, which hit exactly the player acquiring the most. The rise is then
		# clamped, so a pinned banner fades where it is.
		var rest_y: float = first_y - float(slot) * (TOAST_H + TOAST_GAP)
		if rest_y - TOAST_H * 0.5 < TOAST_CEILING:
			break
		var y: float = maxf(rest_y - out * 26.0, TOAST_CEILING + TOAST_H * 0.5)
		_toast(Vector2(anchor.x, y), t, s, alpha, toast_boxes[slot])
		slot += 1


func _toast(centre: Vector2, t: Dictionary, s: float, alpha: float, box: StyleBoxFlat) -> void:
	var head: String = "You acquired"
	var name_str: String = _clipped(String(t["name"]), 17, 240.0, bold)
	var val: String = String(t["val"])
	var w_text: float = maxf(font.get_string_size(head, HORIZONTAL_ALIGNMENT_LEFT, -1, 12).x,
		bold.get_string_size(name_str, HORIZONTAL_ALIGNMENT_LEFT, -1, 17).x)
	var w_val: float = bold.get_string_size(val, HORIZONTAL_ALIGNMENT_LEFT, -1, 15).x
	var w: float = 10.0 + TOAST_MARK + 11.0 + w_text + 16.0 + w_val + 14.0
	var rect := Rect2(-w * 0.5, -TOAST_H * 0.5, w, TOAST_H)

	# Everything below is drawn about the banner's own centre, so one scale is the
	# whole entrance. Reset at the end, or it would carry into the next draw call.
	draw_set_transform(centre, 0.0, Vector2(s, s))
	box.bg_color = Color(BRAND_INK.r, BRAND_INK.g, BRAND_INK.b, 0.97 * alpha)
	box.shadow_color = Color(0.05, 0.05, 0.18, 0.28 * alpha)
	draw_style_box(box, rect)

	var mark_at := Vector2(rect.position.x + 10.0, -TOAST_MARK * 0.5)
	var mark_mid: Vector2 = mark_at + Vector2(TOAST_MARK, TOAST_MARK) * 0.5
	draw_circle(mark_mid, TOAST_MARK * 0.5 + 2.0, Color(1, 1, 1, alpha))
	draw_texture_rect(main.mark_for(int(t["logo"])),
		Rect2(mark_at, Vector2(TOAST_MARK, TOAST_MARK)), false, Color(1, 1, 1, alpha))

	# Two lines, centred as a block on the banner's middle.
	var a12: float = font.get_ascent(12)
	var d12: float = font.get_descent(12)
	var a17: float = bold.get_ascent(17)
	var d17: float = bold.get_descent(17)
	var top: float = -(a12 + d12 + 2.0 + a17 + d17) * 0.5
	var tx: float = mark_at.x + TOAST_MARK + 11.0
	draw_string(font, Vector2(tx, top + a12), head, HORIZONTAL_ALIGNMENT_LEFT, -1, 12,
		Color(1, 1, 1, 0.82 * alpha))
	draw_string(bold, Vector2(tx, top + a12 + d12 + 2.0 + a17), name_str,
		HORIZONTAL_ALIGNMENT_LEFT, -1, 17, Color(1, 1, 1, alpha))
	var vy: float = (bold.get_ascent(15) - bold.get_descent(15)) * 0.5
	draw_string(bold, Vector2(rect.end.x - 14.0 - w_val, vy), val,
		HORIZONTAL_ALIGNMENT_LEFT, -1, 15,
		Color(TOAST_VAL.r, TOAST_VAL.g, TOAST_VAL.b, alpha))
	draw_set_transform(Vector2.ZERO, 0.0, Vector2.ONE)
