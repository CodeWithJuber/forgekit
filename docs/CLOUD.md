# Self-hosted ForgeKit workspace sync

Use cloud sync when a team wants the contents and history of an explicitly enrolled project on its own server. The service needs Node 20+ and an installed Python 3 with SQLite. Provision the following configuration on the server outside any enrolled directory. Replace the data directory with an absolute, owner-only directory and provision distinct, unpredictable bearer secrets of at least 32 characters in the named environment variables. The example variable names contain no credentials.

```json
{
  "port": 4243,
  "dataDir": "/var/lib/forgekit/workspaces",
  "principals": [
    {"tenant":"team","workspace":"demo","role":"writer","tokenEnv":"WORKSPACE_UPLOAD"},
    {"tenant":"team","workspace":"demo","role":"reader","tokenEnv":"WORKSPACE_READ"},
    {"tenant":"team","workspace":"demo","role":"admin","tokenEnv":"WORKSPACE_ADMIN"}
  ]
}
```

Start the receiver with `forge cloud serve --config /path/to/server.json`. It listens on loopback. Use a TLS reverse proxy for remote users with request size and timeout limits appropriate to your deployment. Open the service root in a browser and enter the workspace ID and reader token. The page shows the current revision, files, sizes, redaction status and recent syncs. Filter files by path, inspect a sync for its changed paths, or select a file to verify its SHA-256 digest and download it. Preview text up to 256 KiB and PNG screenshots in the browser. The page keeps credentials in tab memory. Use **Clear session** when finished. Protect the database volume and its backups using your server's encryption and retention policy.

## Enroll a workspace

Choose a project directory separate from ForgeKit's private user state. The enrollment and snapshot checks cover both directions of nesting. To share workspace-scoped memory, enroll the project that owns it.

Run these commands inside the chosen project. `preview` reads the workspace locally and lists metadata and omission counts. After configuring the credential, preview again to include the exact active credential in the redaction check. Enrollment alone does not transmit the workspace.

```sh
forge cloud preview --json
forge cloud configure --full-workspace --url https://forge.example.org --workspace demo --token-env WORKSPACE_UPLOAD
forge cloud push
forge cloud status --remote
forge cloud watch --interval 30
```

The first push publishes the enrolled workspace. Later pushes transfer changed artifacts and deletions. Watch retries pending changes and uses bounded backoff on transient failures. Each batch carries its parent revision and a stable ID. A disconnected machine retains pending bytes in private user state. Retried requests are idempotent and stale writes receive HTTP 409. Inspect the remote manifest before deliberately replacing its baseline with local contents using `forge cloud push --replace-remote --confirm`. The local and remote views can diverge after an offline run. A successful push of pending bytes acknowledges that exact batch. Push again to send subsequent changes.

## What is included

Includes regular files inside the project, including dotfiles, untracked and gitignored files, source, rendered screenshots, temporary scripts, build outputs and recorded `.forge/sessions` artifacts where present. ForgeKit also exports this workspace's own private prompt/proposal directory, captured reusable skill recipes, harness run records and logically scoped memory, job, audit and spending records when available. These appear under the virtual `.forge-cloud-export/` prefix. A real file or directory at that prefix prevents upload to avoid collision. A model or host that never emitted a prompt, action, result or usage receipt leaves no such artifact to synchronize.

Credentials named by the enrolled token variable are removed from text before upload. Other text passes through ForgeKit's secret redactor. Selected credential paths, VCS internals, dependency caches, symlinks, hard links and special files are excluded. Generic opaque SQLite databases and journals are excluded. Known ForgeKit stores use scoped logical export instead. Binary media is eligible, and binary files that match known credential patterns are omitted. Images, documents and newly generated arbitrary files can contain confidential content invisible to a text redactor. Review the eligible paths before enrollment. Redaction and the exclusions below make this a selective project mirror. Global home directories, personal/team memory belonging to other scopes, executable trust bindings, local runtime grants and unrelated workspaces are outside the capture.

One sync supports up to 20,000 eligible files, 24 MiB per artifact and 128 MiB total payload bytes. Exceeding a limit fails the snapshot explicitly. File stability is checked per read. Stop rapidly changing writers for a reproducible snapshot. Only the latest content is retained. The service stores the latest bytes and an ordered history of sync receipts and changed-path manifests. An unchanged file incurs no second upload.

Snapshot inspection recognizes SQLite database and journal headers as well as common database extensions. When an application uses a custom filename, its recognized database and associated sidecars stay outside the file mirror. The workspace-specific logical exports listed above still apply. [SQLite file format](https://sqlite.org/fileformat.html)

## Permissions, logout and deletion

Reader credentials can list the workspace and retrieve eligible artifacts, including workspace-scoped prompt records and proposals that were private before full-workspace enrollment. Grant reader access accordingly. Writers can read metadata and upload. Administrators can perform these operations and delete remote contents. Credentials are constrained to one tenant and workspace on the service. Rotate or revoke a key in server configuration and restart the receiver. The client stores its endpoint, credential variable name, cursor and queue outside the enrolled repo.

- `forge cloud logout` clears local enrollment, pending bytes and the acknowledged cursor. The hosted data remains available to other authorized users.
- `forge cloud delete --confirm` sends an authenticated deletion request, then clears local enrollment after acknowledgement. Supply the configured workspace's admin token through its credential environment variable. The server deletes stored contents and receipts, and advances a deletion generation to reject stale uploads. Server backup retention is an operator responsibility.
- Reusing a deleted workspace ID requires deliberate baseline replacement on the newly enrolled client. A new workspace ID starts empty.

The API exposes `GET /v1/workspaces/{id}` for the manifest and latest 100 receipts, `GET /v1/workspaces/{id}/events?after=<revision>` for paginated incremental receipts, `GET /v1/workspaces/{id}/events?id=<revision>` for changed paths and content hashes, `GET /v1/workspaces/{id}/artifact?path=…` for a base64-encoded artifact and hash, `POST /v1/workspaces/{id}/sync` for a versioned change batch and `DELETE /v1/workspaces/{id}` for deletion. One upload at a time bounds receiver memory. A busy receiver responds with HTTP 429. Local `forge dash` remains independent of the web service.
