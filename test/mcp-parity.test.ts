/**
 * MC-07: anything the panel can do, MCP can do.
 *
 * The two surfaces are skins over `src/control/actions.ts` (§12.0), which only holds if both
 * skins expose the same actions. They drifted once already — the panel could write agents,
 * templates and knowledge for a whole phase while MCP could only read them — and nothing failed,
 * because a missing tool is not a compile error. This test is what makes it one.
 *
 * The vault is the deliberate exception, and it is written down here rather than assumed: a
 * credential value sent through a tool call would travel through the conversation to get here,
 * and VT-02 says values reach the adapter's environment and nowhere else.
 */
import { describe, expect, it } from "vitest";
import { Actions } from "../src/control/actions.js";
import { registerTools, type McpDeps } from "../src/mcp/tools.js";

/** Register against a server that only records names; no handler is ever called. */
function toolNames(): string[] {
  const names: string[] = [];
  const server = {
    registerTool(name: string) {
      names.push(name);
    },
  };
  registerTools(server as never, {} as McpDeps);
  return names;
}

/**
 * Actions that mutate something. Read-only helpers on `Actions` are not required to have a tool:
 * the read side is `src/views.ts`, shared by both surfaces already.
 */
const READ_ONLY = new Set([
  "readDoc",
  // PM-10: reading the project's Markdown. Both have tools anyway (`list_docs`,
  // `read_project_doc`), but they are reads and the parity rule is about mutations.
  "listDocs",
  "readProjectDoc",
  "listAreas",
  "listLearnedAllows",
  // MC-08: pure translation between the container's paths and the user's.
  "resolvePath",
  "agentSource",
  "phase",
  "knowledgeFolders",
  "adoptableFolders",
  // KB-12: the ids that exist, so a caller can derive one that is free. `list_knowledge` already
  // serves the bases themselves; this is the same read, narrower.
  "knowledgeIds",
  // AP-09: the engines and models a launch may name. `list_agents` serves the same catalog and
  // `GET /api/agents/models` serves it to the panel, but it is a read either way.
  "modelCatalog",
  // ST-07: what a project may install into its own toolchain with. `list_toolchain_grants` and
  // `GET /api/projects/:id` both serve it, but it is a read.
  "listToolchainGrants",
  // PV-03: what is being served, and why it is not. Both have tools; both are reads.
  "listPreviews",
  "previewLog",
]);

/**
 * Internal helpers. `private` in TypeScript is a compile-time promise, not a runtime one, so they
 * sit on the prototype next to the actions and have to be named to be excluded.
 */
const INTERNAL = new Set([
  "need",
  "project",
  "changed",
  "requireNotArchived",
  "requireLaunchable",
  "requireCapabilities",
  // AP-09/OR-11: validates the launch's engine and model before a task row exists.
  "requireModelChoice",
]);

/** The one exception, with its reason (VT-02, MC-07). Adding to this list is a design decision. */
const PANEL_ONLY = new Map([
  ["writeVaultEntry", "a credential value must not travel through the conversation (VT-02)"],
  ["deleteVaultEntry", "the vault is edited on loopback or not at all (VT-02)"],
]);

/** action name -> the tool that reaches it. */
const TOOL_FOR: Record<string, string> = {
  createProject: "create_project",
  archiveProject: "archive_project",
  deleteProject: "delete_project",
  launchPhase: "launch_phase",
  skipPhase: "skip_phase",
  addPhase: "add_phase",
  launchTask: "launch_task",
  launchChain: "launch_chain",
  answerDoubt: "answer_doubt",
  abortRun: "abort_run",
  stopRun: "stop_run",
  setProjectContext: "set_project_context",
  setProjectUnattended: "set_project_unattended",
  addArea: "add_area",
  removeArea: "remove_area",
  forgetLearnedAllow: "forget_learned_allow",
  startPreview: "preview_start",
  stopPreview: "preview_stop",
  grantToolchain: "grant_toolchain",
  revokeToolchainGrant: "revoke_toolchain_grant",
  resumeChain: "resume_chain",
  writeDoc: "write_doc",
  writeAgent: "write_agent",
  setAgentEnabled: "set_agent_enabled",
  deleteAgent: "delete_agent",
  reloadAgents: "reload_agents",
  writeTemplate: "write_template",
  deleteTemplate: "delete_template",
  writeKnowledge: "write_knowledge",
  adoptKnowledge: "adopt_knowledge",
  writeKnowledgeDoc: "write_knowledge_doc",
  deleteKnowledgeDoc: "delete_knowledge_doc",
  deleteKnowledge: "delete_knowledge",
  attachKnowledge: "attach_knowledge",
  detachKnowledge: "attach_knowledge",
};

function mutatingActions(): string[] {
  return Object.getOwnPropertyNames(Actions.prototype).filter(
    (name) =>
      name !== "constructor" &&
      !name.startsWith("_") &&
      !INTERNAL.has(name) &&
      !READ_ONLY.has(name),
  );
}

describe("MCP and the panel expose the same actions (MC-07)", () => {
  it("has a tool for every mutating action, or a written reason not to", () => {
    const tools = new Set(toolNames());
    const missing: string[] = [];

    for (const action of mutatingActions()) {
      if (PANEL_ONLY.has(action)) continue;
      const tool = TOOL_FOR[action];
      if (!tool || !tools.has(tool)) missing.push(action);
    }

    // Naming the actions makes the failure actionable: "add a tool for these".
    expect(missing).toEqual([]);
  });

  it("keeps the vault write-free on the MCP side (VT-02)", () => {
    const tools = toolNames();
    expect(tools).toContain("list_vault");
    expect(tools.filter((t) => /vault/.test(t))).toEqual(["list_vault"]);
  });

  it("maps every entry of the table to a tool that exists", () => {
    // A stale mapping would let an action slip through by pointing at a tool nobody registers.
    const tools = new Set(toolNames());
    for (const [action, tool] of Object.entries(TOOL_FOR)) {
      expect(tools.has(tool), `${action} -> ${tool}`).toBe(true);
    }
  });

  it("registers every tool exactly once", () => {
    const tools = toolNames();
    expect(new Set(tools).size).toBe(tools.length);
  });

  it("covers every action the table claims to, and no stale name", () => {
    // If an action is renamed or removed, the mapping should stop mentioning it — otherwise the
    // first test passes for an action that no longer exists.
    const actions = new Set(mutatingActions());
    for (const action of Object.keys(TOOL_FOR)) {
      expect(actions.has(action), `${action} is in the table but not on Actions`).toBe(true);
    }
  });
});
