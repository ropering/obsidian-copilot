import { ChatModelProviders } from "@/constants";
import {
  createLocalWebSearchUnavailableResult,
  extractLocalCodexSalientTerms,
  formatLocalCodexToolResults,
  hasLocalCodexToolCommand,
  isDesktopCodexCliModelConfig,
  processLocalCodexComposerBlocks,
  removeLocalCodexToolCommands,
} from "./DesktopCodexCliToolsChainRunner";

jest.mock("@/tools/ComposerTools", () => ({
  writeFileTool: { name: "writeFile" },
  editFileTool: { name: "editFile" },
}));

jest.mock("@/tools/SearchTools", () => ({
  localSearchTool: { name: "localSearch" },
}));

jest.mock("@/tools/memoryTools", () => ({
  updateMemoryTool: { name: "updateMemory" },
}));

jest.mock("@/tools/toolManager", () => ({
  ToolManager: {
    callTool: jest.fn(),
  },
}));

jest.mock("@/LLMProviders/localWebSearch", () => ({
  hasLocalWebSearchConfig: jest.fn(() => false),
  localWebSearch: jest.fn(),
}));

describe("DesktopCodexCliToolsChainRunner helpers", () => {
  it("detects Desktop Codex CLI model configs", () => {
    expect(
      isDesktopCodexCliModelConfig({
        provider: ChatModelProviders.DESKTOP_CODEX_CLI,
      })
    ).toBe(true);

    expect(
      isDesktopCodexCliModelConfig({
        provider: ChatModelProviders.OPENAI,
      })
    ).toBe(false);
  });

  it("removes only supported local Codex tool command tokens", () => {
    const message = "@vault summarize this @websearch and keep @workspace";

    expect(removeLocalCodexToolCommands(message)).toBe("summarize this and keep @workspace");
  });

  it("treats @web as distinct from @websearch", () => {
    expect(hasLocalCodexToolCommand("find this @websearch", "@websearch")).toBe(true);
    expect(hasLocalCodexToolCommand("find this @websearch", "@web")).toBe(false);
    expect(hasLocalCodexToolCommand("find this @web", "@web")).toBe(true);
  });

  it("extracts language-agnostic salient terms", () => {
    expect(extractLocalCodexSalientTerms("Obsidian Copilot 로컬 도구 테스트")).toEqual([
      "Obsidian",
      "Copilot",
      "로컬",
      "도구",
      "테스트",
    ]);
  });

  it("formats local tool results for prompt injection", () => {
    expect(
      formatLocalCodexToolResults([
        { tool: "localSearch", output: "note result" },
        { tool: "webSearch", output: "local web search is not configured", isError: true },
      ])
    ).toContain('<tool_result name="webSearch" status="error">');
  });

  it("uses a local-only web-search unavailable result", () => {
    expect(createLocalWebSearchUnavailableResult()).toEqual({
      tool: "webSearch",
      output: "local web search is not configured",
      isError: true,
    });
  });

  it("runs writeFile composer blocks through the injected executor", async () => {
    const executor = jest.fn(async () => ({ result: "preview" }));
    const response = await processLocalCodexComposerBlocks(
      `Before
<writeFile>
<path>notes/a.md</path>
<content>Hello</content>
</writeFile>
After`,
      executor
    );

    expect(executor).toHaveBeenCalledWith("writeFile", {
      path: "notes/a.md",
      content: "Hello",
    });
    expect(response).not.toContain("<writeFile>");
    expect(response).toContain("writeFile result:");
    expect(response).toContain("preview");
  });

  it("runs editFile composer blocks through the injected executor", async () => {
    const executor = jest.fn(async () => ({ result: "preview" }));
    const response = await processLocalCodexComposerBlocks(
      `<editFile>
<path>notes/a.md</path>
<oldText>old</oldText>
<newText>new</newText>
</editFile>`,
      executor
    );

    expect(executor).toHaveBeenCalledWith("editFile", {
      path: "notes/a.md",
      oldText: "old",
      newText: "new",
    });
    expect(response).not.toContain("<editFile>");
    expect(response).toContain("editFile result:");
  });
});
