import express from "express";
import fs from "fs";
import fetch from "node-fetch";
import { exec } from "child_process";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());

const supabase = createClient(
  process.env.PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

app.post("/convert", async (req, res) => {
  try {
    const { programId, mp3_url, title } = req.body;

    const inputPath = `/tmp/input.mp3`;
    const outputPath = `/tmp/output.mp4`;

    const response = await fetch(mp3_url);
    const buffer = await response.arrayBuffer();
    fs.writeFileSync(inputPath, Buffer.from(buffer));

    const command = `
      ffmpeg -y -f lavfi -i color=c=black:s=1080x1920:d=60 \
      -i ${inputPath} \
      -shortest \
      -vf "drawtext=text='${title}':fontcolor=white:fontsize=60:x=(w-text_w)/2:y=900" \
      -c:v libx264 -c:a aac -pix_fmt yuv420p \
      ${outputPath}
    `;

    await new Promise((resolve, reject) => {
      exec(command, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });

    const videoBuffer = fs.readFileSync(outputPath);

    await supabase.storage
      .from("video-files")
      .upload(`video-${programId}.mp4`, videoBuffer, {
        contentType: "video/mp4",
        upsert: true
      });

    await supabase
      .from("programs")
      .update({
        mp4_path: `video-${programId}.mp4`,
        status: "completed"
      })
      .eq("id", programId);

    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Conversion failed" });
  }
});

app.listen(process.env.PORT || 8080);
