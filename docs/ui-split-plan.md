# Splitting align_tag_page.html — no build tools

## Status

Steps 1 and 2 are done: `static/css/app.css` and `static/js/main.js` exist, `align_tag_page.html`
is markup only (~375 lines), and `align_tag_server.py` serves `/static/*` with an immutable
cache header, stamps `?v=<build>` on every `/static/` reference, and hashes HTML+static
together for both that stamp and `/api/progress`'s `build` field. Verified locally: byte-identical
extraction, `?v=` present, immutable header present, path traversal 404s, and the page boots,
loads a clip and renders words/waveform/spectrogram with no console errors.

One deviation from the plan below: `main.js` cannot carry the `__BUILD__` placeholder itself
(substituting into a file that is itself hashed into the build would change its own hash), so
the substitution stays in the HTML as `<script>window.PAGE_BUILD='__BUILD__'</script>`, and
`main.js` just reads `window.PAGE_BUILD`.

Step 3 (splitting `main.js` into the per-concern modules below) has not been done yet — it is
one shared closure of mutable state (`gold`, `wi`, `buf`, `clips`, etc.) end to end, so it needs
its own careful pass rather than a mechanical cut.

## Problem

One file, ~2600 lines: markup, ~900 lines of CSS, ~1700 lines of JS. `page()` reads it
fresh from disk every request and stamps `__BUILD__` in, and the client polls
`/api/progress` to self-detect a stale cached copy and reload. Splitting into files must
keep that property — never serve JS/CSS that disagrees with the HTML that references it.

## File layout (all still plain files, no bundler)

```
hebrew_training/
  align_tag_page.html          # markup only, shrinks a lot
  static/
    css/app.css
    js/
      state.js        # PARAMS, TOK, WHO, api(), $, fail(), checkBuild()
      audio-engine.js  # transport (start/stop/now/stretched), Web Audio bits
      spectrogram.js   # buildMelSpec, FFT, mel filterbank, snap-point detector
      canvas-draw.js   # drawOverview/drawWave/drawZoom/drawScroll + pointer handlers
      words.js         # chips, editWord, add/delete word, untangle, reset-baseline
      align-client.js  # startAlign/pollAlign/cancelAlign (the RunPod call-out)
      screens/
        gate.js        # sign-in, name gate, migrate gate, waiting screen
        overview.js     # showOverview/loadOverview/renderOverviewList/claimClip
        eval.js          # showEval/renderEval/renderSignificance
        approvals.js     # showApprovals
      main.js          # boot(), keydown handler, wires everything together
```

Use native ES modules: `<script type="module" src="/static/js/main.js"></script>`.
Modules give real `import`/`export` and file-scoped variables — the thing a 1700-line
single script can't — with zero tooling, since browsers resolve same-origin ES module
graphs natively. `type="module"` also gets strict mode and defers execution for free.

Module boundaries above follow the section comments already in the file (`// ----
transport ----`, `// ---- waveform ----`, etc.) — this is a mechanical split, not a
redesign, at least for the first pass.

CSS: move the `<style>` block to `static/css/app.css` verbatim, link it normally. No
reason to split CSS further yet; it's flat and short relative to the JS.

HTML: markup has no native include mechanism in the browser. Two options:
- Leave it as one `align_tag_page.html` (markup is declarative and greppable; the pain
  was the JS logic, not the tag soup) — recommended for now.
- If it later grows unwieldy too, `page()` already reads the file fresh per request, so
  it can just as cheaply concatenate `screens/overview.html`, `screens/eval.html`, etc.
  with a marker (`<!--include:overview.html-->`) before serving. This costs nothing
  extra since there's no build step to skip either way — it's a string replace at
  request time, same trick `__BUILD__` already uses. Defer until actually needed.

## Cache-busting without staleness

Today: `index.html` is served `Cache-Control: no-store` on every request, and the page
polls `/api/progress` for a `build` hash to detect a stale copy and reload — necessary
because the *page* is the thing whose cache-invalidation can't be expressed any other
way over a single evolving URL.

Once JS/CSS live at their own URLs, they don't need that trick — they can be truly
immutable and cached forever, because the *content hash lives in the URL itself*:

1. Server computes one aggregate hash over all files under `static/` (reuse
   `page_build()`'s approach: sha256 of the concatenated bytes, sorted by path,
   truncated). Call it `ASSET_BUILD`.
2. `page()` (still reading `align_tag_page.html` fresh every request, as now) rewrites
   every `<script src="/static/...">` / `<link href="/static/...">` to append
   `?v=<ASSET_BUILD>` — same string-replace mechanism as `__BUILD__` today, just
   applied to more than one token. `__BUILD__`'s value (used by `/api/progress` and the
   client's `checkBuild()`) can just become `ASSET_BUILD` plus the HTML's own hash, or
   simplest: one hash over *everything* (HTML+CSS+JS together), used both for
   `checkBuild()`'s reload check and for the `?v=` query strings. One number, two jobs.
3. Server's static route serves `static/*` with `Cache-Control: public, max-age=31536000,
   immutable` — always, unconditionally. Safe *because* the URL changes the instant the
   content does; there is nothing to revalidate. `index.html` keeps `no-store` as today,
   since it's the one URL that never changes and must always be re-fetched.
4. Net effect: editing any JS/CSS file changes `ASSET_BUILD`, which changes the `?v=`
   query on every asset URL emitted by the next `page()` call, which is a different URL
   the browser has never cached — so it fetches fresh, then caches that exact byte
   sequence forever under its versioned URL. No 304 round-trips needed, no manual
   cache-header tuning per file type, no staleness window. `checkBuild()`'s existing
   poll-and-reload logic is unaffected (still comparing one hash) — it now also happens
   to guarantee the reloaded page pulls fresh assets, since the reload is to a URL with
   the new `?v=`.

## Server changes (align_tag_server.py)

- Add a `static/<path>` GET route: resolve under `hebrew_training/static/`, reject `..`
  traversal, guess content-type from suffix (`.js` → `application/javascript`, `.css` →
  `text/css`), set the immutable cache header, 404 if missing.
- `page_build()` generalizes to hash `align_tag_page.html` + everything under `static/`
  (sorted, concatenated) instead of just the one file. `/api/progress`'s `build` field
  and the `?v=` stamping both read this same value.
- `page()` gains one more `.replace()` pass (or a tiny regex) to append `?v=<hash>` to
  `static/` URLs. Still no template engine — same spirit as the existing `__BUILD__`
  substitution.

## Migration order (each step independently deployable/testable)

1. Extract `<style>` → `static/css/app.css`, add the static route + cache headers,
   wire `?v=` stamping for just this one file. Lowest risk, proves the mechanism.
2. Move the whole `<script>` body to `static/js/main.js` verbatim (no split yet, just
   `type="module"`), confirm nothing behavioral changes (globals become module-scoped —
   watch for anything relying on them being on `window`; grep for `window.align =` and
   similar and keep those explicit assignments).
3. Split `main.js` into the modules listed above, adding explicit `import`/`export`
   statements at each seam. Do this incrementally, one module extracted at a time, so
   each step is a small reviewable diff rather than one big reshuffle.
4. Only if the HTML markup itself becomes the bottleneck: apply the server-side include
   trick described above to split it into per-screen fragments.

## Non-goals / things this deliberately does not do

- No bundler, no npm, no build step — matches the existing "read the file fresh on
  every request" deploy model exactly; `git push` + xhostd deploy stays the whole
  pipeline.
- No behavior change to auth, gating, or the align/eval/overview logic — this is a
  file-boundary and caching change only.
- Not attempting to cache-bust per-individual-file with independent hashes (i.e.
  `audio-engine.<hash>.js`) — one aggregate `ASSET_BUILD` for everything is simpler and
  the total asset size here is small enough that "any change busts everything" costs
  nothing worth optimizing for.
