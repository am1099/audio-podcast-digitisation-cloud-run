import express from "express";
import fs from "fs";
import { spawn } from "child_process";
import { createClient } from "@supabase/supabase-js";
import cors from "cors";
import multer from "multer";
import { GoogleGenAI } from "@google/genai";

const app = express();

const genAI = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

const upload = multer({ dest: "/tmp" });

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// make sure preflight always succeeds
app.options("*", cors());

app.use(express.json());

const supabase = createClient(
  process.env.PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * Helpers
 */
function stripCodeFences(text = "") {
  // Removes ```json ... ``` or ``` ... ```
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

function isLikelySrt(s = "") {
  // quick sanity check
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

function splitTranscriptToCaptions(transcript, maxChars = 70) {
  // Split into sentence-ish chunks, then wrap to maxChars
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
    // soft wrap long sentences
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
  // Uses ffprobe to read duration; ffprobe usually ships with ffmpeg
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

function buildSrtProportional(transcript, durationSec) {
  // Build SRT by distributing times proportional to word counts across captions
  const captions = splitTranscriptToCaptions(transcript, 72);
  if (!captions.length) return "";

  const wordsPerCaption = captions.map((c) => c.split(/\s+/).filter(Boolean).length);
  const totalWords = wordsPerCaption.reduce((a, b) => a + b, 0) || captions.length;

  // If duration unknown, fallback to ~3s per caption
  const totalDuration = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : captions.length * 3;

  let t = 0;
  let idx = 1;
  let srt = "";

  for (let i = 0; i < captions.length; i++) {
    const w = wordsPerCaption[i] || 1;
    // Minimum 1.8s, maximum 6.0s per caption (keeps them readable)
    const raw = (w / totalWords) * totalDuration;
    const dur = Math.min(6.0, Math.max(1.8, raw));

    const start = t;
    const end = Math.min(totalDuration, t + dur);

    srt += `${idx}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${captions[i]}\n\n`;

    idx++;
    t = end;

    if (t >= totalDuration - 0.05) break;
  }

  return srt.trim() + "\n";
}

function safeUnlink(path) {
  try {
    fs.unlinkSync(path);
  } catch (_) {}
}

app.post("/convert", upload.single("audio"), async (req, res) => {
  const startedAt = Date.now();

  try {
    if (!req.file) {
      return res.status(400).json({ error: "No audio file uploaded" });
    }

    const keywords = JSON.parse(req.body.keywords || "[]");
    const programId = req.body.programId;

    if (!programId) {
      return res.status(400).json({ error: "Missing programId" });
    }

    const inputPath = req.file.path;
    const outputPath = `/tmp/output-${Date.now()}.mp4`;
    const subtitlePath = `/tmp/subtitles-${Date.now()}.srt`;
    const videoFileName = `video-${Date.now()}.mp4`;

    console.log("Audio received:", inputPath);

    /*
      STEP 1 — Send audio to Gemini (JSON only)
      We ASK for transcript + srt + summary + description + keywords.
      If Gemini doesn't produce valid JSON or SRT, we fallback to duration-based SRT.
    */
    const audioData = fs.readFileSync(inputPath).toString("base64");
    const mimeType = req.file.mimetype || "audio/mpeg";

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
                mimeType,
                data: audioData,
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

    // Try parse JSON (handle occasional code fences)
    const rawText = stripCodeFences(aiResponse?.text || "");
    let parsedOk = false;

    try {
      const aiData = JSON.parse(rawText);
      transcript = String(aiData.transcript || "").trim();
      summaryText = String(aiData.summary || "").trim();
      descriptionText = String(aiData.description || "").trim();
      aiKeywords = clampKeywords(aiData.keywords).slice(0, 10);
      srt = String(aiData.srt || "").trim();
      parsedOk = true;
    } catch (err) {
      parsedOk = false;
    }

    // Validate SRT; if missing/invalid, build a better fallback based on audio duration
    if (!transcript) {
      // If transcript missing, fallback to whatever Gemini returned as text
      transcript = rawText || "";
    }

    if (!isLikelySrt(srt)) {
      console.log("SRT invalid or missing; building fallback SRT from duration...");
      const durationSec = await ffprobeDurationSeconds(inputPath);
      srt = buildSrtProportional(transcript, durationSec);
    }

    // If summary/description missing, create minimal safe fallbacks (keeps UI from spinning)
    if (!summaryText) {
      summaryText = transcript
        ? transcript.split(/\s+/).slice(0, 35).join(" ") + "…"
        : "Summary unavailable.";
    }
    if (!descriptionText) {
      descriptionText =
        "🎙️ New broadcast clip\n\nGenerated from the uploaded radio audio.\n\n#radio #podcast";
    }

    // Merge keywords: AI keywords preferred, else use user-provided, and always de-dup
    const mergedKeywords = clampKeywords(
      (aiKeywords && aiKeywords.length ? aiKeywords : []).concat(keywords || [])
    ).slice(0, 25);

    console.log("Subtitles ready");

    fs.writeFileSync(subtitlePath, srt);

    /*
      STEP 2 — Background image
    */
    const backgroundImage = "./assets/radio_background.jpg";

    /*
      STEP 3 — FFmpeg render
      - We scale to 1280x720
      - Force even dimensions (libx264 requirement) by scaling to exact 1280x720
      - Burn subtitles with readable style
    */
    await new Promise((resolve, reject) => {
      const vf = [
        "scale=1280:720",
        // Burn subtitles
        `subtitles=${subtitlePath}:force_style=` +
          `'Fontsize=30,PrimaryColour=&H00FFFFFF&,OutlineColour=&H00000000&,BorderStyle=3,Outline=2,Shadow=1,MarginV=40'`,
      ].join(",");

      const ffmpeg = spawn("ffmpeg", [
        "-y",
        "-loop",
        "1",
        "-i",
        backgroundImage,
        "-i",
        inputPath,
        "-vf",
        vf,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
        outputPath,
      ]);

      ffmpeg.stderr.on("data", (data) => {
        // keep streaming logs (prevents maxBuffer crash)
        console.log(`ffmpeg: ${data.toString()}`);
      });

      ffmpeg.on("error", reject);

      ffmpeg.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`FFmpeg exited with code ${code}`));
      });
    });

    console.log("FFmpeg completed");

    /*
      STEP 4 — Upload video
    */
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

    /*
      STEP 5 — Update database
      (Include summary/description/keywords if your table has these columns)
    */
    const updatePayload = {
      mp4_path: videoFileName,
      status: "completed",
      transcript: transcript,
      summary: summaryText,
      description: descriptionText,
      keywords: mergedKeywords, // if column is jsonb/text[] this is OK
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

    /*
      Cleanup temp files (Cloud Run /tmp is limited)
    */
    safeUnlink(outputPath);
    safeUnlink(subtitlePath);
    safeUnlink(inputPath);

    /*
      FINAL RESPONSE (frontend expects these exact keys)
    */
    res.json({
      success: true,
      videoUrl: publicUrl,
      summary: summaryText,
      description: descriptionText,
      transcript: transcript,
      keywords: mergedKeywords,
      meta: {
        parsedOk,
        ms: Date.now() - startedAt,
      },
    });
  } catch (error) {
    console.error("Conversion error:", error);
    res.status(500).json({ error: "Conversion failed" });
  }
});

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
