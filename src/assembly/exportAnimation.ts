// Exporting an animation (the Animate dialog's Export): one cycle of it —
// once, a loop's one sweep, a bounce's there and back — rendered frame by
// frame at a fixed rate and encoded as a video or a GIF. Frames are rendered,
// not recorded off the screen, so a slow machine drops none: each is the
// dialog's own per-frame solve, posed through poseBodies and drawn through
// ViewportApi.drawFrame, highlights off.
//
// Video: the frames go onto a hidden canvas whose captureStream feeds a
// MediaRecorder, one requestFrame each, paced at the frame rate in real time
// (the recorder stamps frames as they arrive). WebM where the browser can
// record it, else MP4 (Safari). GIF: each frame quantized to its own
// 256-colour palette and encoded with gifenc.
import { applyPalette, GIFEncoder, quantize } from "gifenc";
import { valueAt, type AnimateSpec } from "./animate";

export type ExportFormat = "video" | "gif";

/** Frames per second: smooth video; a GIF's delays are in hundredths of a
 *  second, so 20 (50 ms) keeps it even and small. */
export const EXPORT_FPS: Record<ExportFormat, number> = { video: 30, gif: 20 };
/** Frame width; height follows the view's shape. Even, as video encoders want. */
export const EXPORT_WIDTH: Record<ExportFormat, number> = { video: 1280, gif: 640 };

/** The DOF's value at each frame of one cycle: once from `from` to `to`
 *  (both ends); a loop's sweep, stopping a frame short of `to`, where it
 *  starts again; a bounce there and back, a frame short of `from`. */
export function exportFrameValues(spec: AnimateSpec, fps: number): number[] {
  const cycle = spec.mode === "bounce" ? 2 * spec.seconds : spec.seconds;
  const n = Math.max(2, Math.round(cycle * fps));
  if (spec.mode === "once")
    return Array.from({ length: n }, (_, i) => valueAt(spec, (i / (n - 1)) * spec.seconds).value);
  return Array.from({ length: n }, (_, i) => valueAt(spec, (i / n) * cycle).value);
}

/** The frame size for `format` at the view's shape: both even. */
export function exportSize(format: ExportFormat, aspect: number): { width: number; height: number } {
  const width = EXPORT_WIDTH[format];
  const height = Math.max(2, 2 * Math.round(width / aspect / 2));
  return { width, height };
}

/** A recordable video type this browser has, or null if it can't record. */
export function videoMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const t of ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"])
    if (MediaRecorder.isTypeSupported(t)) return t;
  return null;
}

export interface ExportJob {
  format: ExportFormat;
  /** The DOF's value at each frame (exportFrameValues). */
  values: number[];
  /** Pose the view at `value` and draw it onto `ctx`. */
  draw: (value: number, ctx: CanvasRenderingContext2D) => void;
  aspect: number;
  /** Plays once (a GIF that doesn't repeat), else loops. */
  once: boolean;
  onProgress?: (done: number, total: number) => void;
  /** Stops the export: it rejects with an AbortError. */
  signal?: AbortSignal;
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
const aborted = () => new DOMException("Export cancelled", "AbortError");

/** Render and encode `job`'s frames: the file, as a Blob. */
export async function exportAnimation(job: ExportJob): Promise<Blob> {
  const { width, height } = exportSize(job.format, job.aspect);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: job.format === "gif" })!;
  return job.format === "gif" ? encodeGif(job, ctx) : encodeVideo(job, ctx);
}

async function encodeGif(job: ExportJob, ctx: CanvasRenderingContext2D): Promise<Blob> {
  const { width, height } = ctx.canvas;
  const gif = GIFEncoder();
  const delay = Math.round(1000 / EXPORT_FPS.gif);
  for (const [i, value] of job.values.entries()) {
    if (job.signal?.aborted) throw aborted();
    job.draw(value, ctx);
    const { data } = ctx.getImageData(0, 0, width, height);
    const palette = quantize(data, 256);
    gif.writeFrame(applyPalette(data, palette), width, height, {
      palette,
      delay,
      ...(i === 0 ? { repeat: job.once ? -1 : 0 } : {}),
    });
    job.onProgress?.(i + 1, job.values.length);
    // Let the page breathe (and the progress show) between frames.
    await tick(0);
  }
  gif.finish();
  return new Blob([gif.bytes()], { type: "image/gif" });
}

async function encodeVideo(job: ExportJob, ctx: CanvasRenderingContext2D): Promise<Blob> {
  const mimeType = videoMimeType();
  if (!mimeType) throw new Error("This browser can't record video; export a GIF instead.");
  const stream = ctx.canvas.captureStream(0);
  const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise<void>((r) => (recorder.onstop = () => r()));
  const frameMs = 1000 / EXPORT_FPS.video;
  recorder.start();
  try {
    const t0 = performance.now();
    for (const [i, value] of job.values.entries()) {
      if (job.signal?.aborted) throw aborted();
      job.draw(value, ctx);
      track.requestFrame();
      job.onProgress?.(i + 1, job.values.length);
      // Hold each frame for its time, against the clock, so the recorder's
      // timestamps play back at the frame rate.
      await tick(Math.max(0, t0 + (i + 1) * frameMs - performance.now()));
    }
  } finally {
    recorder.stop();
    track.stop();
  }
  await stopped;
  return new Blob(chunks, { type: mimeType.split(";")[0] });
}

/** A file extension for an exported blob's type. */
export const extensionOf = (type: string) => (type.includes("gif") ? "gif" : type.includes("mp4") ? "mp4" : "webm");
