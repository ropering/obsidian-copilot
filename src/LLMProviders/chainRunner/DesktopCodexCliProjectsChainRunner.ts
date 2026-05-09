import { LOADING_MESSAGES } from "@/constants";
import { LayerToMessagesConverter } from "@/context/LayerToMessagesConverter";
import { LocalCodexProjectContextLoader } from "@/LLMProviders/localCodexProjectContext";
import { logInfo, logWarn } from "@/logger";
import { getSettings } from "@/settings/model";
import type { ChatMessage, ResponseMetadata } from "@/types/message";
import { extractTextFromChunk, withSuppressedTokenWarnings } from "@/utils";
import {
  buildLocalCodexUserContent,
  hasLocalCodexToolCommand,
  LOCAL_CODEX_SYSTEM_INSTRUCTIONS,
  processLocalCodexComposerBlocks,
  type LocalCodexToolResult,
  DesktopCodexCliToolsChainRunner,
} from "./DesktopCodexCliToolsChainRunner";
import { loadAndAddChatHistory } from "./utils/chatHistoryUtils";
import { renderCiCMessage } from "./utils/cicPromptUtils";
import { addLocalCodexFallbackSources } from "./utils/localCodexSearchContext";
import { recordPromptPayload } from "./utils/promptPayloadRecorder";
import { ThinkBlockStreamer } from "./utils/ThinkBlockStreamer";

export const LOCAL_CODEX_PROJECT_SYSTEM_INSTRUCTIONS = `# Desktop Codex Local Projects Mode

Use the provided <ProjectContext> as project-scoped local context.
This mode does not use Copilot Plus, Brevilabs, docs4llm, url4llm, youtube4llm, or twitter4llm.
Unsupported project context items are reported as local mode unsupported instead of being silently converted through Plus services.
When explicit @tools are present, they are pre-executed by Obsidian Copilot and included as additional context; you cannot call tools yourself.`;

/**
 * Lazily read the selected project to avoid adding a top-level aiParams import
 * to this runner's module graph.
 *
 * @returns Currently selected project, or null when no project is selected.
 */
async function getSelectedProject() {
  const { getCurrentProject } = await import("@/aiParams");
  return getCurrentProject();
}

/**
 * Builds the user payload for local Codex Projects mode.
 *
 * @param baseUserContent - User content produced from the message envelope.
 * @param projectContext - Local ProjectContext block.
 * @param toolResults - Pre-executed local tool results.
 * @param includeComposerInstructions - Whether composer XML instructions should be included.
 * @param enableInlineCitations - Whether inline citation guidance is enabled.
 * @returns Context-first prompt payload for Codex CLI.
 */
export function buildLocalCodexProjectUserContent(
  baseUserContent: string,
  projectContext: string,
  toolResults: LocalCodexToolResult[],
  includeComposerInstructions: boolean,
  enableInlineCitations: boolean
): string {
  const toolAugmentedContent = buildLocalCodexUserContent(
    baseUserContent,
    toolResults,
    includeComposerInstructions,
    enableInlineCitations
  );

  if (!projectContext.trim()) {
    return toolAugmentedContent;
  }

  return renderCiCMessage(projectContext, toolAugmentedContent);
}

/**
 * Chain runner for local project chats backed by Desktop Codex CLI.
 */
export class DesktopCodexCliProjectsChainRunner extends DesktopCodexCliToolsChainRunner {
  /**
   * Creates the final LangChain message list with local Project context.
   *
   * @param userMessage - Current user message with context envelope.
   * @param projectContext - Local project context block.
   * @param toolResults - Local tool results to inject.
   * @param includeComposerInstructions - Whether composer XML instructions are needed.
   * @returns Messages ready for Codex CLI.
   */
  private async constructProjectMessages(
    userMessage: ChatMessage,
    projectContext: string,
    toolResults: LocalCodexToolResult[],
    includeComposerInstructions: boolean
  ): Promise<any[]> {
    if (!userMessage.contextEnvelope) {
      throw new Error(
        "[DesktopCodexCliProjects] Context envelope is required but not available. Cannot proceed."
      );
    }

    const project = await getSelectedProject();
    if (!project) {
      throw new Error("codex projects (local) requires a selected project.");
    }

    const baseMessages = LayerToMessagesConverter.convert(userMessage.contextEnvelope, {
      includeSystemMessage: true,
      mergeUserContent: true,
      debug: false,
    });

    const messages: any[] = [];
    const systemMessage = baseMessages.find((message) => message.role === "system");
    const projectSystemPrompt = `<project_system_prompt>\n${project.systemPrompt}\n</project_system_prompt>`;
    const localInstructions = `${LOCAL_CODEX_SYSTEM_INSTRUCTIONS}\n\n${LOCAL_CODEX_PROJECT_SYSTEM_INSTRUCTIONS}`;

    if (systemMessage) {
      messages.push({
        ...systemMessage,
        content: `${systemMessage.content}\n\n${projectSystemPrompt}\n\n${localInstructions}`,
      });
    } else {
      messages.push({
        role: "system",
        content: `${projectSystemPrompt}\n\n${localInstructions}`,
      });
    }

    await loadAndAddChatHistory(this.chainManager.memoryManager.getMemory(), messages);

    const userMessageContent = baseMessages.find((message) => message.role === "user");
    if (userMessageContent) {
      const augmentedText = buildLocalCodexProjectUserContent(
        userMessageContent.content,
        projectContext,
        toolResults,
        includeComposerInstructions,
        getSettings().enableInlineCitations
      );

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
   * Runs local Project context loading, optional explicit @tools, and Codex CLI response generation.
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
    let toolResults: LocalCodexToolResult[] = [];

    try {
      this.assertDesktopCodexCliModelSelected();

      const project = await getSelectedProject();
      if (!project) {
        throw new Error("codex projects (local) requires a selected project.");
      }

      updateLoadingMessage?.(LOADING_MESSAGES.READING_FILES);
      const projectContext = await new LocalCodexProjectContextLoader(this.chainManager.app).load(
        project
      );

      const messageForAnalysis = this.getMessageForToolAnalysis(userMessage);
      toolResults = await this.executeLocalTools(messageForAnalysis, updateLoadingMessage);
      updateLoadingMessage?.(LOADING_MESSAGES.DEFAULT);

      const includeComposerInstructions = hasLocalCodexToolCommand(
        messageForAnalysis.toLowerCase(),
        "@composer"
      );
      const messages = await this.constructProjectMessages(
        userMessage,
        projectContext,
        toolResults,
        includeComposerInstructions
      );

      const chatModel = this.chainManager.chatModelManager.getChatModel();
      recordPromptPayload({
        messages,
        modelName: (chatModel as { modelName?: string } | undefined)?.modelName,
        contextEnvelope: userMessage.contextEnvelope,
      });

      logInfo("[DesktopCodexCliProjects] Final request to Codex CLI:", messages);

      const chatStream = await withSuppressedTokenWarnings(() =>
        chatModel.stream(messages, { signal: abortController.signal })
      );

      let fullResponse = "";
      for await (const chunk of chatStream) {
        if (abortController.signal.aborted) {
          logInfo("[DesktopCodexCliProjects] Stream iteration aborted", {
            reason: abortController.signal.reason,
          });
          break;
        }
        fullResponse += extractTextFromChunk(chunk.content);
      }

      if (includeComposerInstructions) {
        fullResponse = await processLocalCodexComposerBlocks(fullResponse);
      }

      const fallbackSources = toolResults.flatMap((result) => result.fallbackSources ?? []);
      if (fallbackSources.length > 0) {
        fullResponse = addLocalCodexFallbackSources(fullResponse, fallbackSources);
      }

      streamer.processChunk({ content: fullResponse });
    } catch (error: any) {
      updateLoadingMessage?.(LOADING_MESSAGES.DEFAULT);
      if (error.name === "AbortError" || abortController.signal.aborted) {
        logInfo("[DesktopCodexCliProjects] Stream aborted by user", {
          reason: abortController.signal.reason,
        });
      } else {
        logWarn("[DesktopCodexCliProjects] Failed:", error);
        await this.handleError(error, streamer.processErrorChunk.bind(streamer));
      }
    }

    const result = streamer.close();
    const sources = toolResults.flatMap((toolResult) => toolResult.sources ?? []);
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
      sources.length > 0 ? sources : undefined,
      undefined,
      responseMetadata
    );

    return result.content;
  }
}
