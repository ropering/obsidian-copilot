import type { ProjectConfig } from "@/aiParams";
import { hasLocalWebSearchConfig, localWebSearch } from "@/LLMProviders/localWebSearch";
import { logInfo } from "@/logger";
import { getMatchingPatterns, shouldIndexFile } from "@/search/searchUtils";
import { CanvasParser, MarkdownParser } from "@/tools/FileParserManager";
import { err2String } from "@/errorFormat";
import { App, TFile } from "obsidian";
import type { ProjectLoadTracker } from "./projectLoadTracker";

const LOCAL_CODEX_PROJECT_SUPPORTED_EXTENSIONS = new Set(["md", "base", "canvas"]);
const LOCAL_CODEX_PROJECT_CONTEXT_LIMIT = 600_000 * 4;

/**
 * Check whether a file extension is supported by local Codex project context.
 *
 * @param extension - File extension without a leading dot.
 * @returns True when the local loader can parse the file without Plus services.
 */
export function isLocalCodexProjectSupportedExtension(extension: string): boolean {
  return LOCAL_CODEX_PROJECT_SUPPORTED_EXTENSIONS.has(extension.toLowerCase());
}

/**
 * Parse configured project URL lines into non-empty strings.
 *
 * @param value - Raw multiline setting value.
 * @returns Trimmed URL list.
 */
function parseProjectList(value?: string): string[] {
  return (value || "")
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Build metadata and content for one supported project file.
 *
 * @param file - File to parse.
 * @param app - Obsidian app instance.
 * @returns Prompt-ready file context.
 */
async function parseSupportedProjectFile(file: TFile, app: App): Promise<string> {
  const parser = file.extension === "canvas" ? new CanvasParser() : new MarkdownParser();
  const [stat, content] = await Promise.all([
    app.vault.adapter.stat(file.path),
    parser.parseFile(file, app.vault),
  ]);

  const metadata = `[[${file.basename}]]
path: ${file.path}
type: ${file.extension}
created: ${stat ? new Date(stat.ctime).toISOString() : "unknown"}
modified: ${stat ? new Date(stat.mtime).toISOString() : "unknown"}`;

  return `${metadata}\n\n${content}`;
}

/**
 * Build a compact web context block from a local web search result.
 *
 * @param url - Source URL configured on the project.
 * @param content - Search result content.
 * @param citations - Search result citations.
 * @returns Prompt-ready web context.
 */
function formatLocalProjectWebContext(url: string, content: string, citations: string[]): string {
  const citationBlock =
    citations.length > 0
      ? `\n\nCitations:\n${citations.map((item) => `- ${item}`).join("\n")}`
      : "";
  return `Web context requested for ${url}\n\n${content}${citationBlock}`;
}

/**
 * Format local project context using the same top-level ProjectContext wrapper
 * shape as the Plus project path.
 *
 * @param contextParts - Named context sections.
 * @returns ProjectContext prompt block.
 */
export function formatLocalCodexProjectContext(contextParts: {
  markdownContext?: string;
  webContexts?: string[];
}): string {
  const sections: string[] = [];

  if (contextParts.markdownContext?.trim()) {
    sections.push(`## Markdown Files\n${contextParts.markdownContext}`);
  }

  if (contextParts.webContexts?.length) {
    sections.push(`## Web Content\n${contextParts.webContexts.join("\n\n")}`);
  }

  return `
# Project Context
The following information is the relevant local context for this project. Use this information to inform your responses when appropriate:

<ProjectContext>
${sections.join("\n\n")}
</ProjectContext>
`.trim();
}

/**
 * Local Project context loader for Desktop Codex CLI.
 *
 * This intentionally avoids Brevilabs docs4llm/url4llm/youtube4llm/twitter4llm
 * and only uses vault-readable files plus the configured local web search provider.
 */
export class LocalCodexProjectContextLoader {
  private loadTracker?: ProjectLoadTracker;

  /**
   * Create a local Codex project context loader.
   *
   * @param app - Obsidian app instance.
   */
  constructor(private readonly app: App) {}

  /**
   * Lazily resolve the shared ProjectLoadTracker to avoid adding aiParams to
   * this module's top-level dependency graph.
   *
   * @returns Shared ProjectLoadTracker instance.
   */
  private async getLoadTracker(): Promise<ProjectLoadTracker> {
    if (!this.loadTracker) {
      const { ProjectLoadTracker } = await import("./projectLoadTracker");
      this.loadTracker = ProjectLoadTracker.getInstance(this.app);
    }
    return this.loadTracker;
  }

  /**
   * Lazily update the project loading atom.
   *
   * @param loading - New loading state.
   */
  private async setProjectLoading(loading: boolean): Promise<void> {
    const { setProjectLoading } = await import("@/aiParams");
    setProjectLoading(loading);
  }

  /**
   * Return all vault files selected by the project inclusion/exclusion rules.
   *
   * @param project - Project configuration.
   * @returns Matching project files.
   */
  private getProjectAllFiles(project: ProjectConfig): TFile[] {
    const { inclusions, exclusions } = getMatchingPatterns({
      inclusions: project.contextSource.inclusions,
      exclusions: project.contextSource.exclusions,
      isProject: true,
    });

    return this.app.vault
      .getFiles()
      .filter((file) => shouldIndexFile(file, inclusions, exclusions, true));
  }

  /**
   * Mark unsupported local Project context items as failed without calling Plus APIs.
   *
   * @param files - Matching project files.
   * @param youtubeUrls - Configured YouTube URLs.
   */
  private markUnsupportedItems(
    files: TFile[],
    youtubeUrls: string[],
    loadTracker: ProjectLoadTracker
  ): void {
    files
      .filter((file) => !isLocalCodexProjectSupportedExtension(file.extension))
      .forEach((file) => {
        loadTracker.makeItemFailed(
          file.path,
          "nonMd",
          `local mode unsupported: .${file.extension} requires Copilot Plus document conversion`
        );
      });

    youtubeUrls.forEach((url) => {
      loadTracker.makeItemFailed(
        url,
        "youtube",
        "local mode unsupported: YouTube context requires Copilot Plus or a self-host transcript service"
      );
    });
  }

  /**
   * Load supported project context without using Copilot Plus services.
   *
   * @param project - Project configuration.
   * @returns ProjectContext prompt block.
   */
  public async load(project: ProjectConfig): Promise<string> {
    const loadTracker = await this.getLoadTracker();
    loadTracker.clearAllLoadStates();
    await this.setProjectLoading(true);

    try {
      const projectAllFiles = this.getProjectAllFiles(project);
      const webUrls = parseProjectList(project.contextSource.webUrls);
      const youtubeUrls = parseProjectList(project.contextSource.youtubeUrls);
      loadTracker.preComputeAllItems(project, projectAllFiles);
      this.markUnsupportedItems(projectAllFiles, youtubeUrls, loadTracker);

      const supportedFiles = projectAllFiles.filter((file) =>
        isLocalCodexProjectSupportedExtension(file.extension)
      );

      const fileContexts = await Promise.all(
        supportedFiles.map((file) =>
          loadTracker
            .executeWithProcessTracking(file.path, "md", () =>
              parseSupportedProjectFile(file, this.app)
            )
            .catch(
              (error) =>
                `[[${file.basename}]]\npath: ${file.path}\ntype: ${file.extension}\n\n[Error: ${err2String(error)}]`
            )
        )
      );

      const webContexts = await Promise.all(
        webUrls.map((url) =>
          loadTracker
            .executeWithProcessTracking(url, "web", async () => {
              if (!hasLocalWebSearchConfig()) {
                throw new Error("local web search is not configured");
              }
              const result = await localWebSearch(url);
              return formatLocalProjectWebContext(url, result.content, result.citations);
            })
            .catch((error) => `Web context requested for ${url}\n\n[Error: ${err2String(error)}]`)
        )
      );

      let context = formatLocalCodexProjectContext({
        markdownContext: fileContexts.join("\n\n"),
        webContexts,
      });

      if (context.length > LOCAL_CODEX_PROJECT_CONTEXT_LIMIT) {
        logInfo(
          `[LocalCodexProjectContext] Truncating project context from ${context.length} to ${LOCAL_CODEX_PROJECT_CONTEXT_LIMIT} chars`
        );
        context = context.slice(0, LOCAL_CODEX_PROJECT_CONTEXT_LIMIT);
      }

      return context;
    } catch (error) {
      return formatLocalCodexProjectContext({
        markdownContext: `[Error: Could not load local project context. ${err2String(error)}]`,
      });
    } finally {
      await this.setProjectLoading(false);
    }
  }
}
