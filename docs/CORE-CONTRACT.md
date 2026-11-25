# Stable automation contracts

Automation can depend on the v1 CLI envelopes and the v1 context packet consumer. An incompatible change to one of these formats requires a new version selector. Consumers should ignore unfamiliar fields. Individual command payloads retain their own schemas. A provider's catalog, a measured quality band and the text that a human sees can change with the evidence.

## Read one command result

```sh
forge --output=json-v1 verify --json
forge --output=json-v1 models --json
forge --output=json-v1 verify triage --json
```

The global option goes before the command. The command receives its normal arguments, working directory, environment and standard input. Its exit status reaches the caller. Each envelope contains `schemaVersion`, `command`, `exitCode`, `signal`, `complete`, `stdout` and `stderr`. Each stream reports its byte length and truncation flag. A stream with a complete JSON value uses `kind=json` and a parsed `value`. Other UTF-8 output uses `kind=text` and a string. Binary output uses `kind=binary` and `base64`. Each stream keeps its first 8 MiB in this mode. A truncated response sets `complete=false`. Check the exit code, completeness and the command's own verdict before acting on a verification result.

For larger outputs or a running process, use `forge --output=jsonl-v1 <command>`. Each line identifies the schema version and command. The first event is `started`. Intermediate `stdout` and `stderr` events carry base64 bytes in stream order. Decode and join chunks separately for each stream. The final `exit` reports `exitCode` and `signal`. When a host expects MCP stdio or hook JSON, invoke its native command with the transport specified by that host.

## Count and reconstruct context

```sh
forge context "Review the invoice parser" --budget 1200 --packet --json
forge context "Review the invoice parser" --budget 1200 --encoding cl100k_base --packet --json
```

The default counts the exact UTF-8 bytes of the assembled block. This is an upper bound for byte-level tokenizers. For an exact supported encoding, install `js-tiktoken` in a trusted location outside the target checkout on ForgeKit's Node module search path. Select the encoding used by your deployment. The renderer counts the joined block including separators, Unicode and ordinary text that resembles special tokens. The budget excludes host instructions, tools, chat wrappers and other provider-added input.

Import `contextCounter` and `applyContextPacket` from `@codewithjuber/forgekit/context-packet`. When a packet names an encoding, obtain the same encoder with `contextCounter(name, workspacePath)` and pass it as the third argument to `applyContextPacket(packet, priorSnapshot, counter)`. A digest binds the encoder identity, package version, chunk order and context manifest. Retain the validated snapshot before acknowledging it. A missing base requires a full packet. Old v1 manifests keep their original counting convention for reconstruction.

## Inspect verification history

`forge verify triage --json` reports repeated counted suite outcomes from locally authenticated events for this checkout. Runs match on the verifier version, head, measured working-tree bytes, recorded environment, suite command, directory and coverage. A pass and failure in one group produce `inconsistent` and both run IDs. One run produces `one-observation`. Identifying the root cause still requires reading the failures. The latest verification verdict and commit decision continue to use the actual run result. An environment digest covers the recorded attributes of the verifier. Clocks, external services and ignored dependencies can still vary.

The contract tests exercise the normal CLI, earlier packet formats, wrong encoders, missing bases, tampered content, distinct working trees and mixed suite outcomes. The experimental host adapters and hosted deployment settings have separate acceptance records. [Host evidence](INTEGRATIONS.md)
