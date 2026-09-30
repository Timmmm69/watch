import { createWriteStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { MultipartFile } from "@fastify/multipart";
import { MAX_IMAGE_UPLOAD_BYTES, MAX_VIDEO_UPLOAD_BYTES } from "@watch/contracts";
import { CatalogValidationError } from "./catalog.js";

export function sniffMedia(header: Buffer, filename: string, declaredMime: string): "IMAGE" | "VIDEO" {
  const lower = filename.toLowerCase();
  const matches = [
    { type: "IMAGE", mime: "image/jpeg", ext: ".jpg", valid: header.length >= 3 && header.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) },
    { type: "IMAGE", mime: "image/jpeg", ext: ".jpeg", valid: header.length >= 3 && header.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) },
    { type: "IMAGE", mime: "image/png", ext: ".png", valid: header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
    { type: "IMAGE", mime: "image/webp", ext: ".webp", valid: header.length >= 12 && header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP" },
    { type: "VIDEO", mime: "video/mp4", ext: ".mp4", valid: header.length >= 12 && header.toString("ascii", 4, 8) === "ftyp" },
    { type: "VIDEO", mime: "video/webm", ext: ".webm", valid: header.length >= 4 && header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) }
  ] as const;
  const found = matches.find((entry) => entry.valid && lower.endsWith(entry.ext) && declaredMime === entry.mime);
  if (!found) throw new CatalogValidationError("Unsupported or mismatched media type");
  return found.type;
}

export async function stageMedia(part: MultipartFile): Promise<{
  type: "IMAGE" | "VIDEO"; path: string; sizeBytes: number; cleanup: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "watch-media-"));
  const path = join(directory, "upload");
  let sizeBytes = 0;
  try {
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        sizeBytes += chunk.length;
        if (sizeBytes > MAX_VIDEO_UPLOAD_BYTES) callback(new CatalogValidationError("Media file exceeds upload limit"));
        else callback(null, chunk);
      }
    });
    await pipeline(part.file, counter, createWriteStream(path));
    if (part.file.truncated) throw new CatalogValidationError("Media file exceeds upload limit");
    const file = await open(path, "r");
    const header = Buffer.alloc(16);
    try { await file.read(header, 0, 16, 0); } finally { await file.close(); }
    const type = sniffMedia(header, part.filename, part.mimetype);
    if (sizeBytes === 0 || sizeBytes > (type === "IMAGE" ? MAX_IMAGE_UPLOAD_BYTES : MAX_VIDEO_UPLOAD_BYTES)) {
      throw new CatalogValidationError("Media file exceeds upload limit");
    }
    return { type, path, sizeBytes, cleanup: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
