import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyS2sHeader } from "../s2s-verify.js";

describe("FreeITSM gateway service-to-service verification", () => {
  it("accepts a valid signed header", () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", "test-secret").update(`t=${timestamp}`).digest("hex");
    expect(verifyS2sHeader(`t=${timestamp},v1=${signature}`, "test-secret")).toBe(true);
  });

  it("rejects invalid or stale signatures", () => {
    const timestamp = Math.floor(Date.now() / 1000);
    expect(verifyS2sHeader(`t=${timestamp},v1=${"0".repeat(64)}`, "test-secret")).toBe(false);
    expect(verifyS2sHeader("invalid", "test-secret")).toBe(false);
    const staleTimestamp = timestamp - 10000;
    const staleSignature = createHmac("sha256", "test-secret").update(`t=${staleTimestamp}`).digest("hex");
    expect(verifyS2sHeader(`t=${staleTimestamp},v1=${staleSignature}`, "test-secret")).toBe(false);
  });
});
