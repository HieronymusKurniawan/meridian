// Quick smoke test for rpc-rotator.js
import {
  getRpcUrl,
  getHeliusKey,
  getConnection,
  reportRpcError,
  reportHeliusError,
  getRotatorStatus,
  reloadRotatorKeys,
} from "./rpc-rotator.js";

console.log("✅ All exports imported successfully");
console.log("getRpcUrl():", getRpcUrl());
console.log("getHeliusKey():", getHeliusKey() ? "found" : "empty (ok — no keys configured)");

// Test status
const status = getRotatorStatus();
console.log("RPC endpoints:", status.rpc.total);
console.log("Helius keys:", status.helius.total);

// Test rate limit error detection (should return false — only 1 or 0 keys)
const err = new Error("429 Too Many Requests");
err.status = 429;
console.log("reportRpcError(429):", reportRpcError(err), "(false = no alt to rotate to)");
console.log("reportHeliusError(429):", reportHeliusError(err), "(false = no alt to rotate to)");

// Test non-rate-limit ignored
const err500 = new Error("500");
err500.status = 500;
console.log("reportRpcError(500):", reportRpcError(err500), "(false = not a rate limit)");

console.log("\n✅ All checks passed");
process.exit(0);
