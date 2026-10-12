# prismic-local-agent-bridge

Local daemon that lets the Prismic Page Builder (wroom) chat with a local Codex agent over ACP, billed on the user's ChatGPT plan ("Sign in with ChatGPT"). The agent reaches Prismic through the forked Prismic MCP server (`get_editor_context`, `edit_open_document`).

PoC, private. Requires Node >= 22.18 (runs TypeScript natively).

## Run

```sh
npm install
npm start -- --project <path to your website>
```

The daemon listens on `http://127.0.0.1:7878` and prints a banner with a pairing code (`Pairing code: <code>`).

| Option | Default | Description |
|---|---|---|
| `--project` | current directory | Directory the agent works in (must exist). |
| `--port` | `7878` | Listening port. |
| `--origin` | `http://localhost:5173` | Allowed browser origin. Repeatable. |
| `--model` | Codex default | Model slug forced in the Codex config (`[A-Za-z0-9._:-]+`). |
| `--agent-mode` | `read-only` | `read-only`, `workspace-write`, `agent` or `agent-full-access` (the last one needs `--allow-full-access`). |
| `--allow-full-access` | off | Let the browser select the `agent-full-access` mode (see below). |
| `--use-user-codex` | off | Run Codex with your real Codex home instead of an isolated one (see below). |

Environment:

- `PRISMIC_BRIDGE_TOKEN_REFRESH_MARGIN_MS` (default `300000`): the ChatGPT access token is refreshed, and the agent restarted, when it has less validity left than this.
- `XDG_CONFIG_HOME`: data directory is `$XDG_CONFIG_HOME/prismic-local-agent-bridge` (default `~/.config/...`). It holds `credentials.json` (mode 600), `host.json`, `codex-home/` and `conversations/` (see Persistent conversations).

## Demo quick start

```sh
cd ~/DevTools/workspace/prismic-local-agent-bridge
npm install            # first time only
npm start -- --project ~/DevTools/workspace/poc-agent-project
```

1. Read `Pairing code: <code>` in the banner, enter it in the "Local agent" panel of wroom.
2. "Continue with ChatGPT" opens your browser. If you close that window, click "Restart sign-in" in the panel (the authorization URL is also printed in the terminal).
3. Pick a model and reasoning effort, then chat. `--project` is only the agent's working directory; document access goes through the Prismic MCP.

After a daemon restart you must pair again (tokens live in memory), but the ChatGPT sign-in is kept in `~/.config/prismic-local-agent-bridge/credentials.json`.

## Codex home

By default the agent runs in an isolated Codex home, `<data dir>/codex-home`, which the bridge writes (`config.toml` with the ChatGPT plan provider). The banner shows `Codex home: <path> (isolated)`.

With `--use-user-codex` the agent runs with `CODEX_HOME` (or `~/.codex` when unset), which must exist; the banner shows `(user)`. The bridge never writes into that directory and never reads or copies `config.toml` or `auth.json`. The ChatGPT plan provider is injected through codex-acp's `CODEX_CONFIG` environment variable instead, so billing still goes to the bridge's ChatGPT sign-in. `--model` is applied the same way.

Reused from your Codex home: MCP servers from `config.toml`, skills, `AGENTS.md`, hooks, profiles, and your own `model` (unless `--model` is given). Skills in `~/.agents/skills` are visible in both modes.

Not reused: `approval_policy` and `sandbox_mode`. codex-acp sets both on every turn from the agent mode, so `--agent-mode` (default `read-only`) always wins.

Risks of `--use-user-codex`:

- An agent triggered from the browser can call every MCP server you configured, with your hooks and instructions.
- Permission requests still go through the permission cards in the browser.
- Sessions are written into your Codex home (`sessions/`).
- If your `config.toml` defines an MCP server named `prismic`, codex-acp keeps yours and silently drops the bridge's window-bound one.
- If your own `model` isn't available on the ChatGPT plan, turns fail until you pick another model in the panel or pass `--model`.

## Agent mode and full access

The mode (`mode` config option) starts from `--agent-mode` for every new session. A page can't change it when opening the chat: the `mode` key of `preferredConfig` is ignored. Only an explicit `set_config_option` changes it (and it survives agent restarts until `chat_reset`).

The `agent-full-access` mode (unrestricted file and network access) is disabled by default, because a page open in the browser can contain untrusted content. Without `--allow-full-access` the bridge removes that value from the `mode` option in every `session_config`, and answers a `set_config_option` for it with the notice "Full access is disabled. Restart the bridge with --allow-full-access to enable it." The banner shows `Full access: allowed` or `Full access: disabled`.

## Persistent conversations

A conversation is identified by a `conversationId` (a lowercase UUID v4 the browser sends in `session` with `chat_open` and `chat_prompt`; anything else is rejected, because it becomes a filename). It is not tied to a browser window anymore:

- **Refresh:** the agent keeps running, even mid-turn, when the page closes or reloads; closing the socket only detaches the window. The newest window attached to a conversation receives its live events; an older one just stops receiving. On `chat_open` the bridge first sends `{ "type": "chat_history", "events": [...] }` (user messages, agent text, tool calls, permission requests, notices, turn ends), then `session_config`, `available_commands` and the current `chat_status` (`running` if a turn is active). A permission request the agent is still waiting on stays a plain `permission_request` and can still be answered; answered or cancelled ones are followed by a `permission_resolved`.
- **Window binding:** the MCP header `X-Prismic-Window-Id` follows the attached window. The first `chat_open` or `chat_prompt` from a new window restarts the agent (never during a turn) and resumes its session with ACP `session/load`.
- **Daemon restart:** each conversation is saved to `<data dir>/conversations/<conversationId>.json` (`{ version, conversationId, repository, acpSessionId?, updatedAt, events }`), in a `0700` directory with `0600` files, written atomically and debounced (about 500 ms, flushed on exit). The file is loaded on the first `chat_open` of that id and the agent resumes the stored ACP session. If the session can't be resumed, a new one starts with the notice "Started a new agent session after renewing the ChatGPT token; earlier messages aren't in the agent's memory." A corrupt file is ignored with a warning. A session only resumes once a prompt has been sent in it.
- **Transcript limits:** consecutive text chunks of the same message are merged, and the log is capped at 3000 events or about 2 MB; the oldest events are dropped first, but never a permission request that is still unanswered.
- **TTL:** a conversation with no window attached and no turn running is stopped after 6 hours (it stays on disk). Files older than 30 days are deleted at startup.
- **Reset:** `chat_reset` stops the agent and deletes the transcript, the stored session and the file. The next `chat_open` starts a fresh conversation, with a new preamble.

### Limits

- **Resident agents:** at most 4 agents run at once, daemon-wide. To start another, the bridge stops the least recently active agent that no window is attached to and that has no turn running and no pending permission request (its conversation stays on disk and resumes later with `session/load`). If there is none, the new conversation gets the notice "Too many active conversations. Finish or reset one first.". At most 50 conversations are kept in memory; detached ones without an agent are dropped from memory (not from disk).
- **Detached work:** a conversation with no window attached whose turn has run for more than 30 minutes, or whose permission request has gone unanswered for 30 minutes, is cancelled (and its agent stopped if the cancel isn't honored within a minute).
- **Input sizes:** repository 200 characters, prompt 20000, document id and title 300, MCP URL 2048, Prismic token 8192, config values and permission ids 200. WebSocket frames over 256 KiB close the connection.
- **Transcript:** a single event's text is cut at 100000 characters with a visible `…[truncated]` marker (merged agent text too), at most 20 permission requests per agent can wait at once (further ones are cancelled), and the size cap counts bytes. A stored file is read only if it is a regular file of at most 4 MiB and passes the schema bounds, otherwise it is ignored with a warning.
- **Stale agents:** once an agent was stopped or its conversation reset, anything it still sends is ignored (its permission requests are answered as cancelled), so a reset conversation can't come back from a late message. A replaced WebSocket stops being listened to as soon as its replacement attaches.

The transcript contains your prompts and the agent's replies and tool titles in plain text: treat the `conversations/` directory as private.

## Structured editor context

When the agent's MCP tool call `get_editor_context` of the `prismic` server completes, the bridge sends `{ "type": "editor_context", "toolCallId", "context" }` so the browser can render a card from real data instead of parsing the agent's text. `context` is `{ status, ambiguous, document?, slice?, field?, detected?, pinned? }`:

- `document` is the document the agent works on: the pinned window's document for `pinned_matches` and `context_changed`, otherwise the detected one. `slice` and `field` come from that same document. `context_changed` also carries `detected` (what the window shows now) and `pinned.id`; `pinned_document_not_open` carries `pinned.id` only.
- The tool result is parsed with a strict schema: unknown keys are dropped (the draft `content`, field `paths` and slice `item` never leave the bridge), strings are capped at 300 characters, and anything invalid is ignored silently.
- It is emitted only when it differs from the last one of the conversation, recorded in the transcript, replayed in `chat_history` and persisted like the other events.

This reads the tool output that codex-acp 2.1.1 reports itself: an MCP call is a `tool_call` titled `mcp.<server>.<tool>` with `rawInput: { server, tool, arguments }`, and its completed `tool_call_update` carries `rawOutput: { result: { content: [{ type: "text", text }], structuredContent }, error }`. codex-acp leaves unchanged fields (title, `rawInput`) out of updates, so the bridge remembers the tool identity from the start report. The bridge makes no MCP call of its own.

The first prompt of a conversation is preceded by a preamble that also holds an answer style guide and tells the agent not to print a "Context:" line (the UI already shows it). The title, id and repository it interpolates are collapsed to one line, capped at 200 characters, and stripped of double quotes.

## Threat model

- **Trust boundary:** an allowed origin plus the pairing token. Whoever holds both can drive the agent; the bridge has no further per-action authorization.
- **The paired browser does everything:** it sends prompts, approves permission requests (the permission cards), and can switch the agent between `read-only`, `workspace-write` and `agent` (auto review) with `set_config_option`. A page that is compromised, or that injects instructions into the agent, is therefore as powerful as the selected mode and the user's approvals allow.
- **`--allow-full-access`** only gates the `agent-full-access` preset, the only mode that never asks for approval. It does not restrict the other modes.
- **`--use-user-codex`:** the agent uses your Codex home, config, hooks and MCP servers, and all their tools become reachable from the browser (see "Codex home").
- **Stored transcripts:** conversations are saved in plain text under `<data dir>/conversations/` (`0600`), so anyone who can read your files can read them. They are never logged, and `chat_reset` deletes them. A conversation is reachable by any paired window that knows its id; ids are random UUIDs.
- **Blocked commands:** `/logout` is account-global (it would sign out Codex outside the bridge). `/review`, `/review-branch`, `/review-commit` and `/goal` start turns that codex-acp runs outside the bridge's agent mode, sandbox and approval policy. They are removed from the command list and rejected on incoming prompts.

## Slash commands and skills

codex-acp publishes its commands (built-ins such as `status`, `review`, `compact`, plus skills named `$<skill>`) in an `available_commands_update`. The bridge relays it as `{ "type": "available_commands", "commands": [{ "name", "description", "hint"? }] }` whenever it changes, and again after `session_config` on `chat_open`. `hint` comes from the command's input hint.

The commands `/logout`, `/review`, `/review-branch`, `/review-commit` and `/goal` are blocked (see Threat model): they are removed from `available_commands`, and a prompt starting with one of them is not forwarded; the bridge answers with the notice "The /<name> command isn't available in the local agent." The other commands (`status`, `mcp`, `skills`, `plan`, `compact`, `rename`) and `$skill` prompts work.

A prompt starting with `/<name>` is sent as plain text, exactly as typed, and stays the first content block, which is where codex-acp looks for a command. The Prismic preamble is not added to such a prompt. It is held back and added to the next regular prompt, because a handled command never reaches the model.

## Use with wroom

In `packages/wroom/.env.local`:

```
PRISMIC_MCP_SERVER_BASE_URL=http://localhost:3030/
PRISMIC_LOCAL_AGENT_BRIDGE_URL=http://127.0.0.1:7878/
```

Open the agent panel, pick "Local agent", enter the pairing code, then "Continue with ChatGPT".

## Safeguards

- Bound to `127.0.0.1`; requests must carry a `127.0.0.1:<port>` or `localhost:<port>` Host header.
- Browser requests and WebSocket upgrades must come from an allowed origin (`/auth/callback` is exempt and validated by `state`).
- API and WebSocket access needs a token obtained by pairing; tokens live in memory only. Five wrong codes rotate the code and start a cooldown (30 s, doubling up to 15 min, reset by a successful pair) during which `/pair` returns 429.
- Tokens (pairing, ChatGPT, Prismic) are never logged.

## Checks

```sh
npm run check && npm test
```
