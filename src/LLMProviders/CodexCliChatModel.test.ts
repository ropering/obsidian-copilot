import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";

import { buildCodexAgentPrompt, CodexCliChatModel } from "@/LLMProviders/CodexCliChatModel";
import { runCodexCliChat } from "@/services/codexCli/CodexCliClient";

jest.mock("@/services/codexCli/CodexCliClient", () => ({
  DEFAULT_CODEX_CLI_TIMEOUT_MS: 300000,
  runCodexCliChat: jest.fn(),
}));

describe("CodexCliChatModel", () => {
  let originalRequire: ((id: string) => unknown) | undefined;
  let files: Record<string, Uint8Array>;

  /**
   * Install a mocked runtime require for image attachment tests.
   */
  function installRuntimeRequire(): void {
    const container = globalThis as unknown as { require?: (id: string) => unknown };
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
    jest.clearAllMocks();
    const container = globalThis as unknown as { require?: (id: string) => unknown };
    originalRequire = container.require;
    files = {};
    (runCodexCliChat as jest.Mock).mockResolvedValue({
      text: "Codex response",
      processResult: {},
    });
  });

  afterEach(() => {
    const container = globalThis as unknown as { require?: (id: string) => unknown };
    if (originalRequire) {
      container.require = originalRequire;
    } else {
      delete container.require;
    }
  });

  it("buildCodexAgentPrompt serializes messages by role", () => {
    const prompt = buildCodexAgentPrompt([
      new SystemMessage("System rules"),
      new HumanMessage("Question"),
      new AIMessage("Prior answer"),
    ]);

    expect(prompt).toContain('<System index="1">\nSystem rules\n</System>');
    expect(prompt).toContain('<User index="2">\nQuestion\n</User>');
    expect(prompt).toContain('<Assistant index="3">\nPrior answer\n</Assistant>');
    expect(prompt).toContain("Desktop Codex CLI");
    expect(prompt).toContain("read-only sandbox");
    expect(prompt).toContain("preserves the original message roles");
    expect(prompt).toContain("Return only the final answer");
    expect(prompt).not.toContain("inspect files if useful");
  });

  it("invokes Codex CLI from the configured working directory", async () => {
    const model = new CodexCliChatModel({
      workingDirectory: "C:\\Vault",
      codexIgnoreRules: true,
    });

    const result = await model.invoke([new HumanMessage("Hello")]);

    expect(result.content).toBe("Codex response");
    expect(runCodexCliChat).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "C:\\Vault",
        ignoreRules: true,
        timeoutMs: 300000,
      })
    );
  });

  it("streams the final response as a single chunk", async () => {
    const model = new CodexCliChatModel({
      workingDirectory: "C:\\Vault",
    });
    const chunks = [];

    for await (const chunk of (model as any)._streamResponseChunks([new HumanMessage("Hello")])) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe("Codex response");
  });

  it("passes multiple image attachments as temp files without serializing base64 into the prompt", async () => {
    installRuntimeRequire();
    const model = new CodexCliChatModel({
      workingDirectory: "C:\\Vault",
    });

    await model.invoke([
      new HumanMessage({
        content: [
          { type: "text", text: "Describe these images." },
          { type: "image_url", image_url: { url: "data:image/png;base64,UE5HREFUQQ==" } },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,SlBHREFUQQ==" } },
        ],
      }),
    ]);

    const invocation = (runCodexCliChat as jest.Mock).mock.calls[0][0];
    expect(invocation.imagePaths).toHaveLength(2);
    expect(invocation.imagePaths[0]).toMatch(/\.png$/);
    expect(invocation.imagePaths[1]).toMatch(/\.jpg$/);
    expect(invocation.prompt).toContain("Describe these images.");
    expect(invocation.prompt).toContain("[Image attachment 1: image/png passed separately]");
    expect(invocation.prompt).toContain("[Image attachment 2: image/jpeg passed separately]");
    expect(invocation.prompt).not.toContain("data:image");
    expect(invocation.prompt).not.toContain("base64");
    expect(invocation.prompt).not.toContain("UE5HREFUQQ");
    expect(Object.keys(files)).toHaveLength(0);
  });

  it("buildCodexAgentPrompt replaces image payloads with placeholders", () => {
    const prompt = buildCodexAgentPrompt([
      new HumanMessage({
        content: [
          { type: "text", text: "What is in this image?" },
          { type: "image_url", image_url: { url: "data:image/webp;base64,V0VCUA==" } },
        ],
      }),
    ]);

    expect(prompt).toContain("What is in this image?");
    expect(prompt).toContain("[Image attachment 1: image/webp passed separately]");
    expect(prompt).not.toContain("data:image");
    expect(prompt).not.toContain("V0VCUA");
  });
});
