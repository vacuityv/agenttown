// Tests run against TEST_MYSQL_URL (from .env / AGENTTOWN_ENV_FILE / the environment) and start from empty tables.
import mysql from "mysql2/promise";
import { loadLocalEnv } from "../server/local-env.ts";

export async function resetTestDb(): Promise<string> {
  loadLocalEnv();
  const url = process.env.TEST_MYSQL_URL;
  if (!url) throw new Error("TEST_MYSQL_URL is not set (put it in .env or point AGENTTOWN_ENV_FILE at a file that has it)");
  const dbName = decodeURIComponent(new URL(url).pathname.slice(1));
  // Tests drop every table: refuse anything that does not look like a throwaway database.
  if (!/test/i.test(dbName)) throw new Error(`refusing to wipe "${dbName}": TEST_MYSQL_URL must name a test database`);
  const c = await mysql.createConnection({ uri: url });
  try {
    const [rows] = await c.query("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()");
    await c.query("SET FOREIGN_KEY_CHECKS = 0");
    for (const { t } of rows as { t: string }[]) await c.query(`DROP TABLE IF EXISTS \`${t}\``);
    await c.query("SET FOREIGN_KEY_CHECKS = 1");
  } finally {
    await c.end();
  }
  return url;
}
