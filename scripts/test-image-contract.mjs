import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const image = `guionai-web:image-contract-${process.pid}-${Date.now()}`;
const gatewayRequests = [];
let containerID;
let gatewayServer;
let gatewayListening = false;

async function docker(args) {
  return execFileAsync("docker", args, {
    cwd: repositoryRoot,
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function ignoreDocker(args) {
  try {
    await docker(args);
  } catch {
    // Cleanup is best effort after the test-owned resources are identified.
  }
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function findFreePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  if (!address || typeof address === "string") {
    await closeServer(probe);
    throw new Error("could not reserve an HTTP service port");
  }
  const port = address.port;
  await closeServer(probe);
  return port;
}

async function waitForService(port) {
  let lastError;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      const status = response.status;
      await response.arrayBuffer();
      if (status === 404) return;
      lastError = new Error(`readiness returned HTTP ${status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`HTTP image did not become ready: ${String(lastError)}`);
}

try {
  gatewayServer = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/api/render") {
      response.statusCode = 404;
      response.end();
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        response.statusCode = 400;
        response.end("invalid JSON");
        return;
      }
      gatewayRequests.push(payload);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          html: "<html><body><article><p>Docker gateway fixture.</p></article></body></html>",
          url: "https://93.184.216.34/final",
        }),
      );
    });
  });
  await new Promise((resolve, reject) => {
    gatewayServer.once("error", reject);
    gatewayServer.listen(0, "127.0.0.1", resolve);
  });
  const address = gatewayServer.address();
  if (!address || typeof address === "string")
    throw new Error("fake gateway did not expose a TCP port");
  gatewayListening = true;
  const servicePort = await findFreePort();

  await docker(["build", "--tag", image, "."]);
  const started = await docker([
    "run",
    "--detach",
    "--rm",
    "--network",
    "host",
    "-e",
    "EXA_API_KEY=image-contract",
    "-e",
    "GUIONAI_HTTP_IMAGE=1",
    "-e",
    `BROWSER_GATEWAY_URL=http://127.0.0.1:${address.port}`,
    image,
    "--port",
    String(servicePort),
  ]);
  containerID = started.stdout.trim();
  if (!containerID) throw new Error("docker run did not return a container ID");

  await waitForService(servicePort);
  const response = await fetch(
    `http://127.0.0.1:${servicePort}/api/v1/web/fetch`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: "https://93.184.216.34/page",
        render: "browser",
        waitMs: 125,
        mode: "full",
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  const result = await response.json();
  if (
    response.status !== 200 ||
    JSON.stringify(result) !==
      JSON.stringify({
        url: "https://93.184.216.34/page",
        mode: "full",
        content: "Docker gateway fixture.\n",
        truncated: false,
      })
  )
    throw new Error(
      `image browser Fetch contract failed: HTTP ${response.status} ${JSON.stringify(result)}`,
    );
  if (
    gatewayRequests.length !== 1 ||
    gatewayRequests[0].url !== "https://93.184.216.34/page" ||
    gatewayRequests[0].waitMs !== 125
  )
    throw new Error(
      `fake gateway received an unexpected request: ${JSON.stringify(gatewayRequests)}`,
    );

  await docker([
    "run",
    "--rm",
    "--entrypoint",
    "sh",
    image,
    "-c",
    'for binary in agent-browser chromium chromium-browser google-chrome google-chrome-stable; do if command -v "$binary" >/dev/null 2>&1; then echo "$binary is installed" >&2; exit 1; fi; done',
  ]);
  console.log("Docker image browser-gateway contract passed");
} catch (error) {
  if (containerID) {
    try {
      const logs = await docker(["logs", containerID]);
      if (logs.stdout || logs.stderr)
        console.error(`${logs.stdout ?? ""}${logs.stderr ?? ""}`);
    } catch {
      // Preserve the original test failure when logs are unavailable.
    }
  }
  throw error;
} finally {
  if (containerID) await ignoreDocker(["rm", "--force", containerID]);
  await ignoreDocker(["rmi", "--force", image]);
  if (gatewayServer && gatewayListening) await closeServer(gatewayServer);
}
