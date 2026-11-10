// Stands in for src/upload in component tests: the parcel's stage without the crypto worker behind it.
import { reactive } from "vue";

export const send = reactive({ stage: "home" as "home" | "options" | "uploading" | "done", sent: null as object | null });

export function resetSend() {
  Object.assign(send, { stage: "home", sent: null });
}
