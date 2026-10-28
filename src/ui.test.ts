import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { ArgusUI } from "./ui";

test("TUI masks pasted credentials and Escape restores the composer", async () => {
  const testUI = await createTestRenderer({ width: 90, height: 28 });
  const ui = new ArgusUI(testUI.renderer, process.cwd(), null);
  try {
    await testUI.renderOnce();
    expect(testUI.captureCharFrame()).toContain("ARGUS");
    ui.composer.setText("/connect");
    ui.composer.submit();
    await ui.settled;
    await testUI.mockInput.pasteBracketedText("test-private-token");
    await testUI.renderOnce();
    const frame = testUI.captureCharFrame();
    expect(frame).toContain("18 characters");
    expect(frame).not.toContain("test-private-token");
    testUI.mockInput.pressEscape();
    await Bun.sleep(40); // Escape is ambiguous with terminal escape sequence prefixes.
    await testUI.flush();
    expect(testUI.captureCharFrame()).toContain("Ask Argus");
    expect(ui.composer.plainText).toBe("");
  } finally { ui.close(); await testUI.dispose(); }
});

test("TUI pastes multiline code and displays command completion", async () => {
  const testUI = await createTestRenderer({ width: 60, height: 22 });
  const ui = new ArgusUI(testUI.renderer, process.cwd(), null);
  try {
    await testUI.mockInput.pasteBracketedText("function hello() {\n  return 42;\n}");
    expect(ui.composer.plainText).toContain("\n  return 42;");
    ui.composer.setText("/con");
    testUI.mockInput.pressTab();
    await testUI.flush();
    expect(ui.composer.plainText).toBe("/connect");
    testUI.resize(40, 18);
    await testUI.flush();
    expect(testUI.captureCharFrame()).toContain("Ask Argus");
  } finally { ui.close(); await testUI.dispose(); }
});

test("edit approval shows the diff, requires y, and can be cancelled", async () => {
  const testUI = await createTestRenderer({ width: 90, height: 28 });
  const ui = new ArgusUI(testUI.renderer, process.cwd(), null);
  try {
    const controller = new AbortController();
    const approval = ui["ask"]({ title: "Edit example.ts", preview: "--- before\n+++ after\n-old code\n+new code" }, controller.signal);
    await testUI.renderOnce();
    expect(testUI.captureCharFrame()).toContain("+new code");
    expect(testUI.captureCharFrame()).toContain("Approval required");
    testUI.mockInput.pressKey("y");
    expect(await approval).toBe(true);
    const cancelled = ui["ask"]({ title: "Run shell command", preview: "echo hello" }, controller.signal);
    controller.abort();
    expect(await cancelled).toBe(false);
    await testUI.flush();
    expect(testUI.captureCharFrame()).toContain("Ask Argus");
  } finally { ui.close(); await testUI.dispose(); }
});

test("tool output is collapsed, expandable, and Markdown renders", async () => {
  const testUI = await createTestRenderer({ width: 90, height: 28 });
  const ui = new ArgusUI(testUI.renderer, process.cwd(), null);
  try {
    ui["event"]({ type: "tool", name: "read_file", args: '{"path":"example.ts"}', state: "running" });
    ui["event"]({ type: "tool", name: "read_file", args: '{"path":"example.ts"}', state: "done", output: "detailed tool output" });
    await testUI.renderOnce();
    expect(testUI.captureCharFrame()).not.toContain("detailed tool output");
    testUI.mockInput.pressKey("o", { ctrl: true });
    await testUI.flush();
    expect(testUI.captureCharFrame()).toContain("detailed tool output");
    ui["event"]({ type: "text", delta: "**Done**\n\n```ts\nconst answer = 42;\n```" });
    ui["flushResponse"]();
    await testUI.flush();
    expect(testUI.captureCharFrame()).toContain("const answer = 42;");
  } finally { ui.close(); await testUI.dispose(); }
});
