# Claude Desktop extension

`lightsout.mcpb` is how a user connects LightsOut to Claude Desktop (SU-09): one file, one
double-click. It is a zip with `manifest.json` at the root and a dependency-free stdio server
beside it, which forwards JSON-RPC to the container's MCP endpoint on `127.0.0.1`.

Build it with `scripts/windows/Build-Extension.ps1`; the result lands in `dist/lightsout.mcpb`.

Install it in any of three ways:

- double-click the file,
- drag it onto the Claude Desktop window,
- Settings → Extensions → Advanced settings → Install Extension…

## Why not a custom connector URL

A custom connector points Claude at a **remote** MCP server, and Claude reaches it from
Anthropic's cloud, which has no route to a user's `127.0.0.1`. Local servers must ship as
desktop extensions. This cost us two wrong turns before the documentation made it plain.

## Why not `claude_desktop_config.json`

Recent Claude Desktop builds manage MCP servers through extensions and connectors and never read
that file. On builds that do read it, editing it while the app runs is lost anyway, because the
app rewrites it on exit; `scripts/windows/Connect-ClaudeDesktop.ps1` handles that case by waiting
for the app to close.

## Contents

- `manifest.json` — metadata, the fifteen tools, and the port as a user-configurable option.
- `server/index.js` — the bridge. No dependencies: Claude Desktop ships its own Node runtime,
  and the bridge only needs `fetch` against localhost. It holds no state and no database handle,
  so the container remains the single writer (ST-02).
