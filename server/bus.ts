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
  | { type: "home_removed"; home_id: string; data: unknown };

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

export const bus = {
  emit: (e: BusEvent) => emitter.emit("event", e),
  on: (fn: (e: BusEvent) => void) => {
    emitter.on("event", fn);
    return () => emitter.off("event", fn);
  },
};
