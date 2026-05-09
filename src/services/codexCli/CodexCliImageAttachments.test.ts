import {
  cleanupCodexCliImageAttachments,
  createCodexCliImageAttachment,
  parseCodexImageDataUrl,
} from "@/services/codexCli/CodexCliImageAttachments";

/**
 * Runtime require container shape for tests.
 */
interface TestRequireContainer {
  require?: (id: string) => unknown;
}

describe("CodexCliImageAttachments", () => {
  let originalRequire: ((id: string) => unknown) | undefined;
  let files: Record<string, Uint8Array>;

  /**
   * Install a mocked runtime require for image attachment tests.
   */
  function installRuntimeRequire(): void {
    const container = globalThis as unknown as TestRequireContainer;
    container.require = jest.fn((id: string) => {
      if (id === "buffer") {
        return { Buffer };
      }
      if (id === "fs") {
        return {
          existsSync: (path: string) => Object.prototype.hasOwnProperty.call(files, path),
          unlinkSync: (path: string) => {
            delete files[path];
          },
          writeFileSync: (path: string, data: Uint8Array) => {
            files[path] = data;
          },
        };
      }
      if (id === "os") {
        return {
          tmpdir: () => "C:\\Temp",
        };
      }
      if (id === "path") {
        return { join: (...parts: string[]) => parts.join("\\") };
      }
      return {};
    });
  }

  beforeEach(() => {
    const container = globalThis as unknown as TestRequireContainer;
    originalRequire = container.require;
    files = {};
    installRuntimeRequire();
  });

  afterEach(() => {
    const container = globalThis as unknown as TestRequireContainer;
    if (originalRequire) {
      container.require = originalRequire;
    } else {
      delete container.require;
    }
    jest.clearAllMocks();
  });

  it("parses supported image data URL MIME types and extensions", () => {
    const cases: Array<[string, string]> = [
      ["image/png", "png"],
      ["image/jpeg", "jpg"],
      ["image/jpg", "jpg"],
      ["image/gif", "gif"],
      ["image/webp", "webp"],
      ["image/bmp", "bmp"],
      ["image/tiff", "tiff"],
      ["image/avif", "avif"],
      ["image/heic", "heic"],
      ["image/heif", "heif"],
    ];

    for (const [mimeType, extension] of cases) {
      const parsed = parseCodexImageDataUrl(`data:${mimeType};base64,QUJD`);
      expect(parsed.mimeType).toBe(mimeType);
      expect(parsed.extension).toBe(extension);
      expect(parsed.base64).toBe("QUJD");
    }
  });

  it("uses a sanitized extension fallback for unknown image subtypes", () => {
    const parsed = parseCodexImageDataUrl("data:image/x-custom-format;base64,QUJD");

    expect(parsed.extension).toBe("custom-format");
  });

  it("writes and cleans up temporary image files", () => {
    const attachment = createCodexCliImageAttachment("data:image/png;base64,QUJD", 1);

    expect(attachment.mimeType).toBe("image/png");
    expect(attachment.extension).toBe("png");
    expect(attachment.path).toMatch(/obsidian-copilot-codex-image-.+\.png$/);
    expect(files[attachment.path]).toEqual(Buffer.from("QUJD", "base64"));

    cleanupCodexCliImageAttachments([attachment]);

    expect(files[attachment.path]).toBeUndefined();
  });

  it("rejects invalid, non-image, and empty image data URLs", () => {
    expect(() => parseCodexImageDataUrl("not-a-data-url")).toThrow("Invalid Codex CLI image");
    expect(() => parseCodexImageDataUrl("data:text/plain;base64,QUJD")).toThrow(
      "requires an image MIME type"
    );
    expect(() => parseCodexImageDataUrl("data:image/png,QUJD")).toThrow("must use base64");
    expect(() => parseCodexImageDataUrl("data:image/png;base64,")).toThrow("empty base64");
    expect(() => parseCodexImageDataUrl("data:image/png;base64,@@@")).toThrow("invalid base64");
  });
});
