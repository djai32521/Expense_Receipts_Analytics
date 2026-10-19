import type { UploadedPhoto } from "../types";

const MAX_DIMENSION = 2048;
const JPEG_QUALITY = 0.85;
const MAX_BATCH_BYTES = 18 * 1024 * 1024; // 18 MB threshold (under 20 MB inline cap)

// Deduplicate in-flight browser image processing so eager background shrinking
// and immediate "visualise" clicks never decode the same file twice.
const inFlightProcessing = new Map<string, Promise<UploadedPhoto>>();

export function stripFileExtension(filename: string): string {
  return filename.replace(/\.[^/.]+$/, "");
}

export function inferMimeTypeFromFile(file: File): string {
  const rawType = (file.type || "").toLowerCase().trim();
  if (
    rawType &&
    rawType !== "application/octet-stream" &&
    (rawType.startsWith("image/") || rawType === "application/pdf")
  ) {
    return rawType === "image/jpg" ? "image/jpeg" : rawType;
  }

  const ext = file.name.split(".").pop()?.toLowerCase() || "";
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "heic":
      return "image/heic";
    case "heif":
      return "image/heif";
    case "pdf":
      return "application/pdf";
    default:
      return "image/jpeg";
  }
}

export function isPdfFile(file: File): boolean {
  const type = (file.type || "").toLowerCase();
  const ext = file.name.split(".").pop()?.toLowerCase() || "";
  return type === "application/pdf" || ext === "pdf";
}

export function isSupportedImageFile(file: File): boolean {
  const type = (file.type || "").toLowerCase();
  const ext = file.name.split(".").pop()?.toLowerCase() || "";
  return (
    type === "image/jpeg" ||
    type === "image/jpg" ||
    type === "image/png" ||
    type === "image/webp" ||
    type === "image/heic" ||
    type === "image/heif" ||
    type === "application/pdf" ||
    ext === "jpg" ||
    ext === "jpeg" ||
    ext === "png" ||
    ext === "webp" ||
    ext === "heic" ||
    ext === "heif" ||
    ext === "pdf"
  );
}

function readBlobAsBase64(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === "string") {
        const commaIdx = reader.result.indexOf(",");
        resolve(commaIdx !== -1 ? reader.result.slice(commaIdx + 1) : reader.result);
      } else {
        reject(new Error("Failed to read file as base64 data URL"));
      }
    };
    reader.onerror = () => reject(new Error("FileReader error while reading receipt file"));
    reader.readAsDataURL(blob);
  });
}

async function ensureBrowserDecodableBlob(file: File): Promise<Blob> {
  const type = (file.type || "").toLowerCase();
  const ext = file.name.split(".").pop()?.toLowerCase() || "";
  if (
    type === "image/heic" ||
    type === "image/heif" ||
    ext === "heic" ||
    ext === "heif"
  ) {
    // @ts-ignore - heic2any ships without TypeScript .d.ts declarations
    const heicMod = (await import("heic2any")) as {
      default?: (opts: {
        blob: Blob;
        toType: string;
        quality: number;
      }) => Promise<Blob | Blob[]>;
    };
    const heic2any =
      heicMod.default ||
      (heicMod as unknown as (opts: {
        blob: Blob;
        toType: string;
        quality: number;
      }) => Promise<Blob | Blob[]>);
    const converted = await heic2any({
      blob: file,
      toType: "image/jpeg",
      quality: JPEG_QUALITY,
    });
    return Array.isArray(converted) ? converted[0] : converted;
  }
  return file;
}

/**
 * Shrinks image in the browser so longest side <= 2048px, JPEG quality 0.85 (B2).
 * Drawing to <canvas> also strips all EXIF location / camera metadata.
 * For PDF receipts (application/pdf), preserves native PDF bytes for Gemini inlineData.
 */
export async function processPhotoInBrowser(
  photo: UploadedPhoto
): Promise<UploadedPhoto> {
  if (photo.base64Data && photo.width && photo.height) {
    return photo;
  }

  const existingPromise = inFlightProcessing.get(photo.id);
  if (existingPromise) {
    const processed = await existingPromise;
    return {
      ...processed,
      globalIndex: photo.globalIndex,
      status: photo.status,
      receiptsCount: photo.receiptsCount,
      errorText: photo.errorText,
    };
  }

  const task = (async (): Promise<UploadedPhoto> => {
    // Handle PDF receipts directly for Gemini multimodal PDF extraction
    if (isPdfFile(photo.file)) {
      const base64Data = await readBlobAsBase64(photo.file);
      const byteSize =
        photo.file.size || Math.ceil((base64Data.length * 3) / 4);
      return {
        ...photo,
        base64Data,
        mimeType: "application/pdf",
        width: 1000,
        height: 1300,
        byteSize,
      };
    }

    const decodableBlob = await ensureBrowserDecodableBlob(photo.file);
    const bitmapUrl = URL.createObjectURL(decodableBlob);

    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () =>
          reject(new Error(`Failed to decode image ${photo.name}`));
        el.src = bitmapUrl;
      });

      const origW = img.naturalWidth || img.width || 1000;
      const origH = img.naturalHeight || img.height || 1000;

      let targetW = origW;
      let targetH = origH;

      if (origW > MAX_DIMENSION || origH > MAX_DIMENSION) {
        if (origW >= origH) {
          targetW = MAX_DIMENSION;
          targetH = Math.max(1, Math.round((origH * MAX_DIMENSION) / origW));
        } else {
          targetH = MAX_DIMENSION;
          targetW = Math.max(1, Math.round((origW * MAX_DIMENSION) / origH));
        }
      }

      const canvas = document.createElement("canvas");
      canvas.width = targetW;
      canvas.height = targetH;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        throw new Error("Canvas 2D context unavailable");
      }

      // Fill white background in case of transparent PNG/WebP
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(0, 0, targetW, targetH);
      ctx.drawImage(img, 0, 0, targetW, targetH);

      // Exporting via async canvas.toBlob strips all EXIF metadata without blocking the main thread
      const dataUrl = await new Promise<string>((resolve) => {
        if (typeof canvas.toBlob === "function") {
          canvas.toBlob(
            (blob) => {
              if (!blob) {
                resolve(canvas.toDataURL("image/jpeg", JPEG_QUALITY));
                return;
              }
              const reader = new FileReader();
              reader.onloadend = () => {
                if (typeof reader.result === "string") {
                  resolve(reader.result);
                } else {
                  resolve(canvas.toDataURL("image/jpeg", JPEG_QUALITY));
                }
              };
              reader.onerror = () =>
                resolve(canvas.toDataURL("image/jpeg", JPEG_QUALITY));
              reader.readAsDataURL(blob);
            },
            "image/jpeg",
            JPEG_QUALITY
          );
        } else {
          resolve(canvas.toDataURL("image/jpeg", JPEG_QUALITY));
        }
      });
      const base64Data = dataUrl.split(",")[1] || "";
      const byteSize = Math.ceil((base64Data.length * 3) / 4);

      // If the original file was HEIC, update objectUrl so the browser can render it in Proof view
      const ext = photo.file.name.split(".").pop()?.toLowerCase() || "";
      let displayObjectUrl = photo.objectUrl;
      if (ext === "heic" || ext === "heif") {
        if (photo.objectUrl.startsWith("blob:")) {
          URL.revokeObjectURL(photo.objectUrl);
        }
        displayObjectUrl = dataUrl;
      }

      return {
        ...photo,
        objectUrl: displayObjectUrl,
        base64Data,
        mimeType: "image/jpeg",
        width: targetW,
        height: targetH,
        byteSize,
      };
    } catch (err) {
      // Fallback: if browser Image decode failed on a non-empty file within size limits,
      // pass raw bytes with inferred MIME type to Gemini rather than dropping the file.
      if (photo.file.size > 0 && photo.file.size <= MAX_BATCH_BYTES) {
        const base64Data = await readBlobAsBase64(photo.file);
        const inferredMime = inferMimeTypeFromFile(photo.file);
        return {
          ...photo,
          base64Data,
          mimeType: inferredMime,
          width: 1000,
          height: 1300,
          byteSize: photo.file.size,
        };
      }
      throw err;
    } finally {
      URL.revokeObjectURL(bitmapUrl);
    }
  })();

  inFlightProcessing.set(photo.id, task);
  try {
    return await task;
  } finally {
    inFlightProcessing.delete(photo.id);
  }
}

/**
 * Processes multiple photos concurrently with a worker pool (default concurrency = 4)
 * so large piles shrink in parallel without blocking the main thread.
 */
export async function processPhotosConcurrently(
  photos: UploadedPhoto[],
  concurrency = 4,
  onPhotoReady?: (processed: UploadedPhoto) => void
): Promise<UploadedPhoto[]> {
  const results: UploadedPhoto[] = new Array(photos.length);
  let nextIdx = 0;

  const worker = async () => {
    while (nextIdx < photos.length) {
      const idx = nextIdx++;
      const processed = await processPhotoInBrowser(photos[idx]);
      results[idx] = processed;
      if (onPhotoReady) {
        onPhotoReady(processed);
      }
    }
  };

  const workers = Array.from(
    { length: Math.min(concurrency, photos.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

/**
 * Groups processed photos into batches of up to 10 photos and < 18MB payload size (B2).
 * Balances across 3 parallel workers so a 24-photo pile runs in 3 concurrent batches of 8.
 */
export function buildPhotoBatches(photos: UploadedPhoto[]): UploadedPhoto[][] {
  const batches: UploadedPhoto[][] = [];
  let currentBatch: UploadedPhoto[] = [];
  let currentBytes = 0;
  const maxBatchPhotos = Math.min(
    10,
    Math.max(1, Math.ceil(photos.length / 3))
  );

  for (const photo of photos) {
    const photoPayloadBytes = (photo.base64Data?.length || 0) + 512;

    if (
      currentBatch.length > 0 &&
      (currentBatch.length >= maxBatchPhotos ||
        currentBytes + photoPayloadBytes > MAX_BATCH_BYTES)
    ) {
      batches.push(currentBatch);
      currentBatch = [];
      currentBytes = 0;
    }

    currentBatch.push(photo);
    currentBytes += photoPayloadBytes;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}
