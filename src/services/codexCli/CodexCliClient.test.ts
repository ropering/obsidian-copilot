import { Platform } from "obsidian";

import {
  buildCodexExecArgs,
  formatCodexCliFailure,
  resolveCodexCliBinaryCandidates,
  runCodexCliChat,
} from "@/services/codexCli/CodexCliClient";

/**
 * Runtime require container shape for tests.
 */
interface TestRequireContainer {
  require?: (id: string) => unknown;
}

/**
 * Mutable process environment shape for tests.
 */
interface TestProcessContainer {
  process?: {
    env?: Record<string, string | undefined>;
    platform?: string;
  };
}

/**
 * Minimal mocked child process used by spawn tests.
 */
class MockChildProcess {
  stdoutListeners: Array<(chunk: unknown) => void> = [];
  stderrListeners: Array<(chunk: unknown) => void> = [];
  errorListeners: Array<(error: Error & { code?: string }) => void> = [];
  closeListeners: Array<(code: number | null, signal: string | null) => void> = [];
  stdinChunks: string[] = [];
  stdinEnded = false;

  stdin = {
    write: (chunk: string) => {
      this.stdinChunks.push(chunk);
    },
    end: () => {
      this.stdinEnded = true;
    },
  };

  kill = jest.fn(() => {
    this.emitClose(null, "SIGTERM");
    return true;
  });

  stdout = {
    on: (_event: "data", listener: (chunk: unknown) => void) => {
      this.stdoutListeners.push(listener);
    },
  };

  stderr = {
    on: (_event: "data", listener: (chunk: unknown) => void) => {
      this.stderrListeners.push(listener);
    },
  };

  /**
   * Register process event listeners.
   */
  on(
    event: "error" | "close",
    listener:
      | ((error: Error & { code?: string }) => void)
      | ((code: number | null, signal: string | null) => void)
  ): void {
    if (event === "error") {
      this.errorListeners.push(listener as (error: Error & { code?: string }) => void);
      return;
    }
    this.closeListeners.push(listener as (code: number | null, signal: string | null) => void);
  }

  /**
   * Emit stdout data.
   */
  emitStdout(chunk: unknown): void {
    this.stdoutListeners.forEach((listener) => listener(chunk));
  }

  /**
   * Emit stderr data.
   */
  emitStderr(chunk: unknown): void {
    this.stderrListeners.forEach((listener) => listener(chunk));
  }

  /**
   * Emit a process error.
   */
  emitError(error: Error & { code?: string }): void {
    this.errorListeners.forEach((listener) => listener(error));
  }

  /**
   * Emit process close.
   */
  emitClose(code: number | null, signal: string | null): void {
    this.closeListeners.forEach((listener) => listener(code, signal));
  }
}

describe("CodexCliClient", () => {
  let originalRequire: ((id: string) => unknown) | undefined;
  let originalEnv: Record<string, string | undefined>;
  let files: Record<string, string>;

  /**
   * Install a mocked runtime require for Codex CLI tests.
   */
  function installRuntimeRequire(spawnMock: jest.Mock): void {
    const container = globalThis as unknown as TestRequireContainer;
    container.require = jest.fn((id: string) => {
      if (id === "child_process") {
        return { spawn: spawnMock };
      }
      if (id === "fs") {
        return {
          existsSync: (path: string) => Object.prototype.hasOwnProperty.call(files, path),
          readFileSync: (path: string) => files[path],
          unlinkSync: (path: string) => {
            delete files[path];
          },
        };
      }
      if (id === "os") {
        return {
          tmpdir: () => "C:\\Temp",
          homedir: () => "C:\\Users\\alice",
          platform: () => "win32",
        };
      }
      if (id === "path") {
        return { join: (...parts: string[]) => parts.join("\\") };
      }
      return {};
    });
  }

  beforeEach(() => {
    const platform = Platform as unknown as { isDesktopApp?: boolean; isDesktop?: boolean };
    platform.isDesktopApp = true;

    const requireContainer = globalThis as unknown as TestRequireContainer;
    originalRequire = requireContainer.require;

    const processContainer = globalThis as unknown as TestProcessContainer;
    originalEnv = { ...(processContainer.process?.env || {}) };
    if (processContainer.process?.env) {
      processContainer.process.env = {};
    }
    files = {};
  });

  afterEach(() => {
    const requireContainer = globalThis as unknown as TestRequireContainer;
    if (originalRequire) {
      requireContainer.require = originalRequire;
    } else {
      delete requireContainer.require;
    }

    const processContainer = globalThis as unknown as TestProcessContainer;
    if (processContainer.process?.env) {
      processContainer.process.env = originalEnv;
    }

    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it("buildCodexExecArgs creates read-only ephemeral exec args", () => {
    const args = buildCodexExecArgs("Hello", "C:\\Temp\\out.txt", true);

    expect(args).toEqual([
      "exec",
      "-s",
      "read-only",
      "--skip-git-repo-check",
      "--ephemeral",
      "--json",
      "--output-last-message",
      "C:\\Temp\\out.txt",
      "--ignore-rules",
      "-",
    ]);
  });

  it("buildCodexExecArgs can still build argv prompt args for explicit callers", () => {
    const args = buildCodexExecArgs("Hello", "C:\\Temp\\out.txt", true, "argv");

    expect(args).toContain("Hello");
    expect(args).not.toContain("-");
  });

  it("buildCodexExecArgs attaches multiple image paths before the stdin prompt marker", () => {
    const args = buildCodexExecArgs("Hello", "C:\\Temp\\out.txt", true, "stdin", [
      "C:\\Temp\\image-one.png",
      "C:\\Temp\\image-two.webp",
    ]);

    expect(args).toEqual([
      "exec",
      "-s",
      "read-only",
      "--skip-git-repo-check",
      "--ephemeral",
      "--json",
      "--output-last-message",
      "C:\\Temp\\out.txt",
      "--ignore-rules",
      "--image",
      "C:\\Temp\\image-one.png",
      "--image",
      "C:\\Temp\\image-two.webp",
      "-",
    ]);
  });

  it("resolveCodexCliBinaryCandidates uses env overrides before codex", () => {
    const processContainer = globalThis as unknown as TestProcessContainer;
    if (processContainer.process?.env) {
      processContainer.process.env = {
        LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local",
        USERPROFILE: "C:\\Users\\alice",
      };
      processContainer.process.env.CODEX_CLI_BINARY = "C:\\Tools\\codex.exe";
      processContainer.process.env.CODEX_CLI_PATH = "D:\\bin\\codex.exe";
    }

    expect(resolveCodexCliBinaryCandidates()).toEqual([
      "C:\\Tools\\codex.exe",
      "D:\\bin\\codex.exe",
      "C:\\Users\\alice\\AppData\\Local\\OpenAI\\Codex\\bin\\codex.exe",
      "codex",
    ]);
  });

  it("resolveCodexCliBinaryCandidates keeps explicit path and adds native Windows fallback", () => {
    const processContainer = globalThis as unknown as TestProcessContainer;
    if (processContainer.process?.env) {
      processContainer.process.env = {
        LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local",
        USERPROFILE: "C:\\Users\\alice",
      };
    }

    expect(
      resolveCodexCliBinaryCandidates("C:\\Users\\alice\\AppData\\Roaming\\npm\\codex.ps1")
    ).toEqual([
      "C:\\Users\\alice\\AppData\\Roaming\\npm\\codex.ps1",
      "C:\\Users\\alice\\AppData\\Local\\OpenAI\\Codex\\bin\\codex.exe",
    ]);
  });

  it("runCodexCliChat reads the final message and removes the temp file", async () => {
    const spawnMock = jest.fn((_binary: string, args: string[]) => {
      const child = new MockChildProcess();
      const outputPath = args[args.indexOf("--output-last-message") + 1];
      setTimeout(() => {
        files[outputPath] = "Codex response\n";
        child.emitStdout("jsonl noise");
        child.emitClose(0, null);
      }, 0);
      return child;
    });
    installRuntimeRequire(spawnMock);

    const result = await runCodexCliChat({
      prompt: "Hello",
      cwd: "C:\\Vault",
      ignoreRules: true,
    });

    expect(result.text).toBe("Codex response");
    expect(spawnMock).toHaveBeenCalledWith(
      "C:\\Users\\alice\\AppData\\Local\\OpenAI\\Codex\\bin\\codex.exe",
      expect.arrayContaining(["exec", "--ignore-rules", "-"]),
      expect.objectContaining({
        cwd: "C:\\Vault",
        windowsHide: true,
        stdio: ["pipe", "ignore", "pipe"],
      })
    );
    expect(Object.keys(files)).toHaveLength(0);
  });

  it("runCodexCliChat sends long prompts through stdin instead of argv", async () => {
    const spawnedChildren: MockChildProcess[] = [];
    const longPrompt = "Reply OK.\n" + "x".repeat(100_000);
    const spawnMock = jest.fn((_binary: string, args: string[]) => {
      const child = new MockChildProcess();
      spawnedChildren.push(child);
      const outputPath = args[args.indexOf("--output-last-message") + 1];
      setTimeout(() => {
        files[outputPath] = "OK\n";
        child.emitClose(0, null);
      }, 0);
      return child;
    });
    installRuntimeRequire(spawnMock);

    const result = await runCodexCliChat({
      prompt: longPrompt,
      cwd: "C:\\Vault",
      ignoreRules: true,
    });

    const args = spawnMock.mock.calls[0][1] as string[];
    expect(result.text).toBe("OK");
    expect(args).toContain("-");
    expect(args).not.toContain(longPrompt);
    expect(spawnedChildren[0].stdinChunks.join("")).toBe(longPrompt);
    expect(spawnedChildren[0].stdinEnded).toBe(true);
  });

  it("runCodexCliChat passes image paths as CLI attachments without mixing them into stdin", async () => {
    const spawnedChildren: MockChildProcess[] = [];
    const spawnMock = jest.fn((_binary: string, args: string[]) => {
      const child = new MockChildProcess();
      spawnedChildren.push(child);
      const outputPath = args[args.indexOf("--output-last-message") + 1];
      setTimeout(() => {
        files[outputPath] = "Image answer\n";
        child.emitClose(0, null);
      }, 0);
      return child;
    });
    installRuntimeRequire(spawnMock);

    const result = await runCodexCliChat({
      prompt: "Describe the images",
      cwd: "C:\\Vault",
      imagePaths: ["C:\\Temp\\a.png", "C:\\Temp\\b.heic"],
    });

    const args = spawnMock.mock.calls[0][1] as string[];
    expect(result.text).toBe("Image answer");
    expect(args).toEqual(expect.arrayContaining(["--image", "C:\\Temp\\a.png"]));
    expect(args).toEqual(expect.arrayContaining(["--image", "C:\\Temp\\b.heic"]));
    expect(args[args.length - 1]).toBe("-");
    expect(spawnedChildren[0].stdinChunks.join("")).toBe("Describe the images");
    expect(spawnedChildren[0].stdinChunks.join("")).not.toContain("C:\\Temp\\a.png");
  });

  it("runCodexCliChat reports missing Codex CLI", async () => {
    const spawnMock = jest.fn(() => {
      const child = new MockChildProcess();
      setTimeout(() => {
        const error = new Error("spawn ENOENT") as Error & { code?: string };
        error.code = "ENOENT";
        child.emitError(error);
      }, 0);
      return child;
    });
    installRuntimeRequire(spawnMock);

    await expect(
      runCodexCliChat({
        prompt: "Hello",
        cwd: "C:\\Vault",
      })
    ).rejects.toThrow("Codex CLI executable was not found");
  });

  it("runCodexCliChat stops timed out processes", async () => {
    jest.useFakeTimers();
    const child = new MockChildProcess();
    const spawnMock = jest.fn(() => child);
    installRuntimeRequire(spawnMock);

    const promise = runCodexCliChat({
      prompt: "Hello",
      cwd: "C:\\Vault",
      timeoutMs: 10,
    });

    jest.advanceTimersByTime(10);

    await expect(promise).rejects.toThrow("timed out");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("formatCodexCliFailure includes stderr for non-zero exits", () => {
    const message = formatCodexCliFailure({
      args: ["exec"],
      binary: "codex",
      attemptedBinaries: ["codex"],
      ok: false,
      stdout: "",
      stderr: "authentication required",
      exitCode: 1,
      errorCode: 1,
      signal: null,
      durationMs: 50,
    });

    expect(message).toContain("exit code 1");
    expect(message).toContain("authentication required");
  });

  it("formatCodexCliFailure explains command-line length failures", () => {
    const message = formatCodexCliFailure({
      args: ["exec"],
      binary: "codex",
      attemptedBinaries: ["codex"],
      ok: false,
      stdout: "",
      stderr: "",
      exitCode: null,
      errorCode: "ENAMETOOLONG",
      signal: null,
      durationMs: 50,
    });

    expect(message).toContain("command line was too long");
    expect(message).toContain("stdin");
  });
});
