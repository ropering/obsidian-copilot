import React from "react";
import { render, waitFor } from "@testing-library/react";
import ChatSingleMessage, {
  buildObsidianMarkdownLink,
  escapeMarkdownLinkLabel,
  normalizeFootnoteRendering,
} from "@/components/chat-components/ChatSingleMessage";
import { ChatMessage } from "@/types/message";
import type { App } from "obsidian";
import { TooltipProvider } from "@/components/ui/tooltip";

jest.mock("@/settings/model", () => ({
  useSettingsValue: jest.fn(() => ({
    enableInlineCitations: true,
    activeModels: [
      {
        name: "test-model",
        provider: "test-provider",
        enabled: true,
        capabilities: ["reasoning"],
      },
    ],
  })),
}));

jest.mock("@/aiParams", () => ({
  useModelKey: jest.fn(() => ["test-model|test-provider", jest.fn()]),
}));

jest.mock("@/LLMProviders/chainRunner/utils/toolCallParser", () => ({
  parseToolCallMarkers: jest.fn((message: string) => ({
    segments: [{ type: "text", content: message }],
  })),
}));

jest.mock("@/LLMProviders/chainRunner/utils/citationUtils", () => ({
  processInlineCitations: jest.fn((content: string) => content),
}));

jest.mock("obsidian", () => {
  const renderMarkdown = jest.fn();
  return {
    MarkdownRenderer: {
      renderMarkdown,
    },
    Component: class {
      load() {}
      unload() {}
    },
    MarkdownView: class {},
    TFile: class {},
    App: class {},
    Platform: {
      isMobile: false,
    },
    Modal: class {
      open() {
        /* noop */
      }
      close() {
        /* noop */
      }
    },
    __renderMarkdownMock: renderMarkdown,
  };
});

const { __renderMarkdownMock: renderMarkdownMock } = jest.requireMock("obsidian") as {
  __renderMarkdownMock: jest.Mock;
};

describe("normalizeFootnoteRendering", () => {
  beforeEach(() => {
    renderMarkdownMock.mockReset();
  });

  it("removes separator and backref while preserving non-footnote elements", () => {
    const container = document.createElement("div");
    container.innerHTML = `
      <div>
        <p>Body <sup><a href="#fn-1">1-1</a></sup></p>
        <hr class="content-separator" />
        <div class="footnotes">
          <hr class="footnotes-sep" />
          <ol>
            <li id="fn-1">
              Entry <a class="footnote-backref" href="#ref">↩</a>
            </li>
          </ol>
        </div>
      </div>
    `;

    normalizeFootnoteRendering(container);

    expect(container.querySelector(".footnotes hr")).toBeNull();
    expect(container.querySelector(".footnote-backref")).toBeNull();
    expect(container.querySelector(".content-separator")).not.toBeNull();
    expect(container.querySelector('a[href="#fn-1"]')?.textContent).toBe("1");
  });

  it("leaves non-numeric footnote references untouched", () => {
    const container = document.createElement("div");
    container.innerHTML = `
      <p>Body <sup><a href="#fn-note">Note-A</a></sup></p>
      <a class="footnote-backref" href="#ref">↩</a>
    `;

    normalizeFootnoteRendering(container);

    expect(container.querySelector('a[href="#fn-note"]')?.textContent).toBe("Note-A");
    expect(container.querySelector(".footnote-backref")).toBeNull();
  });
});

describe("Obsidian note link preprocessing", () => {
  it("builds markdown links instead of raw HTML anchors", () => {
    const link = buildObsidianMarkdownLink({
      basename: "request_원자적 노트",
      path: "04.Archives/request_원자적 노트.md",
    });

    expect(link).toBe(
      "[request_원자적 노트](obsidian://open?file=04.Archives%2Frequest_%EC%9B%90%EC%9E%90%EC%A0%81%20%EB%85%B8%ED%8A%B8.md)"
    );
    expect(link).not.toContain("<a href=");
  });

  it("escapes markdown link labels", () => {
    expect(escapeMarkdownLinkLabel(String.raw`a\b[c]`)).toBe(String.raw`a\\b\[c\]`);
  });
});

describe("ChatSingleMessage", () => {
  const baseMessage: ChatMessage = {
    id: "message-1",
    message: "Test message",
    sender: "assistant",
    timestamp: { epoch: Date.now(), display: "now", fileName: "now" },
    isVisible: true,
  };

  const createAppStub = (): App =>
    ({
      vault: {
        getResourcePath: jest.fn(() => "app://resource"),
      },
      workspace: {
        getActiveFile: jest.fn(() => null),
        getMostRecentLeaf: jest.fn(() => null),
        getLeaf: jest.fn(() => null),
      },
      metadataCache: {
        getFirstLinkpathDest: jest.fn(() => null),
      },
    }) as unknown as App;

  beforeEach(() => {
    renderMarkdownMock.mockReset();
  });

  beforeAll(() => {
    (globalThis as any).activeDocument = document;
  });

  it("normalizes rendered footnotes for assistant messages", async () => {
    renderMarkdownMock.mockImplementation((_markdown: string, el: HTMLElement) => {
      el.innerHTML = `
        <p>Example <sup><a href="#fn-2">2-1</a></sup></p>
        <hr class="content-hr" />
        <div class="footnotes">
          <hr class="footnotes-sep" />
          <ol>
            <li id="fn-2">
              Source <a class="footnote-backref" href="#back">↩</a>
            </li>
          </ol>
        </div>
      `;
    });

    const { container } = render(
      <TooltipProvider>
        <ChatSingleMessage
          message={baseMessage}
          app={createAppStub()}
          isStreaming={false}
          onDelete={() => {}}
        />
      </TooltipProvider>
    );

    await waitFor(() => expect(renderMarkdownMock).toHaveBeenCalled());

    const messageSegment = container.querySelector(".message-segment");
    expect(messageSegment).toBeTruthy();
    expect(messageSegment?.querySelector(".footnotes hr")).toBeNull();
    expect(messageSegment?.querySelector(".footnote-backref")).toBeNull();
    expect(messageSegment?.querySelector(".content-hr")).not.toBeNull();
    expect(messageSegment?.querySelector('a[href="#fn-2"]')?.textContent).toBe("2");
  });

  it("passes markdown note links to the renderer without raw HTML anchors", async () => {
    const app = createAppStub();
    (app.metadataCache.getFirstLinkpathDest as jest.Mock).mockReturnValue({
      basename: "Linked Note",
      path: "Folder/Linked Note.md",
    });

    const message: ChatMessage = {
      ...baseMessage,
      message: "See [[Linked Note]] for details.",
    };

    render(
      <TooltipProvider>
        <ChatSingleMessage message={message} app={app} isStreaming={false} onDelete={() => {}} />
      </TooltipProvider>
    );

    await waitFor(() =>
      expect(renderMarkdownMock).toHaveBeenCalledWith(
        "See [Linked Note](obsidian://open?file=Folder%2FLinked%20Note.md) for details.",
        expect.any(HTMLElement),
        "",
        expect.anything()
      )
    );

    expect(renderMarkdownMock.mock.calls[0][0]).not.toContain("<a href=");
  });
});
