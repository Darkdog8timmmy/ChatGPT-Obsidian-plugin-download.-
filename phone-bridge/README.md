# Obsidian Phone Bridge

Use the assistant tools to work with a vault open in Obsidian Mobile. The mobile plugin performs each operation inside Obsidian; a small HTTPS relay passes short-lived requests between the phone and the assistant.

## Install on your phone

1. Download [the plugin ZIP](./release/obsidian-phone-bridge-0.1.0.zip).
2. In your vault, create `.obsidian/plugins/obsidian-phone-bridge/`.
3. Copy `main.js` and `manifest.json` from the ZIP into that folder.
4. Enable community plugins and turn on **Obsidian Phone Bridge**.
5. Set the Relay URL to `https://obsidian-vault-bridge.bigsugar10.chatgpt.site`.
6. Generate a pairing code in the plugin settings. Give it to your assistant and ask it to call `vault_pair_phone`.
7. Paste the returned token into **Phone token**. Keep Obsidian open while the assistant works with notes.

The tool set can check connection status, list and search notes, read, create, replace, append, and move Markdown notes, or insert text at the active editor cursor. It does not include a delete-note action.

## What 401 Unauthorized means

HTTP 401 means a request did not include valid authentication. The public relay is supposed to return 401 when a phone request has no valid pairing token, or when an assistant tool request has no signed-in Site identity. That response blocks the request; it does not mean notes were exposed. After pairing, the phone sends its token automatically. If you see 401 after pairing, check that the token is correct and has not been revoked.

## Privacy

The public page contains setup information only. Phone polling and completion require the private bearer token; assistant tools require a signed-in Site identity. The relay hashes pairing codes and phone tokens before storing them. Requested note text is temporarily held in private relay storage while an operation is pending and until its result is retrieved or expires; it is not published as a public page. Do not post a phone token or pairing code publicly.

## Build

From this directory:

```sh
cd obsidian-plugin
npm install
npm run build
```

The `site/.openai/hosting.json` file in this public source tree is a template with `project_id: null`. Set it to the Site ID returned by Sites before building and publishing your own relay.
