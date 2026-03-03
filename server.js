import express from "express";
import fs from "fs";
import fetch from "node-fetch";
import { exec } from "child_process";
import { createClient } from "@supabase/supabase-js";
import cors from "cors";
import multer from "multer";

const app = express();

const upload = multer({
  dest: "/tmp",
});

app.use(cors({
  origin: "*", // for now, allow all
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

    const { programId } = req.body;

    if (!programId) {
      return res.status(400).json({ error: "Missing programId" });
    }

    const inputPath = req.file.path;
    const outputPath = `/tmp/output-${Date.now()}.mp4`;
    const videoFileName = `video-${programId}.mp4`;

    console.log("Audio received:", inputPath);

    const command = `ffmpeg -y -i "${inputPath}" -c:v libx264 -c:a aac "${outputPath}"`;

    await new Promise((resolve, reject) => {
      exec(command, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });

    console.log("FFmpeg completed");

    // 🔹 Read generated video
    const videoBuffer = fs.readFileSync(outputPath);

    // 🔹 Upload to Supabase Storage
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

    // 🔹 Get public URL
    const { data: publicUrlData } = supabase.storage
      .from("video-files")
      .getPublicUrl(videoFileName);

    const publicUrl = publicUrlData.publicUrl;

    // 🔹 Update DB
    const { error: dbError } = await supabase
      .from("programs")
      .insert({
        mp4_path: videoFileName,
        status: "completed",
      });

if (dbError) {
  console.error("DB insert error:", dbError);
  return res.status(500).json({ error: "Database insert failed" });
}

    if (dbError) {
      console.error("DB update error:", dbError);
      return res.status(500).json({ error: "Database update failed" });
    }

    console.log("Supabase updated successfully");

    res.json({
      success: true,
      videoUrl: publicUrl,
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
