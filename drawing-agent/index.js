import OpenAI from "openai";
import fetch from "node-fetch";

// -----------------------------
// ENVIRONMENT
// -----------------------------
const ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT;
const API_KEY = process.env.AZURE_OPENAI_API_KEY;

const MODEL_MINI = process.env.AZURE_MODEL_MINI || "gpt-4o-mini";
const MODEL_MAIN = process.env.AZURE_MODEL_MAIN || "gpt-4o";
const MODEL_PREMIUM = process.env.AZURE_MODEL_PREMIUM || "gpt-4.1";

// Azure OpenAI Client
const client = new OpenAI({
  apiKey: process.env.AZURE_OPENAI_API_KEY,
  baseURL: `${process.env.AZURE_OPENAI_ENDPOINT}/openai/deployments`,
  defaultQuery: { "api-version": "2024-10-01-preview" }
});

// ------------------------------
// HELPERS
// ------------------------------
function base64ToBuffer(b64) {
  return Buffer.from(b64, "base64");
}

function looksLikeStep(filename, mimetype) {
  if (!filename) return false;
  const lower = filename.toLowerCase();
  return lower.endsWith(".stp") || lower.endsWith(".step") || (mimetype && mimetype.includes("step"));
}

function extractNameFromFilename(filename) {
  if (!filename) return null;
  return filename.replace(/\.[^.]+$/, ""); // remove extension
}

// ------------------------------
// MODEL SELECTION LOGIC
// ------------------------------
async function callModel(model, prompt, imageBuffer) {
  const result = await client.chat.completions.create({
    model: model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          imageBuffer
            ? { type: "input_image", url: "data:application/octet-stream;base64," + imageBuffer.toString("base64") }
            : undefined
        ].filter(Boolean)
      }
    ],
    max_tokens: 2000,
    temperature: 0.0
  });

  return result.choices[0].message?.content || "";
}

function evaluateQuality(visionText) {
  // crude heuristics for fallback decision
  let score = 0;

  if (visionText.length > 800) score += 1;
  if (visionText.includes("TOL") || visionText.includes("Tolerance")) score += 1;
  if (visionText.includes("±")) score += 1;
  if (visionText.match(/[0-9]+\s*mm/)) score += 1;
  if (visionText.includes("M6") || visionText.includes("Ø")) score += 1;

  return score; // 0–5
}

// ------------------------------
// MAIN DRAWING NAME EXTRACTOR
// ------------------------------
function extractDrawingName(visionText, filenameFallback) {
  // Try regex part numbers
  const regex = /^[A-Z0-9\-_]{5,}$/m;
  const match = visionText.match(regex);

  if (match) return match[0].trim();
  if (filenameFallback) return filenameFallback;

  // fallback
  return "Unknown Drawing";
}

// ------------------------------
// MAIN FUNCTION
// ------------------------------
export default async function (context, req) {
  try {
    const file = req.body?.file;
    const country = req.body?.country || null;
    const qty = req.body?.quantity || null;

    if (!file || !file.content) {
      return (context.res = {
        status: 400,
        body: { error: "No file provided." }
      });
    }

    const filename = file.name || "unknown.pdf";
    const mimetype = file.mimeType || "application/pdf";
    const buffer = base64ToBuffer(file.content);

    // STEP file? → Auto switch to premium
    const isSTEP = looksLikeStep(filename, mimetype);

    // 1) Run MINIMAL cost model (GPT‑4o‑mini)
    const promptMini = `
You are a mechanical engineering drawing OCR system.
Extract ALL readable text from this file (PDF or STEP).
DO NOT summarize. Return full OCR text.
`;

    let textMini = await callModel(MODEL_MINI, promptMini, buffer);

    // quality scoring
    const quality = evaluateQuality(textMini);

    let finalText = textMini;
    let usedModel = MODEL_MINI;

    // 2) If STEP geometry or poor OCR → fallback to GPT‑4o
    if (isSTEP || quality <= 1) {
      const promptMain = `
You are a mechanical engineering drawing intelligence system.
Perform a deep reading of the document:
- Extract full OCR text
- Extract all dimensions, tolerances
- Extract all manufacturing hints
- Identify shapes (holes, chamfers, fillets)
- Reconstruct any missing notes if possible
`;

      finalText = await callModel(MODEL_MAIN, promptMain, buffer);
      usedModel = MODEL_MAIN;
    }

    // 3) If still poor or need 3D inference → fallback to GPT‑4.1
    const finalQuality = evaluateQuality(finalText);
    const need3D = finalText.includes("3D") || finalText.includes("STEP") || isSTEP;

    if (finalQuality <= 1 || need3D) {
      const promptPremium = `
You are an expert mechanical engineering + CAD reasoning system.
Perform deep analysis:
- OCR every detail
- Infer 3D geometry
- Reconstruct missing surfaces & volumes
- Identify real manufacturing process (e.g., extrusion vs machining vs casting vs stamping).
Return raw extracted text ONLY. No summary.
`;
      finalText = await callModel(MODEL_PREMIUM, promptPremium, buffer);
      usedModel = MODEL_PREMIUM;
    }

    // Extract drawing name
    const filenameName = extractNameFromFilename(filename);
    const drawingName = extractDrawingName(finalText, filenameName);

    // Build response
    const response = {
      DrawingName: drawingName,
      Material: "PLACEHOLDER",
      NetVolume: "0",
      SurfaceArea: "0",
      Tolerance: "",
      PrimaryProcessKey: "",
      ProcessKeys: [],
      RawText: finalText,
      ModelUsed: usedModel,
      Country: country,
      Quantity: qty
    };

    context.res = {
      status: 200,
      body: response
    };
  } catch (err) {
    context.log("ERROR in DrawingAgent:", err);
    context.res = {
      status: 500,
      body: { error: err.message }
    };
  }
}
