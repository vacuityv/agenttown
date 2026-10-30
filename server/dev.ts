// `npm run dev`: the server against DEV_MYSQL_URL (from .env / AGENTTOWN_ENV_FILE / the environment).
import { loadLocalEnv } from "./local-env.ts";

loadLocalEnv();
if (!process.env.DEV_MYSQL_URL) {
  console.error("DEV_MYSQL_URL is not set (put it in .env or point AGENTTOWN_ENV_FILE at a file that has it)");
  process.exit(1);
}
process.env.MYSQL_URL = process.env.DEV_MYSQL_URL;
await import("./index.ts");
