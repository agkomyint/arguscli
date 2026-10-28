import { BoxRenderable, TextRenderable, TextareaRenderable, ScrollBoxRenderable, MarkdownRenderable, SyntaxStyle, createCliRenderer, type CliRenderer, type KeyEvent } from "@opentui/core";
import OpenAI from "openai";
import { Agent, systemPrompt, type AgentEvent } from "./agent";
import { loadCredentials, saveCredentials, MODEL, BASE_URL, configPath, type Credentials } from "./config";
import { listSessions, newSession, saveSession, type Entry, type Session } from "./sessions";
import type { Approval } from "./tools";

const theme = { bg: "#101214", panel: "#191c20", line: "#363b43", fg: "#e3e5e8", muted: "#a0a6b0", accent: "#a5d6c5", warn: "#e9c784", error: "#ef9696" };
const clean = (s: string) => s.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
const brief = (s: string, n = 6000) => s.length > n ? s.slice(0, n) + "\n[display truncated]" : s;
const commands = ["/connect", "/new", "/sessions", "/resume", "/tools", "/status", "/system", "/help", "/exit"];

export class ArgusUI {
  readonly composer: TextareaRenderable;
  readonly scroll: ScrollBoxRenderable;
  private status: TextRenderable;
  private footer: TextRenderable;
  private secretText: TextRenderable;
  private hints: TextRenderable;
  private promptBox: BoxRenderable;
  private style: SyntaxStyle;
  private credentials: Credentials | null;
  private session: Session;
  private agent: Agent;
  private active: AbortController | null = null;
  private response: { entry: Entry; node: MarkdownRenderable } | null = null;
  private toolNode: TextRenderable | null = null;
  private toolEntry: Entry | null = null;
  private lastTool: { entry: Entry; node: TextRenderable; expanded: boolean } | null = null;
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private connectStep: "id" | "secret" | null = null;
  private secretValue = "";
  private tokenId = "";
  private approval: { finish: (value: boolean) => void } | null = null;
  private closed = false;
  settled: Promise<void> = Promise.resolve();
  private inputHistory: string[] = [];
  private historyIndex = 0;

  constructor(readonly renderer: CliRenderer, readonly cwd: string, credentials: Credentials | null) {
    this.credentials = credentials;
    this.agent = this.makeAgent();
    this.session = newSession(cwd, this.agent.messages);
    this.style = SyntaxStyle.fromStyles({ default: { fg: theme.fg }, "markup.heading": { fg: theme.accent, bold: true }, "markup.strong": { bold: true }, "markup.raw": { fg: theme.accent }, "markup.link": { fg: theme.accent, underline: true } }, renderer.nativeScene);
    const root = new BoxRenderable(renderer, { width: "100%", height: "100%", flexDirection: "column", backgroundColor: theme.bg, paddingX: 2 });
    const header = new BoxRenderable(renderer, { height: 3, flexShrink: 0, justifyContent: "center", border: ["bottom"], borderColor: theme.line });
    header.add(new TextRenderable(renderer, { content: `ARGUS  /  ${cwd}`, fg: theme.accent, wrapMode: "none" }));
    this.scroll = new ScrollBoxRenderable(renderer, { flexGrow: 1, flexShrink: 1, minHeight: 1, scrollX: false, stickyScroll: true, stickyStart: "bottom", contentOptions: { flexDirection: "column", gap: 1, paddingY: 1 } });
    this.status = new TextRenderable(renderer, { content: "", fg: theme.muted, height: 1, flexShrink: 0, wrapMode: "none" });
    this.hints = new TextRenderable(renderer, { content: "", visible: false, fg: theme.accent, height: 1, flexShrink: 0 });
    this.promptBox = new BoxRenderable(renderer, { title: " Ask Argus ", titleColor: theme.accent, border: true, borderStyle: "rounded", borderColor: theme.line, height: 5, flexShrink: 0, paddingX: 1, backgroundColor: theme.panel });
    this.composer = new TextareaRenderable(renderer, {
      width: "100%", height: "100%", placeholder: "Build, fix, explain…  /help", placeholderColor: theme.muted,
      backgroundColor: theme.panel, focusedBackgroundColor: theme.panel, textColor: theme.fg, cursorColor: theme.accent,
      keyBindings: [{ name: "return", action: "submit" }, { name: "return", shift: true, action: "newline" }, { name: "return", ctrl: true, action: "newline" }],
      onSubmit: () => { this.settled = this.submit(); },
      onContentChange: () => this.inputChanged(),
    });
    this.secretText = new TextRenderable(renderer, { content: "", visible: false, fg: theme.accent });
    this.promptBox.add(this.composer);
    this.promptBox.add(this.secretText);
    this.footer = new TextRenderable(renderer, { content: "", fg: theme.muted, height: 1, flexShrink: 0, wrapMode: "none" });
    root.add(header); root.add(this.scroll); root.add(this.status); root.add(this.hints); root.add(this.promptBox); root.add(this.footer);
    renderer.root.add(root);
    renderer.keyInput.on("keypress", key => this.key(key));
    renderer.keyInput.on("paste", event => {
      if (!this.connectStep) return;
      event.preventDefault(); event.stopPropagation();
      this.secretValue += new TextDecoder().decode(event.bytes).replace(/[\r\n\x00-\x1f\x7f]/g, "");
      this.drawSecret();
    });
    renderer.on("resize", () => this.inputChanged());
    renderer.on("destroy", () => { this.closed = true; this.active?.abort(); this.approval?.finish(false); if (this.renderTimer) clearTimeout(this.renderTimer); });
    this.welcome();
    this.ready();
    this.composer.focus();
  }

  private makeAgent(messages?: Session["messages"]) { return new Agent(this.cwd, (request, signal) => this.ask(request, signal), messages); }
  private welcome() {
    this.display({ role: "info", text: "Your workspace. One focused agent.\n\nAsk for a change, paste code, or describe a bug.\n/connect  credentials     /sessions  history     /tools  capabilities" });
  }
  private ready() {
    this.status.content = `${this.credentials ? "● Credentials loaded" : "○ /connect to begin"}  ·  Muse Spark  ·  ${this.session.id.slice(0, 8)}`;
    this.footer.content = "Enter send · Shift+Enter newline · Ctrl+O tool details · Esc cancel";
  }
  private display(entry: Entry) {
    const block = new BoxRenderable(this.renderer, { flexDirection: "column", flexShrink: 0, width: "100%" });
    if (entry.role !== "info") block.add(new TextRenderable(this.renderer, { content: entry.role === "you" ? "YOU" : entry.role === "argus" ? "ARGUS" : "TOOL", fg: entry.role === "you" ? theme.accent : theme.muted, height: 1 }));
    const node = entry.role === "argus" ? new MarkdownRenderable(this.renderer, {
      content: clean(entry.text), syntaxStyle: this.style, fg: theme.fg, streaming: false, width: "100%",
      // Plain code blocks avoid loading language parsers or downloading grammars.
      renderNode: token => token.type === "code" ? new TextRenderable(this.renderer, { content: clean(token.text), fg: theme.accent, wrapMode: "word", width: "100%" }) : undefined,
    }) : new TextRenderable(this.renderer, { content: clean(entry.text), fg: entry.role === "tool" ? theme.muted : theme.fg, width: "100%", wrapMode: "word" });
    block.add(node);
    if (entry.role === "tool") {
      node.content = clean(entry.text.split("\n")[0] ?? "") + "  [Ctrl+O details]";
      this.lastTool = { entry, node: node as TextRenderable, expanded: false };
    }
    this.scroll.add(block);
    const children = this.scroll.getChildren();
    if (children.length > 180) children[0]!.destroyRecursively();
    return node;
  }
  private add(role: Entry["role"], text: string) {
    const entry = { role, text };
    this.session.entries.push(entry);
    return { entry, node: this.display(entry) };
  }
  private info(text: string) { this.add("info", text); }
  private inputChanged() {
    if (!this.composer || this.closed) return;
    const value = this.composer.plainText;
    const rows = value.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / Math.max(10, this.renderer.width - 8))), 0);
    this.promptBox.height = Math.min(9, Math.max(5, rows + 2));
    const matches = value.startsWith("/") && !value.includes(" ") ? commands.filter(c => c.startsWith(value)) : [];
    this.hints.visible = matches.length > 0 && !this.connectStep && !this.active;
    this.hints.content = matches.slice(0, 6).join("   ");
    if (!this.active && !this.connectStep) this.footer.content = value.length > 80 ? `${value.length} characters · ${value.split("\n").length} lines  |  Enter send · Shift+Enter newline` : "Enter send · Shift+Enter newline · Ctrl+O tool details · Esc cancel";
  }

  private key(key: KeyEvent) {
    if (key.name === "c" && key.ctrl) {
      key.preventDefault();
      if (this.active) this.active.abort(); else this.close();
      return;
    }
    if (key.name === "escape") {
      key.preventDefault();
      if (this.connectStep) { this.connectStep = null; this.secretValue = this.tokenId = ""; this.restoreInput(); }
      else if (this.approval) this.approval.finish(false);
      else if (this.active) this.active.abort();
      else this.composer.setText("");
      return;
    }
    if (key.name === "pageup" || key.name === "pagedown") {
      key.preventDefault(); this.scroll.scrollBy(key.name === "pageup" ? -Math.max(3, this.renderer.height - 10) : Math.max(3, this.renderer.height - 10)); return;
    }
    if (this.approval) {
      key.preventDefault();
      if (key.name === "y") this.approval.finish(true);
      else if (key.name === "n") this.approval.finish(false);
      return;
    }
    if (this.connectStep) {
      key.preventDefault(); key.stopPropagation();
      if (key.name === "return") { this.settled = this.submitSecret(); return; }
      if (key.name === "backspace") this.secretValue = Array.from(this.secretValue).slice(0, -1).join("");
      else if (key.ctrl && key.name === "u") this.secretValue = "";
      else if (!key.ctrl && !key.meta && key.sequence && !/[\x00-\x1f\x7f]/.test(key.sequence)) this.secretValue += key.sequence;
      this.drawSecret(); return;
    }
    if (key.ctrl && key.name === "o" && this.lastTool) {
      key.preventDefault();
      const tool = this.lastTool;
      tool.expanded = !tool.expanded;
      tool.node.content = clean(tool.expanded ? tool.entry.text : (tool.entry.text.split("\n")[0] ?? "") + "  [Ctrl+O details]");
      return;
    }
    if (this.active) { key.preventDefault(); return; }
    if (key.name === "tab" && this.composer.plainText.startsWith("/")) {
      const match = commands.find(c => c.startsWith(this.composer.plainText));
      if (match) { key.preventDefault(); this.composer.setText(match); this.composer.cursorOffset = match.length; }
    }
    if ((key.name === "up" || key.name === "down") && !this.composer.plainText.includes("\n")) {
      key.preventDefault();
      this.historyIndex = Math.max(0, Math.min(this.inputHistory.length, this.historyIndex + (key.name === "up" ? -1 : 1)));
      const text = this.inputHistory[this.historyIndex] ?? "";
      this.composer.setText(text); this.composer.cursorOffset = text.length;
    }
  }

  private drawSecret() {
    this.secretText.content = `${this.connectStep === "id" ? "Modal token ID" : "Modal token secret"}\n${"•".repeat(Math.min(28, this.secretValue.length))}  ${this.secretValue.length} characters`;
  }
  private connect() {
    this.connectStep = "id"; this.secretValue = ""; this.tokenId = "";
    this.composer.blur(); this.composer.visible = false; this.hints.visible = false;
    this.secretText.visible = true; this.promptBox.title = " Connect Modal ";
    this.footer.content = "Paste or type · Enter next/save · Esc cancel · Saved locally in plaintext";
    this.drawSecret();
  }
  private async submitSecret() {
    const value = this.secretValue.trim();
    if (!value) { this.status.content = "A value is required. Paste or type your token."; return; }
    if (this.connectStep === "id") { this.tokenId = value; this.secretValue = ""; this.connectStep = "secret"; this.drawSecret(); return; }
    const next = { tokenId: this.tokenId, tokenSecret: value };
    this.connectStep = null; this.tokenId = this.secretValue = "";
    this.restoreInput();
    try { await saveCredentials(next); this.credentials = next; this.info("Connection saved. Ready."); this.ready(); }
    catch { this.info("Could not save credentials. Check config directory permissions."); }
  }
  private restoreInput() {
    this.secretText.content = ""; this.secretText.visible = false; this.composer.visible = true;
    this.promptBox.title = " Ask Argus "; this.composer.focus(); this.ready();
  }
  private ask(request: Approval, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted || this.closed) return Promise.resolve(false);
    this.info(`${request.title}\n${brief(request.preview, 32_000)}`);
    this.composer.blur(); this.composer.visible = false; this.secretText.visible = true;
    this.secretText.content = "Allow this action?  [y] yes  [n] no\nPgUp/PgDn to inspect · Esc deny";
    this.promptBox.title = " Approval required "; this.promptBox.borderColor = theme.warn;
    this.status.content = request.title;
    return new Promise(resolve => {
      const finish = (value: boolean) => {
        if (!this.approval) return;
        this.approval = null; signal.removeEventListener("abort", abort);
        if (!this.closed) {
          this.promptBox.borderColor = theme.line; this.restoreInput(); this.composer.blur();
          this.info(value ? "Approved." : "Denied.");
        }
        resolve(value);
      };
      const abort = () => finish(false);
      this.approval = { finish };
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  private event(event: AgentEvent) {
    if (this.closed) return;
    if (event.type === "status") { this.status.content = `${event.text}…  ·  Esc to cancel`; return; }
    if (event.type === "response") { this.flushResponse(); this.response = null; return; }
    if (event.type === "text") {
      if (!this.response) {
        const entry = { role: "argus" as const, text: "" };
        this.session.entries.push(entry);
        const node = this.display(entry) as MarkdownRenderable;
        node.streaming = true; this.response = { entry, node };
      }
      this.response.entry.text += event.delta;
      if (!this.renderTimer) this.renderTimer = setTimeout(() => {
        this.renderTimer = null;
        if (this.response && !this.closed) this.response.node.content = clean(this.response.entry.text);
      }, 40);
      return;
    }
    this.flushResponse();
    if (event.state === "running") {
      let summary = "";
      try { const args = JSON.parse(event.args); summary = args.path ?? args.command ?? args.query ?? ""; } catch { /* Show name only. */ }
      const tool = this.add("tool", `→ ${event.name}  ${brief(summary, 180)}`);
      this.toolNode = tool.node as TextRenderable;
      this.toolEntry = tool.entry;
      this.status.content = `${event.name}…  ·  Esc to cancel`;
    } else {
      if (this.toolNode && this.toolEntry) {
        const title = `${event.state === "error" ? "✕" : "✓"} ${this.toolEntry.text.slice(2)}`;
        this.toolEntry.text = `${title}\n\n${brief(event.output ?? "", 12_000)}`;
        this.toolNode.content = clean(this.lastTool?.expanded ? this.toolEntry.text : title + "  [Ctrl+O details]");
      }
      this.toolNode = null; this.toolEntry = null;
    }
  }
  private flushResponse() {
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = null;
    if (this.response && !this.closed) { this.response.node.content = clean(this.response.entry.text); this.response.node.streaming = false; }
  }

  private async submit() {
    if (this.active || this.connectStep || this.closed) return;
    const text = this.composer.plainText.trim();
    if (!text) return;
    this.composer.setText(""); this.hints.visible = false;
    this.inputHistory.push(text); this.historyIndex = this.inputHistory.length;
    try {
      if (text.startsWith("/")) { await this.command(text); return; }
      if (!this.credentials) { this.info("Use /connect to add your Modal credentials."); return; }
      this.add("you", text);
      if (this.session.title === "New session") this.session.title = text.replace(/\s+/g, " ").slice(0, 70);
      this.active = new AbortController(); this.composer.blur();
      const start = performance.now();
      await this.agent.run(text, this.credentials, this.active.signal, event => this.event(event));
      this.status.content = `Done in ${((performance.now() - start) / 1000).toFixed(1)}s  ·  ${this.session.id.slice(0, 8)}  ·  Muse Spark`;
    } catch (error) {
      if (this.active?.signal.aborted) this.info("Cancelled. Completed tool actions are kept.");
      else if (error instanceof OpenAI.APIError) this.info(`Endpoint error ${error.status ?? "network"}. ${error.status === 401 || error.status === 403 ? "Use /connect to update credentials." : "Try again; /new clears context."}`);
      else this.info(error instanceof Error ? clean(error.message) : "Action failed.");
    } finally {
      this.flushResponse(); this.response = null;
      if (this.active) {
        this.active = null; this.session.messages = this.agent.messages;
        try { await saveSession(this.session); } catch { if (!this.closed) this.info("Could not save session to disk."); }
      }
      if (!this.closed && !this.connectStep && !this.approval) this.composer.focus();
    }
  }

  private async command(text: string) {
    const [command, ...rest] = text.split(" ");
    const value = rest.join(" ").trim();
    if (command === "/exit" || command === "/quit") { this.close(); return; }
    if (command === "/connect") { this.connect(); return; }
    if (command === "/help") { this.info("/connect  credentials\n/new  fresh session\n/sessions  saved workspace sessions\n/resume <id>  reopen a session\n/tools  available tools\n/status  model and connection\n/system <instructions>  customize agent (new session)\n/exit  quit\n\nEnter send · Shift+Enter or Ctrl+Enter newline · Tab completes commands\nUp/Down prompt history · Mouse wheel or PgUp/PgDn scroll\nEdits and shell commands require y/n approval."); return; }
    if (command === "/tools") { this.info("read_file · list_files · search  → automatic\nedit_file · write_file · shell  → approval required\n\nFiles stay inside this workspace. Credential files are excluded.\nApproved shell commands can access your system; they are not sandboxed."); return; }
    if (command === "/status") { this.info(`${this.credentials ? "Credentials loaded; access checked on request" : "Not connected"}\n${MODEL}\n${BASE_URL}\nWorkspace: ${this.cwd}\nCredentials: ${configPath}\nSession: ${this.session.id}`); return; }
    if (command === "/sessions" || command === "/resume") {
      const sessions = await listSessions(this.cwd);
      if (command === "/sessions") { this.info(sessions.length ? sessions.slice(0, 15).map(s => `${s.id.slice(0, 8)}  ${s.title}`).join("\n") + "\n\n/resume <id>" : "No saved sessions in this workspace yet."); return; }
      if (!value) { this.info("Usage: /resume <session id>"); return; }
      const matches = sessions.filter(s => s.id.startsWith(value));
      if (matches.length !== 1) { this.info("Session not found or ID is ambiguous. Use /sessions."); return; }
      this.session = matches[0]!; this.agent = this.makeAgent(this.session.messages);
      this.clearView(); for (const entry of this.session.entries.slice(-180)) this.display(entry);
      this.ready(); return;
    }
    if (command === "/new" || command === "/system") {
      if (command === "/system" && !value) { this.info("Usage: /system <instructions>"); return; }
      this.agent = this.makeAgent(command === "/system" ? [{ role: "system", content: systemPrompt(this.cwd) + "\nUser preferences:\n" + value }] : undefined);
      this.session = newSession(this.cwd, this.agent.messages); this.clearView(); this.welcome(); this.ready(); return;
    }
    this.info("Unknown command. /help");
  }
  private clearView() { for (const child of this.scroll.getChildren()) child.destroyRecursively(); }
  close() {
    if (this.closed) return;
    this.closed = true; this.active?.abort(); this.approval?.finish(false);
    this.secretValue = this.tokenId = "";
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderer.destroy();
  }
}

export async function start(cwd: string) {
  let credentials: Credentials | null = null;
  try { credentials = await loadCredentials(); } catch { /* /connect replaces corrupt config. */ }
  const renderer = await createCliRenderer({ exitOnCtrlC: false, backgroundColor: theme.bg, targetFps: 30, useMouse: true, consoleMode: "disabled" });
  const ui = new ArgusUI(renderer, cwd, credentials);
  const exit = () => ui.close();
  process.once("SIGTERM", exit);
  try { await renderer.closed; await ui.settled; }
  finally { process.off("SIGTERM", exit); ui.close(); }
}

