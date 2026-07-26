# guide :: vault

meta.topic: vault
meta.tools: list_vault
meta.requirement: VT-01..06

## what_it_is

file: workspace/vault.yaml, git-ignored, never read into the database.
entry: an id, a label, a base_url, and named variables. A value is never returned by any read.
index: the prompt gets labels, URLs and variable names — never a value (VT-02).
resolution: values are placed in the environment of the adapter process, and only for a run whose pack grants network. A run that cannot reach anything has no use for a token.

## writing_a_value

surface: the panel only, on loopback. MCP cannot write a value, deliberately: a value sent through a tool call would travel through the conversation to get here (MC-07).
test_only: an entry may be flagged test_only; the probe pack refuses anything else (VT-06).

## for_the_agent

missing: a missing or empty entry is a doubt naming the entry id and the fields needed — never a guess, never an invented URL or token (VT-04).
audit: every resolution is recorded as `vault.read` with the entry id and the field names, never the values (VT-05).
