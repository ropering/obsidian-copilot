import {
  addLocalCodexFallbackSources,
  formatLocalCodexSearchContext,
  prepareLocalCodexSearchResult,
} from "./localCodexSearchContext";

jest.mock("@/tools/ToolResultFormatter", () => ({
  ToolResultFormatter: {
    format: (_tool: string, content: string) => content,
  },
}));

jest.mock("@/settings/model", () => ({
  getSettings: () => ({
    debug: false,
    enableInlineCitations: true,
    maxSourceChunks: 5,
  }),
}));

describe("localCodexSearchContext", () => {
  it("formats localSearch documents as Plus-style localSearch context", () => {
    const result = formatLocalCodexSearchContext(
      {
        type: "local_search",
        documents: [
          {
            title: "Codex Note",
            path: "Notes/Codex.md",
            content: "Codex CLI integration details",
            score: 0.9,
            rerank_score: 0.9,
            includeInContext: true,
          },
        ],
      },
      true
    );

    expect(result.formattedForLLM).toContain("<localSearch>");
    expect(result.formattedForLLM).toContain("[Relevance: 1 high]");
    expect(result.formattedForLLM).toContain(
      "Answer the question based only on the following context:"
    );
    expect(result.formattedForLLM).toContain("<document>");
    expect(result.formattedForLLM).toContain("<path>Notes/Codex.md</path>");
    expect(result.formattedForLLM).toContain("CITATION RULES");
    expect(result.sources).toEqual([
      {
        title: "Codex Note",
        path: "Notes/Codex.md",
        score: 0.9,
        explanation: null,
      },
    ]);
    expect(result.fallbackSources).toEqual([
      {
        title: "Codex Note",
        path: "Notes/Codex.md",
      },
    ]);
  });

  it("preserves filter results in split localSearch sections", () => {
    const result = prepareLocalCodexSearchResult([
      {
        title: "Daily",
        path: "Daily.md",
        content: "Daily note",
        score: 0,
        includeInContext: true,
        isFilterResult: true,
        source: "time-filtered",
        matchType: "time-filtered",
      },
    ]);

    expect(result.formattedForLLM).toContain("<filterResults>");
    expect(result.formattedForLLM).toContain("<matchType>time-filtered</matchType>");
  });

  it("adds fallback sources when the response has no citations", () => {
    const response = addLocalCodexFallbackSources("Summary without sources.", [
      { title: "Codex Note", path: "Notes/Codex.md" },
    ]);

    expect(response).toContain("#### Sources");
    expect(response).toContain("[^1]: [[Codex Note]]");
  });
});
