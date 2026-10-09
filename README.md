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
| `--agent-mode` | `read-only` | `read-only`, `workspace-write` or `agent`. |

Environment:

- `PRISMIC_BRIDGE_TOKEN_REFRESH_MARGIN_MS` (default `300000`): the ChatGPT access token is refreshed, and the agent restarted, when it has less validity left than this.
- `XDG_CONFIG_HOME`: data directory is `$XDG_CONFIG_HOME/prismic-local-agent-bridge` (default `~/.config/...`). It holds `credentials.json` (mode 600), `host.json` and `codex-home/`.

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
- API and WebSocket access needs a token obtained by pairing; tokens live in memory only. Five wrong codes rotate the code.
- Tokens (pairing, ChatGPT, Prismic) are never logged.

## Checks

```sh
npm run check && npm test
```
