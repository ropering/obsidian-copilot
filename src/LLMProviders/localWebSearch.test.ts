import { hasLocalWebSearchConfig, localWebSearch } from "@/LLMProviders/localWebSearch";
import { safeFetch } from "@/utils";

const mockGetSettings = jest.fn();

jest.mock("@/settings/model", () => ({
  getSettings: () => mockGetSettings(),
}));

jest.mock("@/encryptionService", () => ({
  getDecryptedKey: (key: string) => Promise.resolve(key),
}));

jest.mock("@/logger", () => ({
  logInfo: jest.fn(),
}));

jest.mock("@/utils", () => ({
  safeFetch: jest.fn(),
}));

const mockSafeFetch = safeFetch as jest.Mock;

/**
 * Create a minimal Response-like object for local web search tests.
 *
 * @param status - HTTP status.
 * @param json - JSON payload.
 * @param text - Text payload.
 * @returns Response-like object.
 */
function mockResponse(status: number, json: unknown, text: string = "") {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
    text: async () => text,
  };
}

describe("localWebSearch", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSettings.mockReturnValue({
      localWebSearchProvider: "searxng",
      localWebSearchUrl: "http://localhost:8080",
      localWebSearchApiKey: "",
    });
  });

  it("detects SearXNG configuration from URL only", () => {
    expect(
      hasLocalWebSearchConfig({
        localWebSearchProvider: "searxng",
        localWebSearchUrl: "http://localhost:8080",
        localWebSearchApiKey: "",
      } as any)
    ).toBe(true);

    expect(
      hasLocalWebSearchConfig({
        localWebSearchProvider: "searxng",
        localWebSearchUrl: "",
        localWebSearchApiKey: "",
      } as any)
    ).toBe(false);
  });

  it("detects API-key providers from the local web search API key", () => {
    expect(
      hasLocalWebSearchConfig({
        localWebSearchProvider: "firecrawl",
        localWebSearchUrl: "",
        localWebSearchApiKey: "fc-key",
      } as any)
    ).toBe(true);

    expect(
      hasLocalWebSearchConfig({
        localWebSearchProvider: "perplexity",
        localWebSearchUrl: "",
        localWebSearchApiKey: "",
      } as any)
    ).toBe(false);

    expect(
      hasLocalWebSearchConfig({
        localWebSearchProvider: "tavily",
        localWebSearchUrl: "",
        localWebSearchApiKey: "tvly-key",
      } as any)
    ).toBe(true);

    expect(
      hasLocalWebSearchConfig({
        localWebSearchProvider: "tavily",
        localWebSearchUrl: "",
        localWebSearchApiKey: "",
      } as any)
    ).toBe(false);
  });

  it("searches SearXNG with JSON format and formats results", async () => {
    mockSafeFetch.mockResolvedValueOnce(
      mockResponse(200, {
        results: [
          { title: "One", content: "First result", url: "https://example.com/1" },
          { title: "Two", content: "Second result", url: "https://example.com/2" },
        ],
      })
    );

    const result = await localWebSearch("obsidian copilot");

    expect(mockSafeFetch).toHaveBeenCalledWith(
      "http://localhost:8080/search?q=obsidian%20copilot&format=json",
      { method: "GET", throwOnHttpError: false }
    );
    expect(result.content).toContain("### One");
    expect(result.content).toContain("First result");
    expect(result.citations).toEqual(["https://example.com/1", "https://example.com/2"]);
  });

  it("searches Firecrawl with the local web search API key", async () => {
    mockGetSettings.mockReturnValue({
      localWebSearchProvider: "firecrawl",
      localWebSearchUrl: "",
      localWebSearchApiKey: "fc-key",
    });
    mockSafeFetch.mockResolvedValueOnce(
      mockResponse(200, {
        data: {
          web: [{ title: "Firecrawl", description: "Fire result", url: "https://fire.test" }],
        },
      })
    );

    const result = await localWebSearch("query");

    expect(mockSafeFetch).toHaveBeenCalledWith(
      "https://api.firecrawl.dev/v2/search",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer fc-key" }),
      })
    );
    expect(result.content).toContain("Fire result");
    expect(result.citations).toEqual(["https://fire.test"]);
  });

  it("searches Perplexity Sonar with the local web search API key", async () => {
    mockGetSettings.mockReturnValue({
      localWebSearchProvider: "perplexity",
      localWebSearchUrl: "",
      localWebSearchApiKey: "pplx-key",
    });
    mockSafeFetch.mockResolvedValueOnce(
      mockResponse(200, {
        choices: [{ message: { content: "Sonar answer" } }],
        citations: ["https://source.test"],
      })
    );

    const result = await localWebSearch("query");

    expect(mockSafeFetch).toHaveBeenCalledWith(
      "https://api.perplexity.ai/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer pplx-key" }),
      })
    );
    expect(result.content).toBe("Sonar answer");
    expect(result.citations).toEqual(["https://source.test"]);
  });

  it("searches Tavily with the local web search API key and formats results", async () => {
    mockGetSettings.mockReturnValue({
      localWebSearchProvider: "tavily",
      localWebSearchUrl: "",
      localWebSearchApiKey: "tvly-key",
    });
    mockSafeFetch.mockResolvedValueOnce(
      mockResponse(200, {
        results: [
          { title: "Tavily One", content: "First Tavily result", url: "https://tavily.test/1" },
          { title: "Tavily Two", content: "Second Tavily result", url: "https://tavily.test/2" },
        ],
      })
    );

    const result = await localWebSearch("query");

    expect(mockSafeFetch).toHaveBeenCalledWith(
      "https://api.tavily.com/search",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer tvly-key",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          query: "query",
          search_depth: "basic",
          max_results: 5,
          include_answer: false,
          include_images: false,
        }),
        throwOnHttpError: false,
      })
    );
    expect(result.content).toContain("### Tavily One");
    expect(result.content).toContain("First Tavily result");
    expect(result.citations).toEqual(["https://tavily.test/1", "https://tavily.test/2"]);
  });
});
