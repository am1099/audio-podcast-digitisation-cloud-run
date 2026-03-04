import express from "express";
import fs from "fs";
import { exec } from "child_process";
import { createClient } from "@supabase/supabase-js";
import cors from "cors";
import multer from "multer";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const upload = multer({ dest: "/tmp" });

app.use(cors({
  origin: "*",
  methods: ["POST", "GET", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));

app.options("*", cors());

app.use(express.json());

const supabase = createClient(
  process.env.PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

app.post("/convert", upload.single("audio"), async (req, res) => {

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
    const videoFileName = `video-${Date.now()}.mp4`;

    console.log("Audio received:", inputPath);

    /*
    =========================
    STEP 1 — Transcription
    =========================
    */

    const transcriptionModel = genAI.getGenerativeModel({
      model: "gemini-1.5-flash"
    });

    const transcriptionPrompt = `
    Transcribe the following radio broadcast audio.
    Return plain text.
    `;

    const transcriptionResult = await transcriptionModel.generateContent([
      transcriptionPrompt,
      {
        inlineData: {
          mimeType: "audio/mp3",
          data: fs.readFileSync(inputPath).toString("base64")
        }
      }
    ]);

    const transcript = transcriptionResult.response.text();

    console.log("Transcript generated");

    /*
    =========================
    STEP 2 — Subtitle Generation
    =========================
    */

    const lines = transcript.split("\n");

    let srt = "";
    let index = 1;

    lines.forEach((line, i) => {

      const start = i * 4;
      const end = start + 4;

      const startTime = new Date(start * 1000).toISOString().substr(11, 8) + ",000";
      const endTime = new Date(end * 1000).toISOString().substr(11, 8) + ",000";

      srt += `${index}\n${startTime} --> ${endTime}\n${line}\n\n`;

      index++;

    });

    const subtitlePath = "/tmp/subtitles.srt";

    fs.writeFileSync(subtitlePath, srt);

    console.log("Subtitles generated");

    /*
    =========================
    STEP 3 — AI Background Prompt
    =========================
    */

    const imagePrompt = `
    Create a cinematic radio broadcast background.

    Topic keywords:
    ${keywords.join(", ")}

    Style:
    modern podcast studio
    dark cinematic lighting
    professional broadcast graphics
    resolution 1280x720
    `;

    console.log("Image prompt:", imagePrompt);

    /*
    NOTE:
    Gemini text models cannot generate images directly.
    For now we use a static background.
    Later we will plug Imagen here.
    */

    const backgroundImage = "/app/assets/radio_background.jpg";

    /*
    =========================
    STEP 4 — FFmpeg Rendering
    =========================
    */

    const command = `
    ffmpeg -y \
    -loop 1 -i "${backgroundImage}" \
    -i "${inputPath}" \
    -vf "subtitles=${subtitlePath}" \
    -c:v libx264 \
    -c:a aac \
    -shortest "${outputPath}"
    `;

    await new Promise((resolve, reject) => {

      exec(command, (error) => {

        if (error) reject(error);

        else resolve();

      });

    });

    console.log("FFmpeg completed");

    /*
    =========================
    STEP 5 — Upload Video
    =========================
    */

    const videoBuffer = fs.readFileSync(outputPath);

    const { error: uploadError } = await supabase.storage
      .from("video-files")
      .upload(videoFileName, videoBuffer, {
        contentType: "video/mp4",
        upsert: true
      });

    if (uploadError) {

      console.error("Upload error:", uploadError);

      return res.status(500).json({ error: "Storage upload failed" });

    }

    const { data } = supabase.storage
      .from("video-files")
      .getPublicUrl(videoFileName);

    const publicUrl = data.publicUrl;

    /*
    =========================
    STEP 6 — Update DB
    =========================
    */

    const { error: dbError } = await supabase
      .from("programs")
      .update({
        mp4_path: videoFileName,
        status: "completed",
        transcript: transcript
      })
      .eq("id", programId);

    if (dbError) {

      console.error("DB update error:", dbError);

      return res.status(500).json({ error: "Database update failed" });

    }

    console.log("Supabase updated successfully");

    /*
    =========================
    FINAL RESPONSE
    =========================
    */

    res.json({
      success: true,
      videoUrl: publicUrl,
      transcript: transcript
    });

  }

  catch (error) {

    console.error("Conversion error:", error);

    res.status(500).json({ error: "Conversion failed" });

  }

});

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {

  console.log(`Server running on port ${PORT}`);

});
