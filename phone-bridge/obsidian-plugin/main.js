/* Obsidian Phone Bridge v0.1.0 */
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => ObsidianPhoneBridgePlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");
var DEFAULT_SETTINGS = {
  relayUrl: "https://obsidian-vault-bridge.bigsugar10.chatgpt.site",
  phoneToken: "",
  pairingCode: "",
  deviceId: "",
  pendingAcks: []
};
var MAX_NOTE_CHARS = 1e5;
var POLL_EVERY_MS = 2500;
var MAX_PENDING_ACKS = 5;
function randomHex(byteCount) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteCount));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function normalizeRelayUrl(value) {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed || trimmed.includes("YOUR-SITE-URL")) throw new Error("Enter the relay URL from the setup instructions first.");
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Relay URL must be a valid HTTPS address.");
  }
  if (url.protocol !== "https:") throw new Error("Relay URL must use HTTPS.");
  return url.origin;
}
function normalizeNotePath(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("Note path is required.");
  let path = value.trim().replaceAll("\\", "/");
  if (path.startsWith("/") || path.includes("\0")) throw new Error("Note path must be relative to the vault root.");
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error("Note path contains an invalid folder segment.");
  if (!/\.md$/i.test(path)) {
    if (/\.[^/]+$/.test(path)) throw new Error("Only Markdown notes can be accessed.");
    path += ".md";
  }
  if (path.length > 500) throw new Error("Note path is too long.");
  return path;
}
function normalizeFolder(value) {
  if (value === void 0 || value === null || value === "") return "";
  if (typeof value !== "string") throw new Error("Folder must be text.");
  const folder = value.trim().replaceAll("\\", "/");
  if (!folder) return "";
  if (folder.startsWith("/") || folder.includes("\0") || folder.length > 500) throw new Error("Folder must be relative to the vault root.");
  if (folder.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Folder contains an invalid path segment.");
  return folder;
}
var ObsidianPhoneBridgePlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.settings = DEFAULT_SETTINGS;
    this.pollTimer = null;
    this.polling = false;
  }
  async onload() {
    await this.loadSettings();
    if (!this.settings.deviceId) this.settings.deviceId = randomHex(16);
    this.addSettingTab(new BridgeSettingTab(this.app, this));
    this.app.workspace.onLayoutReady(() => this.startPolling());
  }
  onunload() {
    if (this.pollTimer !== null) window.clearInterval(this.pollTimer);
  }
  async loadSettings() {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
    if (!Array.isArray(this.settings.pendingAcks)) this.settings.pendingAcks = [];
  }
  async saveSettings() {
    await this.saveData(this.settings);
    this.startPolling();
  }
  async createPairingCode() {
    if (!this.settings.deviceId) this.settings.deviceId = randomHex(16);
    const pairingCode = randomHex(16);
    const relayUrl = normalizeRelayUrl(this.settings.relayUrl);
    const response = await (0, import_obsidian.requestUrl)({
      url: `${relayUrl}/phone/pair/request`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairing_code: pairingCode,
        device_id: this.settings.deviceId,
        device_name: "Obsidian phone"
      })
    });
    if (response.status < 200 || response.status >= 300 || response.json?.ok !== true) {
      throw new Error(response.json?.error ?? "Could not create a pairing code.");
    }
    this.settings.pairingCode = pairingCode;
    await this.saveData(this.settings);
    return pairingCode;
  }
  startPolling() {
    if (this.pollTimer !== null) window.clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (!this.settings.phoneToken || !this.settings.relayUrl || this.settings.relayUrl.includes("YOUR-SITE-URL")) return;
    this.pollTimer = window.setInterval(() => void this.pollOnce(), POLL_EVERY_MS);
    void this.pollOnce();
  }
  async relay(path, body, authenticated) {
    const relayUrl = normalizeRelayUrl(this.settings.relayUrl);
    const headers = { "Content-Type": "application/json" };
    if (authenticated) headers.Authorization = `Bearer ${this.settings.phoneToken.trim()}`;
    const response = await (0, import_obsidian.requestUrl)({
      url: `${relayUrl}${path}`,
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(response.json?.error ?? `Relay returned HTTP ${response.status}.`);
    }
    return response.json;
  }
  async pollOnce() {
    if (this.polling || !this.settings.phoneToken.trim()) return;
    this.polling = true;
    try {
      await this.flushPendingAcks();
      const response = await this.relay("/phone/poll", {}, true);
      if (response.ok !== true) throw new Error(response.error ?? "Phone poll failed.");
      const action = response.action;
      if (action?.id && action.command) await this.runAction(action);
    } catch (error) {
      console.debug("Obsidian Phone Bridge connection paused.", error);
    } finally {
      this.polling = false;
    }
  }
  async flushPendingAcks() {
    for (const pending of [...this.settings.pendingAcks]) {
      const response = await this.relay("/phone/complete", { action_id: pending.actionId, result: pending.result }, true);
      if (response.ok !== true) throw new Error(response.error ?? "Could not acknowledge a completed action.");
      this.settings.pendingAcks = this.settings.pendingAcks.filter((item) => item.actionId !== pending.actionId);
      await this.saveData(this.settings);
    }
  }
  async runAction(action) {
    const pending = this.settings.pendingAcks.find((item) => item.actionId === action.id);
    if (!pending) {
      let result;
      try {
        result = await this.execute(action.command);
      } catch (error) {
        result = { ok: false, error: error instanceof Error ? error.message : "The phone could not finish the vault action." };
      }
      this.settings.pendingAcks = [...this.settings.pendingAcks, { actionId: action.id, result }].slice(-MAX_PENDING_ACKS);
      await this.saveData(this.settings);
    }
    await this.flushPendingAcks();
  }
  async execute(command) {
    switch (command.type) {
      case "list_notes": {
        const folder = normalizeFolder(command.folder);
        const query = typeof command.query === "string" ? command.query.toLowerCase() : "";
        const limit = Math.max(1, Math.min(Number(command.limit) || 50, 100));
        const files = this.app.vault.getMarkdownFiles().filter((file) => !folder || file.path === folder || file.path.startsWith(`${folder}/`)).filter((file) => !query || file.path.toLowerCase().includes(query)).sort((left, right) => left.path.localeCompare(right.path)).slice(0, limit);
        return { ok: true, notes: files.map((file) => ({ path: file.path, basename: file.basename })), returned: files.length, limit };
      }
      case "search": {
        const query = typeof command.query === "string" ? command.query.trim() : "";
        if (!query) throw new Error("Search text is required.");
        const folder = normalizeFolder(command.folder);
        const limit = Math.max(1, Math.min(Number(command.limit) || 20, 50));
        const candidates = this.app.vault.getMarkdownFiles().filter((file) => !folder || file.path === folder || file.path.startsWith(`${folder}/`)).sort((left, right) => left.path.localeCompare(right.path)).slice(0, 500);
        const matches = [];
        const needle = query.toLowerCase();
        let scanned = 0;
        let scannedChars = 0;
        for (const file of candidates) {
          if (matches.length >= limit || scannedChars >= 2e7) break;
          const content = await this.app.vault.cachedRead(file);
          scanned++;
          scannedChars += content.length;
          const lines = content.split(/\r?\n/);
          for (let index = 0; index < lines.length; index++) {
            if (lines[index].toLowerCase().includes(needle)) {
              const line = lines[index].trim();
              matches.push({ path: file.path, line: index + 1, snippet: line.length > 400 ? `${line.slice(0, 397)}...` : line });
              break;
            }
          }
        }
        return { ok: true, query, matches, scanned_files: scanned, candidate_files: candidates.length };
      }
      case "read_note": {
        const path = normalizeNotePath(command.path);
        const file = this.requireNote(path);
        const fullContent = await this.app.vault.cachedRead(file);
        const content = fullContent.slice(0, MAX_NOTE_CHARS);
        return { ok: true, path, content, truncated: fullContent.length > content.length };
      }
      case "create_note": {
        const path = normalizeNotePath(command.path);
        const content = this.requireContent(command.content);
        if (this.app.vault.getAbstractFileByPath(path)) throw new Error(`A file already exists at ${path}.`);
        await this.ensureFolders(path);
        await this.app.vault.create(path, content);
        return { ok: true, path, created: true };
      }
      case "replace_note": {
        const path = normalizeNotePath(command.path);
        const content = this.requireContent(command.content);
        const file = this.requireNote(path);
        await this.app.vault.modify(file, content);
        return { ok: true, path, replaced: true, characters: content.length };
      }
      case "append_note": {
        const path = normalizeNotePath(command.path);
        const addition = this.requireContent(command.text);
        const file = this.requireNote(path);
        const current = await this.app.vault.read(file);
        if (current.length + addition.length > MAX_NOTE_CHARS) throw new Error("The edited note would exceed the 100,000-character limit.");
        await this.app.vault.modify(file, current + addition);
        return { ok: true, path, appended_characters: addition.length };
      }
      case "move_note": {
        const fromPath = normalizeNotePath(command.fromPath);
        const toPath = normalizeNotePath(command.toPath);
        const file = this.requireNote(fromPath);
        if (fromPath === toPath) return { ok: true, path: toPath, moved: false, message: "The note is already at that path." };
        if (this.app.vault.getAbstractFileByPath(toPath)) throw new Error(`A file already exists at ${toPath}.`);
        await this.ensureFolders(toPath);
        await this.app.vault.rename(file, toPath);
        return { ok: true, from_path: fromPath, to_path: toPath, moved: true };
      }
      case "insert_at_cursor": {
        const insertedText = this.requireContent(command.text);
        const view = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
        if (!view) throw new Error("Open a Markdown note in the editor on the phone before inserting text.");
        view.editor.replaceSelection(insertedText);
        return { ok: true, path: view.file?.path ?? null, inserted_characters: insertedText.length };
      }
      default:
        throw new Error("Unsupported vault action.");
    }
  }
  requireContent(value) {
    if (typeof value !== "string") throw new Error("Text content is required.");
    if (value.length > MAX_NOTE_CHARS) throw new Error("Text exceeds the 100,000-character limit.");
    return value;
  }
  requireNote(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof import_obsidian.TFile)) throw new Error(`Note not found: ${path}`);
    return file;
  }
  async ensureFolders(path) {
    const parts = path.split("/").slice(0, -1);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) await this.app.vault.createFolder(current);
    }
  }
};
var BridgeSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Obsidian Phone Bridge" });
    containerEl.createEl("p", { text: "Pair this phone with the assistant tools. Keep Obsidian open while notes are being read or changed." });
    new import_obsidian.Setting(containerEl).setName("Relay URL").setDesc("HTTPS address provided with the assistant plugin.").addText((text) => text.setPlaceholder("https://your-relay.example").setValue(this.plugin.settings.relayUrl).onChange(async (value) => {
      this.plugin.settings.relayUrl = value;
      await this.plugin.saveSettings();
    }));
    const pairingSetting = new import_obsidian.Setting(containerEl).setName("Pair this phone").setDesc("Generate a one-time code, then ask the assistant to pair this phone. The assistant returns a token to paste below.").addButton((button) => button.setButtonText("Generate code").onClick(async () => {
      button.setButtonText("Working\u2026").setDisabled(true);
      try {
        const code = await this.plugin.createPairingCode();
        this.display();
        new import_obsidian.Notice("Pairing code created. Copy it into the assistant chat.");
        return code;
      } catch (error) {
        new import_obsidian.Notice(error instanceof Error ? error.message : "Could not start pairing.");
      } finally {
        button.setButtonText("Generate code").setDisabled(false);
      }
    }));
    if (this.plugin.settings.pairingCode) {
      const codeSetting = new import_obsidian.Setting(containerEl).setName("One-time pairing code").setDesc("Expires after 10 minutes and can be used once.");
      const code = codeSetting.controlEl.createEl("code", { text: this.plugin.settings.pairingCode });
      codeSetting.addButton((button) => button.setButtonText("Copy").onClick(async () => {
        try {
          await navigator.clipboard.writeText(this.plugin.settings.pairingCode);
          new import_obsidian.Notice("Pairing code copied.");
        } catch {
          new import_obsidian.Notice("Copy the pairing code shown in the settings.");
        }
      }));
      code.setAttr("aria-label", "One-time pairing code");
    }
    new import_obsidian.Setting(containerEl).setName("Phone token").setDesc("Paste the private token returned by vault_pair_phone. Removing it stops this phone from connecting.").addText((text) => {
      text.setPlaceholder("Paste token").setValue(this.plugin.settings.phoneToken).onChange(async (value) => {
        this.plugin.settings.phoneToken = value.trim();
        await this.plugin.saveSettings();
      });
      text.inputEl.type = "password";
    });
    new import_obsidian.Setting(containerEl).setName("Connection").setDesc(this.plugin.settings.phoneToken ? "The plugin checks the relay every 2.5 seconds while Obsidian is open." : "Not paired.");
    new import_obsidian.Setting(containerEl).setName("Unpair").setDesc("Use the assistant's vault_unpair_phone tool to revoke the token, then clear the token field here.").addButton((button) => button.setButtonText("Clear phone token").setWarning().onClick(async () => {
      this.plugin.settings.phoneToken = "";
      this.plugin.settings.pairingCode = "";
      this.plugin.settings.pendingAcks = [];
      await this.plugin.saveSettings();
      this.display();
    }));
  }
};
