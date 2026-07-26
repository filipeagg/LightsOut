/**
 * Making a dev server reachable from the user's browser (PV-04, DESIGN §21.3).
 *
 * Vite, `next dev` and `python -m http.server` all bind `localhost` by default. Inside a container
 * that is the container's own loopback, so publishing the port changes nothing and the browser
 * gets a connection reset — the failure that looks like Docker being broken and is not. And most
 * of them will happily move to another port when the one they were given is busy, which lands them
 * outside the published pool and produces the same symptom for a different reason.
 *
 * So the command is rewritten before it runs: bind `0.0.0.0`, take the port that was allocated, and
 * fail rather than wander. What was rewritten is recorded on the preview row, because a command the
 * system changed must be visible to whoever wrote the original.
 */

export type Normalisation = {
  /** The command as it will actually run. */
  command: string;
  /** What was changed and why, one clause each; empty when the command was left alone. */
  notes: string[];
};

/** Does the command already say what to bind to? Then it is left alone: it was deliberate. */
function hasHost(command: string): boolean {
  return /(^|\s)(--host\b|-H\b|--hostname\b|--bind\b|-b\s+\d)/.test(command);
}

function hasPort(command: string): boolean {
  return /(^|\s)(--port\b|-p\s+\d|--port=)/.test(command);
}

/** The families worth knowing about; anything else gets the generic treatment. */
function family(command: string): "vite" | "next" | "http.server" | "generic" {
  if (/\bvite\b/.test(command)) return "vite";
  if (/\bnext\s+(dev|start)\b/.test(command)) return "next";
  if (/python3?\s+-m\s+http\.server\b/.test(command)) return "http.server";
  return "generic";
}

/**
 * Rewrite `command` to listen on `0.0.0.0:<port>` and not move.
 *
 * A command that already declares a host is trusted: someone chose it, and second-guessing a
 * deliberate `--host 127.0.0.1` would be the system being clever about a decision it did not make.
 * The port is still forced, because the port is not the caller's to choose — it was allocated.
 */
export function normalisePreviewCommand(command: string, port: number): Normalisation {
  const notes: string[] = [];
  let out = command.trim();
  const kind = family(out);

  if (kind === "http.server") {
    // `python -m http.server [port] [--bind addr]` takes the port positionally.
    if (!/--bind\b/.test(out)) {
      out += " --bind 0.0.0.0";
      notes.push("added --bind 0.0.0.0: a server on the container's localhost is unreachable");
    }
    if (!/http\.server\s+\d+/.test(out)) {
      out = out.replace(/(http\.server)(\s|$)/, `$1 ${port} `).trimEnd();
      notes.push(`set the port to ${port}, the one published for this preview`);
    }
    return { command: out, notes };
  }

  if (!hasHost(out)) {
    out += " --host 0.0.0.0";
    notes.push("added --host 0.0.0.0: a server on the container's localhost is unreachable");
  }
  if (!hasPort(out)) {
    out += ` --port ${port}`;
    notes.push(`set the port to ${port}, the one published for this preview`);
  }
  // Only the tools that actually have the flag. `--strictPort` on something that does not know it
  // is an immediate crash, which is worse than the problem it prevents.
  if ((kind === "vite" || /\b(npm|pnpm|yarn|bun)\b/.test(out)) && !/--strictPort\b/.test(out)) {
    out += " --strictPort";
    notes.push("added --strictPort: moving to another port would leave the published one dead");
  }

  return { command: out, notes };
}
