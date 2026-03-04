import express from "express";
import fs from "fs";
import fetch from "node-fetch";
import { exec } from "child_process";
import { createClient } from "@supabase/supabase-js";
import cors from "cors";
import multer from "multer";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

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

    const keywords = JSON.parse(req.body.keywords || "[]");

    const inputPath = req.file.path;
    const outputPath = `/tmp/output-${Date.now()}.mp4`;
    const videoFileName = `video-${Date.now()}.mp4`;
    
    console.log("Audio received:", inputPath);

    // Generate background image prompt
    const imagePrompt = `
    Create a cinematic background image for a radio broadcast.
    
    Topic keywords:
    ${keywords.join(", ")}
    
    Style: professional radio studio
    Resolution: 1280x720
    `;

    const imageModel = genAI.getGenerativeModel({
      model: "gemini-1.5-flash"
    });
    
    const imageResult = await imageModel.generateContent(imagePrompt);
    
    const imageData = imageResult.response.candidates[0].content.parts[0].inlineData.data;
    
    const backgroundImagePath = "/tmp/background.png";
    
    fs.writeFileSync(
      backgroundImagePath,
      Buffer.from(imageData, "base64")
    );
    
    console.log("Background image generated");
    // END

    // Google Gemini for transcription
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    const transcriptionPrompt = `
    Transcribe the following radio broadcast audio.
    Return plain text.
    `;
    
    const transcriptionResult = await model.generateContent([
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

    // End of transcription process

    // Subtitle conversion
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

    // END of Subtitle conversion

    // STEP 4 - bg image
    const backgroundImage = backgroundImagePath;

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

    const { programId } = req.body;

    if (!programId) {
      return res.status(400).json({ error: "Missing programId" });
    }

    // 🔹 Update DB
    const { error: dbError } = await supabase
      .from("programs")
      .update({
        mp4_path: videoFileName,
        status: "completed",
      })
      .eq("id", programId);

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
