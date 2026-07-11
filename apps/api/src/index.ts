import { createApi } from "./app.js";
import { loadEnvironment } from "./env.js";

loadEnvironment();
const runtime = createApi();
const server = runtime.app.listen(runtime.config.port, runtime.config.host, () => {
  process.stdout.write(
    `Proofline API listening on http://${runtime.config.host}:${runtime.config.port}/api (historical replay)\n`,
  );
});

function shutdown(): void {
  runtime.dispose();
  server.close(() => process.exit(0));
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

export { createApi, createApp } from "./app.js";
