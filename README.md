# Argus

A lean coding agent for Bun. OpenTUI Core renders the terminal; the OpenAI SDK connects to your exact Modal Muse endpoint. No React, Solid, or agent framework.

## Run

```sh
bun install
bun start
# Or use your installed launcher:
argus
argus D:\path\to\project
```

The current directory is the workspace unless you pass a directory. Type `/connect` to enter your Modal proxy token ID and secret. Input is masked with dots and a character count. Existing saved credentials still work.

Credentials live in `~/.arguscli/config.json`, as plaintext outside the project. Unix permissions are restricted; Windows uses your profile's permissions. Alternatively use `MODAL_PROXY_TOKEN_ID` and `MODAL_PROXY_TOKEN_SECRET` in your environment or the current directory's `.env`. Saved credentials take precedence. Credentials are read at runtime, not embedded in builds.

## Interaction

- **Enter** sends; **Shift+Enter** or **Ctrl+Enter** adds a newline.
- Paste multiline code directly. Large input shows character and line counts.
- **Tab** completes slash commands; **Up/Down** recalls single-line prompts.
- **Mouse wheel / PgUp / PgDn** scroll history.
- **Ctrl+O** expands/collapses the latest tool result.
- **Esc** cancels a reply, cancels connection setup, or denies an approval.
- **Ctrl+C** cancels active work; press again when idle to quit.

Tool output stays collapsed by default. Markdown is rendered; code blocks are plain text to avoid language grammar downloads. The renderer is capped at 30 FPS, stream updates are batched, and the visible scene is bounded to 180 blocks. Older transcript entries remain in saved sessions.

## Tools

| Tool | Behavior |
| --- | --- |
| `list_files` | Lists workspace files, skipping dependencies/build output |
| `read_file` | Reads UTF-8 files with line numbers and pagination |
| `search` | Searches literal text, case insensitive |
| `edit_file` | Replaces one unique exact match; shows diff and requires approval |
| `write_file` | Creates/replaces files; shows diff and requires approval |
| `shell` | Runs PowerShell on Windows or sh on Unix; requires approval |

Press **y** to approve or **n** to deny. File tools stay inside the workspace, check symlinks, exclude credential files, and detect changes made while awaiting approval. Existing files must be read before editing. Large diffs require smaller edits. Shell commands run with your permissions and are not sandboxed; inspect the displayed command before approving. Shell output is bounded and commands have a 60-second timeout. Cancellation terminates their process tree. Modal environment credentials are omitted from shell subprocesses.

The agent can run up to 20 model/tool rounds per message. It keeps completed tool actions when cancelled. Older complete turns are removed when context grows large; `/new` starts fresh.

## Commands and sessions

| Command | Action |
| --- | --- |
| `/connect` | Save or replace Modal credentials |
| `/new` | Start a new session |
| `/sessions` | List saved sessions for this workspace |
| `/resume <id>` | Restore a session; an unambiguous ID prefix works |
| `/tools` | Show available tools |
| `/status` | Show endpoint, model, workspace, and config path |
| `/system <instructions>` | Customize the agent in a fresh session |
| `/help` | Show shortcuts and commands |
| `/exit` | Quit |

Sessions save automatically after each task in `~/.arguscli/sessions/`. They contain prompts, replies, and tool results in plaintext. Credentials entered through `/connect` are not added to sessions.

## Build

```sh
bun run build       # ~0.44 MB JS bundle; requires Bun and installed @opentui/core
bun run build:exe   # ~127 MB standalone Windows executable, includes Bun/native assets
```

The JS bundle is not a standalone distribution: keep installed dependencies available. `argus` currently runs the source through Bun, so local edits take effect on restart. The standalone executable is `dist/argus.exe` on Windows. Sizes are measured with Bun 1.4.4 and vary by version/platform; the embedded runtime dominates the standalone size. Runtime dependencies are pinned in package.json and bun.lock.

## Check

```sh
bun run check
bun test
bun run test:live
```

`test:live` uses saved credentials and the real Modal endpoint. It creates a temporary fixture, asks the agent to read and fix it, verifies the edit, and removes the fixture. It makes paid/provider API requests if your endpoint bills usage. Unit tests exercise real files, real shell processes, and OpenTUI's native test renderer; no fake model endpoint is used.

For a read-only headless task:

```sh
argus --prompt "Read package.json and summarize this project"
```

Headless mode denies edits and shell commands, and does not save a session.

