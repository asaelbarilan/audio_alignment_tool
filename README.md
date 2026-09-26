# Hebrew alignment tagging tool

A browser tool for hand-marking Hebrew word boundaries, used to build a gold set that says
which forced aligner to trust. Deployed on xhostd; this repo is the source of truth.

- `hebrew_training/align_tag_server.py` — stdlib HTTP server: serves clips, stores marks
- `hebrew_training/align_tag_page.html` — the marking UI
- `data/gold_set/*.jsonl` — the aligner proposals each clip starts from

The audio is **not** in this repo. It lives in the channel's S3-compatible bucket; the
container copies any missing clip up from `--clips-root` at startup, which is how the
original 35 MB of wav got out of the image.

Marks go to Postgres (`DATABASE_URL`), one row per annotator. `GET /api/export` writes them
back out as jsonl in the same shape as the input manifests, plus an `annotator` field.

Sign-in is Google via xhostd, verified server-side from the signed cookie. A new account
lands in a queue: it can read everything but cannot save a mark, claim a clip or align until
somebody lets it in, from the **approvals** screen. Who may do that is `TAG_ADMINS`, a list
of addresses in the environment. Leave it unset and the gate is off, since a gate with no
keyholder only strands people; the annotators already working are grandfathered in.

## Scoring the aligners

The scoring lives in a sibling repo, **`../eval-forced-alignment`** (history carried over from
the old `eval/` folder). The loop:

1. Publish the done clips: `python -m hebrew_training.publish_labeled_dataset --dataset <name>
   --hf-target <owner/repo>` (or `--local-target <dir>`). Each row carries its `annotator`;
   `--all-annotators` adds other annotators' marks of the same clip, which is what the
   human-agreement floor is computed from.
2. In `eval-forced-alignment`: `uv run python -m efa.run --input <owner/repo or dir>`. Every
   aligner times the human-corrected words; the output is one self-contained `result.json`.
3. Upload it on the **aligner eval** screen (approvers only). Results are stored in the bucket
   under `eval-results/` (`EVAL_RESULTS_BUCKET`, defaulting to the datasets bucket), or in
   `<out>/_eval-results/` with no bucket. The screen only displays them -- nothing is scored
   on this server. Its per-clip *open* link shows the result's own alignments as lanes.

`mms-corrected` -- MMS's own output moved by a per-letter shift and a pause-end extension,
held out 29.5 → 23.4 ms median -- is fitted and applied there too (`correction/`).

The **align** button re-times a clip from scratch by calling a Multilingual-Word-Aligner
RunPod endpoint with the clip's audio and transcript (see `api-client-guide.md`), replacing
the annotator's current marks with the result. Needs `ENDPOINT_ID` and `RP_API_KEY` (or
`RUNPOD_API_KEY`) in the environment; without them the button returns "Aligner disabled".
Optional: `ALIGNER_MODEL_NAME` (must match whichever model the endpoint was deployed with)
and `ALIGNER_LANGUAGE` (default `heb`).

# Tagging Guidance

## How to match text to speech
- convert numbers/values/dates to spoken words (1970, 2.5, 5%, 14:30 etc.)
- Add words which are spoken and not in text
- Remove words which are not spoken, or partially spoken (either speaker stopped mid-word or the word cuts off or start mid word in the audio sample)
- Use the proper text form of words even if the speaker mispronounces or stutters mid word - don't make up "literal speech representations" - the task it to align proper text to audio

## Multiple Speakers
- When overlapping - choose those most dominant speaker sequence and carry on with that ignoring the background overlapping words.
- When a word, even by a different speaker is clearly spoken and no other dominant speakers words - time that word even if the sentence does not makes sense
- If a speaker is interrupted and yields so the other speaker clearly speaks - time the interruption words


## Efficiency and Helpers
- Use speech segmentation lines
- Start by listening to all clip - and adapt the text (add, remove, modify words) to the spoken audio
- Lean the "Shift" modifiers to quickly adapt word start/end timings (control the small, med, big increments sizes)


## Quality Control
- Before marking done - play the entire clip and watch the highlights - get a "feel" that all words are in sync with audio