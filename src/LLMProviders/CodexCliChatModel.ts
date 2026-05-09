import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type BaseChatModelParams,
} from "@langchain/core/language_models/chat_models";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import { AIMessage, AIMessageChunk } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { ChatGenerationChunk } from "@langchain/core/outputs";
import type { ChatGeneration, ChatResult } from "@langchain/core/outputs";

import { DEFAULT_CODEX_CLI_TIMEOUT_MS, runCodexCliChat } from "@/services/codexCli/CodexCliClient";
import {
  cleanupCodexCliImageAttachments,
  createCodexCliImageAttachment,
  parseCodexImageDataUrl,
  type CodexCliImageAttachment,
} from "@/services/codexCli/CodexCliImageAttachments";

/**
 * Call options supported by the Desktop Codex CLI chat model.
 */
export interface CodexCliChatModelCallOptions extends BaseChatModelCallOptions {
  timeoutMs?: number;
}

/**
 * Constructor fields for the Desktop Codex CLI chat model.
 */
export interface CodexCliChatModelFields extends BaseChatModelParams {
  modelName?: string;
  codexIgnoreRules?: boolean;
  timeoutMs?: number;
  workingDirectory?: string;
}

/**
 * Minimal shape of the global Obsidian app used to resolve the vault path.
 */
interface GlobalAppContainer {
  app?: {
    vault?: {
      adapter?: {
        getBasePath?: () => string;
        basePath?: string;
      };
    };
  };
}

/**
 * Mutable state used while rendering a prompt and collecting image attachments.
 */
interface CodexPromptBuildState {
  attachImages: boolean;
  imageAttachments: CodexCliImageAttachment[];
  nextImageIndex: number;
}

/**
 * Prepared Codex CLI prompt plus temporary image attachments.
 */
interface PreparedCodexPrompt {
  prompt: string;
  imageAttachments: CodexCliImageAttachment[];
}

/**
 * Extract a printable message role from a LangChain message.
 *
 * @param message - Message to inspect.
 * @returns Human-readable role label.
 */
function getMessageRole(message: BaseMessage): string {
  const type = message._getType();
  switch (type) {
    case "system":
      return "System";
    case "human":
      return "User";
    case "ai":
      return "Assistant";
    case "tool":
      return "Tool";
    default:
      return type.charAt(0).toUpperCase() + type.slice(1);
  }
}

/**
 * Check whether an unknown value is an object record.
 *
 * @param value - Value to inspect.
 * @returns True when the value is a non-null object record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Extract an image URL from a LangChain multimodal content item.
 *
 * @param item - Message content item to inspect.
 * @returns Image URL when the item is an `image_url` block.
 */
function getImageUrlFromContentItem(item: unknown): string | undefined {
  if (!isRecord(item) || item.type !== "image_url") {
    return undefined;
  }

  const imageUrl = item.image_url;
  if (typeof imageUrl === "string") {
    return imageUrl;
  }

  if (isRecord(imageUrl) && typeof imageUrl.url === "string") {
    return imageUrl.url;
  }

  return undefined;
}

/**
 * Render a compact image placeholder for the prompt transcript.
 *
 * @param index - One-based image attachment index.
 * @param mimeType - Image MIME type.
 * @returns Placeholder text that replaces the base64 payload.
 */
function renderImagePlaceholder(index: number, mimeType: string): string {
  return `[Image attachment ${index}: ${mimeType} passed separately]`;
}

/**
 * Convert an image content item into a CLI attachment and prompt placeholder.
 *
 * @param dataUrl - Base64 image data URL.
 * @param state - Mutable prompt build state.
 * @returns Placeholder text for the prompt transcript.
 */
function prepareImageContentPlaceholder(dataUrl: string, state: CodexPromptBuildState): string {
  const imageIndex = state.nextImageIndex;
  state.nextImageIndex += 1;

  if (!state.attachImages) {
    try {
      const parsed = parseCodexImageDataUrl(dataUrl);
      return renderImagePlaceholder(imageIndex, parsed.mimeType);
    } catch {
      return `[Image attachment ${imageIndex}: unsupported image content omitted]`;
    }
  }

  const attachment = createCodexCliImageAttachment(dataUrl, imageIndex);
  state.imageAttachments.push(attachment);
  return renderImagePlaceholder(imageIndex, attachment.mimeType);
}

/**
 * Convert a LangChain message content value to text.
 *
 * @param content - Message content.
 * @param state - Mutable prompt build state.
 * @returns Text representation of the content.
 */
function stringifyMessageContent(
  content: BaseMessage["content"],
  state: CodexPromptBuildState
): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return String(content);
  }

  return content
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }
      if (isRecord(item) && typeof item.text === "string") {
        return item.text;
      }
      const imageUrl = getImageUrlFromContentItem(item);
      if (imageUrl) {
        return prepareImageContentPlaceholder(imageUrl, state);
      }
      return JSON.stringify(item);
    })
    .join("\n");
}

/**
 * Build the agent-style prompt and optionally collect CLI image attachments.
 *
 * @param messages - LangChain conversation messages.
 * @param attachImages - Whether image data URLs should be written to temporary files.
 * @returns Prompt text plus image attachment metadata.
 */
function buildCodexPrompt(messages: BaseMessage[], attachImages: boolean): PreparedCodexPrompt {
  const state: CodexPromptBuildState = {
    attachImages,
    imageAttachments: [],
    nextImageIndex: 1,
  };

  try {
    const transcript = messages
      .map((message, index) => {
        const role = getMessageRole(message);
        const content = stringifyMessageContent(message.content, state).trim();
        return `<${role} index="${index + 1}">\n${content}\n</${role}>`;
      })
      .join("\n\n");

    return {
      prompt: [
        "You are being invoked by Obsidian Copilot through Desktop Codex CLI.",
        "The Codex CLI process runs from the Obsidian vault root in a read-only sandbox.",
        "The transcript below preserves the original message roles; follow those role instructions.",
        "Return only the final answer for the chat user. Do not include process logs or raw transcripts.",
        "",
        "<conversation_transcript>",
        transcript,
        "</conversation_transcript>",
        "",
        "Final answer:",
      ].join("\n"),
      imageAttachments: state.imageAttachments,
    };
  } catch (error) {
    if (attachImages) {
      cleanupCodexCliImageAttachments(state.imageAttachments);
    }
    throw error;
  }
}

/**
 * Build the agent-style prompt sent to `codex exec`.
 *
 * Image data URLs are represented as compact placeholders so exported prompt
 * snapshots never include base64 payloads.
 *
 * @param messages - LangChain conversation messages.
 * @returns Prompt text for Codex CLI.
 */
export function buildCodexAgentPrompt(messages: BaseMessage[]): string {
  return buildCodexPrompt(messages, false).prompt;
}

/**
 * Build a Codex prompt and write image attachments to temporary files.
 *
 * @param messages - LangChain conversation messages.
 * @returns Prompt text plus temporary image attachments.
 */
function prepareCodexPrompt(messages: BaseMessage[]): PreparedCodexPrompt {
  return buildCodexPrompt(messages, true);
}

/**
 * Resolve the current Obsidian vault root from the desktop app.
 *
 * @returns Vault base path when available.
 */
function resolveVaultBasePathFromGlobalApp(): string | undefined {
  const adapter = (globalThis as unknown as GlobalAppContainer).app?.vault?.adapter;
  if (!adapter) {
    return undefined;
  }

  if (typeof adapter.getBasePath === "function") {
    return adapter.getBasePath();
  }

  return typeof adapter.basePath === "string" ? adapter.basePath : undefined;
}

/**
 * LangChain chat model adapter that delegates responses to local Codex CLI.
 */
export class CodexCliChatModel extends BaseChatModel<CodexCliChatModelCallOptions> {
  public readonly modelName: string;

  private readonly codexIgnoreRules: boolean;
  private readonly timeoutMs: number;
  private readonly workingDirectory?: string;

  constructor(fields: CodexCliChatModelFields = {}) {
    const { codexIgnoreRules, timeoutMs, workingDirectory, ...baseParams } = fields;
    super(baseParams);

    this.modelName = fields.modelName || "Desktop Codex CLI Chat";
    this.codexIgnoreRules = codexIgnoreRules !== false;
    this.timeoutMs = timeoutMs ?? DEFAULT_CODEX_CLI_TIMEOUT_MS;
    this.workingDirectory = workingDirectory;
  }

  _llmType(): string {
    return "desktop-codex-cli";
  }

  /**
   * Resolve the working directory used for Codex CLI execution.
   *
   * @returns Absolute working directory path.
   * @throws If the current vault root cannot be resolved.
   */
  private resolveWorkingDirectory(): string {
    const workingDirectory = this.workingDirectory || resolveVaultBasePathFromGlobalApp();
    if (!workingDirectory) {
      throw new Error("Unable to resolve the Obsidian vault root for Desktop Codex CLI execution.");
    }
    return workingDirectory;
  }

  /**
   * Execute Codex CLI for the provided messages.
   *
   * @param messages - LangChain conversation messages.
   * @param options - Optional call options.
   * @returns Final response text.
   */
  private async invokeCodex(
    messages: BaseMessage[],
    options?: CodexCliChatModelCallOptions
  ): Promise<string> {
    const prepared = prepareCodexPrompt(messages);
    try {
      const result = await runCodexCliChat({
        prompt: prepared.prompt,
        cwd: this.resolveWorkingDirectory(),
        imagePaths: prepared.imageAttachments.map((attachment) => attachment.path),
        ignoreRules: this.codexIgnoreRules,
        timeoutMs: options?.timeoutMs ?? this.timeoutMs,
        signal: options?.signal,
      });
      return result.text;
    } finally {
      cleanupCodexCliImageAttachments(prepared.imageAttachments);
    }
  }

  async _generate(
    messages: BaseMessage[],
    options?: CodexCliChatModelCallOptions,
    runManager?: CallbackManagerForLLMRun
  ): Promise<ChatResult> {
    const text = await this.invokeCodex(messages, options);

    if (runManager && text) {
      await runManager.handleLLMNewToken(text);
    }

    const responseMetadata = {
      modelName: this.modelName,
      provider: "desktop-codex-cli",
    };

    const generation: ChatGeneration = {
      message: new AIMessage({
        content: text,
        response_metadata: responseMetadata,
      }),
      text,
      generationInfo: responseMetadata,
    };

    return {
      generations: [generation],
      llmOutput: responseMetadata,
    };
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: CodexCliChatModelCallOptions = {},
    runManager?: CallbackManagerForLLMRun
  ): AsyncGenerator<ChatGenerationChunk> {
    const result = await this._generate(messages, options, runManager);
    const text = result.generations[0]?.text ?? "";
    if (!text) {
      return;
    }

    yield new ChatGenerationChunk({
      message: new AIMessageChunk({
        content: text,
        response_metadata: result.llmOutput ?? {},
      }),
      text,
      generationInfo: result.llmOutput ?? {},
    });
  }
}
