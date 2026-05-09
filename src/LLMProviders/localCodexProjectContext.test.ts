import {
  LocalCodexProjectContextLoader,
  formatLocalCodexProjectContext,
} from "./localCodexProjectContext";
import { hasLocalWebSearchConfig, localWebSearch } from "@/LLMProviders/localWebSearch";

const mockLoadState = {
  success: [] as string[],
  failed: [] as Array<{ path: string; type: string; error?: string }>,
  processingFiles: [] as string[],
  total: [] as string[],
};

const mockTracker = {
  clearAllLoadStates: jest.fn(() => {
    mockLoadState.success = [];
    mockLoadState.failed = [];
    mockLoadState.processingFiles = [];
    mockLoadState.total = [];
  }),
  preComputeAllItems: jest.fn((project, files) => {
    mockLoadState.total = [
      ...new Set([
        ...files.map((file: { path: string }) => file.path),
        ...(project.contextSource.webUrls || "").split("\n").filter(Boolean),
        ...(project.contextSource.youtubeUrls || "").split("\n").filter(Boolean),
      ]),
    ];
  }),
  makeItemFailed: jest.fn((path, type, error) => {
    mockLoadState.failed.push({ path, type, error });
  }),
  executeWithProcessTracking: jest.fn(async (path, type, operation) => {
    try {
      const result = await operation();
      mockLoadState.success.push(path);
      return result;
    } catch (error) {
      mockLoadState.failed.push({
        path,
        type,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }),
};

jest.mock("@/LLMProviders/localWebSearch", () => ({
  hasLocalWebSearchConfig: jest.fn(),
  localWebSearch: jest.fn(),
}));

jest.mock("@/aiParams", () => ({
  setProjectLoading: jest.fn(),
}));

jest.mock("./projectLoadTracker", () => ({
  ProjectLoadTracker: {
    getInstance: jest.fn(() => mockTracker),
  },
}));

const mockHasLocalWebSearchConfig = hasLocalWebSearchConfig as jest.MockedFunction<
  typeof hasLocalWebSearchConfig
>;
const mockLocalWebSearch = localWebSearch as jest.MockedFunction<typeof localWebSearch>;

/**
 * Create a minimal Obsidian app mock for local project context tests.
 *
 * @param files - Vault files exposed by the mock app.
 * @returns Mock Obsidian app object.
 */
function createMockApp(
  files: Array<{ path: string; extension: string; basename: string; content: string }>
) {
  return {
    vault: {
      getFiles: () => files,
      read: async (file: { content: string }) => file.content,
      adapter: {
        stat: async () => ({ ctime: 1, mtime: 2 }),
      },
    },
  } as any;
}

describe("LocalCodexProjectContextLoader", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockHasLocalWebSearchConfig.mockReturnValue(true);
    mockLocalWebSearch.mockResolvedValue({
      content: "### Example\nLocal web result\nSource: https://example.com",
      citations: ["https://example.com"],
    });
  });

  it("formats local project context with ProjectContext wrapper", () => {
    const context = formatLocalCodexProjectContext({
      markdownContext: "path: Notes/A.md\n\nA",
      webContexts: ["Web context"],
    });

    expect(context).toContain("# Project Context");
    expect(context).toContain("<ProjectContext>");
    expect(context).toContain("## Markdown Files");
    expect(context).toContain("## Web Content");
    expect(context).toContain("</ProjectContext>");
  });

  it("loads markdown/base context and Tavily-style local web context without Plus services", async () => {
    const app = createMockApp([
      {
        path: "Notes/A.md",
        extension: "md",
        basename: "A",
        content: "Markdown content",
      },
      {
        path: "Notes/B.base",
        extension: "base",
        basename: "B",
        content: "Base content",
      },
    ]);
    const loader = new LocalCodexProjectContextLoader(app);

    const context = await loader.load({
      id: "project-1",
      name: "Local Project",
      systemPrompt: "Project prompt",
      projectModelKey: "Desktop Codex CLI Chat|desktop-codex-cli",
      modelConfigs: {},
      contextSource: {
        inclusions: "Notes",
        exclusions: "",
        webUrls: "https://example.com",
        youtubeUrls: "",
      },
      created: 1,
      UsageTimestamps: 1,
    });

    expect(context).toContain("Markdown content");
    expect(context).toContain("Base content");
    expect(context).toContain("Web context requested for https://example.com");
    expect(mockLocalWebSearch).toHaveBeenCalledWith("https://example.com");
  });

  it("marks unsupported files and YouTube URLs without falling back to Brevilabs", async () => {
    const app = createMockApp([
      {
        path: "Docs/A.pdf",
        extension: "pdf",
        basename: "A",
        content: "",
      },
    ]);
    const loader = new LocalCodexProjectContextLoader(app);

    await loader.load({
      id: "project-2",
      name: "Unsupported Project",
      systemPrompt: "Project prompt",
      projectModelKey: "Desktop Codex CLI Chat|desktop-codex-cli",
      modelConfigs: {},
      contextSource: {
        inclusions: "Docs",
        exclusions: "",
        webUrls: "",
        youtubeUrls: "https://youtube.com/watch?v=abc",
      },
      created: 1,
      UsageTimestamps: 1,
    });

    expect(mockLoadState.failed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "Docs/A.pdf",
          type: "nonMd",
          error: expect.stringContaining("local mode unsupported"),
        }),
        expect.objectContaining({
          path: "https://youtube.com/watch?v=abc",
          type: "youtube",
          error: expect.stringContaining("local mode unsupported"),
        }),
      ])
    );
    expect(mockLocalWebSearch).not.toHaveBeenCalled();
  });
});
