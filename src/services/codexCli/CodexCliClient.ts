import { Platform } from "obsidian";

/**
 * Default executable name registered by Codex CLI.
 */
export const DEFAULT_CODEX_CLI_BINARY = "codex";

/**
 * Default timeout for Codex CLI chat execution.
 */
export const DEFAULT_CODEX_CLI_TIMEOUT_MS = 300_000;

/**
 * Default maximum captured output buffer for Codex CLI process streams.
 */
export const DEFAULT_CODEX_CLI_MAX_BUFFER_BYTES = 4_194_304;

/**
 * Prompt used for connectivity checks.
 */
export const DEFAULT_CODEX_CLI_PING_PROMPT = "Reply with exactly: OK";

/**
 * Invocation shape for a Codex CLI chat request.
 */
export interface CodexCliChatInvocation {
  prompt: string;
  cwd: string;
  imagePaths?: string[];
  ignoreRules?: boolean;
  timeoutMs?: number;
  maxBufferBytes?: number;
  binary?: string;
  signal?: AbortSignal;
}

/**
 * Internal process invocation shape.
 */
interface CodexCliProcessInvocation {
  args: string[];
  cwd: string;
  stdinText?: string;
  timeoutMs?: number;
  maxBufferBytes?: number;
  binary?: string;
  signal?: AbortSignal;
}

/**
 * Result object returned from Codex CLI process execution.
 */
export interface CodexCliProcessResult {
  args: string[];
  binary: string;
  attemptedBinaries: string[];
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  errorCode: string | number | null;
  signal: string | null;
  durationMs: number;
}

/**
 * Result object returned from a successful Codex chat request.
 */
export interface CodexCliChatResult {
  text: string;
  processResult: CodexCliProcessResult;
}

/**
 * Minimal global shape that may expose Node's `require` in the desktop renderer.
 */
interface RequireContainer {
  require?: (id: string) => unknown;
}

/**
 * Minimal global shape that may expose `process.env`.
 */
interface ProcessContainer {
  process?: {
    env?: Record<string, string | undefined>;
    platform?: string;
  };
}

/**
 * Minimal readable stream shape used by `child_process.spawn`.
 */
interface ReadableStreamLike {
  on(event: "data", listener: (chunk: unknown) => void): void;
}

/**
 * Minimal writable stream shape used for child process stdin.
 */
interface WritableStreamLike {
  write(chunk: string): void;
  end(): void;
}

/**
 * Minimal process error shape emitted by `child_process.spawn`.
 */
interface SpawnProcessError extends Error {
  code?: string | number | null;
  signal?: string | null;
}

/**
 * Minimal spawned child process shape used by this module.
 */
interface ChildProcessLike {
  stdin?: WritableStreamLike | null;
  stdout?: ReadableStreamLike | null;
  stderr?: ReadableStreamLike | null;
  on(event: "error", listener: (error: SpawnProcessError) => void): void;
  on(event: "close", listener: (code: number | null, signal: string | null) => void): void;
  kill(signal?: string): boolean;
}

/**
 * Minimal spawn options shape used by this module.
 */
interface SpawnOptions {
  cwd: string;
  windowsHide: boolean;
  stdio: ["ignore" | "pipe", "ignore", "pipe"];
}

/**
 * Minimal spawn function contract used in this module.
 */
type SpawnFn = (file: string, args: string[], options: SpawnOptions) => ChildProcessLike;

/**
 * Minimal shape of the required child_process module.
 */
interface ChildProcessModule {
  spawn?: SpawnFn;
}

/**
 * Minimal file system module shape used for temporary output files.
 */
interface FileSystemModule {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: "utf8"): string;
  unlinkSync(path: string): void;
}

/**
 * Minimal OS module shape used for temporary output files.
 */
interface OsModule {
  tmpdir(): string;
  homedir?: () => string;
  platform?: () => string;
}

/**
 * Minimal path module shape used for temporary output files.
 */
interface PathModule {
  join(...parts: string[]): string;
}

/**
 * Check whether the current runtime is desktop Obsidian.
 *
 * @returns True when running in desktop runtime.
 */
export function isDesktopRuntime(): boolean {
  const platform = Platform as unknown as { isDesktopApp?: boolean; isDesktop?: boolean };
  return Boolean(platform.isDesktopApp ?? platform.isDesktop);
}

/**
 * Resolve `require` from the desktop runtime.
 *
 * @returns Runtime `require` function.
 * @throws If `require` is not available.
 */
function getRuntimeRequire(): (id: string) => unknown {
  const container = globalThis as unknown as RequireContainer;
  if (typeof container.require !== "function") {
    throw new Error(
      "Node require is unavailable in this runtime. Desktop Codex CLI requires the desktop app."
    );
  }
  return container.require;
}

/**
 * Resolve `require` when it is available without throwing.
 *
 * @returns Runtime `require` function or undefined.
 */
function getOptionalRuntimeRequire(): ((id: string) => unknown) | undefined {
  const container = globalThis as unknown as RequireContainer;
  return typeof container.require === "function" ? container.require : undefined;
}

/**
 * Resolve Node's `spawn` function from `child_process`.
 *
 * @returns `spawn` function.
 * @throws If `child_process.spawn` cannot be resolved.
 */
function getSpawnFunction(): SpawnFn {
  const runtimeRequire = getRuntimeRequire();
  const childProcessModule = runtimeRequire("child_process") as ChildProcessModule;
  if (typeof childProcessModule.spawn !== "function") {
    throw new Error("Failed to resolve child_process.spawn");
  }
  return childProcessModule.spawn;
}

/**
 * Resolve a minimal Node module by id.
 *
 * @param id - Node builtin module id.
 * @returns Required module.
 */
function getNodeModule<T>(id: string): T {
  return getRuntimeRequire()(id) as T;
}

/**
 * Resolve a minimal Node module when desktop `require` is available.
 *
 * @param id - Node builtin module id.
 * @returns Required module or undefined.
 */
function getOptionalNodeModule<T>(id: string): T | undefined {
  try {
    return getOptionalRuntimeRequire()?.(id) as T | undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read optional Codex CLI binary overrides from environment variables.
 *
 * @returns Ordered non-empty binary candidates from environment.
 */
function getCliBinaryCandidatesFromEnv(): string[] {
  const container = globalThis as unknown as ProcessContainer;
  const env = container.process?.env;
  if (!env) {
    return [];
  }

  const envCandidates = [env.CODEX_CLI_BINARY, env.CODEX_CLI_PATH];
  return envCandidates.map((candidate) => candidate?.trim() || "").filter(Boolean);
}

/**
 * Build a path using Node's path module when available.
 *
 * @param parts - Path segments.
 * @returns Joined path.
 */
function joinPath(...parts: string[]): string {
  const path = getOptionalNodeModule<PathModule>("path");
  return path ? path.join(...parts) : parts.join("\\");
}

/**
 * Determine whether the current runtime appears to be Windows.
 *
 * @returns True when running on Windows.
 */
function isWindowsRuntime(): boolean {
  const container = globalThis as unknown as ProcessContainer;
  const platform =
    container.process?.platform || getOptionalNodeModule<OsModule>("os")?.platform?.();
  if (platform) {
    return platform === "win32";
  }

  const env = container.process?.env;
  return Boolean(env?.LOCALAPPDATA || env?.APPDATA || env?.USERPROFILE);
}

/**
 * Return known Windows install locations for the native Codex executable.
 *
 * npm installs often expose `codex.ps1` or `codex.cmd` first, but Obsidian's
 * renderer process is most reliable when spawning the native `codex.exe`.
 *
 * @returns Ordered Windows fallback executable paths.
 */
function getKnownWindowsCodexBinaryCandidates(): string[] {
  if (!isWindowsRuntime()) {
    return [];
  }

  const container = globalThis as unknown as ProcessContainer;
  const env = container.process?.env || {};
  const os = getOptionalNodeModule<OsModule>("os");
  const homeDir = os?.homedir?.() || env.USERPROFILE;
  const candidates: string[] = [];

  if (env.LOCALAPPDATA) {
    candidates.push(joinPath(env.LOCALAPPDATA, "OpenAI", "Codex", "bin", "codex.exe"));
  }

  if (homeDir) {
    candidates.push(joinPath(homeDir, "AppData", "Local", "OpenAI", "Codex", "bin", "codex.exe"));
  }

  return candidates;
}

/**
 * Build a deduplicated ordered list of Codex CLI executable candidates.
 *
 * @param explicitBinary - Explicit binary override provided by caller.
 * @returns Ordered list of binary candidates to attempt.
 */
export function resolveCodexCliBinaryCandidates(explicitBinary?: string): string[] {
  const explicit = explicitBinary?.trim();
  if (explicit) {
    return Array.from(new Set([explicit, ...getKnownWindowsCodexBinaryCandidates()]));
  }

  const candidates = [
    ...getCliBinaryCandidatesFromEnv(),
    ...getKnownWindowsCodexBinaryCandidates(),
    DEFAULT_CODEX_CLI_BINARY,
  ];
  return Array.from(new Set(candidates.map((candidate) => candidate.trim()).filter(Boolean)));
}

/**
 * Build Codex CLI `exec` arguments for a chat invocation.
 *
 * @param prompt - Prompt text to pass to Codex.
 * @param outputPath - Temporary path that receives the final message.
 * @param ignoreRules - Whether to ignore AGENTS.md and other local rules.
 * @param promptTransport - Whether to pass the prompt as argv or stdin.
 * @param imagePaths - Temporary image file paths to attach to Codex CLI.
 * @returns Ordered CLI arguments.
 */
export function buildCodexExecArgs(
  prompt: string,
  outputPath: string,
  ignoreRules: boolean = true,
  promptTransport: "argv" | "stdin" = "stdin",
  imagePaths: string[] = []
): string[] {
  const args = [
    "exec",
    "-s",
    "read-only",
    "--skip-git-repo-check",
    "--ephemeral",
    "--json",
    "--output-last-message",
    outputPath,
  ];

  if (ignoreRules) {
    args.push("--ignore-rules");
  }

  for (const imagePath of imagePaths) {
    if (imagePath.trim()) {
      args.push("--image", imagePath);
    }
  }

  args.push(promptTransport === "stdin" ? "-" : prompt);
  return args;
}

/**
 * Convert process output chunks to strings.
 *
 * @param chunk - Output chunk from stdout/stderr.
 * @returns String form of the chunk.
 */
function chunkToString(chunk: unknown): string {
  return typeof chunk === "string" ? chunk : String(chunk);
}

/**
 * Normalize process exit code from process errors.
 *
 * @param code - Error code from process callback.
 * @returns Numeric exit code when available.
 */
function toExitCode(code: string | number | null | undefined): number | null {
  return typeof code === "number" ? code : null;
}

/**
 * Execute the CLI once with a specific binary candidate.
 *
 * @param spawn - Process spawn function.
 * @param binary - Binary candidate path/name.
 * @param invocation - Process invocation details.
 * @param attemptedBinaries - Current list of attempted binaries.
 * @returns Structured process result.
 */
async function executeOnce(
  spawn: SpawnFn,
  binary: string,
  invocation: Required<Pick<CodexCliProcessInvocation, "timeoutMs" | "maxBufferBytes">> &
    CodexCliProcessInvocation,
  attemptedBinaries: string[]
): Promise<CodexCliProcessResult> {
  const startedAt = Date.now();
  const stdout = "";
  let stderr = "";
  let settled = false;
  let timedOut = false;
  let aborted = false;
  let exceededBuffer = false;
  let child: ChildProcessLike | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  return await new Promise<CodexCliProcessResult>((resolve) => {
    /**
     * Resolve the process once and clean up timers/listeners.
     */
    const finish = (partial: Omit<CodexCliProcessResult, "durationMs">) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      invocation.signal?.removeEventListener("abort", handleAbort);
      resolve({
        ...partial,
        durationMs: Date.now() - startedAt,
      });
    };

    /**
     * Append output and terminate if the configured buffer limit is exceeded.
     */
    const appendOutput = (target: "stdout" | "stderr", chunk: unknown) => {
      const text = chunkToString(chunk);
      if (target === "stderr") {
        stderr += text;
      }

      if (stderr.length > invocation.maxBufferBytes && child) {
        exceededBuffer = true;
        child.kill("SIGTERM");
      }
    };

    /**
     * Abort listener that terminates the child process.
     */
    function handleAbort() {
      aborted = true;
      child?.kill("SIGTERM");
    }

    try {
      const usesStdin = invocation.stdinText !== undefined;
      child = spawn(binary, invocation.args, {
        cwd: invocation.cwd,
        windowsHide: true,
        stdio: [usesStdin ? "pipe" : "ignore", "ignore", "pipe"],
      });
    } catch (error) {
      const processError = error as SpawnProcessError;
      finish({
        args: invocation.args,
        binary,
        attemptedBinaries: [...attemptedBinaries],
        ok: false,
        stdout,
        stderr,
        exitCode: toExitCode(processError.code),
        errorCode: processError.code ?? null,
        signal: processError.signal ?? null,
      });
      return;
    }

    child.stderr?.on("data", (chunk) => appendOutput("stderr", chunk));

    timeoutId = setTimeout(() => {
      timedOut = true;
      child?.kill("SIGTERM");
    }, invocation.timeoutMs);

    if (invocation.signal?.aborted) {
      handleAbort();
    } else {
      invocation.signal?.addEventListener("abort", handleAbort, { once: true });
    }

    if (invocation.stdinText !== undefined) {
      try {
        if (!child.stdin) {
          throw new Error("Failed to open stdin for Codex CLI prompt.");
        }
        child.stdin.write(invocation.stdinText);
        child.stdin.end();
      } catch (error) {
        child.kill("SIGTERM");
        const processError = error as SpawnProcessError;
        finish({
          args: invocation.args,
          binary,
          attemptedBinaries: [...attemptedBinaries],
          ok: false,
          stdout,
          stderr,
          exitCode: toExitCode(processError.code),
          errorCode: processError.code ?? "STDIN_WRITE_FAILED",
          signal: processError.signal ?? null,
        });
      }
    }

    child.on("error", (error) => {
      finish({
        args: invocation.args,
        binary,
        attemptedBinaries: [...attemptedBinaries],
        ok: false,
        stdout,
        stderr,
        exitCode: toExitCode(error.code),
        errorCode: error.code ?? null,
        signal: error.signal ?? null,
      });
    });

    child.on("close", (code, closeSignal) => {
      let errorCode: string | number | null = code === 0 ? null : code;
      if (timedOut) {
        errorCode = "ETIMEDOUT";
      } else if (aborted) {
        errorCode = "ABORT_ERR";
      } else if (exceededBuffer) {
        errorCode = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
      }

      finish({
        args: invocation.args,
        binary,
        attemptedBinaries: [...attemptedBinaries],
        ok: code === 0 && !timedOut && !aborted && !exceededBuffer,
        stdout,
        stderr,
        exitCode: code,
        errorCode,
        signal: closeSignal,
      });
    });
  });
}

/**
 * Execute a Codex CLI process with binary fallback.
 *
 * @param invocation - Process invocation details.
 * @returns Structured process result.
 */
async function runCodexCliProcess(
  invocation: CodexCliProcessInvocation
): Promise<CodexCliProcessResult> {
  if (!isDesktopRuntime()) {
    throw new Error("Desktop Codex CLI is only supported in desktop Obsidian.");
  }

  const spawn = getSpawnFunction();
  const timeoutMs = invocation.timeoutMs ?? DEFAULT_CODEX_CLI_TIMEOUT_MS;
  const maxBufferBytes = invocation.maxBufferBytes ?? DEFAULT_CODEX_CLI_MAX_BUFFER_BYTES;
  const candidateBinaries = resolveCodexCliBinaryCandidates(invocation.binary);
  const attemptedBinaries: string[] = [];

  let lastResult: CodexCliProcessResult | null = null;
  for (const candidateBinary of candidateBinaries) {
    attemptedBinaries.push(candidateBinary);
    const result = await executeOnce(
      spawn,
      candidateBinary,
      { ...invocation, timeoutMs, maxBufferBytes },
      attemptedBinaries
    );
    lastResult = result;

    if (result.ok) {
      return result;
    }

    if (result.errorCode !== "ENOENT") {
      return result;
    }
  }

  if (lastResult) {
    return lastResult;
  }

  throw new Error("Codex CLI execution failed before process spawn.");
}

/**
 * Create a unique temporary output file path for Codex CLI.
 *
 * @returns Temporary output path.
 */
function createTempOutputPath(): string {
  const os = getNodeModule<OsModule>("os");
  const path = getNodeModule<PathModule>("path");
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return path.join(os.tmpdir(), `obsidian-copilot-codex-${suffix}.txt`);
}

/**
 * Remove a temporary file if it exists.
 *
 * @param outputPath - Temporary file path.
 */
function cleanupTempOutput(outputPath: string): void {
  const fs = getNodeModule<FileSystemModule>("fs");
  if (fs.existsSync(outputPath)) {
    fs.unlinkSync(outputPath);
  }
}

/**
 * Read and validate the final message written by Codex CLI.
 *
 * @param outputPath - Temporary output path.
 * @returns Final message text.
 */
function readFinalMessage(outputPath: string): string {
  const fs = getNodeModule<FileSystemModule>("fs");
  if (!fs.existsSync(outputPath)) {
    throw new Error("Codex CLI completed but did not create a final message file.");
  }

  const text = fs.readFileSync(outputPath, "utf8").trim();
  if (!text) {
    throw new Error("Codex CLI completed but did not produce a final message.");
  }
  return text;
}

/**
 * Return a compact process output excerpt for error messages.
 *
 * @param value - Raw output.
 * @returns Trimmed excerpt.
 */
function outputExcerpt(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 1200 ? `${trimmed.slice(0, 1200)}...` : trimmed;
}

/**
 * Build a user-facing error message from a failed Codex process result.
 *
 * @param result - Failed process result.
 * @returns Error message.
 */
export function formatCodexCliFailure(result: CodexCliProcessResult): string {
  if (result.errorCode === "ENOENT") {
    return "Codex CLI executable was not found. Install Codex CLI or set CODEX_CLI_BINARY/CODEX_CLI_PATH to the native codex.exe path.";
  }

  if (result.errorCode === "ETIMEDOUT") {
    return `Codex CLI timed out after ${result.durationMs}ms.`;
  }

  if (result.errorCode === "ABORT_ERR") {
    return "Codex CLI request was cancelled.";
  }

  if (result.errorCode === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return "Codex CLI produced too much process output and was stopped.";
  }

  if (result.errorCode === "ENAMETOOLONG") {
    return "Codex CLI command line was too long. The prompt should be sent through stdin instead of process arguments.";
  }

  const detail = outputExcerpt(result.stderr) || outputExcerpt(result.stdout);
  const suffix = detail ? `\n${detail}` : "";
  return `Codex CLI failed with exit code ${result.exitCode ?? result.errorCode}.${suffix}`;
}

/**
 * Execute a Codex CLI chat request and return the final message.
 *
 * @param invocation - Chat invocation details.
 * @returns Final Codex response plus process metadata.
 */
export async function runCodexCliChat(
  invocation: CodexCliChatInvocation
): Promise<CodexCliChatResult> {
  const prompt = invocation.prompt.trim();
  if (!prompt) {
    throw new Error("Codex CLI prompt is required.");
  }

  const outputPath = createTempOutputPath();
  const args = buildCodexExecArgs(
    prompt,
    outputPath,
    invocation.ignoreRules !== false,
    "stdin",
    invocation.imagePaths
  );

  try {
    const processResult = await runCodexCliProcess({
      args,
      cwd: invocation.cwd,
      stdinText: prompt,
      timeoutMs: invocation.timeoutMs,
      maxBufferBytes: invocation.maxBufferBytes,
      binary: invocation.binary,
      signal: invocation.signal,
    });

    if (!processResult.ok) {
      throw new Error(formatCodexCliFailure(processResult));
    }

    return {
      text: readFinalMessage(outputPath),
      processResult,
    };
  } finally {
    cleanupTempOutput(outputPath);
  }
}

/**
 * Execute a short Codex CLI request to verify installation and authentication.
 *
 * @param cwd - Working directory for the check.
 * @param ignoreRules - Whether to ignore local Codex rules during the check.
 * @returns True when the CLI returns a response.
 */
export async function pingCodexCli(cwd: string, ignoreRules: boolean = true): Promise<boolean> {
  await runCodexCliChat({
    prompt: DEFAULT_CODEX_CLI_PING_PROMPT,
    cwd,
    ignoreRules,
    timeoutMs: 60_000,
  });
  return true;
}
