// Home roles (docs/protocol.md "Home roles"): civic buildings run by an agent, set by the operator only.
// "townhall": the Mayor's home; the web map draws it at the town center (other homes keep their slots). At most one
// home has a role of a given kind: setting it moves the role, it never duplicates it.
import type { Hono } from "hono";
import { tx, one, run } from "./db.ts";
import { bus } from "./bus.ts";
import * as store from "./store.ts";
import { requireAdmin } from "./safety.ts";
import { ApiError } from "./util.ts";

export const ROLES = ["townhall"] as const;
export type Role = (typeof ROLES)[number];
const HOME_RE = /^h_[0-9a-z]{4,16}$/;

export async function setRole(homeId: string, role: Role | null) {
  if (!HOME_RE.test(homeId)) throw new ApiError(404, "not_found", "No such home.");
  const cleared: string[] = [];
  await tx(async (c) => {
    if (!(await one(c, "SELECT id FROM homes WHERE id = ? FOR UPDATE", [homeId]))) throw new ApiError(404, "not_found", "No such home.");
    if (role) {
      const others = await one(c, "SELECT GROUP_CONCAT(id) AS ids FROM homes WHERE role = ? AND id <> ?", [role, homeId]);
      if (others?.ids) cleared.push(...String(others.ids).split(","));
      await run(c, "UPDATE homes SET role = NULL WHERE role = ? AND id <> ?", [role, homeId]);
    }
    await run(c, "UPDATE homes SET role = ? WHERE id = ?", [role, homeId]);
  });
  for (const id of [...cleared, homeId]) {
    const h = await store.homeById(id);
    if (h) bus.emit({ type: "home", home_id: id, data: store.publicHome(h) });
  }
  return { home_id: homeId, role, cleared };
}

export function mountRoles(api: Hono<any>) {
  // POST /v1/admin/homes/:id/role {role: "townhall" | null}. Guards itself (mounted before safety's /admin/* middleware).
  api.post("/admin/homes/:id/role", requireAdmin, async (c) => {
    let b: any;
    try { b = await c.req.json(); } catch { b = null; }
    if (!b || typeof b !== "object" || !("role" in b)) throw new ApiError(400, "bad_json", 'Send {"role": "townhall"} or {"role": null}.');
    if (b.role !== null && !ROLES.includes(b.role)) throw new ApiError(400, "bad_role", `role must be null or one of ${ROLES.join(", ")}.`);
    return c.json(await setRole(c.req.param("id") ?? "", b.role));
  });
}

