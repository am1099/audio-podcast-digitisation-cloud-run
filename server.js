import express from "express";
import fs from "fs";
import { spawn } from "child_process";
import { createClient } from "@supabase/supabase-js";
import cors from "cors";
import multer from "multer";
import { GoogleGenAI } from "@google/genai";

const app = express();

const genAI = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

const upload = multer({ dest: "/tmp" });

app.use(cors({
  origin: "*",
  methods: ["GET","POST","PUT","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization"]
}));

app.use(express.json());

const supabase = createClient(
  process.env.PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

app.post("/convert", upload.single("audio"), async (req,res)=>{

try {

if(!req.file){
return res.status(400).json({error:"No audio file uploaded"});
}

const keywords = JSON.parse(req.body.keywords || "[]");
const programId = req.body.programId;

if(!programId){
return res.status(400).json({error:"Missing programId"});
}

const inputPath = req.file.path;
const outputPath = `/tmp/output-${Date.now()}.mp4`;
const videoFileName = `video-${Date.now()}.mp4`;

console.log("Audio received:",inputPath);

/*
STEP 1 — Send audio to Gemini
*/

const audioData = fs.readFileSync(inputPath).toString("base64");

const aiResponse = await genAI.models.generateContent({
model:"gemini-2.5-flash",
contents:[
{
role:"user",
parts:[
{
text:`
You are processing a radio broadcast.

1. Transcribe the audio.
2. Generate SRT subtitles with correct timing.
3. Write a short summary.
4. Write a YouTube style description.
5. Extract 10 SEO keywords.

Return ONLY JSON:

{
"transcript":"...",
"srt":"...",
"summary":"...",
"description":"...",
"keywords":["..."]
}
`
},
{
inlineData:{
mimeType:"audio/mp3",
data:audioData
}
}
]
}
]
});

console.log("Gemini response received");

let transcript="";
let summaryText="";
let descriptionText="";
let aiKeywords=[];
let srt="";

try{

const aiData = JSON.parse(aiResponse.text);

transcript = aiData.transcript || "";
summaryText = aiData.summary || "";
descriptionText = aiData.description || "";
aiKeywords = aiData.keywords || [];
srt = aiData.srt || "";

}catch(err){

console.log("AI JSON parsing failed, fallback subtitles");

transcript = aiResponse.text;

/* fallback subtitle generator */

const sentences = transcript
.replace(/\n/g," ")
.split(/[.!?]/)
.filter(Boolean);

let index=1;

sentences.forEach((sentence,i)=>{

const start=i*3;
const end=start+3;

const startTime=new Date(start*1000).toISOString().substr(11,8)+",000";
const endTime=new Date(end*1000).toISOString().substr(11,8)+",000";

srt+=`${index}\n${startTime} --> ${endTime}\n${sentence.trim()}\n\n`;

index++;

});

}

console.log("Subtitles ready");

const subtitlePath="/tmp/subtitles.srt";
fs.writeFileSync(subtitlePath,srt);

/*
STEP 2 — Background image
*/

const backgroundImage="./assets/radio_background.jpg";

/*
STEP 3 — FFmpeg render
*/

await new Promise((resolve,reject)=>{

const ffmpeg=spawn("ffmpeg",[
"-y",
"-loop","1",
"-i",backgroundImage,
"-i",inputPath,
"-vf",`scale=1280:720,subtitles=${subtitlePath}:force_style='Fontsize=26,PrimaryColour=&Hffffff&,OutlineColour=&H000000&,BorderStyle=3'`,
"-c:v","libx264",
"-preset","veryfast",
"-c:a","aac",
"-shortest",
outputPath
]);

ffmpeg.stderr.on("data",(data)=>{
console.log(`ffmpeg: ${data}`);
});

ffmpeg.on("close",(code)=>{
if(code===0) resolve();
else reject(new Error(`FFmpeg exited with code ${code}`));
});

});

console.log("FFmpeg completed");

/*
STEP 4 — Upload video
*/

const videoBuffer=fs.readFileSync(outputPath);

const {error:uploadError}=await supabase.storage
.from("video-files")
.upload(videoFileName,videoBuffer,{
contentType:"video/mp4",
upsert:true
});

if(uploadError){
console.error("Upload error:",uploadError);
return res.status(500).json({error:"Storage upload failed"});
}

const {data}=supabase.storage
.from("video-files")
.getPublicUrl(videoFileName);

const publicUrl=data.publicUrl;

/*
STEP 5 — Update database
*/

const {error:dbError}=await supabase
.from("programs")
.update({
mp4_path:videoFileName,
status:"completed",
transcript:transcript
})
.eq("id",programId);

if(dbError){
console.error("DB update error:",dbError);
return res.status(500).json({error:"Database update failed"});
}

console.log("Supabase updated successfully");

/*
FINAL RESPONSE
*/

res.json({
success:true,
videoUrl:publicUrl,
summary:summaryText,
description:descriptionText,
transcript:transcript,
keywords:aiKeywords.length?aiKeywords:keywords
});

}

catch(error){

console.error("Conversion error:",error);

res.status(500).json({error:"Conversion failed"});

}

});

const PORT=process.env.PORT||8080;

app.listen(PORT,()=>{
console.log(`Server running on port ${PORT}`);
});
