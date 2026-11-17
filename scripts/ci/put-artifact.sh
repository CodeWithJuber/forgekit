#!/usr/bin/env bash
# Upload one archive using the job's identity and verify the compute server's receipt.
set -euo pipefail
umask 077
family=${1:?artifact family}
slot=${2:?artifact slot}
file=${3:?ZIP archive}
endpoint=https://n8n.jubershaikh.com/ci-artifacts
[[ "$family" =~ ^[a-z0-9-]+$ && "$slot" =~ ^[a-z0-9-]+$ && -s "$file" ]]
digest=$(sha256sum < "$file" | cut -d' ' -f1)
size=$(wc -c < "$file")
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT

# Keep bearer values in private temporary header files and out of process arguments.
printf 'Authorization: Bearer %s\n' "$ACTIONS_ID_TOKEN_REQUEST_TOKEN" > "$temporary/request-auth"
curl --silent --show-error --fail --proto '=https' --get \
  --header "@$temporary/request-auth" --data-urlencode "audience=$endpoint" \
  "$ACTIONS_ID_TOKEN_REQUEST_URL" > "$temporary/token.json"
jq -er '.value | select(type == "string" and length > 0) | "Authorization: Bearer " + .' \
  "$temporary/token.json" > "$temporary/upload-auth"

curl --silent --show-error --fail --proto '=https' --retry 3 --connect-timeout 20 --max-time 300 \
  --header "@$temporary/upload-auth" --header 'Content-Type: application/octet-stream' \
  --header 'X-Artifact-Format: zip' --header "X-Artifact-SHA256: $digest" \
  --upload-file "$file" "$endpoint/v1/artifacts/$family/$slot" > "$temporary/receipt.json"

jq -e --arg repository "$GITHUB_REPOSITORY" --arg id "$GITHUB_REPOSITORY_ID" \
  --arg run "$GITHUB_RUN_ID" --arg attempt "$GITHUB_RUN_ATTEMPT" --arg family "$family" \
  --arg slot "$slot" --arg sha "$digest" --argjson bytes "$size" \
  '.repository == $repository and .repository_id == $id and .run_id == $run
    and .run_attempt == $attempt and .family == $family and .slot == $slot
    and .sha256 == $sha and .size_bytes == $bytes
    and (.path | type == "string" and test("^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*$") and (split("/") | all(. != "..")))
    and (.retained_until | type == "string" and length > 0)' "$temporary/receipt.json" > /dev/null
expires=$(jq -er '.retained_until' "$temporary/receipt.json")
[[ "$(date -u -d "$expires" +%s)" -gt "$(date -u +%s)" ]]
printf 'Stored %s/%s on compute (%s bytes, SHA-256 `%s`).\n' "$family" "$slot" "$size" "$digest" >> "$GITHUB_STEP_SUMMARY"
