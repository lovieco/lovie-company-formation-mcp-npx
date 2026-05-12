# lovie — Company Formation MCP Server

The [Company Formation MCP](https://www.lovie.co/formation) for AI coding tools. Form companies, manage bank accounts, cards, invoices, and more — directly from your terminal.

## Quick Start

```bash
npm install -g lovie
```

### 1. Log in

```bash
lovie login
```

This opens your browser to authenticate with your Lovie account.

### 2. Add to your AI tool

**Claude Code**

To add Lovie globally (available in all projects):
```bash
claude mcp add --scope user lovie npx lovie
```

To add Lovie to the current project only:
```bash
claude mcp add lovie npx lovie
```

**Cursor** — add to `.cursor/mcp.json`
```json
{
  "mcpServers": {
    "lovie": {
      "command": "npx",
      "args": ["-y", "lovie"]
    }
  }
}
```

**Windsurf** — add to `mcp_config.json`
```json
{
  "mcpServers": {
    "lovie": {
      "command": "npx",
      "args": ["-y", "lovie"]
    }
  }
}
```

**Claude Desktop** — add to `claude_desktop_config.json`
```json
{
  "mcpServers": {
    "lovie": {
      "command": "npx",
      "args": ["-y", "lovie"]
    }
  }
}
```

**VS Code / GitHub Copilot** — add to `.vscode/mcp.json`
```json
{
  "mcpServers": {
    "lovie": {
      "command": "npx",
      "args": ["-y", "lovie"]
    }
  }
}
```

**Replit** — add to `.replit` or use the MCP panel in Replit Agent
```json
{
  "mcpServers": {
    "lovie": {
      "command": "npx",
      "args": ["-y", "lovie"]
    }
  }
}
```

**Lovable** — in the MCP integration settings, add:
- **Name**: `lovie`
- **Command**: `npx`
- **Arguments**: `-y lovie`

**Manus** — in the MCP tool configuration, add:
- **Name**: `lovie`
- **Command**: `npx`
- **Arguments**: `-y lovie`

**OpenAI (ChatGPT / Codex)** — if MCP is supported, use the same stdio config:
```json
{
  "mcpServers": {
    "lovie": {
      "command": "npx",
      "args": ["-y", "lovie"]
    }
  }
}
```

**Any MCP-compatible platform** — Lovie works with any tool that supports the MCP stdio protocol. Use `npx -y lovie` as the command, or `lovie` if installed globally.

That's it. Your AI tool now has access to 79 Lovie business tools.

## What You Can Do

| Category | Tools |
|----------|-------|
| **Company Formation** | Start formation, set state, choose entity type, check name availability, add shareholders, generate certificate, pay filing fee |
| **Bank Accounts** | Create checking/savings/wallet, get balances, freeze/unfreeze, close accounts |
| **Cards** | Issue virtual/physical cards, set spending limits, freeze/unfreeze, cancel |
| **Payments** | Transfer between accounts, deposit funds, withdraw from wallet |
| **Invoicing** | Create/send/duplicate invoices, mark as paid, generate PDFs |
| **Clients** | Create and manage client records for invoicing |
| **Transactions** | List and filter transactions with AI-powered categorization |
| **Linked Accounts** | Connect external bank accounts via Plaid, sync transactions |
| **User Profile** | View/update profile, manage sessions, activity history |

## Commands

```bash
lovie              # Show setup instructions
lovie login        # Authenticate with Lovie
lovie logout       # Clear stored credentials
lovie status       # Check authentication status
lovie help         # Show help
```

## How It Works

This package is a lightweight stdio-to-HTTP proxy. It connects your local AI tool to the Lovie MCP server:

```
AI Tool (Claude, Cursor, etc.)  ←— stdio —→  lovie (this package)  ←— HTTPS —→  Lovie MCP Server
```

- On startup, discovers all available tools from the remote server
- Forwards tool calls over HTTPS and returns results via stdio
- Handles OAuth authentication, session management, and automatic token refresh
- All business logic runs on the Lovie server — this package is just the bridge

## Environment Variables

| Variable | Description |
|----------|-------------|
| `LOVIE_MCP_URL` | Custom MCP server URL (default: `https://lovie-mcp.vercel.app/mcp/mcp`) |
| `LOVIE_API_KEY` | Bearer token — overrides stored OAuth token |
| `DEBUG` | Enable verbose logging to stderr |

## Requirements

- Node.js 18+
- A Lovie account ([lovie.co](https://lovie.co))

## License

MIT
