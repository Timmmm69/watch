import { Readable } from "node:stream";
import type { MultipartFile } from "@fastify/multipart";
import { MAX_IMAGE_UPLOAD_BYTES, MAX_VIDEO_UPLOAD_BYTES } from "@watch/contracts";
import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import { createApp, type CatalogApi } from "../app.js";
import { deriveCsrfToken } from "../auth/middleware.js";
import { SESSION_COOKIE_NAME, type SessionStore } from "../auth/session.js";
import type { AssetService } from "./assets.js";
import { sniffMedia, stageMedia } from "./media-upload.js";

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const mp4 = Buffer.from([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);

function upload(size: number, header: Buffer, filename: string, mimetype: string): MultipartFile {
  const stream = Readable.from((async function* () {
    yield header;
    let remaining = size - header.length;
    while (remaining > 0) {
      const length = Math.min(remaining, 64 * 1024);
      yield Buffer.alloc(length);
      remaining -= length;
    }
  })());
  return { file: stream, filename, mimetype } as MultipartFile;
}

describe("media validation", () => {
  it("accepts exact IMAGE and VIDEO byte limits and rejects max+1", async () => {
    for (const [limit, header, filename, mime] of [
      [MAX_IMAGE_UPLOAD_BYTES, jpeg, "photo.jpg", "image/jpeg"],
      [MAX_VIDEO_UPLOAD_BYTES, mp4, "video.mp4", "video/mp4"]
    ] as const) {
      const accepted = await stageMedia(upload(limit, header, filename, mime));
      expect(accepted.sizeBytes).toBe(limit);
      await accepted.cleanup();
      await expect(stageMedia(upload(limit + 1, header, filename, mime))).rejects.toThrow(/limit/);
    }
  });

  it("rejects MIME, extension, and content mismatches", () => {
    expect(() => sniffMedia(jpeg, "photo.svg", "image/jpeg")).toThrow();
    expect(() => sniffMedia(jpeg, "photo.jpg", "text/html")).toThrow();
    expect(() => sniffMedia(Buffer.from("<svg>"), "photo.jpg", "image/jpeg")).toThrow();
  });
});

describe("Admin media upload route", () => {
  it("streams a MIME-valid multipart upload to the asset service", async () => {
    const secret = Buffer.alloc(32, 3);
    const userId = "00000000-0000-4000-8000-000000000010";
    const productId = "00000000-0000-4000-8000-000000000011";
    const createMedia = vi.fn(async () => ({ id: "asset-id" }));
    const app = createApp({ checkReadiness: async () => undefined, logger: false,
      auth: {
        store: { loadCurrent: async () => ({
          session: { id: "session-1", userId, createdAt: new Date(), expiresAt: new Date(), revokedAt: null },
          user: { id: userId, telegramUserId: "42", firstName: "Ada", lastName: null,
            username: null, languageCode: null, isAdmin: true, isBlocked: false }
        }) } as unknown as SessionStore,
        csrfSecret: secret, appBaseUrl: "https://app.example", adminIds: () => new Set(["42"])
      },
      catalog: { service: {} as CatalogApi },
      assets: { service: { createMedia } as unknown as AssetService }
    });
    const boundary = "watch-boundary";
    for (const [limit, header, filename, mime, type] of [
      [MAX_IMAGE_UPLOAD_BYTES, jpeg, "photo.jpg", "image/jpeg", "IMAGE"],
      [MAX_VIDEO_UPLOAD_BYTES, mp4, "video.mp4", "video/mp4", "VIDEO"]
    ] as const) {
      for (const size of [limit, limit + 1]) {
        const file = Buffer.alloc(size);
        header.copy(file);
        const payload = Buffer.concat([
          Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nSTOREFRONT\r\n`),
          Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`),
          file, Buffer.from(`\r\n--${boundary}--\r\n`)
        ]);
        const response = await app.inject({
          method: "POST", url: `/api/v1/admin/products/${productId}/assets/media`,
          headers: { cookie: `${SESSION_COOKIE_NAME}=${"a".repeat(43)}`,
            origin: "https://app.example", "x-csrf-token": deriveCsrfToken(secret, "session-1"),
            "content-type": `multipart/form-data; boundary=${boundary}` },
          payload
        });
        expect(response.statusCode).toBe(size === limit ? 200 : 400);
        if (size === limit) expect(createMedia).toHaveBeenCalledWith(userId, productId, expect.objectContaining({
          type, purpose: "STOREFRONT", sizeBytes: limit, mimeType: mime
        }));
      }
    }
    expect(createMedia).toHaveBeenCalledTimes(2);
    await app.close();
  }, 30_000);
});
