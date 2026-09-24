# ---- Stage 1: export the game client to WebAssembly -------------------------
# Pinned by digest, not just tag. A mutable tag re-pushed with different export
# templates would silently change the shipped .wasm, and this project's whole
# verification story is that the deployed bytes match the verified bytes.
FROM barichello/godot-ci:4.4.1@sha256:274a9a1849ec64d0ce8577ccf698bd1b97f9994c150a8e9783e561533e568708 AS build

# The engine is piped through `tee`, and a pipeline's exit status is the LAST
# command's. Without pipefail an engine crash exits 0 and the build carries on.
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

WORKDIR /src
COPY . .

# The engine rejects a stray carriage return, and this project is edited on
# Windows. Normalising here is cheaper than finding out from a failed export.
# The list is the file types the engine parses, with the root project file
# matched by its name. Every other file ships exactly as uploaded. The grep
# skips anything binary, so a stray image that matches is never rewritten.
RUN find . -type f \( -name '*.gd' -o -name '*.tscn' -o -path './project.*' \
      -o -name '*.import' -o -name '*.gdshader' -o -name '*.cfg' \) \
      -exec grep -Iq . {} \; -exec sed -i 's/\r$//' {} +

# export_presets.cfg is gitignored upstream, so the preset is carried at a
# non-ignored path and put in place here.
RUN cp deploy/web.export_presets.cfg export_presets.cfg

# Without an explicit import pass, assets have no .import sidecar and the export
# ships nothing. This is where "Failed loading resource" surfaces FIRST, so it is
# gated here and not only after the export.
RUN godot --headless --path . --import 2>&1 | tee /tmp/import.log \
 && ! grep -qiE '^(ERROR|SCRIPT ERROR|USER ERROR)' /tmp/import.log

# The company marks are 256x256 and a $1B startup wears one at about 50 screen
# pixels. Without mipmaps that is a point sample every fifth texel and the mark
# sparkles as the company moves. The project file asks for them under
# [importer_defaults]; an ignored or misspelled key there would be invisible
# until somebody noticed the shimmer, so the GENERATED sidecar is checked rather
# than trusted.
#
# 🔴 The count is checked against the PNGs on disk and against companies.json,
# never against a magic number. It used to be `-ge 100`, which was true of the
# 119 company board and would have failed this build the moment that board was
# deliberately culled to 50. A gate that fires on a correct change is a gate
# somebody eventually deletes. What actually matters is that every mark imported
# and that the server names exactly as many companies as there are marks,
# because index and basename are the same number in Scripts/main.gd.
RUN set -eu; test -f logos/000.png.import; \
    grep -q 'mipmaps/generate=true' logos/000.png.import; \
    n=$(ls logos/*.png.import | wc -l); \
    d=$(ls logos/*.png | wc -l); \
    c=$(grep -c '"f"' server/companies.json); \
    echo "logo pack: $n imported, $d on disk, $c named by the server"; \
    test "$n" -eq "$d"; test "$n" -eq "$c"; test "$n" -ge 20

RUN mkdir -p build/web \
 && godot --headless --path . --export-release "Web" build/web/index.html 2>&1 | tee /tmp/export.log

# index.html/.js/.wasm come out of the template zip and appear even when the
# project itself packed badly, so they only prove the templates were present.
# The grep is the check that catches a broken export; keep both.
RUN test -s build/web/index.html \
 && test -s build/web/index.wasm \
 && test -s build/web/index.pck \
 && test -s build/web/index.js \
 && ls -la build/web \
 && ! grep -qiE '^(ERROR|SCRIPT ERROR|USER ERROR)' /tmp/export.log

# The login card and lobby picker. Shipped as plain files beside the engine's own
# output and injected into the generated index.html, rather than as a custom HTML
# shell: the generated shell bakes in a config literal carrying per-build
# file sizes, so freezing a copy would ship a stale config on the next export.
# The injected string is deliberately ONE line. A `\n` inside a Dockerfile RUN is
# eaten by Docker's own escape parser and broke this build once already.
# 🔴 logos.js MUST load before login.js: it defines window.AGARIPO_LOGOS, which
# login.js reads synchronously at parse time to build the picker. Reversed, the
# grid is silently empty and only the upload path works.
COPY deploy/login.css deploy/login.js deploy/logos.js build/web/
# The global leaderboard page. A plain HTML page beside the game rather than
# a second service: it is the same origin, so it needs no CORS, no second
# domain and no second thing for Railway to bill. It loads login.css for the
# palette and the wordmark, which is why the two pages cannot drift apart.
COPY deploy/leaderboard.html deploy/leaderboard.css deploy/leaderboard.js build/web/
# The picker's thumbnails: 96x96 versions of the same marks that are inside the
# .pck. The card is plain HTML and cannot read a packed resource, so it needs its
# own copy. 267 KB in total since the cull from 119 companies to 50, and every
# tile is still loading="lazy".
COPY deploy/logos/ build/web/logos/
RUN set -eu; f=build/web/index.html; grep -q '</body>' "$f"; sed -i 's#</body>#<link rel="stylesheet" href="login.css"><script src="logos.js"></script><script src="login.js"></script></body>#' "$f"; grep -q 'login.js' "$f"; grep -q 'login.css' "$f"; grep -q 'logos.js' "$f"; grep -q 'logos.js.*login.js' "$f"; echo "overlay injected"

# Both licences travel with the deployed copy: AgarIPO's own, and the upstream
# template's MIT notice, which MIT requires to go with every copy of its code.
COPY LICENSE UPSTREAM-LICENSE build/web/

# The browser tab, belt AND braces.
#
# 🔴 Overwriting these two exported files is NOT on its own enough, and that was
# measured in a real browser: the engine replaces the <link rel=icon> href at
# runtime with a blob built from the PROJECT icon, so the tab showed the engine's
# default icon a second after boot while every file on disk was correct. The real
# fix is the project's config/icon, now res://icon.png. These copies still matter,
# because they are what the tab shows in the seconds BEFORE the engine boots,
# and a 43 MB wasm makes that a long few seconds.
#
# Asserted to exist first: if a future engine version renames them, this has to
# fail the build rather than silently ship the engine's logo while everything
# else looks fine.
RUN set -eu; test -f build/web/index.icon.png; test -f build/web/index.apple-touch-icon.png
# 🔴 FROM brand/ AT THE REPO ROOT, not deploy/. That folder is the ONE source
# for the mark and it has to be a res:// resource, because overlay.gd preloads
# res://brand/agaripo-icon-64-light.png for the HUD wordmark and board.gd uses
# res://brand/agaripo-default.png as the fallback company disc. A second copy
# under deploy/ is a copy that goes stale, so there is no longer one.
# cp, not COPY, so the .import sidecars the engine generates beside these PNGs are
# not also published to the web root.
RUN set -eu; mkdir -p build/web/brand; \
    cp brand/*.png build/web/brand/; \
    cp brand/agaripo-icon-64.png build/web/index.icon.png; \
    cp brand/agaripo-icon-180.png build/web/index.apple-touch-icon.png; \
    n=$(ls build/web/brand/*.png | wc -l); \
    m=$(ls brand/*.png | wc -l); \
    echo "brand pack: $n published of $m rendered"; \
    test "$n" -eq "$m"; test "$n" -ge 6

# index.wasm is 43 MB raw. Compressing it once here and serving the .gz saves
# roughly 30 MB on every cold load; compressing it per request would not.
RUN cd build/web && for f in index.wasm index.pck index.js index.html login.js login.css logos.js \
      leaderboard.html leaderboard.css leaderboard.js; do \
      test -f "$f" && gzip -9 -k -f "$f"; \
    done && ls -la

# ---- Stage 2: one Node process serves the client AND hosts the lobbies ------
FROM node:22-alpine@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85

WORKDIR /app
ENV NODE_ENV=production

COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

COPY server/ ./
COPY --from=build /src/build/web/ /srv/web/

ENV STATIC_DIR=/srv/web
ENV PORT=8080
EXPOSE 8080

# Not root. The process only ever reads /srv/web and talks on one port.
USER node
CMD ["node", "index.js"]
