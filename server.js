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
 */

const FAST_MODE = String(process.env.FAST_MODE || "false").toLowerCase() === "true";
const FAST_MODE_SECONDS = Number(process.env.FAST_MODE_SECONDS || 180);
const GEMINI_AUDIO_SECONDS = Number(process.env.GEMINI_AUDIO_SECONDS || 600);

const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const upload = multer({
  dest: "/tmp",
  limits: { fileSize: 250 * 1024 * 1024 },
});

app.use(cors({ origin: "*" }));
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

function safeUnlink(p) {
  try { fs.unlinkSync(p); } catch {}
}

function stripCodeFences(text = "") {
  return String(text)
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

function extractFirstJsonObject(text = "") {
  const s = String(text);
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  return s.slice(start, end + 1);
}

function clampKeywords(arr) {
  if (!Array.isArray(arr)) return [];
  return [...new Set(arr.map(x => String(x).trim()).filter(Boolean))].slice(0, 15);
}

function formatSrtTime(sec) {
  const ms = Math.floor((sec % 1) * 1000);
  const s = Math.floor(sec) % 60;
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")},${String(ms).padStart(3,"0")}`;
}

function splitTranscriptToCaptions(text) {
  return text.split(/[.!?]/).map(s => s.trim()).filter(Boolean);
}

function buildSrtProportional(transcript, duration) {
  const lines = splitTranscriptToCaptions(transcript);
  if (!lines.length) return "";

  const step = duration / lines.length;
  let t = 0, i = 1, srt = "";

  for (const line of lines) {
    const start = t;
    const end = t + step;
    srt += `${i++}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${line}\n\n`;
    t = end;
  }

  return srt;
}

async function ffprobeDurationSeconds(inputPath) {
  return new Promise(resolve => {
    const p = spawn("ffprobe", ["-v","error","-show_entries","format=duration","-of","default=nw=1:nk=1",inputPath]);
    let out = "";
    p.stdout.on("data", d => out += d);
    p.on("close", () => resolve(parseFloat(out) || 0));
  });
}

async function runFfmpeg(args, label = "ffmpeg") {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", args);
    p.stderr.on("data", d => console.log(`${label}: ${d.toString()}`));
    p.on("close", c => c === 0 ? resolve() : reject());
  });
}

/**
 * =========
 * Gemini Safe Call (FIXED)
 * =========
 */
async function callGeminiSafe(payload) {
  try {
    return await genAI.models.generateContent(payload);
  } catch (err) {
    console.error("Gemini failed:", err);
    return null;
  }
}

/**
 * =========
 * MAIN ROUTE
 * =========
 */
app.post("/convert", upload.single("audio"), async (req, res) => {

  const tmp = [];

  try {

    if (!req.file) {
      return res.status(400).json({ error: "No audio file uploaded" });
    }

    const inputPath = req.file.path;
    tmp.push(inputPath);

    console.log("Audio received:", inputPath);

    /**
     * =========
     * STEP A — Transcode to MP3
     * =========
     */
    const mp3Path = `/tmp/audio-${Date.now()}.mp3`;
    tmp.push(mp3Path);

    await runFfmpeg([
      "-y",
      "-i", inputPath,
      "-vn",
      "-ac", "2",
      "-ar", "44100",
      "-b:a", "128k",
      mp3Path
    ], "ffmpeg(transcode)");

    /**
     * =========
     * STEP 1 — Gemini (SAFE)
     * =========
     */
    const audioBase64 = fs.readFileSync(mp3Path).toString("base64");

    const aiResponse = await callGeminiSafe({
      model: "gemini-2.5-flash",
      contents: [{
        role: "user",
        parts: [
          {
            text: `
Return ONLY JSON:
{
  "transcript": "...",
  "summary": "...",
  "description": "...",
  "keywords": []
}
            `
          },
          {
            inlineData: {
              mimeType: "audio/mp3",
              data: audioBase64
            }
          }
        ]
      }]
    });

    let transcript = "";
    let summaryText = "";
    let descriptionText = "";
    let keywords = [];
    let parsedOk = false;

    if (aiResponse) {

      const rawText = stripCodeFences(aiResponse.text);

      try {
        const parsed = JSON.parse(extractFirstJsonObject(rawText) || rawText);

        transcript = parsed.transcript || "";
        summaryText = parsed.summary || "";
        descriptionText = parsed.description || "";
        keywords = clampKeywords(parsed.keywords);

        parsedOk = true;

      } catch (err) {
        console.error("JSON parse failed:", err);
        transcript = "Transcript unavailable.";
      }

    } else {
      console.log("Gemini failed — fallback used");
      transcript = "Transcript unavailable.";
      summaryText = "Summary unavailable.";
      descriptionText = "Generated video.";
    }

    /**
     * =========
     * STEP 2 — Subtitles (FORCED FIX)
     * =========
     */
    const duration = await ffprobeDurationSeconds(mp3Path);
    let srt = buildSrtProportional(transcript, duration);

    // remove emoji glyphs
    srt = srt.replace(/[^\u0000-\uFFFF]/g, "");

    const subtitlePath = `/tmp/sub-${Date.now()}.srt`;
    fs.writeFileSync(subtitlePath, srt);
    tmp.push(subtitlePath);

    /**
     * =========
     * STEP 3 — FFmpeg render
     * =========
     */
    const outputPath = `/tmp/out-${Date.now()}.mp4`;
    tmp.push(outputPath);

    await runFfmpeg([
      "-y",
      "-loop","1",
      "-i","./assets/radio_background.jpg",
      "-i", mp3Path,
      "-vf", `subtitles=${subtitlePath}`,
      "-c:v","libx264",
      "-preset","ultrafast",
      "-tune","stillimage",
      "-crf","30",
      "-c:a","aac",
      "-shortest",
      outputPath
    ]);

    console.log("FFmpeg completed");

    /**
     * =========
     * STEP 4 — Upload (STREAM FIX)
     * =========
     */
    const fileName = `video-${Date.now()}.mp4`;

    const stream = fs.createReadStream(outputPath);

    const { error } = await supabase.storage
      .from("video-files")
      .upload(fileName, stream, {
        contentType: "video/mp4",
        upsert: true
      });

    if (error) {
      console.error("Upload error:", error);
      return res.status(500).json({ error: "Upload failed" });
    }

    const { data } = supabase.storage
      .from("video-files")
      .getPublicUrl(fileName);

    /**
     * =========
     * FINAL RESPONSE
     * =========
     */
    res.json({
      success: true,
      videoUrl: data.publicUrl,
      transcript: transcript || "",
      summary: summaryText || "",
      description: descriptionText || "",
      keywords
    });

  } catch (err) {
    console.error("Conversion error:", err);
    res.status(500).json({ error: "Conversion failed" });
  } finally {
    tmp.forEach(safeUnlink);
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
