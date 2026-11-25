// The stdio tools server and Streamable HTTP discovery client implement different transports.
export const stdioVersions = Object.freeze(["2024-11-05"]);
export const httpDiscoveryVersions = Object.freeze(["2025-11-25", "2025-06-18", "2025-03-26"]);

/** MCP initialize returns a supported alternative when the peer proposes an unsupported revision. */
export function negotiateStdio(requested) {
  if (
    requested !== undefined &&
    (typeof requested !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(requested))
  )
    throw new Error("protocolVersion must be a dated MCP revision");
  return stdioVersions.includes(requested) ? requested : stdioVersions[0];
}
