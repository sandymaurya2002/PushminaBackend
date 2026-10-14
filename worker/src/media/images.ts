export const IMAGE_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/gif": "gif",
} as const;

export type ImageMime = keyof typeof IMAGE_TYPES;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_DIMENSION = 12_000;

export interface SniffedImage {
  mime: ImageMime;
  ext: string;
  width: number | null;
  height: number | null;
}

const ascii = (bytes: Uint8Array, start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length));
const u16be = (b: Uint8Array, o: number) => (b[o]! << 8) | b[o + 1]!;
const u16le = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u24le = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
const u32be = (b: Uint8Array, o: number) => ((b[o]! << 24) >>> 0) + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!;

function jpegSize(bytes: Uint8Array): [number, number] | null {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) {
      offset += marker === 0xff ? 1 : 2;
      continue;
    }
    const length = u16be(bytes, offset + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return [u16be(bytes, offset + 7), u16be(bytes, offset + 5)];
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

function webpSize(bytes: Uint8Array): [number, number] | null {
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8X" && bytes.length >= 30) return [u24le(bytes, 24) + 1, u24le(bytes, 27) + 1];
  if (chunk === "VP8 " && bytes.length >= 30) return [u16le(bytes, 26) & 0x3fff, u16le(bytes, 28) & 0x3fff];
  if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    const b = bytes;
    const width = 1 + (((b[22]! & 0x3f) << 8) | b[21]!);
    const height = 1 + (((b[24]! & 0x0f) << 10) | (b[23]! << 2) | ((b[22]! & 0xc0) >> 6));
    return [width, height];
  }
  return null;
}

function avifSize(bytes: Uint8Array): [number, number] | null {
  const limit = Math.min(bytes.length - 16, 64 * 1024);
  for (let offset = 0; offset < limit; offset += 1) {
    if (bytes[offset] === 0x69 && ascii(bytes, offset, 4) === "ispe") {
      return [u32be(bytes, offset + 8), u32be(bytes, offset + 12)];
    }
  }
  return null;
}

/** Identifies the image from its bytes; the client-declared type is never trusted. */
export function sniffImage(bytes: Uint8Array): SniffedImage | null {
  if (bytes.length < 16) return null;
  let mime: ImageMime | null = null;
  let size: [number, number] | null = null;

  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    mime = "image/jpeg";
    size = jpegSize(bytes);
  } else if (ascii(bytes, 0, 8) === "\x89PNG\r\n\x1a\n") {
    mime = "image/png";
    if (ascii(bytes, 12, 4) === "IHDR") size = [u32be(bytes, 16), u32be(bytes, 20)];
  } else if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") {
    mime = "image/gif";
    size = [u16le(bytes, 6), u16le(bytes, 8)];
  } else if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    mime = "image/webp";
    size = webpSize(bytes);
  } else if (ascii(bytes, 4, 4) === "ftyp" && /avi[fs]/.test(ascii(bytes, 8, Math.min(32, bytes.length - 8)))) {
    mime = "image/avif";
    size = avifSize(bytes);
  }

  if (!mime) return null;
  const [width, height] = size ?? [null, null];
  return { mime, ext: IMAGE_TYPES[mime], width, height };
}

export const VIDEO_TYPES = {
  "video/mp4": "mp4",
  "video/webm": "webm",
} as const;

export type VideoMime = keyof typeof VIDEO_TYPES;
export const MAX_VIDEO_BYTES = 40 * 1024 * 1024;

export interface SniffedVideo {
  mime: VideoMime;
  ext: string;
}

const MP4_BRANDS = /^(isom|iso[2-9]|mp41|mp42|avc1|M4V |M4VH|M4VP|dash|mmp4|qt  )$/;

/** Identifies MP4 (ISO base media) and WebM from their headers. */
export function sniffVideo(bytes: Uint8Array): SniffedVideo | null {
  if (bytes.length < 32) return null;
  if (ascii(bytes, 4, 4) === "ftyp" && MP4_BRANDS.test(ascii(bytes, 8, 4))) return { mime: "video/mp4", ext: "mp4" };
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3 && ascii(bytes, 0, Math.min(64, bytes.length)).includes("webm")) {
    return { mime: "video/webm", ext: "webm" };
  }
  return null;
}

export const MEDIA_FOLDERS = ["products", "collections", "categories", "banners", "videos", "misc"] as const;
export const MEDIA_KEY_PATTERN =
  /^(products|collections|categories|banners|videos|misc)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|avif|gif|mp4|webm)$/;
