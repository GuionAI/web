import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerWebTools } from "./tool.js";

export { registerWebTools } from "./tool.js";
export type { WebToolDependencies } from "./tool.js";

/** Registers the in-process Guion web research tools with Pi. */
export default function (pi: ExtensionAPI): void {
  registerWebTools(pi);
}
