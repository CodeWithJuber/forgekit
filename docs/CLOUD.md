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

Git determines which regular files the workspace shares. Tracked and untracked source, screenshots and scripts are eligible. Git ignore rules apply by default, including nested rules and exceptions. Use `forge cloud preview --include-ignored` to see the additional paths. Enroll with `configure --full-workspace --include-ignored` to include them in pushes and watches. Relay uses the same selection. Credential, database and link exclusions apply in both modes. ForgeKit also exports this workspace's own private prompt/proposal directory, captured reusable skill recipes, harness run records and logically scoped memory, job, audit and spending records when available. These appear under the virtual `.forge-cloud-export/` prefix. A real file or directory at that prefix prevents upload to avoid collision. A model or host that never emitted a prompt, action, result or usage receipt leaves no such artifact to synchronize.

Credentials named by the enrolled token variable are removed from text before upload. Other text passes through ForgeKit's secret redactor. Selected credential paths, VCS internals, dependency caches, symlinks, hard links and special files are excluded. Generic opaque SQLite databases and journals are excluded. Known ForgeKit stores use scoped logical export instead. Binary media is eligible, and binary files that match known credential patterns are omitted. Images, documents and newly generated arbitrary files can contain confidential content invisible to a text redactor. Review the eligible paths before enrollment. Redaction and the exclusions below make this a selective project mirror. Global home directories, personal/team memory belonging to other scopes, executable trust bindings, local runtime grants and unrelated workspaces are outside the capture.

One sync supports up to 20,000 eligible files, 24 MiB per artifact and 128 MiB total payload bytes. Exceeding a limit fails the snapshot explicitly. File stability is checked per read. Stop rapidly changing writers for a reproducible snapshot. Only the latest content is retained. The service stores the latest bytes and an ordered history of sync receipts and changed-path manifests. An unchanged file incurs no second upload.

Snapshot inspection recognizes SQLite database and journal headers as well as common database extensions. When an application uses a custom filename, its recognized database and associated sidecars stay outside the file mirror. The workspace-specific logical exports listed above still apply. [SQLite file format](https://sqlite.org/fileformat.html)

Uploads allow 45 seconds for setup plus the encoded request size divided by the minimum transfer rate. The default rate is 65,536 bytes per second. Set `FORGE_CLOUD_MIN_BYTES_PER_SECOND` on each endpoint to accommodate a slower connection. The server also closes idle connections.

## Permissions, logout and deletion

Reader credentials can list the workspace and retrieve eligible artifacts, including workspace-scoped prompt records and proposals that were private before full-workspace enrollment. Grant reader access accordingly. Writers can read metadata and upload. Administrators can perform these operations and delete remote contents. Credentials are constrained to one tenant and workspace on the service. Rotate or revoke a key in server configuration and restart the receiver. The client stores its endpoint, credential variable name, cursor and queue outside the enrolled repo.

- `forge cloud logout` clears local enrollment, pending bytes and the acknowledged cursor. The hosted data remains available to other authorized users.
- `forge cloud delete --confirm` sends an authenticated deletion request, then clears local enrollment after acknowledgement. Supply the configured workspace's admin token through its credential environment variable. The server deletes stored contents and receipts, and advances a deletion generation to reject stale uploads. SQLite retains one row in `heads` containing the tenant/workspace scope and a new tombstone UUID. It uses that generation to reject uploads created before deletion. Server backup retention is an operator responsibility.
- Reusing a deleted workspace ID requires deliberate baseline replacement on the newly enrolled client. A new workspace ID starts empty.

The API exposes `GET /v1/workspaces/{id}` for the manifest and latest 100 receipts, `GET /v1/workspaces/{id}/events?after=<revision>` for paginated incremental receipts, `GET /v1/workspaces/{id}/events?id=<revision>` for changed paths and content hashes, `GET /v1/workspaces/{id}/artifact?path=…` for a base64-encoded artifact and hash, `POST /v1/workspaces/{id}/sync` for a versioned change batch and `DELETE /v1/workspaces/{id}` for deletion. The receiver enforces per-workspace write admission and separate limits for concurrent readers and writers. Local `forge dash` remains independent of the web service.

## End-to-end encrypted relay

Choose `forge relay` when the receiver should store encrypted content. The same Node and SQLite service can run in relay mode on a separate port with a separate private data directory. Use the scoped principal configuration above. A workspace can have independent dashboard and relay enrollments. Each has its own credentials, queue, revision and logout.

Generate one random 32-byte workspace encryption key using a secret manager, with standard base64 encoding. For example, `openssl rand -base64 32` produces that format. Keep the key on the authorized clients and deliver it to collaborators through an independent trusted channel. Use a different bearer credential for each reader, writer and administrator. Keep the encryption key out of the server configuration, shell logs and project files. Losing every copy of the key makes the encrypted workspace unreadable.

Start the receiver with `forge relay serve --config /private/relay.json`. It binds to loopback, accepts the scoped relay API and serves a text landing page. Use an HTTPS reverse proxy for remote access. The operator controls bearer credentials, the tenant and workspace IDs, storage, deletion and backups. Read decrypted files with an independently installed client.

The service exposes status, sync, events, artifact retrieval and administrator deletion under `/v1/relay/{tenant}/{workspace}`. Artifact retrieval takes an opaque object identifier and the expected current revision. An operator with the scoped administrator credential can delete the active data through the API if all clients lose their encryption keys.

The following commands assume the client has the workspace key in `WORKSPACE_RELAY_KEY` and the appropriate scoped bearer credential in `WORKSPACE_ACCESS`.

```sh
forge relay configure --full-workspace --url https://relay.example.org --tenant team --workspace demo --token-env WORKSPACE_ACCESS --key-env WORKSPACE_RELAY_KEY
forge relay preview
forge relay push
forge relay status --remote
forge relay list
forge relay read README.md --revision "$EXPECTED_REVISION" --json
```

A push returns its revision. Send that revision over an independent channel when a second device needs to verify an exact snapshot. Set `EXPECTED_REVISION` on the reader to that value. On the reader, configure the same endpoint, tenant and workspace with its own bearer credential and the shared encryption key. `list` decrypts names and metadata locally. `read` writes the verified bytes to stdout. Use `--path=--help` for a file named `--help`. The JSON form returns base64 bytes, verified SHA-256 and the revision. The reader chooses the destination. Provision a reader or administrator token for file contents. A writer with the workspace key can verify the encrypted manifest for replacement. `watch`, `logout` and administrator `delete --confirm` follow the cloud operations above in the relay's separate storage namespace.

### What the relay can observe

The client encrypts the manifest and changed artifacts after local redaction. Protocol version 1 derives separate keys with HKDF-SHA-256 for each tenant and workspace. A path becomes an HMAC-SHA-256 identifier. Each record uses an independently derived revision-and-object key, a random 96-bit nonce and AES-256-GCM with a 128-bit tag. Authenticated data includes the protocol, tenant, workspace, object identifier and revision. The encrypted manifest binds the path, content digest, media type, redaction status, ciphertext digest and originating revision of every file. The client verifies the complete manifest and the selected file before returning its bytes. Retrying a pending push reuses the exact sealed batch. An unchanged artifact retains its identifier and ciphertext.

The receiver sees tenant and workspace IDs, credentials presented to it, timestamps, revision links, counts, ciphertext lengths and repeated opaque file identifiers. It can infer which encrypted objects changed and can withhold or serve older data. A revision received through an independent channel detects a rollback. A first-time reader without such a revision establishes only that the snapshot was written by someone holding the shared key. `status --remote` verifies the manifest locally and reports its revision, authentication status and file count. An empty or deleted workspace with no encrypted manifest reports `authenticated: false`. A key holder can create a valid manifest. Client compromise, access-pattern privacy and individual author signatures are outside this protocol. [HKDF](https://www.rfc-editor.org/rfc/rfc5869) · [GCM](https://csrc.nist.gov/pubs/sp/800/38/d/final)

The 128 MiB snapshot limit includes the sealed manifest and encryption overhead. Up to 20,000 artifacts are supported, with one additional manifest. The existing 24 MiB file limit applies to plaintext artifacts and to the encoded manifest before encryption. Exceeding any bound fails the push. The client records the credential variable names and a key binding in enrollment state. Pending artifact bytes and the cursor manifest are encrypted on disk. A client-only authentication tag covers the exact saved request bytes. The client can also retry queues created with the earlier format. If local queue bytes change, the client rejects the retry before contacting the receiver.

Changing either scope or key requires a new enrollment. To rotate after a device loses access, provision a new workspace ID, encryption key and scoped bearer credentials, publish a fresh snapshot, revoke the old credentials and apply your retention policy to the old workspace. A holder of a previous key may retain already decrypted files and decrypt copies of ciphertext they retained. Remote deletion clears active contents and receipts. Operators separately expire old database copies, WAL archives, volume snapshots and replicas according to policy.

### Verify a deployment

Use disposable tenants and synthetic files. Publish a known text fixture and binary artifact, transfer the resulting revision to a separate reader, and verify the local content digests. Confirm a credential scoped to another tenant cannot read this workspace even when both tenants use the same workspace ID. Disconnect a writer after the server stores a revision, then retry the push and check it reports the same revision. Delete the sandbox as an administrator and verify the old writer's queued parent revision is rejected.

For backup acceptance, use SQLite's online backup API or the SQLite shell's `.backup` command to a new owner-only file on the operator's private volume. Restore it into a fresh private data directory on a separate loopback instance. Verify a known saved revision and file digest with the trusted client. The repository's `test/cloud_relay.test.js` runs this drill with synthetic keys and checks that a later receipt detects a stale restore. Record the production TLS configuration, recovery time, effective access policy and backup expiry for the deployment where they were observed.

The receiver allows one active upload or deletion per tenant/workspace. Other scopes can write concurrently while capacity is available. Receiver configuration accepts positive integer `maxConcurrentWrites` and `maxConcurrentReads` limits. The defaults are two writers and four read workers across all scopes. A saturated concurrency limit returns HTTP 429. A separate `maxHistoryBytes` limit defaults to 128 MiB per tenant/workspace. The receiver counts retained change summaries, path manifests and their keys in the same transaction as the snapshot. A new revision above that limit receives HTTP 413 and the previous revision stays readable. Identical retries remain valid. An administrator can increase the quota, or delete the workspace to release its history. Existing history counts toward the limit on upgrade.
