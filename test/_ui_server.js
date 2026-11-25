// Serve only the selected HTML fixture to exercise the same loopback browser entry
// point used by applications, including browsers with file-navigation policies.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
export async function serveFixture(t, file) {
  const server = createServer((req, res) => {
    if (req.url !== "/") {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(readFileSync(file));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(undefined));
  });
  t.after(
    () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(r);
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server has no TCP port");
  return `http://127.0.0.1:${address.port}/`;
}
