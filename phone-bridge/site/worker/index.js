const VERSION = "0.1.0";
const PAIRING_TTL_MS = 10 * 60 * 1000;
const ACTION_TTL_MS = 15 * 60 * 1000;
const RESULT_TTL_MS = 10 * 60 * 1000;
const PHONE_ONLINE_MS = 60 * 1000;
const MAX_CONTENT_CHARS = 100_000;
const MAX_RESULT_CHARS = 300_000;
const WAIT_MS = 8_000;

const textEncoder = new TextEncoder();

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, GET, OPTIONS",
      "access-control-allow-headers": "content-type, authorization",
    },
  });
}

function text(data, status = 200, contentType = "text/plain; charset=utf-8") {
  return new Response(data, {
    status,
    headers: { "content-type": contentType, "cache-control": "no-store" },
  });
}

function userKey(userId) {
  return Array.from(textEncoder.encode(userId), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomHex(byteCount) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteCount));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function requireBucket(env) {
  if (!env.BUCKET) throw new Error("The relay storage binding is unavailable.");
  return env.BUCKET;
}

async function readObject(bucket, key) {
  const object = await bucket.get(key);
  if (!object) return null;
  try {
    return JSON.parse(await object.text());
  } catch {
    return null;
  }
}

async function writeObject(bucket, key, value) {
  await bucket.put(key, JSON.stringify(value), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
}

async function readRequestJson(request, maxChars = MAX_CONTENT_CHARS + 20_000) {
  const raw = await request.text();
  if (raw.length > maxChars) throw new Error("Request is too large.");
  try {
    return JSON.parse(raw || "{}");
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function requireSiteUser(request) {
  const userId = request.headers.get("oai-authenticated-user-id")?.trim();
  if (!userId) throw new Error("Sign in to the connected Obsidian Vault Bridge plugin first.");
  return userId;
}

function safeNotePath(value, label = "path") {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  let path = value.trim().replaceAll("\\", "/");
  if (path.startsWith("/") || path.includes("\0")) throw new Error(`${label} must be relative to the vault root.`);
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${label} must not contain empty, dot, or parent-directory segments.`);
  }
  if (!/\.md$/i.test(path)) {
    if (/\.[^/]+$/.test(path)) throw new Error(`${label} must point to a Markdown note (.md).`);
    path += ".md";
  }
  if (path.length > 500) throw new Error(`${label} is too long.`);
  return path;
}

function safeFolder(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw new Error("folder must be a string.");
  const folder = value.trim().replaceAll("\\", "/");
  if (folder.startsWith("/") || folder.includes("\0") || folder.length > 500) {
    throw new Error("folder must be a relative vault path.");
  }
  if (folder.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("folder must not contain empty, dot, or parent-directory segments.");
  }
  return folder;
}

function requireString(value, label, maxLength = MAX_CONTENT_CHARS) {
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  if (value.length > maxLength) throw new Error(`${label} exceeds the ${maxLength}-character limit.`);
  return value;
}

function requireDeviceId(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{32}$/i.test(value)) {
    throw new Error("Invalid phone device ID.");
  }
  return value.toLowerCase();
}

function toolResult(value, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

function toolError(message) {
  return toolResult({ ok: false, error: message }, true);
}

function field(name, description, maxLength = undefined) {
  return {
    type: "string",
    description,
    ...(maxLength ? { maxLength } : {}),
    ...(name === "path" || name.endsWith("_path") || name === "request_id" || name === "pairing_code"
      ? { minLength: 1 }
      : {}),
  };
}

const TOOL_DEFS = [
  {
    name: "vault_status",
    description: "Check whether the paired Obsidian phone is online. Keep Obsidian open to receive actions.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "vault_pair_phone",
    description: "Exchange a one-time code shown in the Obsidian mobile plugin for a private phone token. Return the token to the user so they can paste it into the plugin settings. The token is a secret.",
    inputSchema: {
      type: "object",
      properties: { pairing_code: field("pairing_code", "32-character one-time code displayed by the Obsidian plugin.", 32) },
      required: ["pairing_code"],
      additionalProperties: false,
    },
  },
  {
    name: "vault_unpair_phone",
    description: "Revoke the paired phone token and clear pending relay requests. This does not change any vault notes.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "vault_list_notes",
    description: "List Markdown notes in the paired vault, optionally filtered by folder or path/title text.",
    inputSchema: {
      type: "object",
      properties: {
        folder: field("folder", "Optional relative folder path within the vault.", 500),
        query: field("query", "Optional case-insensitive text filter for note paths.", 300),
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Maximum notes to return (default 50)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "vault_search",
    description: "Search note contents in the paired vault. Keep Obsidian open while the phone processes the request.",
    inputSchema: {
      type: "object",
      properties: {
        query: field("query", "Text to search for.", 300),
        folder: field("folder", "Optional relative folder path within the vault.", 500),
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Maximum matching notes to return (default 20)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "vault_read_note",
    description: "Read one Markdown note by its path relative to the vault root.",
    inputSchema: {
      type: "object",
      properties: { path: field("path", "Relative note path; .md is added when omitted.", 500) },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "vault_create_note",
    description: "Create a new Markdown note. Fails if the destination already exists.",
    inputSchema: {
      type: "object",
      properties: {
        path: field("path", "New note path relative to the vault root.", 500),
        content: field("content", "Complete Markdown body for the new note."),
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "vault_replace_note",
    description: "Replace the entire contents of an existing Markdown note. This is a full-note replacement.",
    inputSchema: {
      type: "object",
      properties: {
        path: field("path", "Existing note path relative to the vault root.", 500),
        content: field("content", "Complete replacement Markdown body."),
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "vault_append_note",
    description: "Append Markdown text to an existing note without replacing its current contents.",
    inputSchema: {
      type: "object",
      properties: {
        path: field("path", "Existing note path relative to the vault root.", 500),
        text: field("text", "Markdown text to add to the end of the note."),
      },
      required: ["path", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "vault_move_note",
    description: "Move or rename an existing Markdown note. Fails if the destination exists.",
    inputSchema: {
      type: "object",
      properties: {
        from_path: field("from_path", "Current note path relative to the vault root.", 500),
        to_path: field("to_path", "New note path relative to the vault root.", 500),
      },
      required: ["from_path", "to_path"],
      additionalProperties: false,
    },
  },
  {
    name: "vault_insert_at_cursor",
    description: "Type or paste Markdown at the active Obsidian editor cursor on the phone. If text is selected, Obsidian replaces that selection.",
    inputSchema: {
      type: "object",
      properties: { text: field("text", "Markdown text to insert at the current editor selection or cursor.") },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "vault_wait_for_action",
    description: "Wait for a queued phone action to finish after a vault tool returned status=pending. The phone must have Obsidian open and online.",
    inputSchema: {
      type: "object",
      properties: {
        request_id: field("request_id", "Request ID returned by a previous vault tool.", 36),
        timeout_seconds: { type: "integer", minimum: 1, maximum: 15, description: "How long to wait (default 10 seconds)." },
      },
      required: ["request_id"],
      additionalProperties: false,
    },
  },
];

async function getDevice(bucket, userId) {
  return readObject(bucket, `users/${userKey(userId)}/device.json`);
}

async function clearPrefix(bucket, prefix, limit = 100) {
  const listing = await bucket.list({ prefix, limit });
  if (listing.objects?.length) await bucket.delete(listing.objects.map((object) => object.key));
}

async function phonePairRequest(request, env) {
  const body = await readRequestJson(request, 5_000);
  const code = typeof body.pairing_code === "string" ? body.pairing_code.toLowerCase() : "";
  if (!/^[a-f0-9]{32}$/.test(code)) return json({ ok: false, error: "Pairing code must be 32 hexadecimal characters." }, 400);
  const deviceId = requireDeviceId(body.device_id);
  const now = Date.now();
  const clientIp = request.headers.get("cf-connecting-ip") || "unknown";
  const ipHash = await sha256(clientIp);
  const rateKey = `pair-rate/${ipHash}/${Math.floor(now / (60 * 60 * 1000))}.json`;
  const bucket = requireBucket(env);
  const rateRecord = await readObject(bucket, rateKey);
  if ((rateRecord?.count || 0) >= 10) return json({ ok: false, error: "Pairing code rate limit reached. Try again in an hour." }, 429);
  await writeObject(bucket, rateKey, { count: (rateRecord?.count || 0) + 1, expiresAt: now + 60 * 60 * 1000 });
  const codeHash = await sha256(code);
  const pairings = await bucket.list({ prefix: "pairings/", limit: 50 });
  for (const item of pairings.objects || []) {
    const oldPairing = await readObject(bucket, item.key);
    if (!oldPairing || oldPairing.expiresAt <= now) await bucket.delete(item.key);
  }
  await writeObject(bucket, `pairings/${codeHash}.json`, {
    deviceId,
    deviceName: typeof body.device_name === "string" ? body.device_name.slice(0, 50) : "Obsidian phone",
    createdAt: now,
    expiresAt: now + PAIRING_TTL_MS,
  });
  return json({ ok: true, expires_at: now + PAIRING_TTL_MS });
}

function bearerToken(request) {
  const header = request.headers.get("authorization") || "";
  const match = /^Bearer\s+([a-f0-9]{64})$/i.exec(header);
  return match ? match[1].toLowerCase() : null;
}

async function authenticatePhone(request, env) {
  const token = bearerToken(request);
  if (!token) return null;
  const tokenHash = await sha256(token);
  const bucket = requireBucket(env);
  const record = await readObject(bucket, `tokens/${tokenHash}.json`);
  if (!record || !record.userId || !record.deviceId) return null;
  return { token, tokenHash, record, bucket };
}

async function phonePoll(request, env) {
  const auth = await authenticatePhone(request, env);
  if (!auth) return json({ ok: false, error: "Invalid phone token." }, 401);
  const { bucket, record, tokenHash } = auth;
  const now = Date.now();
  const ukey = userKey(record.userId);
  const device = await getDevice(bucket, record.userId);
  if (!device || device.tokenHash !== tokenHash || device.deviceId !== record.deviceId) {
    return json({ ok: false, error: "This phone pairing has been revoked." }, 401);
  }
  device.lastSeenAt = now;
  await writeObject(bucket, `users/${ukey}/device.json`, device);
  record.lastSeenAt = now;
  await writeObject(bucket, `tokens/${tokenHash}.json`, record);

  const prefix = `queue/${ukey}/${record.deviceId}/`;
  const listing = await bucket.list({ prefix, limit: 30 });
  const queuedItems = [];
  for (const item of listing.objects || []) {
    const queued = await readObject(bucket, item.key);
    if (!queued) {
      await bucket.delete(item.key);
      continue;
    }
    if (queued.expiresAt <= now) {
      await bucket.delete(item.key);
      continue;
    }
    queuedItems.push({ item, queued });
  }
  const oldResults = await bucket.list({ prefix: `results/${ukey}/`, limit: 30 });
  for (const item of oldResults.objects || []) {
    const result = await readObject(bucket, item.key);
    if (!result || result.expiresAt <= now) await bucket.delete(item.key);
  }
  queuedItems.sort((left, right) => left.queued.createdAt - right.queued.createdAt);
  const next = queuedItems.find(({ queued }) => !queued.leaseUntil || queued.leaseUntil <= now);
  if (next) {
    next.queued.leaseUntil = now + 60_000;
    await writeObject(bucket, next.item.key, next.queued);
    return json({ ok: true, action: { id: next.queued.id, command: next.queued.command } });
  }
  return json({ ok: true, action: null });
}

async function phoneComplete(request, env) {
  const auth = await authenticatePhone(request, env);
  if (!auth) return json({ ok: false, error: "Invalid phone token." }, 401);
  const body = await readRequestJson(request, MAX_RESULT_CHARS + 20_000);
  const actionId = typeof body.action_id === "string" ? body.action_id : "";
  if (!/^[a-f0-9-]{36}$/i.test(actionId)) return json({ ok: false, error: "Invalid action ID." }, 400);
  const resultText = JSON.stringify(body.result ?? null);
  if (resultText.length > MAX_RESULT_CHARS) return json({ ok: false, error: "Action result is too large." }, 413);
  const { bucket, record } = auth;
  const ukey = userKey(record.userId);
  const resultKey = `results/${ukey}/${actionId}.json`;
  const existingResult = await readObject(bucket, resultKey);
  if (existingResult) return json({ ok: true, duplicate: true });
  const queueKey = `queue/${ukey}/${record.deviceId}/${actionId}.json`;
  const queued = await readObject(bucket, queueKey);
  if (!queued || queued.deviceId !== record.deviceId) return json({ ok: false, error: "Action is no longer waiting." }, 404);
  await writeObject(bucket, resultKey, {
    actionId,
    deviceId: record.deviceId,
    createdAt: Date.now(),
    expiresAt: Date.now() + RESULT_TTL_MS,
    result: body.result ?? null,
  });
  await bucket.delete(queueKey);
  return json({ ok: true });
}

async function issuePhoneToken(bucket, userId, pairingCode) {
  const codeHash = await sha256(pairingCode.toLowerCase());
  const pairingKey = `pairings/${codeHash}.json`;
  const pairing = await readObject(bucket, pairingKey);
  if (!pairing || pairing.expiresAt < Date.now()) {
    if (pairing) await bucket.delete(pairingKey);
    throw new Error("That pairing code is missing or expired. Generate a fresh code in Obsidian.");
  }
  const token = randomHex(32);
  const tokenHash = await sha256(token);
  const now = Date.now();
  const ukey = userKey(userId);
  const oldDevice = await getDevice(bucket, userId);
  if (oldDevice?.tokenHash) {
    await bucket.delete(`tokens/${oldDevice.tokenHash}.json`);
    await clearPrefix(bucket, `queue/${ukey}/${oldDevice.deviceId}/`);
    await clearPrefix(bucket, `results/${ukey}/`);
  }
  const device = {
    deviceId: pairing.deviceId,
    deviceName: pairing.deviceName || "Obsidian phone",
    tokenHash,
    pairedAt: now,
    lastSeenAt: null,
  };
  await writeObject(bucket, `tokens/${tokenHash}.json`, {
    userId,
    deviceId: device.deviceId,
    createdAt: now,
    lastSeenAt: null,
  });
  await writeObject(bucket, `users/${ukey}/device.json`, device);
  await bucket.delete(pairingKey);
  return {
    ok: true,
    device_name: device.deviceName,
    session_token: token,
    instructions: "Paste this token into the Obsidian plugin's Phone token setting. Keep it private. It remains valid until you unpair the phone.",
  };
}

async function unpairPhone(bucket, userId) {
  const device = await getDevice(bucket, userId);
  if (!device) return { ok: true, paired: false };
  const ukey = userKey(userId);
  if (device.tokenHash) await bucket.delete(`tokens/${device.tokenHash}.json`);
  await bucket.delete(`users/${ukey}/device.json`);
  await clearPrefix(bucket, `queue/${ukey}/${device.deviceId}/`);
  await clearPrefix(bucket, `results/${ukey}/`);
  return { ok: true, paired: false };
}

function validateCommand(name, args) {
  switch (name) {
    case "vault_list_notes":
      return {
        type: "list_notes",
        folder: safeFolder(args.folder),
        query: args.query === undefined ? "" : requireString(args.query, "query", 300),
        limit: Math.max(1, Math.min(Number.isInteger(args.limit) ? args.limit : 50, 100)),
      };
    case "vault_search":
      return {
        type: "search",
        query: requireString(args.query, "query", 300),
        folder: safeFolder(args.folder),
        limit: Math.max(1, Math.min(Number.isInteger(args.limit) ? args.limit : 20, 50)),
      };
    case "vault_read_note":
      return { type: "read_note", path: safeNotePath(args.path) };
    case "vault_create_note":
      return { type: "create_note", path: safeNotePath(args.path), content: requireString(args.content, "content") };
    case "vault_replace_note":
      return { type: "replace_note", path: safeNotePath(args.path), content: requireString(args.content, "content") };
    case "vault_append_note":
      return { type: "append_note", path: safeNotePath(args.path), text: requireString(args.text, "text") };
    case "vault_move_note":
      return { type: "move_note", fromPath: safeNotePath(args.from_path, "from_path"), toPath: safeNotePath(args.to_path, "to_path") };
    case "vault_insert_at_cursor":
      return { type: "insert_at_cursor", text: requireString(args.text, "text") };
    default:
      throw new Error("Unsupported vault action.");
  }
}

async function enqueueAction(bucket, userId, command) {
  const device = await getDevice(bucket, userId);
  if (!device) throw new Error("No phone is paired. Open the Obsidian plugin settings and pair this phone first.");
  if (!device.lastSeenAt || Date.now() - device.lastSeenAt > PHONE_ONLINE_MS) {
    throw new Error("The paired phone is offline. Open Obsidian on the phone and keep it in the foreground, then try again.");
  }
  const id = crypto.randomUUID();
  const now = Date.now();
  const key = `queue/${userKey(userId)}/${device.deviceId}/${id}.json`;
  await writeObject(bucket, key, {
    id,
    deviceId: device.deviceId,
    command,
    createdAt: now,
    expiresAt: now + ACTION_TTL_MS,
    leaseUntil: null,
  });
  return id;
}

async function readActionResult(bucket, userId, requestId, consume = true) {
  if (typeof requestId !== "string" || !/^[a-f0-9-]{36}$/i.test(requestId)) throw new Error("Invalid request ID.");
  const resultKey = `results/${userKey(userId)}/${requestId}.json`;
  const result = await readObject(bucket, resultKey);
  if (result && result.expiresAt > Date.now()) {
    if (consume) await bucket.delete(resultKey);
    return { status: "completed", ...result.result };
  }
  if (result) await bucket.delete(resultKey);
  const device = await getDevice(bucket, userId);
  if (!device) return { status: "unpaired" };
  const queueKey = `queue/${userKey(userId)}/${device.deviceId}/${requestId}.json`;
  const queued = await readObject(bucket, queueKey);
  if (queued && queued.expiresAt > Date.now()) return { status: "pending", request_id: requestId };
  if (queued) await bucket.delete(queueKey);
  return { status: "expired", request_id: requestId };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function enqueueAndWait(bucket, userId, command, timeoutMs = WAIT_MS) {
  const requestId = await enqueueAction(bucket, userId, command);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await readActionResult(bucket, userId, requestId, false);
    if (result.status === "completed") {
      await bucket.delete(`results/${userKey(userId)}/${requestId}.json`);
      return { request_id: requestId, ...result };
    }
    if (result.status === "expired" || result.status === "unpaired") return { request_id: requestId, ...result };
    await sleep(300);
  }
  return { status: "pending", request_id: requestId, message: "The request is queued. Keep Obsidian open and call vault_wait_for_action to retrieve the result." };
}

async function waitForAction(bucket, userId, requestId, timeoutSeconds = 10) {
  const deadline = Date.now() + Math.max(1, Math.min(timeoutSeconds, 15)) * 1000;
  while (Date.now() < deadline) {
    const result = await readActionResult(bucket, userId, requestId, false);
    if (result.status !== "pending") {
      if (result.status === "completed") await bucket.delete(`results/${userKey(userId)}/${requestId}.json`);
      return { request_id: requestId, ...result };
    }
    await sleep(300);
  }
  return { status: "pending", request_id: requestId, message: "The phone has not returned a result yet. Keep Obsidian open and try vault_wait_for_action again." };
}

async function handleTool(request, env, name, args) {
  const userId = requireSiteUser(request);
  const bucket = requireBucket(env);
  if (name === "vault_status") {
    const device = await getDevice(bucket, userId);
    if (!device) return toolResult({ paired: false, online: false, message: "No phone is paired." });
    const online = Boolean(device.lastSeenAt && Date.now() - device.lastSeenAt <= PHONE_ONLINE_MS);
    return toolResult({ paired: true, online, device_name: device.deviceName, last_seen_at: device.lastSeenAt ? new Date(device.lastSeenAt).toISOString() : null });
  }
  if (name === "vault_pair_phone") {
    const code = requireString(args.pairing_code, "pairing_code", 32).toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(code)) return toolError("Pairing code must be 32 hexadecimal characters.");
    return toolResult(await issuePhoneToken(bucket, userId, code));
  }
  if (name === "vault_unpair_phone") return toolResult(await unpairPhone(bucket, userId));
  if (name === "vault_wait_for_action") {
    const timeoutSeconds = Number.isInteger(args.timeout_seconds) ? args.timeout_seconds : 10;
    const result = await waitForAction(bucket, userId, args.request_id, timeoutSeconds);
    return toolResult(result, result.status === "expired" || result.status === "unpaired" || result.ok === false);
  }
  const command = validateCommand(name, args);
  const result = await enqueueAndWait(bucket, userId, command);
  return toolResult(result, result.status === "expired" || result.status === "unpaired" || result.ok === false);
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function handleMcp(request, env) {
  let body;
  try {
    body = await readRequestJson(request, MAX_CONTENT_CHARS + 30_000);
  } catch (error) {
    return json(rpcError(null, -32700, error.message), 400);
  }
  const id = body.id ?? null;
  if (body.method === "server/discover") {
    return json({ jsonrpc: "2.0", id, result: { supportedVersions: ["2026-07-28"], capabilities: { tools: {} } } });
  }
  if (body.method === "initialize") {
    return json({ jsonrpc: "2.0", id, result: { protocolVersion: "2026-07-28", capabilities: { tools: {} }, serverInfo: { name: "obsidian-vault-bridge", version: VERSION } } });
  }
  if (body.method === "notifications/initialized") return new Response(null, { status: 202, headers: { "cache-control": "no-store" } });
  if (body.method === "ping") return json({ jsonrpc: "2.0", id, result: {} });
  if (body.method === "tools/list") return json({ jsonrpc: "2.0", id, result: { tools: TOOL_DEFS } });
  if (body.method === "tools/call") {
    const name = body.params?.name;
    const args = body.params?.arguments ?? {};
    if (!TOOL_DEFS.some((tool) => tool.name === name)) return json(rpcError(id, -32602, "Unknown tool."), 200);
    try {
      return json({ jsonrpc: "2.0", id, result: await handleTool(request, env, name, args) });
    } catch (error) {
      return json({ jsonrpc: "2.0", id, result: toolError(error instanceof Error ? error.message : "Vault request failed.") });
    }
  }
  return json(rpcError(id, -32601, "Method not found."), 200);
}

function landingPage() {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Obsidian Vault Bridge</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:760px;margin:8vh auto;padding:0 24px;color:#202124}h1{font-size:2rem;line-height:1.15}code{background:#f2f3f5;padding:.15em .35em;border-radius:4px}.card{background:#f7f8fa;border-radius:14px;padding:18px 22px;margin:22px 0}a{color:#5641d9}</style><body><h1>Obsidian Vault Bridge</h1><p>This HTTPS relay is reachable from the public internet so a phone can connect. This page contains setup information; it does not display vault notes.</p><div class="card"><strong>Phone setup</strong><ol><li>Install the Obsidian Phone Bridge plugin in your vault.</li><li>Open the plugin settings and generate a pairing code.</li><li>Use the assistant's <code>vault_pair_phone</code> tool with that code, then paste the returned token into Obsidian.</li><li>Keep Obsidian open while the assistant works with notes.</li></ol></div><p>Phone requests require the private pairing token, and assistant tools require a signed-in Site identity. Requested note text passes through relay storage only while that action runs. Use <code>vault_unpair_phone</code> to revoke a phone token.</p></body></html>`;
}

async function fetchHandler(request, env) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, GET, OPTIONS", "access-control-allow-headers": "content-type, authorization" } });
  if (url.pathname === "/" && request.method === "GET") return text(landingPage(), 200, "text/html; charset=utf-8");
  if (url.pathname === "/health" && request.method === "GET") return json({ ok: true, version: VERSION });
  if (url.pathname === "/mcp" && request.method === "POST") return handleMcp(request, env);
  if (url.pathname === "/phone/pair/request" && request.method === "POST") {
    try { return await phonePairRequest(request, env); }
    catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : "Pair request failed." }, 400); }
  }
  if (url.pathname === "/phone/poll" && request.method === "POST") {
    try { return await phonePoll(request, env); }
    catch { return json({ ok: false, error: "Phone poll failed." }, 500); }
  }
  if (url.pathname === "/phone/complete" && request.method === "POST") {
    try { return await phoneComplete(request, env); }
    catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : "Action completion failed." }, 400); }
  }
  return json({ ok: false, error: "Not found." }, 404);
}

export default { fetch: fetchHandler };
