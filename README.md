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
- `XDG_CONFIG_HOME`: data directory is `$XDG_CONFIG_HOME/prismic-local-agent-bridge` (default `~/.config/...`). It holds `credentials.json` (mode 600), `host.json` and `codex-home/`.

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

## Slash commands and skills

codex-acp publishes its commands (built-ins such as `status`, `review`, `compact`, plus skills named `$<skill>`) in an `available_commands_update`. The bridge relays it as `{ "type": "available_commands", "commands": [{ "name", "description", "hint"? }] }` whenever it changes, and again after `session_config` on `chat_open`. `hint` comes from the command's input hint.

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
