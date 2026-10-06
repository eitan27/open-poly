// Synthesizes each narration line into $OUT/audio/<id>.wav and writes
// $OUT/audio/durations.json. Lines are cached by engine, voice and text.
//
// Engine: Kokoro-82M (kokoro-js, run locally on the CPU) when it's installed —
// `npm install` in this folder; its weights download from Hugging Face on first
// run and are cached — otherwise macOS `say`. Force one with ENGINE=kokoro|say.
//   Kokoro: VOICE (default af_heart), SPEED (default 1)
//   say:    VOICE (default Samantha), RATE  (default 182 wpm)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { NARRATION, SPOKEN } from "./narration.mjs";

const dir = `${process.env.OUT}/audio`;
fs.mkdirSync(dir, { recursive: true });

let kokoro = null;
if (process.env.ENGINE !== "say") {
  try {
    kokoro = (await import("kokoro-js")).KokoroTTS;
  } catch (e) {
    if (process.env.ENGINE === "kokoro") throw e;
    console.log("kokoro-js not installed (npm install in scripts/tutorial) — falling back to `say`");
  }
}
const ENGINE = kokoro ? "kokoro" : "say";
const VOICE = process.env.VOICE ?? (kokoro ? "af_heart" : "Samantha");
const PACE = kokoro ? (process.env.SPEED ?? "1") : (process.env.RATE ?? "182");

let tts = null; // loaded only if some line actually needs synthesizing
async function synth(text, raw) {
  if (ENGINE === "say") {
    execFileSync("say", ["-v", VOICE, "-r", PACE, "-o", raw, text]);
    return;
  }
  tts ??= await kokoro.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: "q8", device: "cpu" });
  const audio = await tts.generate(text, { voice: VOICE, speed: +PACE });
  await audio.save(raw);
}

const durations = {};
for (const [id, caption] of NARRATION) {
  const text = SPOKEN.reduce((t, [re, say]) => t.replace(re, say), caption);
  const wav = `${dir}/${id}.wav`,
    raw = `${dir}/${id}.${ENGINE === "say" ? "aiff" : "raw.wav"}`,
    stamp = `${dir}/${id}.txt`,
    key = `trimmed|${ENGINE}|${VOICE}|${PACE}|${text}`;
  if (!fs.existsSync(wav) || !fs.existsSync(stamp) || fs.readFileSync(stamp, "utf8") !== key) {
    await synth(text, raw);
    // Trim the engine's lead-in/tail silence: record.mjs paces the gaps itself.
    const trim = "silenceremove=start_periods=1:start_threshold=-45dB";
    execFileSync("ffmpeg", [
      "-loglevel",
      "error",
      "-y",
      "-i",
      raw,
      "-af",
      `${trim},areverse,${trim},areverse`,
      "-ar",
      "48000",
      "-ac",
      "2",
      wav,
    ]);
    fs.writeFileSync(stamp, key);
  }
  durations[id] = +execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", wav])
    .toString()
    .trim();
}
fs.writeFileSync(`${dir}/durations.json`, JSON.stringify(durations, null, 1));
const total = Object.values(durations).reduce((a, b) => a + b, 0);
console.log(`${ENGINE} / ${VOICE}: speech total ${total.toFixed(1)}s`);
