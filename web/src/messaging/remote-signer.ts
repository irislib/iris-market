import { validateUploadAuthorization } from '../upload-auth.ts';
// Adapted from Iris Chat at cc68f2fa6ac9396faed732bc94e3b511f09d834f.
// https://github.com/irislib/iris-chat/blob/cc68f2fa6ac9396faed732bc94e3b511f09d834f/src/lib/remoteSigner.ts
import { finalizeEvent, generateSecretKey, getPublicKey, nip44, verifyEvent } from "nostr-tools";
import type { Event, UnsignedEvent, VerifiedEvent } from 'nostr-tools';
import type { PrivateTransport } from './transport.ts';
export interface RemoteSignerOptions {runtime:PrivateTransport;relays:string[];signal:AbortSignal;bunkerLink?:string;permissions?:string[];timeoutMs?:number;onConnectionLink?:(url:string)=>void;onAuthUrl?:(url:string)=>void;onClose?:(error:Error)=>void}
const HEX_KEY = /^[a-f0-9]{64}$/;
const TIMEOUT = 120_000;
const MAX_MESSAGE = 64 * 1024;
const APPROVAL_ERRORS = /* @__PURE__ */ new Set([
  "Device approval expired. Try again.",
  "Device approval cancelled.",
  "Use your primary device to approve this link.",
  "Device list changed. Try again.",
  "Conflicting device lists. Try again later.",
  "Could not check message servers. Try again.",
  "Too many linked devices.",
  "Device list is too large.",
  "Device list does not match. Try again.",
  "Invalid device link. Try again.",
  "This link already approved a device.",
  "Could not save device link. Try again.",
  "Could not approve this link. Try again."
]);
function approvalErrorMessage(error) {
  if (error === "Your device list changed. Create a new link.") return "Device list changed. Try again.";
  if (typeof error === "string" && APPROVAL_ERRORS.has(error)) return error;
  if (error === "Denied" || error === "Denied by user") return "Signer declined the request. Try again.";
  return "Your other device could not approve this link. Try again.";
}
function signerPermissions(values) {
  if (values === undefined) return ["sign_event:37368"];
  const supported = new Set(["sign_event:0", "sign_event:3", "sign_event:30402", "sign_event:24242"]);
  if (!Array.isArray(values) || !values.length || values.length > supported.size || values.some(value => !supported.has(value))) throw new Error("Unsupported signer permissions.");
  return [...new Set(values)];
}
function signerRelayUrls(values:string[]):string[] {
  const urls = [...new Set(values.map((value) => {
    const url = new URL(value);
    if (!["wss:", "ws:"].includes(url.protocol) || url.username || url.password || url.hash) {
      throw new Error("Invalid signer message server.");
    }
    return url.toString();
  }))];
  if (!urls.length || urls.length > 8) throw new Error("Invalid signer message servers.");
  return urls;
}
function parseBunkerLink(value) {
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Paste a signer link to continue.");
  }
  if (url.protocol !== "bunker:" || !HEX_KEY.test(url.hostname) || url.pathname && url.pathname !== "/" || url.username || url.password || url.port || url.hash) {
    throw new Error("Invalid signer link.");
  }
  return { pubkey: url.hostname, relays: signerRelayUrls(url.searchParams.getAll("relay")), secret: url.searchParams.get("secret") || "" };
}
/** Ephemeral NIP-46 transport keys are never account or chat device keys. */
class RemoteSigner {
  options:RemoteSignerOptions;
  permissions:string[];
  constructor(options:RemoteSignerOptions) {
    this.options = options;
    this.permissions = signerPermissions(options.permissions);
    options.signal.addEventListener("abort", this.abort, { once: true });
    if (options.signal.aborted) this.abort();
  }
  linkInfo?:{v:number;linkId:string;device:string;approver:string};
  key = generateSecretKey();
  publicKey = getPublicKey(this.key);
  remoteKey = "";
  relays = [];
  subscription;
  pending = /* @__PURE__ */ new Map();
  seen = /* @__PURE__ */ new Set();
  closed = false;
  error = new Error("Sign-in cancelled.");
  timer;
  challenge = crypto.randomUUID().replaceAll("-", "");
  waitingConnection;
  abort = () => this.close(new Error("Sign-in cancelled."));
  ensureActive() {
    if (this.closed) throw this.error;
  }
  check() {
    this.ensureActive();
  }
  startApprovalTimer() {
    this.timer = setTimeout(() => this.close(new Error("Sign-in timed out. Try again.")), this.options.timeoutMs ?? TIMEOUT);
  }
  async listen(urls) {
    this.check();
    this.subscription?.close();
    this.relays = urls;
    this.subscription = this.options.runtime.subscribe([{
      kinds: [24133],
      "#p": [this.publicKey],
      since: Math.floor(Date.now() / 1e3) - 60
    }], { onEvent: (event) => this.receive(event) }, {
      relays: urls,
      sources: [],
      cache: "network-only",
      localEcho: false,
      signal: this.options.signal
    });
  }
  async connect() {
    const bunker = this.options.bunkerLink ? parseBunkerLink(this.options.bunkerLink) : null;
    if (bunker) this.remoteKey = bunker.pubkey;
    await this.listen(bunker?.relays ?? signerRelayUrls(this.options.relays));
    if (bunker) {
      this.startApprovalTimer();
      const result = await this.request("connect", [bunker.pubkey, bunker.secret, this.permissions.join(","), JSON.stringify({ name: "Iris Market", url: "https://market.iris.to" })]);
      if (result !== "ack" && (!bunker.secret || result !== bunker.secret)) throw new Error("Invalid signer confirmation.");
    } else {
      const connected = new Promise((resolve, reject) => {
        this.waitingConnection = { resolve, reject };
      });
      const link = new URL(`nostrconnect://${this.publicKey}`);
      for (const relay of this.relays) link.searchParams.append("relay", relay);
      link.searchParams.set("secret", this.challenge);
      link.searchParams.set("perms", this.permissions.join(","));
      link.searchParams.set("name", "Iris Market");
      link.searchParams.set("url", "https://market.iris.to");
      this.options.onConnectionLink?.(link.toString().replaceAll("+", "%20"));
      await connected;
      this.startApprovalTimer();
    }
    this.check();
    const switched = await this.request("switch_relays", [], 3e3).catch((error) => {
      this.check();
      if (error instanceof SignerDeniedError && error.unsupported || error instanceof SignerRequestTimeout) return "null";
      throw error;
    });
    if (switched !== "null") {
      let urls;
      try {
        urls = JSON.parse(switched);
      } catch {
        throw new Error("Invalid signer message servers.");
      }
      if (!Array.isArray(urls) || !urls.every((url) => typeof url === "string")) throw new Error("Invalid signer message servers.");
      await this.listen(signerRelayUrls(urls));
    }
    const owner = await this.request("get_public_key", []);
    if (!HEX_KEY.test(owner)) throw new Error("Invalid user ID from signer.");
    return owner;
  }
  async signEvent(event:UnsignedEvent):Promise<VerifiedEvent> {
    if (!this.permissions.includes(`sign_event:${event?.kind}`)) throw new Error("This signer cannot approve that event type.");
    if (event.kind === 24242) validateUploadAuthorization(event,undefined);
    const response = await this.request("sign_event", [JSON.stringify(event)]);
    if (response.length > 32 * 1024) throw new Error("Invalid signer response.");
    let signed;
    try {
      signed = JSON.parse(response);
    } catch {
      throw new Error("Invalid signer response.");
    }
    if (event.kind !== 37368) return signed;
    try {
      const info = await this.request("iris_get_link_info", [], 3e3);
      this.linkInfo = JSON.parse(info);
    } catch (error) {
      this.check();
      if (!(error instanceof SignerDeniedError && error.unsupported) && !(error instanceof SignerRequestTimeout)) throw new Error("Invalid device-link information.");
    }
    return signed;
  }
  get transportPubkey() {
    return this.publicKey;
  }
  request(method:string, params:string[], timeoutMs = 9e4):Promise<string> {
    this.check();
    const id = crypto.randomUUID();
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new SignerRequestTimeout("Sign-in timed out. Try again."));
      }, timeoutMs);
      const fail = (error) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      };
      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: fail
      });
      try {
        const conversationKey = nip44.v2.utils.getConversationKey(this.key, this.remoteKey);
        const event = finalizeEvent({ kind: 24133, created_at: Math.floor(Date.now() / 1e3), tags: [["p", this.remoteKey]], content: nip44.v2.encrypt(JSON.stringify({ id, method, params }), conversationKey) }, this.key);
        this.options.runtime.publish(event, { relays: this.relays, sources: [], requireAck: true, queue: false, localEcho: false }).then((result) => {
          if (!result.remoteAccepted) throw new Error("Signer request was not accepted");
        }).catch(() => {
          if (this.pending.has(id)) fail(new Error("Could not reach signer. Try again."));
        });
      } catch {
        fail(new Error("Invalid signer connection."));
      }
    });
  }
  remember(id) {
    this.seen.add(id);
    if (this.seen.size > 128) this.seen.delete(this.seen.values().next().value);
  }
  receive(raw) {
    if (!raw || typeof raw.content !== "string" || !Array.isArray(raw.tags) || !raw.tags.every(tag => Array.isArray(tag) && tag.every(value => typeof value === "string"))) return;
    // Clone only signed fields so a supplied verification marker cannot bypass checks.
    const event = {
      id: raw.id,
      pubkey: raw.pubkey,
      sig: raw.sig,
      kind: raw.kind,
      created_at: raw.created_at,
      content: raw.content,
      tags: raw.tags.map((tag) => [...tag])
    };
    if (this.closed || this.seen.has(event.id) || event.kind !== 24133 || event.content.length > MAX_MESSAGE || !event.tags.some((tag) => tag[0] === "p" && tag[1] === this.publicKey) || !verifyEvent(event)) return;
    if (this.remoteKey && event.pubkey !== this.remoteKey) return;
    try {
      const plaintext = nip44.v2.decrypt(event.content, nip44.v2.utils.getConversationKey(this.key, event.pubkey));
      const response = JSON.parse(plaintext);
      if (typeof response.id !== "string") return;
      if (!this.remoteKey) {
        if (!this.waitingConnection || response.result !== this.challenge || response.error) return;
        this.remoteKey = event.pubkey;
        this.remember(event.id);
        this.waitingConnection.resolve(this.remoteKey);
        this.waitingConnection = void 0;
        return;
      }
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.remember(event.id);
      if (response.result === "auth_url") {
        const url = new URL(String(response.error));
        if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid signer approval link.");
        this.options.onAuthUrl?.(url.toString());
        return;
      }
      this.pending.delete(response.id);
      if (response.error) pending.reject(new SignerDeniedError(
        /unknown method|unsupported|not supported|not implemented|method not found/i.test(String(response.error)),
        pending.method === "sign_event" ? approvalErrorMessage(response.error) : void 0
      ));
      else if (pending.method === "switch_relays" && (response.result === null || Array.isArray(response.result))) pending.resolve(JSON.stringify(response.result));
      else if (typeof response.result !== "string") pending.reject(new Error("Invalid signer response."));
      else pending.resolve(response.result);
    } catch {
    }
  }
  close(error = new Error("Sign-in cancelled.")) {
    if (this.closed) return;
    this.closed = true;
    this.error = error;
    clearTimeout(this.timer);
    this.options.signal.removeEventListener("abort", this.abort);
    this.waitingConnection?.reject(error);
    this.waitingConnection = void 0;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.subscription?.close();
    this.key.fill(0);
    try { this.options.onClose?.(error); } catch { /* Closure is already complete. */ }
  }
}
class SignerDeniedError extends Error {
  unsupported:boolean;
  constructor(unsupported, message = "Signer declined the request. Try again.") {
    super(message);
    this.unsupported = unsupported;
  }
}
class SignerRequestTimeout extends Error {
}
export {
  RemoteSigner,
  parseBunkerLink,
  signerRelayUrls
};
