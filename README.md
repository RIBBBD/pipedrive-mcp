# Pipedrive MCP server (self-hosted)

A small remote MCP server that gives Claude read + write access to your Pipedrive
CRM — list/search deals, create and update deals, search/create people, and log
activities and notes. Built for Claude on the web / Cowork / Dispatch, so it uses
**Streamable HTTP** transport (not stdio, which is desktop-local only).

The 12 tools: `list_pipelines`, `list_stages`, `list_deals`, `search_deals`,
`get_deal`, `create_deal`, `update_deal`, `search_persons`, `create_person`,
`add_activity`, `add_note`.

---

## 1. Get your Pipedrive API token

In Pipedrive: top-right profile picture → **Company settings** → **Personal
preferences** → **API** → copy your personal API token. (Your account's
permissions apply — the connector can only do what your Pipedrive user can do.)

## 2. Generate a path secret

The endpoint lives at `/mcp/<secret>` so a random host visitor can't poke it.
Generate one:

```
node -e "console.log(require('crypto').randomUUID())"
```

## 3. Deploy it somewhere public

Custom connectors are reached **from Anthropic's cloud, not your laptop**, so the
server must be on the public internet over HTTPS. Anything that gives you a public
HTTPS URL works — Render, Railway, Fly.io, or a small VPS. Whatever you pick, set
these environment variables:

| Variable                   | Required | Notes                                   |
|----------------------------|----------|-----------------------------------------|
| `PIPEDRIVE_API_TOKEN`      | yes      | From step 1. Stays server-side only.    |
| `MCP_PATH_SECRET`          | yes      | From step 2.                            |
| `PIPEDRIVE_COMPANY_DOMAIN` | no       | e.g. `bbd` for bbd.pipedrive.com.       |
| `PORT`                     | no       | Most hosts set this automatically.      |

Build and run:

```
npm install
npm run build
npm start
```

Confirm it's alive by visiting `https://<your-host>/healthz` → `{"ok":true}`.

Your full MCP URL is:

```
https://<your-host>/mcp/<MCP_PATH_SECRET>
```

## 4. Add it to Claude

Customize → **Connectors** → **+** → enter a name (e.g. "Pipedrive") and paste the
full MCP URL above. Leave the OAuth fields blank. Click **Add**, then **Connect**.
On Pro/Max you can do this yourself. Once connected it's available to Cowork; test
a Pipedrive request from a **Dispatch** session early, as connector availability in
Dispatch has been patchy.

---

## Security notes

- The Pipedrive token lives only in the server's environment — it's never in the
  URL and Claude never sees it.
- The path secret is the only thing guarding the endpoint, so keep the full URL
  private (treat it like a password) and rotate it by changing `MCP_PATH_SECRET`
  and redeploying if it ever leaks.
- This touches BBD's live CRM with write access. Worth a quick word with whoever
  handles BBD's IT before you wire it to production data, and consider testing
  against a sandbox or with a low-permission Pipedrive user first.
- For stronger protection than a secret path (e.g. proper OAuth), the connector's
  advanced settings accept an OAuth Client ID/secret — a sensible hardening step if
  BBD wants it later.
