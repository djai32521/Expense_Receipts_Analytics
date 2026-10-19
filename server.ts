import dotenv from "dotenv";
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  GoogleGenAI,
  ThinkingLevel,
  Type,
  type GenerateContentParameters,
} from "@google/genai";
import { createServer as createViteServer } from "vite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: [path.join(__dirname, ".env.local"), path.join(__dirname, ".env")] });

export const MODEL_ID = process.env.GEMINI_MODEL || "gemini-4-argon";
const FALLBACK_MODELS = ["gemini-3.8-flash"];
let activeModelId: string = MODEL_ID;
const unavailableModels = new Set<string>();
const LOG_FILE = "/tmp/shoebox.log";

function logEvent(message: string, meta?: Record<string, unknown>) {
  const line = `[${new Date().toISOString()}] ${message}${
    meta ? " " + JSON.stringify(meta) : ""
  }\n`;
  process.stdout.write(line);
  try {
    fs.appendFileSync(LOG_FILE, line, "utf8");
  } catch {
    // ignore file logging errors
  }
}

function parseJsonSafely<T>(rawText: string | undefined, fallback: T): T {
  if (!rawText) return fallback;
  let cleaned = rawText.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1)) as T;
      } catch {
        return fallback;
      }
    }
    return fallback;
  }
}

const PLACEHOLDER_API_KEYS = new Set([
  "",
  "MY_GEMINI_API_KEY",
  "PLACEHOLDER_API_KEY",
  "YOUR_GEMINI_API_KEY",
  "YOUR_API_KEY",
  "TODO",
  "undefined",
  "null",
]);

function isValidApiKey(val: unknown): val is string {
  if (typeof val !== "string") return false;
  const trimmed = val.trim();
  return trimmed.length > 0 && !PLACEHOLDER_API_KEYS.has(trimmed);
}

function readDevEnvJson(): Record<string, unknown> {
  const candidates = [
    path.join(process.cwd(), ".dev.env.json"),
    "/tmp/.dev.env.json",
  ];
  for (const filePath of candidates) {
    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          return parsed as Record<string, unknown>;
        }
      }
    } catch {
      // ignore unreadable or malformed .dev.env.json
    }
  }
  return {};
}

function resolveApiKey(): string | undefined {
  for (const candidate of [process.env.GEMINI_API_KEY, process.env.API_KEY]) {
    if (isValidApiKey(candidate)) {
      return candidate.trim();
    }
  }

  const devEnv = readDevEnvJson();
  for (const candidate of [devEnv.GEMINI_API_KEY, devEnv.API_KEY]) {
    if (isValidApiKey(candidate)) {
      return candidate.trim();
    }
  }

  return undefined;
}

let cachedClient: GoogleGenAI | null = null;
let cachedClientKey: string | undefined = undefined;

function getGenAIClient(): GoogleGenAI {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY environment variable is missing or set to a placeholder value."
    );
  }
  if (cachedClient && cachedClientKey === apiKey) {
    return cachedClient;
  }
  cachedClient = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
  cachedClientKey = apiKey;
  return cachedClient;
}

async function generateWithModelFallback(
  params: Omit<GenerateContentParameters, "model">
): Promise<{
  response: Awaited<ReturnType<GoogleGenAI["models"]["generateContent"]>>;
  modelUsed: string;
}> {
  const ai = getGenAIClient();
  const allOrdered = [
    activeModelId,
    ...FALLBACK_MODELS.filter((m) => m !== activeModelId),
  ];
  const candidates = allOrdered.filter((m) => !unavailableModels.has(m));
  const pool = candidates.length > 0 ? candidates : allOrdered;

  let lastErr: unknown = null;
  for (const candidateModel of pool) {
    try {
      const response = await ai.models.generateContent({
        ...params,
        model: candidateModel,
      });
      activeModelId = candidateModel;
      return { response, modelUsed: candidateModel };
    } catch (err: unknown) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes("404") ||
        msg.includes("not found") ||
        msg.includes("NOT_FOUND") ||
        msg.includes("not supported") ||
        msg.includes("invalid argument")
      ) {
        unavailableModels.add(candidateModel);
        const nextFallback = FALLBACK_MODELS.find(
          (m) => !unavailableModels.has(m)
        );
        if (nextFallback) {
          activeModelId = nextFallback;
        }
        logEvent(
          `Model ${candidateModel} unavailable (${msg}), falling back...`
        );
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

const READ_SYSTEM_INSTRUCTION = `You are a careful, meticulous bookkeeper examining photos of physical receipts and business invoices. Your job is to find every receipt in every photo, box each one accurately, and extract its printed and handwritten values.

What to look for and catch that a basic scanner misses:
- Several receipts per photo: Box each physical receipt separately using box_2d = [ymin, xmin, ymax, xmax] normalised 0–1000 relative to the photo, even when receipts overlap or are tilted.
- Which number is the total: Find the true total charged, NOT the subtotal, NOT "cash tendered", and NOT "change". When there is no handwritten tip, set both printed_total and final_total to the same true total charged.
- Handwritten tips on card slips that change the printed total: Return printed_total, handwritten_tip, and final_total separately. If there is a handwritten tip that changes the total, add a flag with type "tip_changes_total". If there is no handwritten tip on the receipt, simply return null for handwritten_tip with NO flag.
- Foreign currency: Read the ISO 3-letter currency code (e.g., USD, GBP, EUR, NZD, AUD, JPY, CAD) from currency symbols, words, tax labels, or shop address. Never convert currencies.
- Tax lines (VAT, GST, consumption tax): Read the tax amount and tax_label (e.g. "VAT 20%", "GST 15%"). If a tax line is visibly printed on the receipt but blurred/unreadable, return null for tax, lower tax confidence, and add a flag with type "unreadable_field" and note "tax unreadable". If the receipt simply has no tax line, return null for tax and tax_label with NO flag.
- B2B Tax & Invoice compliance fields:
  - tax_id_or_vat: Extract the merchant's VAT, GST, EIN, or ABN tax registration ID if printed on the receipt (e.g. "GB 123 4567 89", "GST 12-345-678"), or null if not printed.
  - is_tax_invoice: Set to true if the receipt shows an itemized tax/VAT line, a merchant tax registration number, or a formal "TAX INVOICE" header; set to false if it is only a summary card terminal slip or receipt without tax details.
- Faded, creased, stained, or cut-off text: Only add an "unreadable_field" or "low_confidence" flag when a core printed field (merchant, date, total, or a visibly present tax/tip line) is damaged, blurry, or cut off. Do NOT add flags for optional fields (like handwritten_tip, time, item_count, card_last4, or tax_id_or_vat) that are simply not printed on the receipt.
- Time and item count: Read "time" (as HH:MM:SS or HH:MM as printed, or null if not printed) and "item_count" (explicit printed item count or count of printed line items on the receipt, or null if not printed or unreadable). Never guess either field.

Strict rules:
1. Return one entry per physical receipt, even if the same receipt appears in two photos (a separate duplicate pass handles that).
2. Every total, tax, and tip must be read directly from the receipt. Never compute or estimate a missing monetary value; return null and a flag.
3. Categories must come strictly from this fixed list: "Meals", "Travel", "Lodging", "Office", "Other".
4. Never give advice on what is tax-deductible, allowable, or claimable.
5. Date should be formatted as YYYY-MM-DD when possible, or as printed if partial, or null if unreadable.`;

const READ_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    receipts: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          photo_index: {
            type: Type.NUMBER,
            description: "The 1-based global photo index passed in the prompt.",
          },
          box_2d: {
            type: Type.ARRAY,
            items: { type: Type.NUMBER },
            description: "Bounding box [ymin, xmin, ymax, xmax] normalised 0 to 1000.",
          },
          merchant: {
            type: Type.STRING,
            nullable: true,
            description: "Merchant or shop name as printed on the receipt, or null if unreadable.",
          },
          date: {
            type: Type.STRING,
            nullable: true,
            description: "Receipt date in YYYY-MM-DD format if possible, or null if unreadable.",
          },
          time: {
            type: Type.STRING,
            nullable: true,
            description: "Time printed on receipt (e.g. '09:34:12' or '09:34'), or null if not present.",
          },
          item_count: {
            type: Type.NUMBER,
            nullable: true,
            description: "Number of items read from the receipt, or null if not present.",
          },
          printed_total: {
            type: Type.NUMBER,
            nullable: true,
            description: "Printed total before handwritten tip, or null if unreadable.",
          },
          handwritten_tip: {
            type: Type.NUMBER,
            nullable: true,
            description: "Handwritten tip or gratuity amount if present, otherwise null.",
          },
          final_total: {
            type: Type.NUMBER,
            nullable: true,
            description: "Final total written or printed on the receipt, or null if unreadable.",
          },
          currency: {
            type: Type.STRING,
            nullable: true,
            description: "3-letter currency code read from symbols, words, or address (e.g. USD, GBP, JPY, NZD, EUR).",
          },
          tax: {
            type: Type.NUMBER,
            nullable: true,
            description: "Tax amount printed on the receipt, or null if not shown or unreadable.",
          },
          tax_label: {
            type: Type.STRING,
            nullable: true,
            description: "Tax label printed on the receipt (e.g. 'VAT 20%', 'GST'), or null.",
          },
          tax_id_or_vat: {
            type: Type.STRING,
            nullable: true,
            description: "Merchant VAT, GST, EIN, or ABN tax registration ID if printed on the receipt, or null.",
          },
          is_tax_invoice: {
            type: Type.BOOLEAN,
            nullable: true,
            description: "True if the receipt shows an itemized tax/VAT line, tax registration number, or formal TAX INVOICE header; false if only a card slip or receipt without tax details.",
          },
          category: {
            type: Type.STRING,
            description: "Fixed category: Meals, Travel, Lodging, Office, or Other.",
          },
          card_last4: {
            type: Type.STRING,
            nullable: true,
            description: "Last 4 digits of payment card if shown (e.g. '0000'), or null.",
          },
          confidence: {
            type: Type.OBJECT,
            properties: {
              merchant: { type: Type.NUMBER },
              date: { type: Type.NUMBER },
              printed_total: { type: Type.NUMBER },
              handwritten_tip: { type: Type.NUMBER },
              currency: { type: Type.NUMBER },
              tax: { type: Type.NUMBER },
            },
            required: ["merchant", "date", "printed_total", "handwritten_tip", "currency", "tax"],
          },
          flags: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                type: {
                  type: Type.STRING,
                  description: "One of: tip_changes_total, unreadable_field, foreign_currency, possible_duplicate, low_confidence, not_a_receipt",
                },
                note: {
                  type: Type.STRING,
                  description: "Short human-readable explanation of the flag.",
                },
              },
              required: ["type", "note"],
            },
          },
        },
        required: [
          "photo_index",
          "box_2d",
          "merchant",
          "date",
          "time",
          "item_count",
          "printed_total",
          "handwritten_tip",
          "final_total",
          "currency",
          "tax",
          "tax_label",
          "tax_id_or_vat",
          "is_tax_invoice",
          "category",
          "card_last4",
          "confidence",
          "flags",
        ],
      },
    },
  },
  required: ["receipts"],
};

const DUPLICATES_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    duplicates: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          row: {
            type: Type.NUMBER,
            description: "The later 1-based row number that is a likely duplicate.",
          },
          duplicate_of: {
            type: Type.NUMBER,
            description: "The earlier 1-based row number that this row duplicates.",
          },
          reason: {
            type: Type.STRING,
            description: "Clear explanation, e.g. 'Same merchant, date, total and card; photographed twice' or 'Cross-source duplicate between Google Drive and Gmail'.",
          },
        },
        required: ["row", "duplicate_of", "reason"],
      },
    },
  },
  required: ["duplicates"],
};

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS || "https://djai32521.github.io").split(",").map((value) => value.trim()).filter(Boolean));
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }
    if (req.method === "OPTIONS") {
      res.sendStatus(origin && !allowedOrigins.has(origin) ? 403 : 204);
      return;
    }
    next();
  });

  // Support batches up to 20MB inline payload
  app.use(express.json({ limit: "25mb" }));

  app.get("/api/workspace-config", (_req, res) => {
    const devEnv = readDevEnvJson();
    let firebaseConfig: Record<string, unknown> | null = null;
    const configCandidates = [
      path.join(process.cwd(), "firebase-applet-config.json"),
      path.join(__dirname, "firebase-applet-config.json"),
    ];
    for (const candidatePath of configCandidates) {
      try {
        if (fs.existsSync(candidatePath)) {
          const parsed = JSON.parse(fs.readFileSync(candidatePath, "utf8"));
          if (parsed && typeof parsed === "object") {
            const apiKey =
              typeof parsed.apiKey === "string" ? parsed.apiKey.trim() : "";
            const authDomain =
              typeof parsed.authDomain === "string"
                ? parsed.authDomain.trim()
                : "";
            const projectId =
              typeof parsed.projectId === "string"
                ? parsed.projectId.trim()
                : "";
            const isValidFb =
              apiKey.length > 0 &&
              !PLACEHOLDER_API_KEYS.has(apiKey) &&
              !apiKey.includes("remixed-") &&
              authDomain.length > 0 &&
              !authDomain.includes("remixed-") &&
              !projectId.includes("remixed-");
            if (isValidFb) {
              firebaseConfig = parsed as Record<string, unknown>;
              break;
            }
          }
        }
      } catch {
        // ignore unreadable firebase-applet-config.json
      }
    }

    const rawFbClientId =
      (typeof firebaseConfig?.oAuthClientId === "string"
        ? firebaseConfig.oAuthClientId.trim()
        : null) ||
      (typeof firebaseConfig?.oauthClientId === "string"
        ? firebaseConfig.oauthClientId.trim()
        : null);
    const fbClientId =
      rawFbClientId &&
      !PLACEHOLDER_API_KEYS.has(rawFbClientId) &&
      !rawFbClientId.includes("remixed-")
        ? rawFbClientId
        : null;

    const rawId =
      process.env.GOOGLE_CLIENT_ID ||
      process.env.VITE_GOOGLE_CLIENT_ID ||
      (typeof devEnv.GOOGLE_CLIENT_ID === "string"
        ? devEnv.GOOGLE_CLIENT_ID
        : null) ||
      (typeof devEnv.VITE_GOOGLE_CLIENT_ID === "string"
        ? devEnv.VITE_GOOGLE_CLIENT_ID
        : null) ||
      fbClientId;

    const cleanId =
      rawId &&
      !PLACEHOLDER_API_KEYS.has(rawId.trim()) &&
      !rawId.trim().includes("remixed-")
        ? rawId.trim()
        : null;

    res.json({
      firebaseConfig,
      googleClientId: cleanId,
    });
  });

  app.get("/api/logs", (_req, res) => {
    try {
      const content = fs.existsSync(LOG_FILE)
        ? fs.readFileSync(LOG_FILE, "utf8")
        : "No logs yet.";
      res.type("text/plain").send(content);
    } catch (e) {
      res.status(500).send(String(e));
    }
  });

  app.post("/api/read-receipts", async (req, res) => {
    const startTime = Date.now();
    try {
      const { photos } = req.body as {
        photos: Array<{
          globalIndex: number;
          totalPhotos: number;
          mimeType: string;
          base64Data: string;
        }>;
      };

      if (!photos || !Array.isArray(photos) || photos.length === 0) {
        res.status(400).json({ error: "No photos provided in batch." });
        return;
      }

      const indices = photos.map((p) => p.globalIndex);
      const totalKB = Math.round(
        photos.reduce((acc, p) => acc + (p.base64Data?.length || 0) * 0.75, 0) /
          1024
      );
      logEvent("START /api/read-receipts", {
        model: activeModelId,
        photoIndices: indices,
        totalKB,
      });

      const parts: Array<
        { text: string } | { inlineData: { mimeType: string; data: string } }
      > = [];

      const indexDescriptions = photos
        .map(
          (p, i) =>
            `Image ${i + 1} in this request is Photo ${p.globalIndex} of ${p.totalPhotos} (set photo_index = ${p.globalIndex}).`
        )
        .join("\n");

      parts.push({
        text: `Examine the following ${photos.length} photo(s) of receipts.\n${indexDescriptions}\n\nFind every physical receipt in each photo, box it with box_2d = [ymin, xmin, ymax, xmax] (0-1000), and extract all fields strictly following the schema.`,
      });

      for (const photo of photos) {
        parts.push({
          text: `Photo ${photo.globalIndex} of ${photo.totalPhotos} is the image below (use photo_index: ${photo.globalIndex}):`,
        });
        parts.push({
          inlineData: {
            mimeType: photo.mimeType || "image/jpeg",
            data: photo.base64Data,
          },
        });
      }

      const { response, modelUsed } = await generateWithModelFallback({
        contents: { parts },
        config: {
          systemInstruction: READ_SYSTEM_INSTRUCTION,
          responseMimeType: "application/json",
          responseSchema: READ_RESPONSE_SCHEMA,
          temperature: 0.1,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        },
      });

      const parsed = parseJsonSafely<{ receipts: unknown[] }>(response.text, {
        receipts: [],
      });
      const elapsedMs = Date.now() - startTime;
      logEvent("DONE /api/read-receipts", {
        model: modelUsed,
        photoIndices: indices,
        receiptsFound: Array.isArray(parsed.receipts)
          ? parsed.receipts.length
          : 0,
        elapsedMs,
      });

      res.json(parsed);
    } catch (error: unknown) {
      const elapsedMs = Date.now() - startTime;
      const message =
        error instanceof Error ? error.message : "Failed to read receipts batch";
      logEvent("ERROR /api/read-receipts", { message, elapsedMs });
      res.status(500).json({ error: message });
    }
  });

  app.post("/api/check-duplicates", async (req, res) => {
    const startTime = Date.now();
    try {
      const { rows } = req.body as {
        rows: Array<{
          row: number;
          photo_index: number;
          merchant: string | null;
          date: string | null;
          time: string | null;
          final_total: number | null;
          printed_total: number | null;
          currency: string | null;
          card_last4: string | null;
          source_type?: string;
          source_label?: string;
        }>;
      };

      if (!rows || !Array.isArray(rows) || rows.length < 2) {
        res.json({ duplicates: [] });
        return;
      }

      logEvent("START /api/check-duplicates", {
        model: activeModelId,
        rowCount: rows.length,
      });

      const { response, modelUsed } = await generateWithModelFallback({
        contents: `Here are the merged receipt rows extracted from a pile of receipt photos and synced Workspace sources:\n\n${JSON.stringify(
          rows,
          null,
          2
        )}\n\nIdentify any likely duplicate pairs where the same transaction appears more than once (e.g., same merchant, same total, same or adjacent date, same card last 4 digits). Pay special attention to duplicate transactions across different ingestion sources (e.g., a receipt synced from Google Drive or Gmail that matches a manual upload or another email/Drive file) and include that cross-source context in "reason". Always set "row" to the higher row number and "duplicate_of" to the lower row number.`,
        config: {
          systemInstruction:
            "You are a careful bookkeeper checking extracted receipt rows for duplicate transactions across manual uploads, Google Drive folders, and Gmail receipts. Only report pairs that are genuinely likely to be the same transaction captured twice.",
          responseMimeType: "application/json",
          responseSchema: DUPLICATES_RESPONSE_SCHEMA,
          temperature: 0.1,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        },
      });

      const parsed = parseJsonSafely<{ duplicates: unknown[] }>(response.text, {
        duplicates: [],
      });
      logEvent("DONE /api/check-duplicates", {
        model: modelUsed,
        duplicatesFound: Array.isArray(parsed.duplicates)
          ? parsed.duplicates.length
          : 0,
        elapsedMs: Date.now() - startTime,
      });

      res.json(parsed);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to check duplicates";
      logEvent("ERROR /api/check-duplicates", {
        message,
        elapsedMs: Date.now() - startTime,
      });
      res.status(500).json({ error: message });
    }
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    logEvent(`Shoebox server running on http://localhost:${PORT}`);
  });
}

startServer();
