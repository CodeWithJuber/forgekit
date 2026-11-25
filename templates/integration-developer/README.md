# ForgeKit integration starter

The manifest in `team-guide/plugin.json` exposes a read-only Markdown reference to the supervised harness. Edit its name, source, license, description and reference. The machine-readable catalog gives executable argument arrays and permission boundaries for each adapter. Running the template command lists the MCP revisions supported by the installed package.

From the project root, for a copy created with `forge integrations template --out plugins`, inspect the actual contents, then pin the displayed SHA-256 digest.

```sh
forge harness extensions inspect plugins/team-guide
forge harness extensions pin plugins/team-guide --digest REVIEWED_SHA256
forge harness extensions list
forge harness extensions remove team-guide
```

Keep the source directory for later edits. After a change, inspect the new digest and explicitly pin it. Removing the extension revokes its approval and removes its lock entry. An executable MCP plugin uses a separate binding. Install and review the executable outside the worktree before enabling it. Record only the environment names it needs. An executable upgrade requires a new reviewed binding. The service and client control OS or remote access.

For a custom HTTP endpoint, replace the example URL with the exact service URL, issue a read-only service token, and place it in the named environment variable. Use `--probe` to test the handshake and enumerate tools before use. The probe sends no tool calls. Different clients support different authentication modes. Existing divergent client configurations require an explicit operator ownership decision with `--adopt`. Remove a managed integration with `forge integrations remove <id>`.
