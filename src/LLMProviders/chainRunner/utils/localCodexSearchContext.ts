import { MAX_CHARS_FOR_LOCAL_SEARCH_CONTEXT } from "@/constants";
import { logInfo, logWarn } from "@/logger";
import { getSettings } from "@/settings/model";
import { ToolResultFormatter } from "@/tools/ToolResultFormatter";
import {
  addFallbackSources,
  formatSourceCatalog,
  getLocalSearchGuidance,
  sanitizeContentForCitations,
  type SourceCatalogEntry,
} from "./citationUtils";
import { buildLocalSearchInnerContent, wrapLocalSearchPayload } from "./cicPromptUtils";
import {
  extractSourcesFromSearchResults,
  formatMetadataOnlyDocuments,
  formatQualitySummary,
  formatSearchResultStringForLLM,
  formatSearchResultsForLLM,
  formatSplitSearchResultsForLLM,
  generateQualitySummary,
  isFilterOnlyResults,
  isTimeDominantResults,
  logSearchResultsDebugTable,
} from "./searchResultUtils";

export interface LocalCodexSearchContext {
  formattedForLLM: string;
  formattedForDisplay: string;
  sources: { title: string; path: string; score: number; explanation?: any }[];
  fallbackSources: { title?: string; path?: string }[];
}

/**
 * Convert unknown localSearch output into a parsed document array.
 *
 * @param output - Raw output from localSearchTool or a serialized result.
 * @returns Parsed local search documents, or null when the shape is invalid.
 */
function parseLocalSearchDocuments(output: unknown): any[] | null {
  const parsed = typeof output === "string" ? JSON.parse(output) : output;
  if (
    parsed &&
    typeof parsed === "object" &&
    (parsed as { type?: string }).type === "local_search" &&
    Array.isArray((parsed as { documents?: unknown }).documents)
  ) {
    return (parsed as { documents: any[] }).documents;
  }
  return null;
}

/**
 * Prepare localSearch documents using the same citation and source-catalog
 * conventions used by the Plus runner.
 *
 * @param documents - Raw localSearch documents.
 * @param timeExpression - Optional time expression for time-filtered searches.
 * @returns XML-wrapped localSearch context and fallback source metadata.
 */
export function prepareLocalCodexSearchResult(
  documents: any[],
  timeExpression = ""
): { formattedForLLM: string; fallbackSources: { title?: string; path?: string }[] } {
  const settings = getSettings();
  const includedDocs = documents.filter((doc) => doc.includeInContext !== false);
  const qualityHeader = formatQualitySummary(generateQualitySummary(includedDocs));
  const filterOnly = isFilterOnlyResults(includedDocs);
  const timeDominant = isTimeDominantResults(includedDocs);

  let tier1Docs: any[];
  let tier2Docs: any[];
  if (timeDominant) {
    const sorted = [...includedDocs].sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
    tier1Docs = sorted.slice(0, settings.maxSourceChunks);
    tier2Docs = sorted.slice(settings.maxSourceChunks);
  } else if (filterOnly) {
    tier1Docs = [];
    tier2Docs = includedDocs;
  } else if (includedDocs.length > settings.maxSourceChunks) {
    tier1Docs = includedDocs.slice(0, settings.maxSourceChunks);
    tier2Docs = includedDocs.slice(settings.maxSourceChunks);
  } else {
    tier1Docs = includedDocs;
    tier2Docs = [];
  }

  const totalContentLength = tier1Docs.reduce((sum, doc) => sum + (doc.content?.length || 0), 0);
  let processedDocs = tier1Docs;
  if (totalContentLength > MAX_CHARS_FOR_LOCAL_SEARCH_CONTEXT) {
    const truncationRatio = MAX_CHARS_FOR_LOCAL_SEARCH_CONTEXT / totalContentLength;
    logInfo(
      "[LocalCodexSearchContext] Truncating localSearch context. Truncation ratio:",
      truncationRatio
    );
    processedDocs = tier1Docs.map((doc) => ({
      ...doc,
      content:
        doc.content?.slice(0, Math.floor((doc.content?.length || 0) * truncationRatio)) || "",
    }));
  }

  const withIds = processedDocs.map((doc, idx) => ({
    ...doc,
    __sourceId: idx + 1,
    content: sanitizeContentForCitations(doc.content || ""),
  }));

  const filterDocs = withIds.filter((doc: any) => doc.isFilterResult === true);
  const searchDocs = withIds.filter((doc: any) => doc.isFilterResult !== true);
  const hasFilterResults = filterDocs.length > 0;

  let formattedContent = hasFilterResults
    ? formatSplitSearchResultsForLLM(filterDocs, searchDocs)
    : tier1Docs.length === 0 && tier2Docs.length > 0
      ? formatMetadataOnlyDocuments(tier2Docs)
      : formatSearchResultsForLLM(withIds);

  if (tier1Docs.length > 0 && tier2Docs.length > 0) {
    formattedContent = `${formattedContent}\n\n${formatMetadataOnlyDocuments(tier2Docs)}`;
  }

  const sourceEntries: SourceCatalogEntry[] = withIds
    .slice(0, Math.min(20, withIds.length))
    .map((doc: any) => ({
      title: doc.title || doc.path || "Untitled",
      path: doc.path || doc.title || "",
    }));
  const catalogLines = formatSourceCatalog(sourceEntries);
  const fallbackSources = withIds.slice(0, Math.min(20, withIds.length)).map((doc: any) => ({
    title: doc.title || doc.path || "Untitled",
    path: doc.path || undefined,
  }));

  const guidance = getLocalSearchGuidance(catalogLines, settings.enableInlineCitations).trim();
  const documentsSection = buildLocalSearchInnerContent(
    "Answer the question based only on the following context:",
    formattedContent
  );
  const fullInnerContent = guidance
    ? `${qualityHeader}\n\n${documentsSection}\n\n${guidance}`
    : `${qualityHeader}\n\n${documentsSection}`;

  return {
    formattedForLLM: wrapLocalSearchPayload(fullInnerContent, timeExpression),
    fallbackSources,
  };
}

/**
 * Format a localSearch tool result for Desktop Codex local modes.
 *
 * @param output - Raw localSearch tool output.
 * @param success - Whether the tool call succeeded.
 * @param timeExpression - Optional time expression for contextualizing results.
 * @returns Formatted LLM context, display text, and source metadata.
 */
export function formatLocalCodexSearchContext(
  output: unknown,
  success: boolean,
  timeExpression = ""
): LocalCodexSearchContext {
  let sources: LocalCodexSearchContext["sources"] = [];
  let fallbackSources: LocalCodexSearchContext["fallbackSources"] = [];
  let formattedForLLM: string;
  let formattedForDisplay: string;

  if (!success) {
    const resultText = typeof output === "string" ? output : JSON.stringify(output);
    formattedForLLM = "<localSearch>\nSearch failed.\n</localSearch>";
    formattedForDisplay = `Search failed: ${resultText}`;
    return { formattedForLLM, formattedForDisplay, sources, fallbackSources };
  }

  try {
    const searchResults = parseLocalSearchDocuments(output);
    if (!Array.isArray(searchResults)) {
      formattedForLLM = "<localSearch>\nInvalid search results format.\n</localSearch>";
      formattedForDisplay = "Search results were in an unexpected format.";
      return { formattedForLLM, formattedForDisplay, sources, fallbackSources };
    }

    logSearchResultsDebugTable(searchResults);
    sources = extractSourcesFromSearchResults(searchResults);

    const prepared = prepareLocalCodexSearchResult(searchResults, timeExpression);
    formattedForLLM = prepared.formattedForLLM;
    fallbackSources = prepared.fallbackSources;
    formattedForDisplay = ToolResultFormatter.format("localSearch", formattedForLLM);
  } catch (error) {
    logWarn("[LocalCodexSearchContext] Failed to parse localSearch results:", error);
    const resultText = typeof output === "string" ? output : JSON.stringify(output);
    const formatted = formatSearchResultStringForLLM(resultText);
    formattedForLLM = timeExpression
      ? `<localSearch timeRange="${timeExpression}">\n${formatted}\n</localSearch>`
      : `<localSearch>\n${formatted}\n</localSearch>`;
    formattedForDisplay = ToolResultFormatter.format("localSearch", formattedForLLM);
  }

  return { formattedForLLM, formattedForDisplay, sources, fallbackSources };
}

/**
 * Add fallback note sources to a Codex response when the model used localSearch
 * context but forgot to emit a Sources section.
 *
 * @param response - Raw model response.
 * @param fallbackSources - Source metadata from the localSearch context.
 * @returns Response with fallback sources when needed.
 */
export function addLocalCodexFallbackSources(
  response: string,
  fallbackSources: { title?: string; path?: string }[]
): string {
  return addFallbackSources(response, fallbackSources, getSettings().enableInlineCitations);
}
