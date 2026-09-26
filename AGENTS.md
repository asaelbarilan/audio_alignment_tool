# Handoff

Operational notes for an agent picking this up cold. Written 2026-09-23.

## What this is

A browser tool for hand-marking Hebrew word boundaries, and the evaluation built on the
marks it collects. The point of the gold set is to decide **which forced aligner to trust**
for a 4,000-hour Hebrew TTS corpus (Knesset plenum, committee and recital audio).

Two repositories, side by side, both on GitHub:

- `C:\Users\Asael\PycharmProjects\audio_alignment_tool` — this one: the tool, the evaluation,
  the correction. Source of truth for what is deployed.
- `C:\Users\Asael\PycharmProjects\pocket-tts` — the write-ups. Every finding below is argued
  out properly in `pocket-tts/docs/`, with the papers in `pocket-tts/papers/hebrew-alignment/`.
  **It has ~46 unpushed commits; they are all this work and nobody else's.**

They used to live inside `F5-TTS`. That folder was moved to `D:\F5-TTS` on 2026-09-23 because
C: had 2 GB free; its virtualenvs hardcode `C:\` paths and need recreating if it is used again.

## How to work here

Read `.claude/skills/brief/SKILL.md` before replying to anything. The user has said four
times that they cannot read long replies. **One idea per reply, eight lines, one question at
the end, and the detail goes in a doc.** This is the single most important thing in this file:
a correct analysis they do not read is a failed reply.

Two standing constraints from the user:

- **Do not change MMS or what it is fed.** The correction is a classifier outside the
  aligner, taking its output as given. Feeding it a better romanization is ruled out, however
  tempting `vyrvshlym` makes it look.
- Measure before claiming a cause. Every real finding here came from an instrument, and
  several confident-sounding guesses (mine) were wrong.

## The live site

https://hebrew-align-tagging-asaelbarilan.xhostd.app — 300 clips, 76 marks from three
annotators, six aligner labels.

Deploying is: push to `origin/master`, then

```
POST https://api.xhostd.com/apps/<app>/github/sync
POST https://api.xhostd.com/apps/<app>/channels/<channel>/deploy   {"sha": "<sha>"}
```
with `Authorization: Bearer <xhostd token>`. App `9662e58a-f841-4026-8dc8-105157291283`,
prod channel `2fd667cd-65f6-4fec-a3ad-09135f493a94`. A deploy takes about a minute and
restarts the container, which is also how an env-var change takes effect.

**Credentials are not in this repo and were held in the previous session's scratchpad, which
is gone.** The xhostd API token and the S3 keys come from the xhostd dashboard; ask the user.

`/api/progress` is the only route without a sign-in and reports clips, marks, labels and where eval
results are stored. It is the first thing to look at when the site misbehaves, and it was added
after an afternoon lost to guessing.

### Sign-in and the approval gate

Google via xhostd. A new account lands in a queue: it can read everything, but every save,
claim and align is refused until an approver clicks *let in* on the **approvals** screen.
Approvers are `TAG_ADMINS` (set on the prod channel to the user's and yoad's addresses).

Two deliberate safeties: annotators who already existed were grandfathered in at the moment
the column was created, once and never again; and with `TAG_ADMINS` unset the gate is off
entirely, because a gate with no keyholder only strands people.

## The gold set

72 clips marked (52 committee, 13 recital, 7 plenum, ten minutes), 1,096 paired words,
annotators `yoad` (50), `asael` (22), `asael_old` (4). Exclude the annotator `probe` — it is
a test row of mine and counting it as a person once put human-human agreement at 587 ms.

Two facts that shape everything:

- **Annotators added 205 words (15.2%) the transcript lacked.** The text is a written
  protocol, not a transcription, so it was never verbatim; the additions are function words
  and repetitions — the layer a stenographer cleans out.
- **13.9% of human boundaries were never moved off the `ivrit-ai` seed** the tool opens clips
  on. Those are not independent judgements. Comparisons involving `ivrit-ai` are flagged
  unfair in the dashboard for exactly this reason.

## Results, settled

Scored with a clip-level paired bootstrap, 2,000 draws, Holm-corrected. Clips are resampled,
not boundaries — boundaries in one clip share a speaker and are not independent.

    aligner            median    p90   <=25ms  <=50ms
    mms-corrected       23 ms   78 ms   53.0%   78.4%
    mms                 30 ms   91 ms   44.2%   71.7%
    whisper-stable-ts   40 ms  145 ms   36.7%   61.6%
    ivrit-ai            30 ms  190 ms   43.7%   63.3%   (flattered; it is the seed)
    wav2vec2-hebrew     50 ms  201 ms   28.4%   50.4%
    mwa-buckeye         50 ms  505 ms   32.3%   49.6%
    mwa-timit           50 ms  615 ms   32.5%   50.2%
    two humans          25 ms   95 ms   52.4%   83.3%

- **MMS wins**, and corrected MMS is closer to a human mark than two humans are to each other
  on the median, at 25 ms and on the tail. They still lead inside 10 ms and inside 50 ms.
- **MWA lost on both checkpoints**, which is not a mix-up — checked structurally, and `timit`
  (the one the paper's Hebrew table uses) scores the same as `buckeye` here. Our `mms` starts
  reproduce the paper's `mms` to a few points, so the harness is sound and MWA's own output
  is the outlier. Unexplained; see `docs/mms-boundary-correction.md`.

## The correction, `mms-corrected`

Not a sixth aligner: MMS's own output moved, so **MMS never has to be run again**.

1. Every boundary moves outward by an amount set by the letter at it — the first letter sets
   the start, the last sets the end. Plosive −2 ms, nasal +23/+9, glottal +24/+24, liquid
   +30/+8, fricative +44/+16. Starts move far more than ends, because CTC commits a letter
   only when it is sure and a word's onset is where it is least sure. Text and timings only.
2. A word end with 100 ms or more of silence after it is extended to where the sound stops:
   forward while the envelope stays above **20%** of that word's own peak, capped at 100 ms.
   Reads the waveform. 24% of words.

Held out (fit on half the clips, score the other half, swap): median 29.5 → 23.4 ms, p90
90.5 → 79.0. On the pre-pause ends, p90 187 → 133 ms and within 50 ms 38.5% → 48.3%.
It helps 87 of those 143 ends and hurts 25 — the 25 are ones MMS already had right, and I
could not separate them with any feature available.

All evaluation code, the correction included, moved to `../eval-forced-alignment` on
2026-09-26: `correction/correct_mms.py` measures it and writes `correction.json`,
`correction/push_corrected.py` applies it to a whole manifest. This site only displays
uploaded `result.json` files (aligner eval screen); nothing is scored here any more.

## What was tried and did not work

Do not re-propose these without new data. All are written up with numbers.

- **Taking a fraction of the adjacent gap** instead of a fixed shift. Worse than doing
  nothing on the tail: people move a boundary ~30 ms whatever the pause, so 43% of a 400 ms
  pause overshoots by 170 ms.
- **Sampling the shift from its distribution.** Worse than raw MMS. Absolute error is
  minimised by the conditional median; a draw misses in a random direction.
- **A regression tree over every feature.** Ties the plain letter-class rule overall and
  loses to it on the pre-pause ends. The published method (Zito 2020) warns why: common
  contexts hold no systematic error to model.
- **Phonikud phonemes and stress** in place of the Hebrew letters. Lost — 25.4 vs 23.4 —
  because MMS aligns uroman's transliteration of the *spelling*, not the sounds. `בירושלים`
  reaches it as `vyrvshlym`.
- **Extending word ends using the CTC posterior.** No signal exists: past a word end the
  model's "something is being said" value is 0.01. CTC blank means "no new letter", not
  "no sound".
- **Moving ו out of the fricatives.** It does behave like a vowel at word end (18 ms against
  9 ms for real fricatives) but regrouping moves the median by 0.3 ms. Noise, on 43 starts.

## Mismatch detection, and why it is repair not filtering

`research/mismatch.py`, `research/mismatch_report.py`, `research/unclaimed_*.py` in `../eval-forced-alignment`.

- A word **in the text but not the audio** is findable: CTC score 0.04 against 0.66 for a
  real word; 53% caught at a 5% false-alarm rate. Duration is a poor signal, 4%.
- A word **in the audio but not the text** is half findable, and only from the waveform:
  summing 1−P(blank) across the gaps the aligner leaves gives 102 ms of unclaimed speech on a
  missing word against 5 ms elsewhere. 45% of rows at 9% false alarms. 40% leave no gap at
  all, because the aligner stretches a neighbour over them — a hard ceiling.
- **Do not build a row-level filter.** 49 of 72 rows already contain a missing word. At that
  base rate any threshold discards most of the corpus. The answer is ASR repair, with the
  unclaimed-speech measure as its referee: a word ASR adds where no word claims the audio is
  real; one it adds over claimed audio is a hallucination.

## Environments

The aligners have incompatible dependencies, so each has its own interpreter, named in `.env`
(see `../eval-forced-alignment/README.md`, which now builds them as uv projects under `envs/`).

- `ctc-env/` — torch (CPU), torchaudio, transformers, uroman, soundfile, scipy, matplotlib,
  phonikud, phonikud-onnx. Runs the CTC aligners and the research scripts that need audio.
  CPU is fine: `forced_align` has no CUDA kernel anyway and timings reproduce the GPU run
  exactly.
- `C:\Users\Asael\PycharmProjects\Multilingual-Word-Aligner\.venv` — MWA's own environment.
- stable-ts needs its own (torch 2.4, faster-whisper, `numpy<2`); it no longer exists locally.

## Open

- **ASR repair**: run Whisper over the 72 clips and check its additions against the 205 known
  missing words, gated by the unclaimed-speech measure. This is the next experiment.
- **More marks.** 72 clips is now the binding limit on everything: corrected MMS already
  beats human-human agreement on the median and the tail, so the gold set can no longer
  measure an improvement. Nothing in the modelling list is worth doing before this.
- Email on new sign-ups was asked for and dropped — xhostd cannot send mail and the badge on
  the approvals link was judged enough.

<!-- graft:start -->
## Graft — repo context graph

This repo is indexed in `graft/`: small linked markdown nodes that explain each
system and carry exact file:line spans, kept in sync with the code through git.

For ANY task here — understanding how something works, finding where code lives,
or scoping a change — get context from the graph before grepping or opening
source files. Re-ask freely (it's cheap) and reuse literal identifiers you
already have (symbol, error string, file name) as the query. New to this repo?
Run `graft map` first — a token-budgeted orientation (dir clusters, hubs,
hotspots), no LLM, no key.

- Run `graft ask "<your question>" --source` → ranked nodes with the relevant
  code spans inlined (each hit's ≤8-line crux by default; `--full` for whole
  definitions when the crux isn't enough). Match the tool to the task shape:
  for understanding or editing, the top node IS the answer — cite its
  `covers:` file:line spans and edit straight from `--source`. For
  exhaustive tasks ("every occurrence / every caller of this pattern"), ranked
  results are top-N, not complete — run `graft grep "<literal>"` instead
  (exhaustive over indexed files, grouped by enclosing symbol), falling back
  to raw `grep -rn` only for unindexed files.
- `graft skeleton <file>` → every definition's signature + span, ~10× cheaper
  than reading the file; use it to skim an API surface.
- `graft callers <symbol>` gives precomputed, exact edges — who calls this.
  Add `--direction out` for what it calls, or `--depth N` to walk
  transitively for the full blast radius. For structural questions, skip
  ranking and use this directly.
- Or browse: `graft/INDEX.md` lists every node; follow the links.
- Monorepos and folders of multiple repos rank fairly across sub-projects —
  hits carry `[scope/]` labels naming which one they're from. Narrow with
  `graft ask "<task>" --in <scope>/` once you know where you're working.

If a returned span is truncated ("+N more lines"), open the file at that exact
range before finalizing. Only open source files when a node genuinely lacks a
needed detail, and then at the exact file:line the node points to — never
re-read whole files.

After big code changes, refresh the graph with `graft build` (deterministic,
no API key, $0).
<!-- graft:end -->
