import { loadConfig } from "./config.js";
import { createPoolDawgsServer } from "./server.js";

const config = loadConfig();
const server = createPoolDawgsServer(config);

server.httpServer.listen(config.port, () => {
  console.log(
    `PoolDawgs server on :${config.port} ` +
      `(chain ${config.chainEnabled ? "enabled" : "DISABLED — dev mode"}, ` +
      `shot clock ${config.shotClockMs / 1000}s)`
  );
});
