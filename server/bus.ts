import { EventEmitter } from "node:events";

export type BusEvent =
  | { type: "home"; home_id: string; data: unknown }
  | { type: "persona"; home_id: string; data: unknown }
  | { type: "session"; home_id: string; data: unknown }
  | { type: "counts"; home_id: string; data: { open: number; busy: number } }
  | { type: "agent"; home_id: string; data: unknown }
  // free town
  | { type: "say"; home_id: string; data: unknown }
  | { type: "tombstone"; home_id: string; data: unknown }
  | { type: "home_removed"; home_id: string; data: unknown }
  // moderation (server/safety.ts)
  | { type: "say_removed"; home_id: string; data: unknown }
  | { type: "tombstone_update"; home_id: string; data: unknown }
  // task market (server/market-core.ts). `task`: town feed + home streams of poster and assignee (home_id = poster);
  // `task_message` / `wallet`: home streams only (no contents, ever).
  | { type: "task"; home_id: string; data: unknown }
  | { type: "task_message"; home_id: string; data: unknown }
  | { type: "wallet"; home_id: string; data: unknown };

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

export const bus = {
  emit: (e: BusEvent) => emitter.emit("event", e),
  on: (fn: (e: BusEvent) => void) => {
    emitter.on("event", fn);
    return () => emitter.off("event", fn);
  },
};
