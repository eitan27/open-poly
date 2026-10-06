// Assembles $OUT/open-poly-tutorial.mp4 from record.mjs's screencast frames and
// tts.mjs's narration, placing each line at the moment its beat started.
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const OUT = process.env.OUT;
const { frames, marks } = JSON.parse(fs.readFileSync(`${OUT}/timeline.json`, "utf8"));
const t0 = frames[0].t;
const run = (args) => execFileSync("ffmpeg", ["-loglevel", "error", "-y", ...args], { stdio: "inherit" });

// Video: the screencast only emits a frame when something changed, so each
// frame is held until the next one arrives, then resampled to a steady 30fps.
const list = frames
  .map((f, i) => `file 'frames/${f.file}'\nduration ${((frames[i + 1]?.t ?? f.t + 0.5) - f.t).toFixed(4)}`)
  .join("\n");
fs.writeFileSync(`${OUT}/frames.txt`, `${list}\nfile 'frames/${frames.at(-1).file}'\n`);
const length = frames.at(-1).t + 0.5 - t0;
run([
  "-f",
  "concat",
  "-safe",
  "0",
  "-i",
  `${OUT}/frames.txt`,
  "-vf",
  `fps=30,scale=1920:1080:flags=lanczos,fade=t=out:st=${(length - 0.8).toFixed(2)}:d=0.8,format=yuv420p`,
  "-c:v",
  "libx264",
  "-preset",
  "slow",
  "-crf",
  "18",
  "-movflags",
  "+faststart",
  `${OUT}/video.mp4`,
]);

// Narration: every line delayed to its beat's start, mixed, levelled.
const inputs = marks.flatMap((m) => ["-i", `${OUT}/audio/${m.id}.wav`]);
const delays = marks.map((m, i) => `[${i}]adelay=${Math.round((m.t - t0) * 1000)}:all=1[a${i}]`).join(";");
const mix = `${marks.map((_, i) => `[a${i}]`).join("")}amix=inputs=${marks.length}:normalize=0,loudnorm=I=-16:TP=-1.5,apad[out]`;
run([
  ...inputs,
  "-filter_complex",
  `${delays};${mix}`,
  "-map",
  "[out]",
  "-t",
  length.toFixed(2),
  "-ar",
  "48000",
  `${OUT}/voice.wav`,
]);

run([
  "-i",
  `${OUT}/video.mp4`,
  "-i",
  `${OUT}/voice.wav`,
  "-c:v",
  "copy",
  "-c:a",
  "aac",
  "-b:a",
  "192k",
  "-shortest",
  `${OUT}/open-poly-tutorial.mp4`,
]);
console.log(`wrote ${OUT}/open-poly-tutorial.mp4 (${length.toFixed(1)}s)`);
