#!/usr/bin/env node

// ─── Section 1: Imports ───────────────────────────────────────────────────────

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { randomBytes, createHash } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { exec } from "node:child_process";
import { createInterface } from "node:readline";
import qrcode from "qrcode-terminal";

// ─── Section 2: Constants + Helpers ───────────────────────────────────────────

const REMOTE_MCP_URL =
  process.env.LOVIE_MCP_URL ?? "https://lovie-mcp.vercel.app/mcp/mcp";
const REQUEST_TIMEOUT = 30_000;
const DEBUG = !!process.env.DEBUG;

/** Derive the base URL (without /mcp/mcp) for .well-known endpoints */
function getBaseUrl(): string {
  return REMOTE_MCP_URL.replace(/\/mcp\/mcp\/?$/, "");
}

function log(...args: unknown[]): void {
  process.stderr.write(`[lovie-formation] ${args.join(" ")}\n`);
}

function debug(...args: unknown[]): void {
  if (DEBUG) log("[debug]", ...args);
}

interface RemoteTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

// ─── Section 3: Token Storage ─────────────────────────────────────────────────

const CONFIG_DIR = join(homedir(), ".config", "lovie");
const TOKEN_FILE = join(CONFIG_DIR, "auth.json");

interface StoredAuth {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_at?: number;
  client_id: string;
  client_secret?: string;
}

function loadStoredAuth(): StoredAuth | null {
  try {
    if (!existsSync(TOKEN_FILE)) return null;
    const data = JSON.parse(readFileSync(TOKEN_FILE, "utf8")) as StoredAuth;
    if (!data.access_token) return null;
    return data;
  } catch {
    return null;
  }
}

function saveAuth(auth: StoredAuth): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(TOKEN_FILE, JSON.stringify(auth, null, 2), { mode: 0o600 });
}

function clearAuth(): void {
  try {
    if (existsSync(TOKEN_FILE)) unlinkSync(TOKEN_FILE);
  } catch {
    // ignore
  }
}

/** Get the best available bearer token: env var > stored OAuth token */
function getAccessToken(): string | null {
  if (process.env.LOVIE_API_KEY) return process.env.LOVIE_API_KEY;
  const stored = loadStoredAuth();
  return stored?.access_token ?? null;
}

// ─── Section 4: OAuth PKCE Helpers ────────────────────────────────────────────

function base64url(buffer: Buffer): string {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function generateCodeVerifier(): string {
  return base64url(randomBytes(32));
}

function generateCodeChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

interface OAuthMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
}

async function discoverOAuthMetadata(): Promise<OAuthMetadata> {
  const url = `${getBaseUrl()}/.well-known/oauth-authorization-server`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch OAuth metadata: ${res.status}`);
  return (await res.json()) as OAuthMetadata;
}

interface ClientRegistration {
  client_id: string;
  client_secret?: string;
}

async function registerDynamicClient(
  registrationEndpoint: string,
  redirectUri: string,
): Promise<ClientRegistration> {
  const res = await fetch(registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Lovie CLI (create-company)",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "profile email offline_access",
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Dynamic client registration failed (${res.status}): ${text}`,
    );
  }
  return (await res.json()) as ClientRegistration;
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd =
    platform === "darwin"
      ? "open"
      : platform === "win32"
        ? "start"
        : "xdg-open";
  exec(`${cmd} "${url}"`, (err) => {
    if (err) {
      console.log(`\nOpen this URL in your browser:\n  ${url}\n`);
    }
  });
}

function generateQR(url: string): Promise<string> {
  return new Promise((resolve) => {
    qrcode.generate(url, { small: true }, (code: string) => {
      resolve(code);
    });
  });
}

function waitForEnter(prompt: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

// ─── Section 5: Login / Logout / Token Refresh ────────────────────────────────

async function refreshAccessToken(
  storedAuth: StoredAuth,
  metadata: OAuthMetadata,
): Promise<boolean> {
  if (!storedAuth.refresh_token) return false;

  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: storedAuth.refresh_token,
      client_id: storedAuth.client_id,
    });

    const res = await fetch(metadata.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    if (!res.ok) return false;

    const tokens = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    saveAuth({
      ...storedAuth,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token ?? storedAuth.refresh_token,
      expires_at: tokens.expires_in
        ? Date.now() + tokens.expires_in * 1000
        : undefined,
    });
    return true;
  } catch {
    return false;
  }
}

async function login(): Promise<void> {
  console.log("Logging in to Lovie...\n");

  // 1. Discover OAuth endpoints
  const metadata = await discoverOAuthMetadata();
  debug("OAuth metadata:", JSON.stringify(metadata));

  if (!metadata.registration_endpoint) {
    throw new Error(
      "OAuth server does not support dynamic client registration",
    );
  }

  // 2. Generate PKCE pair
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  // 3. Start local callback server
  const { port, waitForCode, close } = await startCallbackServer();
  const redirectUri = `http://localhost:${port}/callback`;

  try {
    // 4. Register dynamic client
    console.log("Registering client...");
    const client = await registerDynamicClient(
      metadata.registration_endpoint,
      redirectUri,
    );
    debug("Client registered:", client.client_id);

    // 5. Build authorization URL
    const authUrl = new URL(metadata.authorization_endpoint);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", client.client_id);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("code_challenge", codeChallenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("scope", "profile email offline_access");

    // 6. Show QR code + let user choose
    const qr = await generateQR(authUrl.toString());
    console.log(qr);
    console.log("  Scan the QR code with your phone,");
    console.log("  or press Enter to open the browser.\n");

    waitForEnter("").then(() => {
      openBrowser(authUrl.toString());
      console.log("  Browser opened. Waiting for authentication...\n");
    });

    console.log("  Waiting for authentication...\n");

    // 7. Wait for the callback with the auth code
    const code = await waitForCode();
    debug("Received auth code");

    // 8. Exchange code for tokens
    console.log("Exchanging code for token...");
    debug(`Token endpoint: ${metadata.token_endpoint}`);
    debug(`Redirect URI: ${redirectUri}`);
    debug(`Client ID: ${client.client_id}`);

    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: client.client_id,
      code_verifier: codeVerifier,
    });

    const tokenRes = await fetch(metadata.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody,
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text().catch(() => "");
      console.error(`\n  Token exchange failed (${tokenRes.status})`);
      console.error(`  redirect_uri: ${redirectUri}`);
      console.error(`  client_id: ${client.client_id}`);
      console.error(`  Response: ${errText}\n`);
      throw new Error(`Token exchange failed (${tokenRes.status}): ${errText}`);
    }

    const tokens = (await tokenRes.json()) as {
      access_token: string;
      refresh_token?: string;
      token_type: string;
      expires_in?: number;
    };

    // 9. Store tokens
    saveAuth({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_type: tokens.token_type,
      expires_at: tokens.expires_in
        ? Date.now() + tokens.expires_in * 1000
        : undefined,
      client_id: client.client_id,
      client_secret: client.client_secret,
    });

    console.log("\n  Authenticated successfully!\n");
    printSetupInstructions();
  } finally {
    close();
  }

  process.exit(0);
}

function startCallbackServer(): Promise<{
  port: number;
  waitForCode: () => Promise<string>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    let resolveCode: (code: string) => void;
    let rejectCode: (err: Error) => void;

    const codePromise = new Promise<string>((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1`);

      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (error) {
          const desc = url.searchParams.get("error_description") ?? error;
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            `<html><body><h1>Authentication failed</h1><p>${desc}</p><p>You can close this tab.</p></body></html>`,
          );
          rejectCode(new Error(`OAuth error: ${desc}`));
          return;
        }

        if (code) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            `<html><body><h1>Authenticated!</h1><p>You can close this tab and return to your terminal.</p></body></html>`,
          );
          resolveCode(code);
          return;
        }

        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Missing code parameter");
        return;
      }

      res.writeHead(404);
      res.end();
    });

    server.listen(0, "localhost", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to start callback server"));
        return;
      }
      resolve({
        port: addr.port,
        waitForCode: () => codePromise,
        close: () => server.close(),
      });
    });

    server.on("error", reject);

    // Timeout after 2 minutes
    setTimeout(() => {
      rejectCode(new Error("Authentication timed out (2 minutes)"));
      server.close();
    }, 120_000);
  });
}

async function logout(): Promise<void> {
  clearAuth();
  console.log("Logged out. Token cleared.");
}

async function showStatus(): Promise<void> {
  const stored = loadStoredAuth();
  if (!stored) {
    console.log("Not logged in. Run: npx lovie login");
    return;
  }

  const expired = stored.expires_at && stored.expires_at < Date.now();
  console.log(`Logged in (token ${expired ? "expired" : "active"})`);
  console.log(`Token file: ${TOKEN_FILE}`);

  if (expired && stored.refresh_token) {
    console.log("Token expired — will auto-refresh on next use.");
  } else if (expired) {
    console.log("Token expired — run: npx lovie login");
  }
}

function printSetupInstructions(): void {
  console.log(`
  Add Lovie to your AI tools:

  Claude Code
    claude mcp add lovie npx lovie

  Cursor  (.cursor/mcp.json)
    {
      "mcpServers": {
        "lovie": {
          "command": "npx",
          "args": ["-y", "lovie"]
        }
      }
    }

  Windsurf  (mcp_config.json)
    {
      "mcpServers": {
        "lovie": {
          "command": "npx",
          "args": ["-y", "lovie"]
        }
      }
    }

  Claude Desktop  (claude_desktop_config.json)
    {
      "mcpServers": {
        "lovie": {
          "command": "npx",
          "args": ["-y", "lovie"]
        }
      }
    }
`);
}

async function interactive(): Promise<void> {
  console.log(`
  Lovie — Form companies, manage banking, cards & invoices from your AI tools.
`);

  const stored = loadStoredAuth();

  if (!stored) {
    console.log("  Not logged in.\n");
    console.log("  Run:  npx lovie login\n");
    return;
  }

  const expired = stored.expires_at && stored.expires_at < Date.now();
  if (expired && !stored.refresh_token) {
    console.log("  Session expired.\n");
    console.log("  Run:  npx lovie login\n");
    return;
  }

  console.log("  Authenticated.\n");
  printSetupInstructions();
}

// ─── Section 6: Session State ─────────────────────────────────────────────────

let sessionId: string | null = null;
let requestId = 1;
let discoveredTools: RemoteTool[] = [];
let isReinitializing = false;
let cachedAccessToken: string | null = null;

function resolveAuthHeader(): string | null {
  if (cachedAccessToken) return cachedAccessToken;
  cachedAccessToken = getAccessToken();
  return cachedAccessToken;
}

// ─── Section 7: Core HTTP Transport ───────────────────────────────────────────

async function rpcCall(
  method: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  const id = requestId++;
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    params: params ?? {},
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  const token = resolveAuthHeader();
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  if (sessionId) {
    headers["Mcp-Session-Id"] = sessionId;
  }

  debug(`→ ${method}`, params ? JSON.stringify(params).slice(0, 200) : "");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  let response: Response;
  try {
    response = await fetch(REMOTE_MCP_URL, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
  } catch (err: unknown) {
    clearTimeout(timeout);
    const msg = err instanceof Error ? err.message : String(err);
    throw new McpError(ErrorCode.InternalError, `HTTP request failed: ${msg}`);
  } finally {
    clearTimeout(timeout);
  }

  // Capture session ID from response
  const newSessionId = response.headers.get("mcp-session-id");
  if (newSessionId) {
    sessionId = newSessionId;
    debug("Session ID:", sessionId);
  }

  // 401 → token expired, try refresh
  if (response.status === 401 && !isReinitializing) {
    const stored = loadStoredAuth();
    if (stored?.refresh_token) {
      debug("Got 401, attempting token refresh…");
      const metadata = await discoverOAuthMetadata();
      const refreshed = await refreshAccessToken(stored, metadata);
      if (refreshed) {
        cachedAccessToken = null; // force reload
        return rpcCall(method, params);
      }
    }
    // If refresh failed, surface a clear error
    log("Authentication failed. Run: npx lovie login");
    throw new McpError(
      ErrorCode.InvalidRequest,
      "Not authenticated. Run `npx lovie login` in your terminal to authenticate.",
    );
  }

  // 404 → session expired, reinitialize once
  if (response.status === 404 && !isReinitializing) {
    debug("Got 404, reinitializing session…");
    await reinitializeSession();
    return rpcCall(method, params);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new McpError(
      ErrorCode.InternalError,
      `Remote returned ${response.status}: ${text.slice(0, 300)}`,
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  let result: unknown;

  if (contentType.includes("text/event-stream")) {
    const text = await response.text();
    result = parseSSEResponse(text);
  } else {
    const json = (await response.json()) as Record<string, unknown>;
    if (json.error) {
      const err = json.error as { code?: number; message?: string };
      throw new McpError(
        err.code ?? ErrorCode.InternalError,
        err.message ?? "Remote error",
      );
    }
    result = json.result;
  }

  debug(`← ${method}`, JSON.stringify(result).slice(0, 200));
  return result;
}

// ─── Section 8: SSE Parser ────────────────────────────────────────────────────

function parseSSEResponse(text: string): unknown {
  const lines = text.split("\n");

  for (const line of lines) {
    if (!line.startsWith("data:")) continue;

    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;

    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      if (parsed.error) {
        const err = parsed.error as { code?: number; message?: string };
        throw new McpError(
          err.code ?? ErrorCode.InternalError,
          err.message ?? "Remote SSE error",
        );
      }
      if (parsed.result !== undefined) {
        return parsed.result;
      }
    } catch (err) {
      if (err instanceof McpError) throw err;
      debug("Skipping unparseable SSE line:", data.slice(0, 100));
    }
  }

  throw new McpError(
    ErrorCode.InternalError,
    "No valid JSON-RPC result found in SSE response",
  );
}

// ─── Section 9: Session (Re)initialization ────────────────────────────────────

async function reinitializeSession(): Promise<void> {
  isReinitializing = true;

  try {
    sessionId = null;

    debug("Sending initialize…");
    await rpcCall("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: {
        name: "lovie-formation",
        version: "1.0.0",
      },
    });

    debug("Sending notifications/initialized…");
    const notifHeaders: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const token = resolveAuthHeader();
    if (token) {
      notifHeaders["Authorization"] = `Bearer ${token}`;
    }
    if (sessionId) {
      notifHeaders["Mcp-Session-Id"] = sessionId;
    }
    fetch(REMOTE_MCP_URL, {
      method: "POST",
      headers: notifHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    }).catch(() => {});

    debug("Fetching tools/list…");
    const toolsResult = (await rpcCall("tools/list")) as {
      tools?: RemoteTool[];
    };
    discoveredTools = toolsResult?.tools ?? [];
    log(`Discovered ${discoveredTools.length} tools from remote`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Warning: session init failed: ${msg}`);
    discoveredTools = [];
  } finally {
    isReinitializing = false;
  }
}

// ─── Section 10: Main (stdio MCP server) ─────────────────────────────────────

/** When not authenticated, expose a single helper tool that tells the AI what to do */
const AUTH_REQUIRED_TOOL: RemoteTool = {
  name: "lovie_auth_required",
  description:
    "The user is not authenticated with Lovie. Tell them to run `npx lovie login` in their terminal to authenticate, then restart the MCP connection. All Lovie tools (company formation, banking, cards, invoices) will become available after login.",
  inputSchema: {
    type: "object" as const,
    properties: {},
  },
};

async function main(): Promise<void> {
  const token = resolveAuthHeader();
  const notAuthenticated = !token;
  if (notAuthenticated) {
    log("Not authenticated. Run: npx lovie login");
  }

  const server = new Server(
    {
      name: "lovie-formation",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // Initialize remote session (skip if no token — will fail anyway)
  if (!notAuthenticated) {
    try {
      await reinitializeSession();
    } catch {
      log("Warning: could not reach remote server, starting with 0 tools");
    }
  }

  // Handler: tools/list
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (notAuthenticated || discoveredTools.length === 0) {
      return { tools: [AUTH_REQUIRED_TOOL] };
    }
    return { tools: discoveredTools };
  });

  // Handler: tools/call
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // Handle the auth-required helper tool
    if (name === "lovie_auth_required") {
      return {
        content: [
          {
            type: "text" as const,
            text: "Not authenticated with Lovie. The user needs to run `npx lovie login` in their terminal to authenticate, then restart the MCP connection (e.g. `/mcp` in Claude Code). After login, all Lovie tools will be available.",
          },
        ],
        isError: true,
      };
    }

    try {
      const result = (await rpcCall("tools/call", {
        name,
        arguments: args ?? {},
      })) as {
        content?: Array<{ type: string; text: string }>;
        isError?: boolean;
      };

      if (result?.content && Array.isArray(result.content)) {
        return {
          content: result.content,
          isError: result.isError ?? false,
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text:
              typeof result === "string"
                ? result
                : JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Error: ${msg}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  if (notAuthenticated) {
    log(
      "Server running — NOT AUTHENTICATED. Only lovie_auth_required tool exposed. Run: npx lovie login",
    );
  } else if (discoveredTools.length === 0) {
    log(
      "Server running — 0 tools discovered. Remote server may be down or auth may have failed.",
    );
  } else {
    log(`Server running — ${discoveredTools.length} tools available via stdio`);
  }
}

// ─── Section 11: Entry Point ──────────────────────────────────────────────────

const command = process.argv[2];
const isTTY = !!process.stdin.isTTY;

process.on("uncaughtException", (err) => {
  log("Uncaught exception:", err.message);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  log("Unhandled rejection:", String(reason));
  process.exit(1);
});

if (command === "login") {
  login().catch((err) => {
    console.error(
      "Login failed:",
      err instanceof Error ? err.message : String(err),
    );
    process.exit(1);
  });
} else if (command === "logout") {
  logout().catch(() => process.exit(1));
} else if (command === "status") {
  showStatus().catch(() => process.exit(1));
} else if (command === "help" || command === "--help" || command === "-h") {
  console.log(`
  Lovie — MCP server for company formation, banking, cards & invoices.

  Usage:
    npx lovie login       Authenticate with Lovie (opens browser)
    npx lovie logout      Clear stored credentials
    npx lovie status      Check authentication status
    npx lovie help        Show this help

  Environment:
    LOVIE_MCP_URL     Remote MCP server URL
    LOVIE_API_KEY     Bearer token (overrides stored OAuth token)
    DEBUG             Enable verbose logging
`);
} else if (!command && isTTY) {
  // User ran interactively (e.g. "npx lovie" in terminal)
  interactive().catch(() => process.exit(1));
} else {
  // Piped by MCP client — start stdio server
  main().catch((err) => {
    log("Fatal:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
