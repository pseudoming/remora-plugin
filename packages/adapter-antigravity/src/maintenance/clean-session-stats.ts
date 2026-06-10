import { cleanup } from "../bridge/stats";

export function main(context: Record<string, unknown>): Record<string, unknown> {
  try {
    return _main(context);
  } catch {
    return {};
  }
}

export function _main(context: Record<string, unknown>): Record<string, unknown> {
  if (context["fullyIdle"]) {
    const convId = context["conversationId"] as string | undefined;
    if (convId) cleanup(convId);
  }
  return {};
}

import { hookEntrypoint } from "../bridge/context";

if (typeof require !== "undefined" && require.main === module) {
  hookEntrypoint()(main)();
}

