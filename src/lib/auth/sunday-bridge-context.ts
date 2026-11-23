import { AsyncLocalStorage } from "node:async_hooks";

declare global {
  var __signudocSundayBridgeStorage: AsyncLocalStorage<true> | undefined;
}

// While the Sunday bridge provisions an account, the sign-up rule stands aside: Sunday's membership is the rule for those accounts (sunday-bridge.ts). Kept on globalThis, as setup-context.ts is, so the bridge and the auth code read one store even if a bundler gives each its own copy of this module.
const sundayBridgeStorage = (globalThis.__signudocSundayBridgeStorage ??=
  new AsyncLocalStorage<true>());

export function runAsSundayBridge<T>(run: () => Promise<T>): Promise<T> {
  return sundayBridgeStorage.run(true, run);
}

export function isRunningSundayBridge(): boolean {
  return sundayBridgeStorage.getStore() === true;
}
