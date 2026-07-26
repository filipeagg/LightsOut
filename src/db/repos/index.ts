/**
 * Repository bundle: the single object the rest of the process uses to reach the
 * database. Constructed once at boot from the one writable connection (DB-03, ST-02).
 */
import type { Db } from "../db.js";
import { ProjectsRepo } from "./projects.js";
import { ChainsRepo } from "./chains.js";
import { TasksRepo } from "./tasks.js";
import { RunsRepo } from "./runs.js";
import { EventsRepo } from "./events.js";
import { DoubtsRepo } from "./doubts.js";
import { DecisionsRepo } from "./decisions.js";
import { AuditRepo } from "./audit.js";
import { SettingsRepo } from "./settings.js";
import { PhasesRepo } from "./phases.js";
import { ProjectKnowledgeRepo } from "./knowledge.js";
import { VaultAuditRepo } from "./vault-audit.js";
import { AreasRepo } from "./areas.js";
import { LearnedRepo } from "./learned.js";
import { ToolchainGrantsRepo } from "./toolchain-grants.js";
import { PreviewsRepo } from "./previews.js";

export type Repos = {
  db: Db;
  projects: ProjectsRepo;
  chains: ChainsRepo;
  tasks: TasksRepo;
  runs: RunsRepo;
  events: EventsRepo;
  doubts: DoubtsRepo;
  decisions: DecisionsRepo;
  audit: AuditRepo;
  settings: SettingsRepo;
  phases: PhasesRepo;
  projectKnowledge: ProjectKnowledgeRepo;
  vaultAudit: VaultAuditRepo;
  /** Read-only workspace areas per project (PE-09). */
  areas: AreasRepo;
  /** Command shapes a human has already allowed (PE-10). */
  learned: LearnedRepo;
  /** Package managers authorised for a project's durable toolchain (ST-07). */
  toolchainGrants: ToolchainGrantsRepo;
  /** Development servers LightsOut is running for a person to look at (PV-01). */
  previews: PreviewsRepo;
};

export function createRepos(db: Db): Repos {
  return {
    db,
    projects: new ProjectsRepo(db),
    chains: new ChainsRepo(db),
    tasks: new TasksRepo(db),
    runs: new RunsRepo(db),
    events: new EventsRepo(db),
    doubts: new DoubtsRepo(db),
    decisions: new DecisionsRepo(db),
    audit: new AuditRepo(db),
    settings: new SettingsRepo(db),
    phases: new PhasesRepo(db),
    projectKnowledge: new ProjectKnowledgeRepo(db),
    vaultAudit: new VaultAuditRepo(db),
    areas: new AreasRepo(db),
    learned: new LearnedRepo(db),
    toolchainGrants: new ToolchainGrantsRepo(db),
    previews: new PreviewsRepo(db),
  };
}

export {
  ProjectsRepo,
  ChainsRepo,
  TasksRepo,
  RunsRepo,
  EventsRepo,
  DoubtsRepo,
  DecisionsRepo,
  AuditRepo,
  SettingsRepo,
  PhasesRepo,
  ProjectKnowledgeRepo,
  VaultAuditRepo,
  AreasRepo,
  LearnedRepo,
  ToolchainGrantsRepo,
  PreviewsRepo,
};
