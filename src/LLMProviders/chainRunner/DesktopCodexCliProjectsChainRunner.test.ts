import {
  LOCAL_CODEX_PROJECT_SYSTEM_INSTRUCTIONS,
  buildLocalCodexProjectUserContent,
} from "./DesktopCodexCliProjectsChainRunner";

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

describe("DesktopCodexCliProjectsChainRunner helpers", () => {
  it("places local ProjectContext before local tool context and user query", () => {
    const content = buildLocalCodexProjectUserContent(
      "What should I do next?",
      "<ProjectContext>\nProject notes\n</ProjectContext>",
      [{ tool: "localSearch", output: "<localSearch>\nVault result\n</localSearch>" }],
      false,
      true
    );

    expect(content.indexOf("<ProjectContext>")).toBeLessThan(
      content.indexOf("# Additional context:")
    );
    expect(content.indexOf("# Additional context:")).toBeLessThan(content.indexOf("[User query]:"));
    expect(content).toContain("[User query]:\nWhat should I do next?");
  });

  it("documents that local projects do not use Plus conversion gateways", () => {
    expect(LOCAL_CODEX_PROJECT_SYSTEM_INSTRUCTIONS).toContain("Local Projects Mode");
    expect(LOCAL_CODEX_PROJECT_SYSTEM_INSTRUCTIONS).toContain("does not use Copilot Plus");
    expect(LOCAL_CODEX_PROJECT_SYSTEM_INSTRUCTIONS).toContain("docs4llm");
    expect(LOCAL_CODEX_PROJECT_SYSTEM_INSTRUCTIONS).toContain("local mode unsupported");
  });
});
