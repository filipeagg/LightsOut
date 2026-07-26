/** Row shapes and domain unions mirroring src/db/schema.sql (DESIGN §4). */

export type PushPolicy = "auto" | "manual" | "never";
export type ChainStatus = "active" | "paused" | "completed" | "aborted";
export type TaskLevel = "quick" | "full";
export type Engine = "claude" | "codex";

export type TaskStatus =
  | "queued"
  | "running"
  | "ok"
  | "doubt"
  | "verify_failed"
  | "timeout"
  | "stuck"
  | "error"
  | "aborted"
  | "interrupted";

/** Runs share the task states plus waiting_human, and never sit in queued. */
export type RunStatus = Exclude<TaskStatus, "queued"> | "waiting_human";

export type DoubtKind = "functional" | "permission" | "gate" | "hard_rule";
export type PhaseGate = "auto" | "human";
export type PhaseStatus = "pending" | "running" | "done" | "failed" | "skipped";
export type DoubtStatus = "open" | "answered" | "closed";
export type DecisionKind = "human" | "provisional" | "auto";
export type PermissionVerdict = "allow" | "deny" | "require_human" | "provisional";
export type RuleSource = "project" | "agent" | "default";

export type EventType =
  | "run.state"
  | "task.state"
  | "chain.state"
  | "agent.message"
  | "tool.call"
  | "file.edit"
  | "perm.request"
  | "perm.verdict"
  | "doubt.opened"
  | "doubt.answered"
  | "advisor.consulted"
  /** The permission judge answered (PE-11, DESIGN §6.5b). */
  | "judge.verdict"
  | "verify.start"
  | "verify.result"
  | "git.commit"
  | "git.tag"
  | "git.push"
  | "system.auth"
  | "phase.state"
  | "config.changed"
  | "knowledge.attached"
  | "knowledge.detached"
  | "vault.read"
  /** Machine-first document check (BA-08, DESIGN §20.4); recorded, never a failure. */
  | "deliverable.lint"
  /** End-of-run hygiene (PE-08, DESIGN §5.2b). */
  | "scratch.swept"
  | "scratch.sweep_failed"
  | "run.untracked"
  | "system";

export type ProjectRow = {
  id: string;
  name: string;
  path: string;
  /** The context brief (PM-09). Never null; `status: provisional` when migration 4 wrote it. */
  context: string;
  repo_remote: string | null;
  push_policy: PushPolicy;
  policy_pack: string;
  verify_cmd: string | null;
  template_id: string | null;
  archived: number;
  created_at: string;
};

export type ProjectPhaseRow = {
  id: string;
  project_id: string;
  position: number;
  phase_id: string;
  title: string;
  agent_id: string;
  instructions: string;
  deliverable: string | null;
  verify_cmd: string | null;
  gate: PhaseGate;
  optional: number;
  repeatable: number;
  status: PhaseStatus;
  task_id: string | null;
  started_at: string | null;
  ended_at: string | null;
};

export type ProjectKnowledgeRow = {
  project_id: string;
  base_id: string;
  kind: string;
  writable: number;
  attached_at: string;
};

export type VaultAuditRow = {
  id: number;
  run_id: string;
  ts: string;
  entry_id: string;
  fields: string;
};

export type ChainRow = {
  id: string;
  project_id: string;
  title: string;
  status: ChainStatus;
  created_at: string;
};

export type TaskRow = {
  id: string;
  chain_id: string;
  project_id: string;
  position: number;
  title: string;
  spec: string;
  agent_id: string;
  level: TaskLevel;
  verify_cmd: string | null;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
};

export type RunRow = {
  id: string;
  task_id: string;
  attempt: number;
  engine: Engine;
  model: string | null;
  acp_session: string | null;
  status: RunStatus;
  started_at: string;
  ended_at: string | null;
  exit_reason: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  wip_commit: string | null;
  final_commit: string | null;
  summary: string | null;
  error: string | null;
};

export type EventRow = {
  id: number;
  run_id: string | null;
  ts: string;
  type: string;
  payload: string;
};

export type DoubtOption = { id: string; text: string };

export type DoubtRow = {
  id: string;
  ref: string;
  project_id: string;
  task_id: string;
  run_id: string | null;
  kind: DoubtKind;
  status: DoubtStatus;
  context: string;
  blocks: string;
  options: string;
  recommendation: string | null;
  second_opinion: string | null;
  answer: string | null;
  created_at: string;
  answered_at: string | null;
  /** Permission doubts only: the class the policy assigned and the command's shape (PE-10). */
  action_class: string | null;
  action_shape: string | null;
};

export type DecisionRow = {
  id: string;
  project_id: string;
  task_id: string | null;
  doubt_id: string | null;
  kind: DecisionKind;
  question: string;
  choice: string;
  rationale: string | null;
  checkpoint_tag: string | null;
  created_at: string;
};

export type PermissionAuditRow = {
  id: number;
  run_id: string;
  ts: string;
  action_class: string;
  detail: string;
  rule_source: RuleSource;
  verdict: PermissionVerdict;
  latency_ms: number;
};
