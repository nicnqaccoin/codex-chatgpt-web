import { describe, expect, test } from "bun:test";
import { ChatGptTurnDomHealthTracker } from "../src/adapters/chatgpt-web/browser-worker";

describe("Streaming Responsiveness & Stall Mitigation", () => {
  test("DOM Health Tracker tolerates long thinking phases when response DOM is not yet created but running is active", () => {
    const tracker = new ChatGptTurnDomHealthTracker(60_000, 10_000, 60_000);

    const t0 = 1000;
    // Initial state: generation running, no response DOM yet
    const errorAtT0 = tracker.update({
      responsePresent: false,
      running: true,
      currentText: "",
      completionActionVisible: false,
    }, t0);
    expect(errorAtT0).toBeUndefined();

    // 30 seconds into thinking (still within 60s grace period)
    const errorAtT30 = tracker.update({
      responsePresent: false,
      running: true,
      currentText: "",
      completionActionVisible: false,
    }, t0 + 30_000);
    expect(errorAtT30).toBeUndefined();

    // At 61 seconds with no response DOM, fails with proper diagnostics
    const errorAtT61 = tracker.update({
      responsePresent: false,
      running: true,
      currentText: "",
      completionActionVisible: false,
    }, t0 + 61_000);
    expect(errorAtT61).toBe("ChatGPT did not create a response DOM after the message was sent");
  });

  test("DOM Health Tracker detects disappeared response DOM", () => {
    const tracker = new ChatGptTurnDomHealthTracker(60_000, 10_000, 60_000);

    const t0 = 1000;
    // Response appeared
    tracker.update({
      responsePresent: true,
      running: true,
      currentText: "Generating...",
      completionActionVisible: false,
    }, t0);

    // Response disappeared
    tracker.update({
      responsePresent: false,
      running: true,
      currentText: "",
      completionActionVisible: false,
    }, t0 + 5_000);

    // After 60s of missing response DOM
    const error = tracker.update({
      responsePresent: false,
      running: true,
      currentText: "",
      completionActionVisible: false,
    }, t0 + 66_000);
    expect(error).toBe("ChatGPT response DOM disappeared while the browser turn was active");
  });
});
