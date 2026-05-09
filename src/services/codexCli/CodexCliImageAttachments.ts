/**
 * Temporary image attachment written for a single Codex CLI invocation.
 */
export interface CodexCliImageAttachment {
  path: string;
  mimeType: string;
  extension: string;
}

/**
 * Minimal global shape that may expose Node's `require` in the desktop renderer.
 */
interface RequireContainer {
  require?: (id: string) => unknown;
}

/**
 * Minimal file system module shape used for temporary image files.
 */
interface FileSystemModule {
  existsSync(path: string): boolean;
  unlinkSync(path: string): void;
  writeFileSync(path: string, data: Uint8Array): void;
}

/**
 * Minimal OS module shape used for temporary image files.
 */
interface OsModule {
  tmpdir(): string;
}

/**
 * Minimal path module shape used for temporary image files.
 */
interface PathModule {
  join(...parts: string[]): string;
}

/**
 * Minimal Buffer module shape used to decode base64 image payloads.
 */
interface BufferModule {
  Buffer: {
    from(input: string, encoding: "base64"): Uint8Array;
  };
}

/**
 * Parsed image data URL payload.
 */
interface ParsedImageDataUrl {
  mimeType: string;
  extension: string;
  base64: string;
}

const MIME_EXTENSION_MAP: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/x-ms-bmp": "bmp",
  "image/tiff": "tiff",
  "image/avif": "avif",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/svg+xml": "svg",
};

/**
 * Resolve `require` from the desktop runtime.
 *
 * @returns Runtime `require` function.
 * @throws If `require` is not available.
 */
function getRuntimeRequire(): (id: string) => unknown {
  const container = globalThis as unknown as RequireContainer;
  if (typeof container.require !== "function") {
    throw new Error(
      "Node require is unavailable in this runtime. Desktop Codex CLI image attachments require the desktop app."
    );
  }
  return container.require;
}

/**
 * Resolve a minimal Node module by id.
 *
 * @param id - Node builtin module id.
 * @returns Required module.
 */
function getNodeModule<T>(id: string): T {
  return getRuntimeRequire()(id) as T;
}

/**
 * Return a safe file extension for an image MIME type.
 *
 * @param mimeType - MIME type from the data URL.
 * @returns File extension without a leading dot.
 */
function getImageExtension(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  const knownExtension = MIME_EXTENSION_MAP[normalized];
  if (knownExtension) {
    return knownExtension;
  }

  const subtype = normalized.slice("image/".length);
  const sanitized = subtype
    .replace(/^x-/, "")
    .replace(/\+xml$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);

  return sanitized || "img";
}

/**
 * Normalize and validate a base64 payload.
 *
 * @param payload - Raw base64 payload from a data URL.
 * @returns Whitespace-free base64 payload.
 * @throws If the payload is empty or malformed.
 */
function normalizeBase64Payload(payload: string): string {
  const normalized = payload.replace(/\s/g, "");
  if (!normalized) {
    throw new Error("Codex CLI image data URL contains an empty base64 payload.");
  }

  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1) {
    throw new Error("Codex CLI image data URL contains invalid base64 data.");
  }

  return normalized;
}

/**
 * Parse an image data URL produced by the chat image picker.
 *
 * @param dataUrl - Data URL to parse.
 * @returns Parsed image payload metadata.
 * @throws If the URL is not a base64 image data URL.
 */
export function parseCodexImageDataUrl(dataUrl: string): ParsedImageDataUrl {
  const match = /^data:([^;,]+)((?:;[^,]*)*),([\s\S]*)$/.exec(dataUrl);
  if (!match) {
    throw new Error("Invalid Codex CLI image data URL.");
  }

  const mimeType = match[1].trim().toLowerCase();
  if (!mimeType.startsWith("image/")) {
    throw new Error(`Codex CLI image attachment requires an image MIME type, got ${mimeType}.`);
  }

  const parameters = match[2]
    .split(";")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (!parameters.includes("base64")) {
    throw new Error("Codex CLI image data URL must use base64 encoding.");
  }

  return {
    mimeType,
    extension: getImageExtension(mimeType),
    base64: normalizeBase64Payload(match[3]),
  };
}

/**
 * Create a unique temporary image file path.
 *
 * @param extension - File extension without a leading dot.
 * @param index - One-based image attachment index.
 * @returns Temporary image file path.
 */
function createTempImagePath(extension: string, index: number): string {
  const os = getNodeModule<OsModule>("os");
  const path = getNodeModule<PathModule>("path");
  const suffix = `${Date.now()}-${index}-${Math.random().toString(36).slice(2)}`;
  return path.join(os.tmpdir(), `obsidian-copilot-codex-image-${suffix}.${extension}`);
}

/**
 * Write a base64 image data URL to a temporary image file for Codex CLI.
 *
 * @param dataUrl - Base64 image data URL.
 * @param index - One-based image attachment index.
 * @returns Temporary image attachment metadata.
 */
export function createCodexCliImageAttachment(
  dataUrl: string,
  index: number
): CodexCliImageAttachment {
  const parsed = parseCodexImageDataUrl(dataUrl);
  const bufferModule = getNodeModule<BufferModule>("buffer");
  const bytes = bufferModule.Buffer.from(parsed.base64, "base64");
  if (bytes.length === 0) {
    throw new Error("Codex CLI image data URL decoded to an empty file.");
  }

  const fs = getNodeModule<FileSystemModule>("fs");
  const imagePath = createTempImagePath(parsed.extension, index);
  fs.writeFileSync(imagePath, bytes);

  return {
    path: imagePath,
    mimeType: parsed.mimeType,
    extension: parsed.extension,
  };
}

/**
 * Remove temporary image files created for a Codex CLI invocation.
 *
 * @param attachments - Temporary image attachments to remove.
 */
export function cleanupCodexCliImageAttachments(attachments: CodexCliImageAttachment[]): void {
  if (attachments.length === 0) {
    return;
  }

  const fs = getNodeModule<FileSystemModule>("fs");
  for (const attachment of attachments) {
    try {
      if (fs.existsSync(attachment.path)) {
        fs.unlinkSync(attachment.path);
      }
    } catch {
      // Best-effort cleanup must not mask the original Codex CLI result.
    }
  }
}
