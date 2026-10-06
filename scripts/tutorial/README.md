# Tutorial video

Generates the "Getting started" video (an intro for people with little CAD
experience, kept **under 3 minutes**). Nothing is screen-recorded by hand: a
script drives the app, a local text-to-speech model reads the narration, and
ffmpeg puts the two together. Change the script, re-run, get a new video.

## Setup (once)

```bash
cd scripts/tutorial
npm install        # kokoro-js — kept out of the app's own dependencies
```

You also need `ffmpeg` on the PATH (`brew install ffmpeg`). The first run
downloads the Kokoro-82M voice model (~90 MB) from Hugging Face and caches it;
after that everything runs offline.

## Make the video

Start the app (`npm run dev` at the repo root), then from the repo root:

```bash
OUT=/tmp/tutorial node scripts/tutorial/tts.mjs      # narration → $OUT/audio
OUT=/tmp/tutorial node scripts/tutorial/record.mjs   # frames    → $OUT/frames
OUT=/tmp/tutorial node scripts/tutorial/build.mjs    # → $OUT/open-poly-tutorial.mp4
```

`record.mjs` opens a visible Chromium window for about three minutes — leave it
alone while it runs. It has to be headed: headless Chromium renders the view
cube black. It also blocks the agent bridge, so a running MCP session isn't
disturbed.

Add `SHOTS=1` to `record.mjs` to save a screenshot at the end of every beat
(`$OUT/shots/`) — the quickest way to check a run without watching it.

## The files

| File            | What it does                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------- |
| `narration.mjs` | The voice-over, one line per beat, and `SPOKEN` — respellings for words the voice says wrong.       |
| `tts.mjs`       | Speaks each line into `$OUT/audio/<id>.wav`. Only re-synthesizes lines whose text changed.          |
| `record.mjs`    | Drives the app. Each `beat(id, action)` plays its line while the action runs.                       |
| `overlay.js`    | What gets drawn over the app: cursor, click ripples, key badges, captions, spotlights, title cards. |
| `build.mjs`     | Places each line at the moment its beat started and writes the mp4.                                 |

## Changing it

- **Edit a line:** change it in `narration.mjs`, then re-run all three steps.
  Line lengths drive the timing, so `record.mjs` must be re-run whenever the
  narration changes.
- **Add a beat:** add a line to `narration.mjs` and a matching
  `await beat("<id>", async () => { … })` in `record.mjs`. The beat waits for
  whichever is longer, the line or the action, so lines never overlap.
  `record.mjs` prints any action that runs past its line.
- **Keep it under 3 minutes.** It currently runs ~2:57, and a run varies by
  about ±2 s. New narration needs a trim somewhere else.
- **Change the voice:** `VOICE=am_michael` (or any Kokoro voice) and `SPEED=1.1`
  for `tts.mjs`. `ENGINE=say VOICE=Samantha` uses the macOS voices instead.

## Pronunciation

The voice gets some words wrong — it spells out "CAD", stresses both
syllables of "3D", says "fillet" with a silent t, and reads a URL as three
sentences (it splits text on "."). The fix is a respelling in `SPOKEN` in
`narration.mjs`; captions keep the normal spelling.

To check a respelling before re-recording, see what Kokoro's phonemizer makes
of it (`ˈ` marks a stressed syllable):

```bash
cd scripts/tutorial
node -e 'import("phonemizer").then(async ({ phonemize }) => console.log(await phonemize("choose fillit", "en-us")))'
```

Then listen to the result — the phonemes say what the voice _should_ do, not
how it sounds.

## Polish rules learned the hard way

- **Never let the cursor rest on, or travel across, a button or the model.**
  Hover highlights read as presses. Park it on empty canvas and route around
  toolbars (see the redo beat in `record.mjs` for an example).
- **Clicking a part's row selects it**, which tints the model; clear it with
  `apply({ op: "select", refs: [] })` before a beauty shot.
- **The sketch-region hover** lights up the whole region — park outside it.

## Known issues

- Voice and clicks are synced per line, not per word, so a click can land a
  little early or late against the word that describes it. Splitting long lines
  into shorter beats at those words would tighten it.
