import { getModelKey } from "@/aiParams";
import type { CustomModel } from "@/aiParams";
import { ChatModelProviders, LOADING_MESSAGES } from "@/constants";
import { LayerToMessagesConverter } from "@/context/LayerToMessagesConverter";
import { hasLocalWebSearchConfig, localWebSearch } from "@/LLMProviders/localWebSearch";
import { logInfo, logWarn } from "@/logger";
import { getSettings } from "@/settings/model";
import { editFileTool, writeFileTool } from "@/tools/ComposerTools";
import { updateMemoryTool } from "@/tools/memoryTools";
import { localSearchTool } from "@/tools/SearchTools";
import { ToolManager } from "@/tools/toolManager";
import type { ChatMessage, ResponseMetadata } from "@/types/message";
import { extractTextFromChunk, findCustomModel, withSuppressedTokenWarnings } from "@/utils";
import { BaseChainRunner } from "./BaseChainRunner";
import { loadAndAddChatHistory } from "./utils/chatHistoryUtils";
import { recordPromptPayload } from "./utils/promptPayloadRecorder";
import { ThinkBlockStreamer } from "./utils/ThinkBlockStreamer";

export const LOCAL_CODEX_TOOL_COMMANDS = [
  "@vault",
  "@websearch",
  "@web",
  "@composer",
  "@memory",
] as const;

type LocalCodexToolCommand = (typeof LOCAL_CODEX_TOOL_COMMANDS)[number];

export interface LocalCodexToolResult {
  tool: string;
  output: string;
  isError?: boolean;
}

export type LocalCodexComposerExecutor = (
  toolName: "writeFile" | "editFile",
  args: Record<string, string>
) => Promise<unknown>;

export const LOCAL_CODEX_SYSTEM_INSTRUCTIONS = `# Desktop Codex Local Tools Mode

You are running in a local tools mode where Obsidian Copilot pre-executes local tools only when the user explicitly includes @vault, @websearch, @web, @composer, or @memory.
You cannot call tools yourself in this mode. Do not request, simulate, or invent additional tool calls.
Do not use Copilot Plus, Brevilabs, or any remote tool gateway.

## Source Priority
- Use explicit user-provided context first.
- When local tool results are present, treat them as the primary evidence for the parts of the answer they cover.
- If no relevant local tool result is present, answer normally from the conversation and clearly state important limitations.

## Citation Integrity
- For webSearch results, use only URLs and citations included in the webSearch result as web sources.
- For vault/localSearch results, only cite or mention notes that appear in the localSearch result.
- Never fabricate sources, URLs, note titles, web searches, vault searches, or tool outputs.
- If a tool result reports an error, explain that limitation clearly.

## Response Policy
- Return the final user-facing answer only.
- Do not expose raw <tool_result> XML, JSON payloads, or process logs unless the user explicitly asks to inspect them.`;

const LOCAL_CODEX_COMPOSER_INSTRUCTIONS = `When @composer is present, you may request local file changes with these XML blocks.

For a new file or full-file rewrite:
<writeFile>
<path>path/to/file.md</path>
<content>full target file content</content>
</writeFile>

For a targeted edit:
<editFile>
<path>path/to/file.md</path>
<oldText>exact text to replace</oldText>
<newText>replacement text</newText>
</editFile>

Use vault-relative paths. Prefer editFile for small precise changes and writeFile for new files or full rewrites.`;

/**
 * Checks whether a model configuration points at the Desktop Codex CLI provider.
 *
 * @param model - Model configuration to check.
 * @returns True when the model uses the Desktop Codex CLI provider.
 */
export function isDesktopCodexCliModelConfig(
  model?: Pick<CustomModel, "provider"> | null
): boolean {
  return model?.provider === ChatModelProviders.DESKTOP_CODEX_CLI;
}

/**
 * Returns true when the given message contains a local Codex @tool command.
 *
 * @param message - User message to inspect.
 * @param command - Tool command to search for.
 * @returns True when the command is present as a whitespace-delimited token.
 */
export function hasLocalCodexToolCommand(message: string, command: LocalCodexToolCommand): boolean {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\s)${escaped}(?=\\s|$)`, "i").test(message);
}

/**
 * Removes supported local Codex @tool commands from a message.
 *
 * @param message - Raw user message.
 * @returns User message without supported @tool tokens.
 */
export function removeLocalCodexToolCommands(message: string): string {
  return message
    .replace(/(^|\s)@(vault|websearch|web|composer|memory)(?=\s|$)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extracts language-agnostic salient terms for local vault search.
 *
 * @param query - Cleaned user query.
 * @returns Up to ten terms that can help the vault search retriever.
 */
export function extractLocalCodexSalientTerms(query: string): string[] {
  return query
    .split(/[\s\p{P}]+/u)
    .filter(
      (word) =>
        word.length >= 3 || (word.length >= 2 && [...word].some((char) => char.charCodeAt(0) > 127))
    )
    .slice(0, 10);
}

/**
 * Builds a stable tool-result prompt section for the Codex CLI request.
 *
 * @param results - Tool results collected before invoking Codex.
 * @returns Prompt text containing all local tool results.
 */
export function formatLocalCodexToolResults(results: LocalCodexToolResult[]): string {
  if (results.length === 0) {
    return "";
  }

  const rendered = results
    .map((result) => {
      const status = result.isError ? ' status="error"' : "";
      return `<tool_result name="${result.tool}"${status}>\n${result.output}\n</tool_result>`;
    })
    .join("\n\n");

  return `# Local tool results\n\n${rendered}`;
}

/**
 * Creates the local-only web-search failure result used when self-host search is unavailable.
 *
 * @returns A structured tool result with the required user-facing error.
 */
export function createLocalWebSearchUnavailableResult(): LocalCodexToolResult {
  return {
    tool: "webSearch",
    output: "local web search is not configured",
    isError: true,
  };
}

/**
 * Converts unknown tool output into readable text.
 *
 * @param output - Raw tool output.
 * @returns Stringified output suitable for prompt inclusion.
 */
function stringifyToolOutput(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output, null, 2);
}

/**
 * Extracts a simple XML tag body from a composer block.
 *
 * @param block - XML-ish composer block.
 * @param tag - Tag name to extract.
 * @returns Trimmed tag content, or undefined when missing.
 */
function extractTagContent(block: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i").exec(block);
  return match?.[1]?.trim();
}

/**
 * Runs composer XML blocks through the existing preview tools and replaces the
 * blocks with the resulting tool status.
 *
 * @param text - Full LLM response text.
 * @param executor - Optional executor for tests.
 * @returns Response text with action blocks replaced by preview results.
 */
export async function processLocalCodexComposerBlocks(
  text: string,
  executor: LocalCodexComposerExecutor = async (toolName, args) => {
    const tool = toolName === "writeFile" ? writeFileTool : editFileTool;
    return ToolManager.callTool(tool, args);
  }
): Promise<string> {
  const blockRegex = /<(writeFile|editFile)>\s*([\s\S]*?)<\/\1>/gi;
  let processed = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = blockRegex.exec(text)) !== null) {
    processed += text.slice(lastIndex, match.index);

    const toolName = match[1] as "writeFile" | "editFile";
    const blockContent = match[2];
    const path = extractTagContent(blockContent, "path");

    let replacement: string;
    try {
      if (!path) {
        throw new Error(`${toolName} block is missing <path>`);
      }

      if (toolName === "writeFile") {
        const content = extractTagContent(blockContent, "content");
        if (content === undefined) {
          throw new Error("writeFile block is missing <content>");
        }
        const result = await executor("writeFile", { path, content });
        replacement = `\n\nwriteFile result:\n${stringifyToolOutput(result)}\n`;
      } else {
        const oldText = extractTagContent(blockContent, "oldText");
        const newText = extractTagContent(blockContent, "newText");
        if (oldText === undefined || newText === undefined) {
          throw new Error("editFile block is missing <oldText> or <newText>");
        }
        const result = await executor("editFile", { path, oldText, newText });
        replacement = `\n\neditFile result:\n${stringifyToolOutput(result)}\n`;
      }
    } catch (error) {
      replacement = `\n\n${toolName} result:\n${error instanceof Error ? error.message : String(error)}\n`;
    }

    processed += replacement;
    lastIndex = blockRegex.lastIndex;
  }

  processed += text.slice(lastIndex);
  return processed.trim();
}

/**
 * Chain runner for local explicit @tool execution backed by Desktop Codex CLI.
 */
export class DesktopCodexCliToolsChainRunner extends BaseChainRunner {
  /**
   * Ensures the selected response model is the Desktop Codex CLI provider.
   */
  private assertDesktopCodexCliModelSelected(): void {
    const settings = getSettings();
    const modelKey = getModelKey();
    const currentModel = findCustomModel(modelKey, settings.activeModels);

    if (!isDesktopCodexCliModelConfig(currentModel)) {
      throw new Error(
        "codex tools (local) requires the selected chat model to be Desktop Codex CLI Chat."
      );
    }
  }

  /**
   * Extracts the clean user query used for local tool execution.
   *
   * @param userMessage - Current chat message.
   * @returns Raw L5 user text when available, otherwise a best-effort fallback.
   */
  private getMessageForToolAnalysis(userMessage: ChatMessage): string {
    const l5Text = userMessage.contextEnvelope?.layers.find(
      (layer) => layer.id === "L5_USER"
    )?.text;
    return l5Text || userMessage.originalMessage || userMessage.message;
  }

  /**
   * Executes supported local @tool commands before invoking Codex.
   *
   * @param messageForAnalysis - Raw user message text.
   * @param updateLoadingMessage - Optional loading-message callback.
   * @returns Tool results to inject into the prompt.
   */
  private async executeLocalTools(
    messageForAnalysis: string,
    updateLoadingMessage?: (message: string) => void
  ): Promise<LocalCodexToolResult[]> {
    const results: LocalCodexToolResult[] = [];
    const cleanQuery = removeLocalCodexToolCommands(messageForAnalysis);
    const lowerMessage = messageForAnalysis.toLowerCase();

    if (hasLocalCodexToolCommand(lowerMessage, "@vault")) {
      updateLoadingMessage?.(LOADING_MESSAGES.READING_FILES);
      try {
        const output = await ToolManager.callTool(localSearchTool, {
          query: cleanQuery,
          salientTerms: extractLocalCodexSalientTerms(cleanQuery),
        });
        results.push({ tool: "localSearch", output: stringifyToolOutput(output) });
      } catch (error) {
        results.push({
          tool: "localSearch",
          output: `Vault search failed: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        });
      }
    }

    if (
      hasLocalCodexToolCommand(lowerMessage, "@websearch") ||
      hasLocalCodexToolCommand(lowerMessage, "@web")
    ) {
      updateLoadingMessage?.(LOADING_MESSAGES.SEARCHING_WEB);
      if (hasLocalWebSearchConfig()) {
        try {
          const output = await localWebSearch(cleanQuery);
          results.push({
            tool: "webSearch",
            output: stringifyToolOutput([{ type: "web_search", ...output }]),
          });
        } catch (error) {
          results.push({
            tool: "webSearch",
            output: `Local web search failed: ${error instanceof Error ? error.message : String(error)}`,
            isError: true,
          });
        }
      } else {
        results.push(createLocalWebSearchUnavailableResult());
      }
    }

    if (hasLocalCodexToolCommand(lowerMessage, "@memory")) {
      const settings = getSettings();
      if (settings.enableSavedMemory) {
        try {
          const output = await ToolManager.callTool(updateMemoryTool, {
            statement: cleanQuery,
          });
          results.push({ tool: "updateMemory", output: stringifyToolOutput(output) });
        } catch (error) {
          results.push({
            tool: "updateMemory",
            output: `Memory update failed: ${error instanceof Error ? error.message : String(error)}`,
            isError: true,
          });
        }
      } else {
        results.push({
          tool: "updateMemory",
          output: "saved memory is not enabled",
          isError: true,
        });
      }
    }

    return results;
  }

  /**
   * Creates the final LangChain message list for Codex CLI.
   *
   * @param userMessage - Current user message with context envelope.
   * @param toolResults - Local tool results to inject.
   * @param includeComposerInstructions - Whether composer XML instructions are needed.
   * @returns Messages ready for the selected chat model.
   */
  private async constructMessages(
    userMessage: ChatMessage,
    toolResults: LocalCodexToolResult[],
    includeComposerInstructions: boolean
  ): Promise<any[]> {
    if (!userMessage.contextEnvelope) {
      throw new Error(
        "[DesktopCodexCliTools] Context envelope is required but not available. Cannot proceed."
      );
    }

    const baseMessages = LayerToMessagesConverter.convert(userMessage.contextEnvelope, {
      includeSystemMessage: true,
      mergeUserContent: true,
      debug: false,
    });

    const messages: any[] = [];
    const systemMessage = baseMessages.find((message) => message.role === "system");
    if (systemMessage) {
      messages.push({
        ...systemMessage,
        content: `${systemMessage.content}\n\n${LOCAL_CODEX_SYSTEM_INSTRUCTIONS}`,
      });
    } else {
      messages.push({
        role: "system",
        content: LOCAL_CODEX_SYSTEM_INSTRUCTIONS,
      });
    }

    await loadAndAddChatHistory(this.chainManager.memoryManager.getMemory(), messages);

    const userMessageContent = baseMessages.find((message) => message.role === "user");
    if (userMessageContent) {
      const localToolResults = formatLocalCodexToolResults(toolResults);
      const composerInstructions = includeComposerInstructions
        ? `\n\n# Local composer instructions\n\n${LOCAL_CODEX_COMPOSER_INSTRUCTIONS}`
        : "";
      const augmentedText = [userMessageContent.content, localToolResults, composerInstructions]
        .filter(Boolean)
        .join("\n\n");

      if (userMessage.content && Array.isArray(userMessage.content)) {
        const updatedContent = userMessage.content.map((item: any) => {
          if (item.type === "text") {
            return { ...item, text: augmentedText };
          }
          return item;
        });
        messages.push({ role: "user", content: updatedContent });
      } else {
        messages.push({ ...userMessageContent, content: augmentedText });
      }
    }

    return messages;
  }

  /**
   * Runs local @tool preprocessing and streams the Codex CLI response into the
   * existing chat message lifecycle.
   *
   * @param userMessage - User message with processed context.
   * @param abortController - Abort controller for the current generation.
   * @param updateCurrentAiMessage - Streaming UI update callback.
   * @param addMessage - Final chat message callback.
   * @param options - Runtime options passed by the chat flow.
   * @returns Final response content.
   */
  async run(
    userMessage: ChatMessage,
    abortController: AbortController,
    updateCurrentAiMessage: (message: string) => void,
    addMessage: (message: ChatMessage) => void,
    options: {
      debug?: boolean;
      ignoreSystemMessage?: boolean;
      updateLoading?: (loading: boolean) => void;
      updateLoadingMessage?: (message: string) => void;
    }
  ): Promise<string> {
    const streamer = new ThinkBlockStreamer(updateCurrentAiMessage, true);
    const updateLoadingMessage = options.updateLoadingMessage;

    try {
      this.assertDesktopCodexCliModelSelected();

      const messageForAnalysis = this.getMessageForToolAnalysis(userMessage);
      const toolResults = await this.executeLocalTools(messageForAnalysis, updateLoadingMessage);
      updateLoadingMessage?.(LOADING_MESSAGES.DEFAULT);

      const includeComposerInstructions = hasLocalCodexToolCommand(
        messageForAnalysis.toLowerCase(),
        "@composer"
      );
      const messages = await this.constructMessages(
        userMessage,
        toolResults,
        includeComposerInstructions
      );

      const chatModel = this.chainManager.chatModelManager.getChatModel();
      recordPromptPayload({
        messages,
        modelName: (chatModel as { modelName?: string } | undefined)?.modelName,
        contextEnvelope: userMessage.contextEnvelope,
      });

      logInfo("[DesktopCodexCliTools] Final request to Codex CLI:", messages);

      const chatStream = await withSuppressedTokenWarnings(() =>
        chatModel.stream(messages, { signal: abortController.signal })
      );

      let fullResponse = "";
      for await (const chunk of chatStream) {
        if (abortController.signal.aborted) {
          logInfo("[DesktopCodexCliTools] Stream iteration aborted", {
            reason: abortController.signal.reason,
          });
          break;
        }
        fullResponse += extractTextFromChunk(chunk.content);
      }

      if (includeComposerInstructions) {
        fullResponse = await processLocalCodexComposerBlocks(fullResponse);
      }

      streamer.processChunk({ content: fullResponse });
    } catch (error: any) {
      updateLoadingMessage?.(LOADING_MESSAGES.DEFAULT);
      if (error.name === "AbortError" || abortController.signal.aborted) {
        logInfo("[DesktopCodexCliTools] Stream aborted by user", {
          reason: abortController.signal.reason,
        });
      } else {
        logWarn("[DesktopCodexCliTools] Failed:", error);
        await this.handleError(error, streamer.processErrorChunk.bind(streamer));
      }
    }

    const result = streamer.close();
    const responseMetadata: ResponseMetadata = {
      wasTruncated: result.wasTruncated,
      tokenUsage: result.tokenUsage ?? undefined,
    };

    await this.handleResponse(
      result.content,
      userMessage,
      abortController,
      addMessage,
      updateCurrentAiMessage,
      undefined,
      undefined,
      responseMetadata
    );

    return result.content;
  }
}
