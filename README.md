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

## Scoring the aligners, and correcting one

`eval/` holds everything behind the **aligner eval** screen — read `eval/README.md` first.

- `eval/run_eval.py` runs every aligner over the marked clips and scores them against the
  humans, with significance tests. Five are compared; MMS wins.
- `eval/correct_mms.py` is the one to know about. `mms-corrected` is not a sixth aligner:
  it is MMS's own output moved, so **MMS never has to be run again**. Two rules — a shift
  set by the letter at each boundary (the first letter moves the start, the last letter the
  end), then, for a word end with a pause after it, an
  extension to where the sound actually stops. Held out: median error 29.5 → 23.4 ms, and
  on those pre-pause ends p90 187 → 133 ms. It needs the existing timings plus the audio,
  and no model.
- `eval/push_corrected.py` applies it to a whole dataset, adding `mms-corrected` beside the
  labels already there and leaving untouched any clip that has no `mms` label.

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