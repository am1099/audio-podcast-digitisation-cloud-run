import express from "express";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { createClient } from "@supabase/supabase-js";
import cors from "cors";
import multer from "multer";
import { GoogleGenAI } from "@google/genai";

const app = express();

/**
 * =========
 * ENV
 * =========
 * GEMINI_API_KEY
 * PUBLIC_SUPABASE_URL
 * SUPABASE_SERVICE_ROLE_KEY
 *
 * Optional speed knobs:
 * FAST_MODE=true                -> trims audio for Gemini + video render (for dev testing)
 * FAST_MODE_SECONDS=180         -> how many seconds to process when FAST_MODE=true
 * GEMINI_AUDIO_SECONDS=600      -> even in normal mode, only send first N seconds to Gemini (faster + cheaper)
 */

const FAST_MODE = String(process.env.FAST_MODE || "false").toLowerCase() === "true";
const FAST_MODE_SECONDS = Number(process.env.FAST_MODE_SECONDS || 180); // 3 mins
const GEMINI_AUDIO_SECONDS = Number(process.env.GEMINI_AUDIO_SECONDS || 600); // 10 mins

const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const upload = multer({
  dest: "/tmp",
  limits: {
    // 20min mp3 at 128kbps ~= ~19MB; but uploads could be wav/webm etc, so allow bigger
    fileSize: 250 * 1024 * 1024, // 250MB
  },
});

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

app.use(express.json());

const supabase = createClient(
  process.env.PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * =========
 * Helpers
 * =========
 */

function nowMs() {
  return Date.now();
}

function safeUnlink(p) {
  try {
    fs.unlinkSync(p);
  } catch (_) {}
}

function stripCodeFences(text = "") {
  return String(text)
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

// If Gemini returns extra text before/after JSON, extract first {...} block
function extractFirstJsonObject(text = "") {
  const s = String(text);
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return s.slice(start, end + 1);
}

function isLikelySrt(s = "") {
  return (
    typeof s === "string" &&
    s.includes("-->") &&
    /\d{2}:\d{2}:\d{2},\d{3}\s-->/.test(s)
  );
}

function clampKeywords(arr) {
  if (!Array.isArray(arr)) return [];
  const cleaned = arr
    .map((x) => String(x || "").trim())
    .filter(Boolean)
    .slice(0, 25);
  return Array.from(new Set(cleaned));
}

function formatSrtTime(sec) {
  const ms = Math.max(0, Math.floor((sec % 1) * 1000));
  const total = Math.max(0, Math.floor(sec));
  const h = String(Math.floor(total / 3600)).padStart(2, "0");
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${h}:${m}:${s},${String(ms).padStart(3, "0")}`;
}

function splitTranscriptToCaptions(transcript, maxChars = 72) {
  const flat = String(transcript || "")
    .replace(/\r/g, "")
    .replace(/\n+/g, " ")
    .trim();

  if (!flat) return [];

  const sentences = flat
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const chunks = [];
  for (const s of sentences.length ? sentences : [flat]) {
    if (s.length <= maxChars) {
      chunks.push(s);
      continue;
    }
    let cur = "";
    for (const word of s.split(/\s+/)) {
      if (!cur) cur = word;
      else if ((cur + " " + word).length <= maxChars) cur += " " + word;
      else {
        chunks.push(cur);
        cur = word;
      }
    }
    if (cur) chunks.push(cur);
  }

  return chunks;
}

async function ffprobeDurationSeconds(inputPath) {
  return await new Promise((resolve) => {
    const args = [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=nw=1:nk=1",
      inputPath,
    ];
    const p = spawn("ffprobe", args);
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("close", () => {
      const val = parseFloat(String(out).trim());
      resolve(Number.isFinite(val) && val > 0 ? val : null);
    });
    p.on("error", () => resolve(null));
  });
}

/**
 * Much better fallback than "3 seconds per line":
 * distributes caption times across full duration proportional to word counts,
 * with sensible min/max per caption so it doesn't dump everything early.
 */
function buildSrtProportional(transcript, durationSec) {
  const captions = splitTranscriptToCaptions(transcript, 72);
  if (!captions.length) return "";

  const wordsPerCaption = captions.map((c) => c.split(/\s+/).filter(Boolean).length);
  const totalWords = wordsPerCaption.reduce((a, b) => a + b, 0) || captions.length;

  const totalDuration =
    Number.isFinite(durationSec) && durationSec > 0 ? durationSec : captions.length * 3;

  let t = 0;
  let idx = 1;
  let srt = "";

  for (let i = 0; i < captions.length; i++) {
    const w = wordsPerCaption[i] || 1;

    // readable cadence
    const raw = (w / totalWords) * totalDuration;
    const dur = Math.min(6.0, Math.max(1.6, raw));

    const start = t;
    const end = Math.min(totalDuration, t + dur);

    srt += `${idx}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${captions[i]}\n\n`;

    idx++;
    t = end;
    if (t >= totalDuration - 0.05) break;
  }

  return srt.trim() + "\n";
}

async function runFfmpeg(args, logPrefix = "ffmpeg") {
  return await new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", args);

    p.stderr.on("data", (data) => {
      console.log(`${logPrefix}: ${data.toString()}`);
    });

    p.on("error", reject);

    p.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg exited with code ${code}`));
    });
  });
}

/**
 * Ensure we have a Gemini-friendly audio file:
 * - Convert whatever upload is (wav/webm/m4a/etc) to mp3
 * - Optionally trim to N seconds (FAST_MODE for dev speed)
 * - Optionally trim only for Gemini (GEMINI_AUDIO_SECONDS)
 */
async function transcodeToMp3(inputPath, outPath) {
  // -vn ensures no video track; -ar 44100 stable
  await runFfmpeg(
    [
      "-y",
      "-i",
      inputPath,
      "-vn",
      "-ac",
      "2",
      "-ar",
      "44100",
      "-b:a",
      "128k",
      outPath,
    ],
    "ffmpeg(transcode)"
  );
}

async function trimAudio(inputPath, outPath, seconds) {
  await runFfmpeg(
    [
      "-y",
      "-i",
      inputPath,
      "-t",
      String(seconds),
      "-c",
      "copy",
      outPath,
    ],
    "ffmpeg(trim)"
  );
}

app.post("/convert", upload.single("audio"), async (req, res) => {
  const startedAt = nowMs();

  // Track temp files so we can clean up
  const tmp = [];

  try {
    if (!req.file) return res.status(400).json({ error: "No audio file uploaded" });

    const keywords = JSON.parse(req.body.keywords || "[]");
    const programId = req.body.programId;
    if (!programId) return res.status(400).json({ error: "Missing programId" });

    const inputPath = req.file.path;
    tmp.push(inputPath);

    console.log("Audio received:", inputPath, "mimetype:", req.file.mimetype);

    /**
     * =========
     * STEP A — Normalize audio to MP3 (important for Gemini reliability)
     * =========
     */
    const mp3Path = `/tmp/audio-${Date.now()}.mp3`;
    tmp.push(mp3Path);

    // Always transcode -> consistent + fixes weird upload formats
    await transcodeToMp3(inputPath, mp3Path);

    /**
     * =========
     * STEP B — FAST MODE (dev) and GEMINI trimming (speed)
     * =========
     * FAST_MODE:
     *   - trims BOTH Gemini + video render (super fast end-to-end testing)
     * GEMINI_AUDIO_SECONDS:
     *   - even in non-fast mode, only send first N seconds to Gemini to reduce AI time/cost
     *   - subtitles then get proportionally distributed across full duration (fallback)
     */
    let mp3ForGemini = mp3Path;

    if (FAST_MODE) {
      const trimmed = `/tmp/audio-fast-${Date.now()}.mp3`;
      tmp.push(trimmed);
      await trimAudio(mp3Path, trimmed, FAST_MODE_SECONDS);
      mp3ForGemini = trimmed;
      console.log(`FAST_MODE enabled: processing only first ${FAST_MODE_SECONDS}s`);
    } else if (GEMINI_AUDIO_SECONDS > 0) {
      const dur = await ffprobeDurationSeconds(mp3Path);
      if (dur && dur > GEMINI_AUDIO_SECONDS + 5) {
        const trimmed = `/tmp/audio-gemini-${Date.now()}.mp3`;
        tmp.push(trimmed);
        await trimAudio(mp3Path, trimmed, GEMINI_AUDIO_SECONDS);
        mp3ForGemini = trimmed;
        console.log(
          `Gemini audio trimmed to ${GEMINI_AUDIO_SECONDS}s (full duration ~${Math.round(dur)}s)`
        );
      }
    }

    /**
     * =========
     * STEP 1 — Gemini: transcript + srt + summary + description + keywords
     * =========
     */
    const audioBase64 = fs.readFileSync(mp3ForGemini).toString("base64");

    const aiResponse = await genAI.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `
You are processing a radio broadcast audio file.

Return ONLY valid JSON (no markdown, no backticks, no extra text):

{
  "transcript": "plain text transcript with paragraphs (NO timestamps)",
  "srt": "valid .srt subtitles WITH timestamps in correct SRT format",
  "summary": "2-3 sentence summary",
  "description": "YouTube-style description with emojis and a few hashtags at the end",
  "keywords": ["10", "SEO", "keywords", "as", "strings"]
}

Rules:
- transcript: plain readable text, no SRT lines, no timestamps.
- srt: must be valid SRT timing format HH:MM:SS,mmm --> HH:MM:SS,mmm
- keywords: 10 items max
              `.trim(),
            },
            {
              inlineData: {
                mimeType: "audio/mp3",
                data: audioBase64,
              },
            },
          ],
        },
      ],
    });

    console.log("Gemini response received");

    let transcript = "";
    let summaryText = "";
    let descriptionText = "";
    let aiKeywords = [];
    let srt = "";
    let parsedOk = false;

    const rawText = stripCodeFences(aiResponse?.text || "");
    const rawJson = extractFirstJsonObject(rawText) || rawText;

    try {
      const aiData = JSON.parse(rawJson);
      transcript = String(aiData.transcript || "").trim();
      summaryText = String(aiData.summary || "").trim();
      descriptionText = String(aiData.description || "").trim();
      aiKeywords = clampKeywords(aiData.keywords).slice(0, 10);
      srt = String(aiData.srt || "").trim();
      parsedOk = true;
    } catch (_) {
      parsedOk = false;
    }

    // Ensure transcript exists
    if (!transcript) transcript = rawText || "";

    // Validate / fallback SRT
    if (!isLikelySrt(srt)) {
      console.log("SRT invalid or missing; building fallback SRT from duration...");
      const durationSec = await ffprobeDurationSeconds(mp3Path); // full duration
      srt = buildSrtProportional(transcript, durationSec);
    }

    // Ensure summary/description exists so UI doesn't spin forever
    if (!summaryText) {
      summaryText = transcript
        ? transcript.split(/\s+/).slice(0, 40).join(" ") + "…"
        : "Summary unavailable.";
    }

    if (!descriptionText) {
      descriptionText = "🎙️ New broadcast clip\n\nGenerated from the uploaded radio audio.\n\n#radio #podcast";
    }

    // Merge keywords: AI first, then user keywords
    const mergedKeywords = clampKeywords(
      (aiKeywords?.length ? aiKeywords : []).concat(keywords || [])
    ).slice(0, 25);

    /**
     * =========
     * STEP 2 — Write subtitles to disk
     * =========
     */
    const subtitlePath = `/tmp/subtitles-${Date.now()}.srt`;
    tmp.push(subtitlePath);
    fs.writeFileSync(subtitlePath, srt);

    /**
     * =========
     * STEP 3 — Render MP4 with FFmpeg
     * =========
     * Speed-focused flags:
     * -preset ultrafast
     * -crf 30 (smaller / faster)
     * -tune stillimage (best for static background)
     * -movflags +faststart (download/play sooner)
     * -threads 2 (match your Cloud Run CPU if 2 vCPU)
     */
    const backgroundImage = "./assets/radio_background.jpg";

    const outputPath = `/tmp/output-${Date.now()}.mp4`;
    tmp.push(outputPath);

    // In FAST_MODE we also trim the video render to the same duration (quick dev cycle)
    const renderAudioPath = FAST_MODE ? mp3ForGemini : mp3Path;

    const vf =
      "scale=1280:720," +
      `subtitles=${subtitlePath}:force_style=` +
      `'Fontsize=30,PrimaryColour=&H00FFFFFF&,OutlineColour=&H00000000&,BorderStyle=3,Outline=2,Shadow=1,MarginV=40'`;

    await new Promise((resolve, reject) => {
      const ffmpeg = spawn("ffmpeg", [
        "-y",
        "-loop",
        "1",
        "-i",
        backgroundImage,
        "-i",
        renderAudioPath,

        "-vf",
        vf,

        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-tune",
        "stillimage",
        "-crf",
        "30",
        "-pix_fmt",
        "yuv420p",
        "-threads",
        "2",

        "-c:a",
        "aac",
        "-b:a",
        "128k",

        "-shortest",
        "-movflags",
        "+faststart",

        outputPath,
      ]);

      ffmpeg.stderr.on("data", (data) => console.log(`ffmpeg: ${data.toString()}`));
      ffmpeg.on("error", reject);
      ffmpeg.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`FFmpeg exited with code ${code}`));
      });
    });

    console.log("FFmpeg completed");

    /**
     * =========
     * STEP 4 — Upload video to Supabase Storage
     * =========
     * NOTE: This reads file into memory. For very large files (longer than 20min),
     * you'll eventually want signed upload URLs or chunked upload.
     */
    const videoFileName = `video-${Date.now()}.mp4`;
    const videoBuffer = fs.readFileSync(outputPath);

    const { error: uploadError } = await supabase.storage
      .from("video-files")
      .upload(videoFileName, videoBuffer, {
        contentType: "video/mp4",
        upsert: true,
      });

    if (uploadError) {
      console.error("Upload error:", uploadError);
      return res.status(500).json({ error: "Storage upload failed" });
    }

    const { data } = supabase.storage.from("video-files").getPublicUrl(videoFileName);
    const publicUrl = data.publicUrl;

    /**
     * =========
     * STEP 5 — Update DB
     * =========
     * Only include columns that exist in your table schema.
     * If programs.keywords is NOT jsonb/text[], remove it here.
     */
    const updatePayload = {
      mp4_path: videoFileName,
      status: "completed",
      transcript,
      summary: summaryText,
      description: descriptionText,
      keywords: mergedKeywords,
    };

    const { error: dbError } = await supabase
      .from("programs")
      .update(updatePayload)
      .eq("id", programId);

    if (dbError) {
      console.error("DB update error:", dbError);
      return res.status(500).json({ error: "Database update failed" });
    }

    console.log("Supabase updated successfully");

    /**
     * =========
     * FINAL RESPONSE
     * =========
     */
    res.json({
      success: true,
      videoUrl: publicUrl,
      summary: summaryText,
      description: descriptionText,
      transcript,
      keywords: mergedKeywords,
      meta: {
        parsedOk,
        fastMode: FAST_MODE,
        geminiSeconds: FAST_MODE ? FAST_MODE_SECONDS : GEMINI_AUDIO_SECONDS,
        ms: nowMs() - startedAt,
      },
    });
  } catch (error) {
    console.error("Conversion error:", error);
    res.status(500).json({ error: "Conversion failed" });
  } finally {
    // Clean up temp files (Cloud Run /tmp is small)
    // Keep logs readable and avoid storage bloat between requests.
    // (If debugging, comment this out temporarily)
    // eslint-disable-next-line no-unused-vars
    // tmp.forEach(safeUnlink);
    try {
      // safer: only delete files that exist
      // (comment out if you want to inspect /tmp in debugging)
      // tmp.forEach(safeUnlink);

      // By default keep cleanup ON:
      tmp.forEach(safeUnlink);
    } catch (_) {}
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
