import { getDecryptedKey } from "@/encryptionService";
import { logInfo } from "@/logger";
import { getSettings, type CopilotSettings } from "@/settings/model";
import { safeFetch } from "@/utils";

const FIRECRAWL_SEARCH_URL = "https://api.firecrawl.dev/v2/search";
const PERPLEXITY_CHAT_URL = "https://api.perplexity.ai/chat/completions";
const TAVILY_SEARCH_URL = "https://api.tavily.com/search";

export type LocalWebSearchProvider = "searxng" | "firecrawl" | "perplexity" | "tavily";

export interface LocalWebSearchResult {
  content: string;
  citations: string[];
}

interface FirecrawlSearchResult {
  title?: string;
  description?: string;
  url?: string;
}

interface SearxngSearchResult {
  title?: string;
  content?: string;
  url?: string;
  engine?: string;
}

interface TavilySearchResult {
  title?: string;
  content?: string;
  url?: string;
}

interface FormattedSearchResult {
  title?: string;
  snippet?: string;
  url?: string;
}

/**
 * Normalize a configured service URL by trimming whitespace and trailing slashes.
 *
 * @param url - Raw URL from settings.
 * @returns Normalized URL without trailing slash.
 */
function normalizeServiceUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * Check whether local web search has enough configuration to run.
 *
 * @param settings - Optional settings snapshot.
 * @returns True when the selected local web search provider is configured.
 */
export function hasLocalWebSearchConfig(settings: Readonly<CopilotSettings> = getSettings()) {
  switch (settings.localWebSearchProvider) {
    case "searxng":
      return normalizeServiceUrl(settings.localWebSearchUrl).length > 0;
    case "firecrawl":
    case "perplexity":
    case "tavily":
      return settings.localWebSearchApiKey.trim().length > 0;
    default:
      return false;
  }
}

/**
 * Convert web result fields to a stable prompt-ready content block.
 *
 * @param results - Search results to format.
 * @returns Text block for tool output.
 */
function formatSearchResults(results: FormattedSearchResult[]): string {
  return results
    .map((item) => {
      const title = item.title || "Untitled";
      const description = item.snippet || "";
      const url = item.url || "";
      return `### ${title}\n${description}\nSource: ${url}`;
    })
    .join("\n\n");
}

/**
 * Search with a SearXNG instance that exposes JSON results.
 *
 * @param query - Search query.
 * @param baseUrl - SearXNG base URL.
 * @returns Search result content and citations.
 */
async function searxngSearch(query: string, baseUrl: string): Promise<LocalWebSearchResult> {
  const startedAt = Date.now();
  const normalizedUrl = normalizeServiceUrl(baseUrl);
  if (!normalizedUrl) {
    throw new Error("SearXNG URL is required for local web search.");
  }

  const url = `${normalizedUrl}/search?q=${encodeURIComponent(query)}&format=json`;
  const response = await safeFetch(url, { method: "GET", throwOnHttpError: false });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SearXNG search failed (${response.status}): ${text}`);
  }

  const json = await response.json();
  const results: SearxngSearchResult[] = Array.isArray(json?.results)
    ? json.results.slice(0, 5)
    : [];
  const citations = results.map((item) => item.url).filter((url): url is string => Boolean(url));
  const elapsed = Date.now() - startedAt;
  logInfo(`[localWebSearch] SearXNG: ${results.length} results in ${elapsed}ms`);

  return {
    content: formatSearchResults(
      results.map((item) => ({
        title: item.title,
        snippet: item.content,
        url: item.url,
      }))
    ),
    citations,
  };
}

/**
 * Search with Firecrawl using the user's local web search API key.
 *
 * @param query - Search query.
 * @param apiKey - Firecrawl API key.
 * @returns Search result content and citations.
 */
async function firecrawlSearch(query: string, apiKey: string): Promise<LocalWebSearchResult> {
  const startedAt = Date.now();
  const response = await safeFetch(FIRECRAWL_SEARCH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, limit: 5 }),
    throwOnHttpError: false,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Firecrawl search failed (${response.status}): ${text}`);
  }

  const json = await response.json();
  const rawData = json?.data;
  const results: FirecrawlSearchResult[] = Array.isArray(rawData)
    ? rawData
    : Array.isArray(rawData?.web)
      ? rawData.web
      : [];
  const citations = results.map((item) => item.url).filter((url): url is string => Boolean(url));
  const elapsed = Date.now() - startedAt;
  logInfo(`[localWebSearch] Firecrawl: ${results.length} results in ${elapsed}ms`);

  return {
    content: formatSearchResults(
      results.map((item) => ({
        title: item.title,
        snippet: item.description,
        url: item.url,
      }))
    ),
    citations,
  };
}

/**
 * Search with Perplexity Sonar using the user's local web search API key.
 *
 * @param query - Search query.
 * @param apiKey - Perplexity API key.
 * @returns Search result content and citations.
 */
async function perplexitySearch(query: string, apiKey: string): Promise<LocalWebSearchResult> {
  const response = await safeFetch(PERPLEXITY_CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "sonar",
      messages: [{ role: "user", content: query }],
    }),
    throwOnHttpError: false,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Perplexity Sonar search failed (${response.status}): ${text}`);
  }

  const json = await response.json();
  const content = json?.choices?.[0]?.message?.content ?? "";
  const citations: string[] = Array.isArray(json?.citations) ? json.citations : [];

  return { content, citations };
}

/**
 * Search with Tavily using the user's local web search API key.
 *
 * @param query - Search query.
 * @param apiKey - Tavily API key.
 * @param settings - Current settings snapshot with Tavily options.
 * @returns Search result content and citations.
 */
async function tavilySearch(
  query: string,
  apiKey: string,
  settings: Pick<
    CopilotSettings,
    "localWebSearchTavilySearchDepth" | "localWebSearchTavilyMaxResults"
  >
): Promise<LocalWebSearchResult> {
  const startedAt = Date.now();
  const response = await safeFetch(TAVILY_SEARCH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      search_depth: settings.localWebSearchTavilySearchDepth,
      max_results: settings.localWebSearchTavilyMaxResults,
      include_answer: false,
      include_images: false,
    }),
    throwOnHttpError: false,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Tavily search failed (${response.status}): ${text}`);
  }

  const json = await response.json();
  const results: TavilySearchResult[] = Array.isArray(json?.results) ? json.results : [];
  const citations = results.map((item) => item.url).filter((url): url is string => Boolean(url));
  const elapsed = Date.now() - startedAt;
  logInfo(`[localWebSearch] Tavily: ${results.length} results in ${elapsed}ms`);

  return {
    content: formatSearchResults(
      results.map((item) => ({
        title: item.title,
        snippet: item.content,
        url: item.url,
      }))
    ),
    citations,
  };
}

/**
 * Run local web search through the provider selected in settings.
 *
 * @param query - Search query.
 * @returns Search result content and citations.
 */
export async function localWebSearch(query: string): Promise<LocalWebSearchResult> {
  const settings = getSettings();
  switch (settings.localWebSearchProvider) {
    case "firecrawl":
      return firecrawlSearch(query, await getDecryptedKey(settings.localWebSearchApiKey));
    case "perplexity":
      return perplexitySearch(query, await getDecryptedKey(settings.localWebSearchApiKey));
    case "tavily":
      return tavilySearch(query, await getDecryptedKey(settings.localWebSearchApiKey), settings);
    case "searxng":
    default:
      return searxngSearch(query, settings.localWebSearchUrl);
  }
}
