import {rumorMilliseconds,messageMilliseconds} from '../message-timestamp.ts';
import {contextTags,messageContext,orderContext,validMessageContext,type MessageContext} from '../message-context.ts';
import { invitationBase } from '../asset-url.ts';
import { validateUploadAuthorization } from '../upload-auth.ts';
import { REVIEW_KIND, parseReview, validateReviewDraft } from '../reviews.ts';
import {validateShippingOptionEvent} from '../shipping.ts';
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey, nip19 } from 'nostr-tools';
import { AppKeys, Invite, NdrRuntime, createPersistentNostrOutbox, hasMetadataPrivacyVersion } from 'nostr-double-ratchet';
import { createVault } from './vault.ts';
import { createPrivateTransport, verifiedPrivateEvent } from './transport.ts';
import { RemoteSigner } from './remote-signer.ts';
import { authorizeSignerDevice, fetchSignerRoster, prepareSignerAuthorization, selectSignerRoster, validateSignerAuthorization } from './authorization.ts';
import {createChatControls,applyChatControl,messageReactions,deliveryRank,type ReceiptPreferences,type ReactionSummary,type ChatControlMeta} from './chat-controls.ts';
import { createOrderBook, isOrderMessage } from '../orders.ts';
import type { Event, UnsignedEvent, VerifiedEvent } from 'nostr-tools';
import type { NostrPublishContext, Rumor, OnEventMeta } from 'nostr-double-ratchet';
import type { Vault } from './vault.ts';
import type { PrivateTransport } from './transport.ts';
import type { DeliveryPlace, DeliveryRequest, OrderListing, OrderPatch, OrderView } from '../orders.ts';
type AccountMode='local'|'extension'|'linked';
interface AccountRecord {owner:string;mode:AccountMode;deviceSecret:number[];ownerSecret?:number[];proof?:VerifiedEvent;installed?:boolean;freshOwner?:boolean;displayName?:string;profileEvent?:VerifiedEvent}
export interface ChatMessage {id:string;text:string;mine:boolean;createdAt:number;createdAtMs?:number;expiresAt?:number;delivery:'queued'|'sent'|'delivered'|'seen'|'received';reactions?:ReactionSummary[];_chat?:ChatControlMeta;orderId?:string;context?:MessageContext;system?:boolean}
export interface MessagingState {receiptPreferences:ReceiptPreferences;status:string;error:string;password:boolean;ownerPubkey?:string;devicePubkey?:string;displayName?:string;pendingPublic:number;chatStatus:string;profileEvent?:VerifiedEvent;pendingListings:VerifiedEvent[];pendingReviews:VerifiedEvent[];orders:OrderView[];canSend:boolean;canSign:boolean;mode?:AccountMode;needsLogin:boolean;devices:{pubkey:string;current:boolean}[];conversations:{pubkey:string;messages:ChatMessage[]}[]}
type AccountSigner=(event:UnsignedEvent)=>Event|Promise<Event>;
interface BrowserSigner {getPublicKey():Promise<string>;signEvent:AccountSigner}
interface MessagingOptions {developerMint?:string;getRelays?:()=>string[];onChange?:(state:MessagingState)=>void;vault?:Vault;transportFactory?:()=>PrivateTransport;extension?:()=>BrowserSigner|undefined}
interface SignerLoginOptions {password?:string;bunkerLink?:string;signal?:AbortSignal;onConnectionLink?:(url:string)=>void;onAuthUrl?:(url:string)=>void;onCommitting?:()=>void}
type PublicationContext=NostrPublishContext&{recipientDeviceOwnerPubkey?:string};

const HEX = /^[a-f0-9]{64}$/;
const DEVICE_PREFIX = 'v1/device-manager/';
const now = () => Math.floor(Date.now() / 1000);
function publicAccountEvent(event:VerifiedEvent):boolean {
  if([0,3,30402].includes(event.kind))return true;
  if(event.kind===30406){try{validateShippingOptionEvent(event);return true;}catch{return false;}}
  if(event.kind!==REVIEW_KIND)return false;
  try{parseReview(event);return true;}catch{return false;}
}

function secretBytes(value) {
  if (value instanceof Uint8Array && value.length === 32) return new Uint8Array(value);
  const text = String(value).trim();
  if (text.startsWith('nsec1')) {
    const decoded = nip19.decode(text);
    if (decoded.type === 'nsec') return new Uint8Array(decoded.data);
  }
  if (HEX.test(text)) return Uint8Array.from(text.match(/../g), byte => parseInt(byte, 16));
  throw new Error('Enter a valid private key.');
}

export function canPublishToDevice(event, context, snapshots) {
  if (event.kind !== 1060) return true;
  if (!context?.recipientOwnerPubkey) return false;
  const target = event.tags.find(tag => tag[0] === 'p')?.[1];
  const roster = snapshots.find(snapshot => snapshot.ownerPubkey === (context.recipientDeviceOwnerPubkey ?? context.recipientOwnerPubkey));
  return !!roster?.appKeys.getDevice(target);
}

export function messageProjection(rumor:Rumor, from:string, meta:OnEventMeta, owner:string):{pubkey:string;message:ChatMessage}|null {
  if (rumor.kind !== 14 || typeof rumor.content !== 'string' || rumor.content.length > 16_000 || rumor.tags.some(tag => tag[0] === 'l')) return null;
  const expiry = rumor.tags.find(tag => tag[0] === 'expiration')?.[1];
  if (expiry && Number(expiry) <= now()) return null;
  const mine = meta?.isSelf === true || meta?.senderOwnerPubkey === owner;
  const pubkey = mine ? rumor.tags.find(tag => tag[0] === 'p')?.[1] ?? owner : meta?.senderOwnerPubkey ?? from;
  if (!HEX.test(pubkey) || !HEX.test(rumor.id)) return null;
  return { pubkey, message: { id: rumor.id, text: rumor.content, mine, createdAt: rumor.created_at,...(rumorMilliseconds(rumor)!==undefined?{createdAtMs:rumorMilliseconds(rumor)}:{}),
    ...(expiry ? { expiresAt: Number(expiry) } : {}), context:messageContext(rumor.tags), delivery: mine ? 'sent' : 'received' } };
}

/** Public account identity and per-device chat key follow the active Iris Chat NDR runtime. */
export function createMessaging({ developerMint, getRelays=()=>[], onChange = () => {}, vault = createVault(),
  transportFactory = () => createPrivateTransport(getRelays), extension = () => (globalThis.window as Window&{nostr?:BrowserSigner})?.nostr }:MessagingOptions = {}) {
  let account:AccountRecord,runtime:NdrRuntime,transport:PrivateTransport,outbox:ReturnType<typeof createPersistentNostrOutbox>,ownerSecret:Uint8Array,signer:AccountSigner,controller:AbortController,postingRemote:RemoteSigner,postingTransport:PrivateTransport,generation = 0;
  let status = 'signed-out', error = '', authorizationChecked = false, savedStatus;
  let chatStatus = 'connecting', activation, syncing, syncingProfile, retryTimer, enrollmentSigner, enrollmentRemote;
  let publicQueue = new Map<string,VerifiedEvent>(), profilePatch:{name:string;picture?:string};
  let conversations = new Map<string,ChatMessage[]>();
  let orders:ReturnType<typeof createOrderBook>, syncingOrders:Promise<void>;
  let controls:ReturnType<typeof createChatControls>,syncingControls:Promise<void>;
  let messageWrites = Promise.resolve(),lastChatMs=0;
  const state = ():MessagingState => ({ status, error, password: !!savedStatus?.password,
    ownerPubkey: account?.owner, devicePubkey: runtime?.getState().currentDevicePubkey ?? (account?.deviceSecret ? getPublicKey(Uint8Array.from(account.deviceSecret)) : undefined),
    receiptPreferences:controls?.preferences()??{delivered:true,seen:true},
    displayName: profilePatch?.name ?? account?.displayName, pendingPublic: publicQueue.size + (profilePatch ? 1 : 0), chatStatus,
    profileEvent: account?.profileEvent ? structuredClone(account.profileEvent) : undefined,
    pendingListings: [...publicQueue.values()].filter(event => event.kind === 30402).map(event => structuredClone(event)),
    pendingReviews: [...publicQueue.values()].filter(event => event.kind === REVIEW_KIND).map(event => structuredClone(event)),
    orders: orders?.state() ?? [],
    canSend: status === 'ready' && authorizationChecked && runtime?.getState().isCurrentDeviceRegistered === true,
    canSign: !!signer && status === 'ready', mode: account?.mode, needsLogin: status === 'locked' && !account?.ownerSecret,
    devices: runtime?.getState().registeredDevices.map(device => ({ pubkey: device.identityPubkey,
      current: device.identityPubkey === runtime.getState().currentDevicePubkey })) ?? [],
    conversations: [...conversations].map(([pubkey, messages]) => ({ pubkey, messages: messages.filter(message => !message.expiresAt || message.expiresAt > now()).map(({_chat,...message}) => ({ ...message,reactions:messageReactions({...message,_chat},account?.owner) })) })) });
  const validOrderContext=(id:string,peer:string)=>{
    const order=orders?.state().find(order=>order.id===id);
    if(!order)return false;
    const participants=new Set([order.buyer,order.seller,...order.shipment.stops.map(stop=>stop.courierPubkey).filter(Boolean)]);
    return participants.has(account?.owner)&&participants.has(peer);
  };
  const notify = () => onChange(state());
  const report = () => { if (status !== 'ready') return; error = 'Some messages are waiting for a connection.'; notify(); };
  const check = attempt => { if (attempt !== generation) throw new Error('Account changed.'); };
  const requireReady = () => { if (!account || status !== 'ready') throw new Error('Sign in to continue.'); };
  const requireChat = () => { requireReady(); if (!runtime) throw new Error('Chat is connecting. Your profile is ready.'); };
  const signing = async draft => {
    if (!signer || !account) throw new Error('Approve this action with your account signer.');
    if (draft.kind === 24242) validateUploadAuthorization(draft,undefined);
    if (draft.kind === REVIEW_KIND) validateReviewDraft(draft,account.owner);
    const expected = { ...draft, pubkey: account.owner, tags: draft.tags.map(tag => [...tag]) };
    const attempt = generation;
    const signed = verifiedPrivateEvent(await signer(structuredClone(expected)));
    check(attempt);
    if (!signed || signed.pubkey !== account.owner || signed.id !== getEventHash(expected)) throw new Error('Signer changed the requested event.');
    if (signed.kind === 24242) validateUploadAuthorization(signed,undefined);
    return signed;
  };
  const saveMessage = (pubkey:string, message:ChatMessage) => {
    const attempt = generation;
    const operation = messageWrites.then(async () => {
      check(attempt);
      const previous = conversations.get(pubkey) ?? [];
      const index = previous.findIndex(existing => existing.id === message.id);
      const next = [...previous];
      let combined=index<0?structuredClone(message):{...next[index],...message,_chat:next[index]._chat};
      if(index>=0&&message.mine&&deliveryRank(next[index].delivery)>deliveryRank(combined.delivery))combined.delivery=next[index].delivery;
      const pending=controls?.pendingFor(pubkey,message.id)??[];
      for(const control of pending)combined=applyChatControl(combined,control,account.owner,pubkey);
      if(index===-1)next.push(combined);else next[index]=combined;
      // Stable sorting preserves existing order when legacy timestamps tie.
      next.sort((a, b) => messageMilliseconds(a)-messageMilliseconds(b));
      if(combined.mine)lastChatMs=Math.max(lastChatMs,messageMilliseconds(combined));
      if (next.length > 1000) throw new Error('This conversation has reached its local storage limit.');
      await vault.put(`market/messages/${pubkey}`, next);
      check(attempt); conversations.set(pubkey, next); notify();
      await controls?.settled(pending);
    });
    messageWrites = operation.catch(() => {});
    return operation;
  };
  const orderQueueEntry = (key, value) => {
    if(key.startsWith('v1/message-queue/')||key.startsWith('v1/discovery-queue/'))return value?.event?.id;
    if(key.startsWith('v1/runtime-outbox/'))return value?.innerEventId;
  };
  // These queue prefixes belong to the pinned NDR storage adapter. Remove only
  // exact order rumors the book has retired; ordinary messages are untouched.
  const privateStorage = { ...vault, async put(key,value){
    const id=orderQueueEntry(key,value);
    return id&&orders&&!orders.canPublish(id)?vault.del(key):vault.put(key,value);
  }};
  async function pruneOrderQueues(){
    const attempt=generation,book=orders;if(!book)return;
    for(const prefix of ['v1/message-queue/','v1/discovery-queue/','v1/runtime-outbox/'])for(const key of await vault.list(prefix)){
      check(attempt);const value=await vault.get(key),id=orderQueueEntry(key,value);
      if(id&&!book.canPublish(id))await vault.del(key);
    }
  }
  const startRuntime = async ({ justAuthorized = false } = {}) => {
    const attempt = generation;
    check(attempt);
    if (!account || !HEX.test(account.owner) || !account.proof || !account.deviceSecret) throw new Error('Chat is waiting for device approval.');
    authorizationChecked = justAuthorized;
    // Only the delegate's stable key is installed into NDR storage, never the account key.
    if (!await vault.get(`${DEVICE_PREFIX}identity-public-key`)) {
      await vault.put(`${DEVICE_PREFIX}identity-public-key`, getPublicKey(Uint8Array.from(account.deviceSecret)));
      await vault.put(`${DEVICE_PREFIX}identity-private-key`, account.deviceSecret);
      await vault.put(`${DEVICE_PREFIX}owner-pubkey`, account.owner);
    }
    check(attempt);
    outbox = createPersistentNostrOutbox({ storage: privateStorage, concurrency: 3,
      publish: async (event, _innerId, context) => {
        check(attempt);
        // Superseded/expired positions are retired without network publication.
        // Their IDs remain in the private book so NDR's exact retry can be dropped.
        if (_innerId && orders && !orders.canPublish(_innerId)) return event;
        if ([1059, 1060].includes(event.kind) && (!authorizationChecked || !runtime?.getState().isCurrentDeviceRegistered || !hasMetadataPrivacyVersion(event))) throw new Error('This device is not authorized to send.');
        if (!canPublishToDevice(event, context, runtime?.getKnownAppKeysSnapshots() ?? [])) throw new Error('The receiving device was removed.');
        const receipt = await transport.publish(event, { signal: controller.signal });
        check(attempt);
        if (!receipt.remoteAccepted) throw new Error('No message server accepted this message.');
        return event;
      },
      onPublished: async ({ innerEventId, context: rawContext }) => {
        if (!innerEventId) return;
        const context=rawContext as PublicationContext;
        await orders?.sent(innerEventId, context?.recipientDeviceOwnerPubkey ?? context?.recipientOwnerPubkey);
        for (const [peer, messages] of conversations) {
          const message = messages.find(item => item.id === innerEventId && item.mine);
          if (message && (context?.recipientDeviceOwnerPubkey ?? context?.recipientOwnerPubkey)===peer) await saveMessage(peer, { ...message, delivery: 'sent' });
        }
      }, onError: report,
    });
    const publicationContext = (event:UnsignedEvent, context:PublicationContext):PublicationContext => {
      if (event.kind !== 1060) return context;
      const target = event.tags.find(tag => tag[0] === 'p')?.[1];
      // The library's recipientOwnerPubkey names the conversation, including
      // sender copies. Check the actual destination device against its own roster.
      const actualOwner = runtime?.getKnownAppKeysSnapshots().find(snapshot => snapshot.appKeys.getDevice(target))?.ownerPubkey;
      if (actualOwner) return { ...context, recipientOwnerPubkey: context?.recipientOwnerPubkey ?? actualOwner, recipientDeviceOwnerPubkey: actualOwner, createdAt: context?.createdAt ?? now() };
      if (context) return context;
      for (const [recipientOwnerPubkey, record] of runtime?.getSessionUserRecords() ?? []) {
        if (record.devices.has(target) || record.appKeys?.getAllDevices().some(device=>device.identityPubkey===target)) return { recipientOwnerPubkey, createdAt: now() };
      }
      return context;
    };
    const observedAuthorization = new Map([[account.proof.id, account.proof]]);
    let observedAt = -1, authorizationOverflow = false;
    const observeAuthorization = event => {
      if (event.kind !== 37368 || event.pubkey !== account.owner || !event.tags.some(tag => tag[0] === 'type' && tag[1] === 'app_keys_roster_snapshot')) return;
      try {
        if (authorizationOverflow) throw new Error('Device approval limit reached.');
        if (!observedAuthorization.has(event.id) && observedAuthorization.size >= 64) { authorizationOverflow = true; throw new Error('Device approval limit reached.'); }
        observedAuthorization.set(event.id, event);
        const latest = selectSignerRoster([...observedAuthorization.values()], account.owner);
        if (!latest) return;
        for (const [id, older] of observedAuthorization) if (older.created_at < latest.created_at) observedAuthorization.delete(id);
        if (observedAuthorization.size > 64) throw new Error('Conflicting device approvals.');
        observedAt = Math.max(observedAt, event.created_at);
        if (observedAt >= latest.created_at) { authorizationChecked = !!AppKeys.fromEvent(latest).getDevice(runtime.getState().currentDevicePubkey); chatStatus = authorizationChecked ? 'ready' : 'revoked'; }
      } catch { authorizationChecked = false; chatStatus = 'pending'; }
      notify();
    };
    runtime = new NdrRuntime({ storage: privateStorage,
      nostrSubscribe: (filter, callback) => transport.subscribe([filter], { onEvent: event => {
        if (attempt !== generation) return;
        const wasAuthorized = authorizationChecked;
        observeAuthorization(event);
        Promise.resolve(callback(event)).then(() => {
          if (attempt === generation && status === 'ready' && authorizationChecked) {
            if (!wasAuthorized) void runtime.republishInvite().catch(report);
            void outbox.retry().catch(report); scheduleBackground();
          }
        }).catch(report);
      } }, { signal: controller.signal }).close,
      nostrFetch: async filter => (await transport.query([filter], { signal: controller.signal })).events,
      nostrSign: signing,
      nostrEnqueue: (event, id, context) => outbox.enqueue(event, id, publicationContext(event, context)),
      nostrPublish: (event, id, context) => outbox.publish(event, id, publicationContext(event, context)),
      onPublishError: report, appKeysFetchTimeoutMs: 6000, appKeysFastTimeoutMs: 1500,
    });
    runtime.onStateChange(() => { if (attempt === generation) notify(); });
    runtime.onDurableSessionEvent([14,7,15], async (rumor, from, meta) => {
      check(attempt);
      if(rumor.kind===7||rumor.kind===15){
        const sender=meta?.senderOwnerPubkey;if(!HEX.test(sender??''))return;
        const targets=rumor.tags.filter(t=>t[0]==='e').map(t=>t[1]);
        const selfPeer=rumor.tags.find(t=>t[0]==='p')?.[1]??[...conversations].find(([,messages])=>messages.some(message=>targets.includes(message.id)))?.[0];
        const peer=sender===account.owner?selfPeer:sender;
        if(!peer||!conversations.has(peer))return;
        const accepted=await controls.receive(rumor,sender,peer);
        for(const target of new Set(accepted.map(c=>c.target))){const message=conversations.get(peer)?.find(m=>m.id===target);if(message)await saveMessage(peer,message);}
        return;
      }
      const projection = messageProjection(rumor, from, meta, account.owner);
      if (isOrderMessage(rumor)) {
        // A transport/device key or a claimed JSON field never grants order roles.
        const sender = meta?.senderOwnerPubkey;
        const senderDevice=meta?.senderDevicePubkey??meta?.fromDeviceId;
        const accepted = projection && HEX.test(sender ?? '') ? await orders?.receive(rumor, sender, senderDevice) : null;
        if(accepted)await pruneOrderQueues();
        if (accepted && !accepted.location) {await saveMessage(projection.pubkey, { ...projection.message, orderId: accepted.orderId,context:orderContext(accepted.orderId),system:true });if(!projection.message.mine&&meta?.senderOwnerPubkey===projection.pubkey)await sendReceipt(projection.pubkey,[projection.message.id],'delivered').catch(report);}
        return;
      }
      if (projection) {
        const context=projection.message.context;
        if(context?.order_id&&!validOrderContext(context.order_id,projection.pubkey))delete projection.message.context;
        projection.message.orderId=projection.message.context?.order_id;
        await saveMessage(projection.pubkey, projection.message);
        if(!projection.message.mine&&meta?.senderOwnerPubkey===projection.pubkey)await sendReceipt(projection.pubkey,[projection.message.id],'delivered').catch(report);
      }
    });
    for (const key of await vault.list('market/messages/')) conversations.set(key.slice('market/messages/'.length), await vault.get<ChatMessage[]>(key));
    await runtime.initManagers();
    check(attempt);
    const manager = await runtime.initSessionManager(account.owner);
    const own = manager.getKnownAppKeysSnapshots().find(snapshot => snapshot.ownerPubkey === account.owner);
    if (own) await runtime.applyTrustedAppKeysSnapshot(own);
    await runtime.applyVerifiedAppKeysEvent(account.proof);
    for (const event of runtime.getKnownAppKeysEvents()) if (event.pubkey === account.owner) observedAuthorization.set(event.id, event);
    await runtime.initForOwner(account.owner);
    check(attempt);
    if (!justAuthorized) {
      try {
        const latest = await fetchSignerRoster(account.owner, getRelays(), controller.signal, transport);
        if (latest) { observeAuthorization(latest); await runtime.applyVerifiedAppKeysEvent(latest); }
        else if (!authorizationChecked) chatStatus = 'pending';
      } catch { if (!authorizationChecked) chatStatus = 'pending'; }
    }
    check(attempt); chatStatus = authorizationChecked ? 'ready' : chatStatus; notify();
    if (authorizationChecked && runtime.getState().isCurrentDeviceRegistered) {
      void runtime.republishInvite().catch(report);
      void outbox.retry().catch(report);
    }
    return state();
  };
  async function queuePublicEvents(events:VerifiedEvent[]) {
    requireReady();
    const attempt=generation,stored=events.map(event=>structuredClone(event));
    if(publicQueue.size+new Set(stored.filter(event=>!publicQueue.has(event.id)).map(event=>event.id)).size>128)throw new Error('Too many updates are waiting to sync.');
    // Persist the complete publication before exposing any member to the worker.
    await vault.putMany(stored.map(event=>[`market/public/${event.id}`,event] as const));
    check(attempt);for(const event of stored)publicQueue.set(event.id,event);
    notify();scheduleBackground();
    return stored.map(event=>({event:structuredClone(event),delivery:'queued',accepted:[]}));
  }
  async function queuePublic(event) { return (await queuePublicEvents([event]))[0]; }
  async function syncPublic() {
    if (syncing || status !== 'ready') return syncing;
    const attempt = generation, attempted = new Set();
    syncing = (async () => {
      for (const event of publicQueue.values()) {
        check(attempt); attempted.add(event.id);
        let receipt;
        try { receipt = await transport.publish(event,{signal:controller.signal}); } catch { check(attempt); continue; }
        check(attempt);
        if (!receipt.remoteAccepted) continue;
        if (event.kind===0 && (!account.profileEvent || event.created_at>=account.profileEvent.created_at)) {account.profileEvent=event;account.displayName=JSON.parse(event.content).display_name||JSON.parse(event.content).name;await vault.put('market/account',account);}
        await vault.del(`market/public/${event.id}`);check(attempt);publicQueue.delete(event.id);notify();
      }
    })().catch(()=>{}).finally(()=>{if(attempt===generation){syncing=undefined;notify();if([...publicQueue.keys()].some(id=>!attempted.has(id)))queueMicrotask(()=>void syncPublic());}});
    return syncing;
  }
  async function syncProfile() {
    if (syncingProfile || !profilePatch || !signer || status !== 'ready') return syncingProfile;
    const attempt = generation;
    syncingProfile = (async () => {
      if (profilePatch && signer) {
        const patch = profilePatch;
        const cached = account.profileEvent;
        const response = account.freshOwner && !cached ? {events:[],complete:true} : await transport.query([{kinds:[0],authors:[account.owner],limit:20}],{signal:controller.signal});
        check(attempt);
        const latest = [...response.events,...(cached?[cached]:[])].sort((a,b)=>b.created_at-a.created_at||a.id.localeCompare(b.id))[0];
        if (!latest && !response.complete) throw new Error('Profile update is waiting for a connection.');
        const previous = latest ? JSON.parse(latest.content) : {};
        if (!previous || typeof previous !== 'object' || Array.isArray(previous)) throw new Error('Existing profile is unreadable.');
        const created_at = Math.max(now(),(latest?.created_at??0)+1);
        if (created_at > now()+300) throw new Error('Profile update is dated too far ahead.');
        const event = await signing({kind:0,tags:[],created_at,content:JSON.stringify({...previous,name:patch.name,display_name:patch.name,...(patch.picture!==undefined?{picture:patch.picture}:{})})});
        await queuePublic(event); check(attempt);
        account.profileEvent=event; account.displayName=patch.name; await vault.put('market/account',account);
        if (profilePatch === patch) {await vault.del('market/profile-patch');check(attempt);profilePatch=undefined;}
      }
    })().catch(() => {}).finally(() => { if (attempt === generation) { syncingProfile = undefined; notify(); } });
    return syncingProfile;
  }
  async function activateChat() {
    if (activation || runtime || status !== 'ready') return activation;
    const attempt=generation;
    activation=(async()=>{
      if (account.freshOwner && !account.proof && account.mode==='local') {
        // A new identity has no older devices to discover. Its own signed proof
        // authorizes this device; server acknowledgement only confirms delivery.
        const draft=prepareSignerAuthorization(account.owner,getPublicKey(Uint8Array.from(account.deviceSecret)),null);
        const proof=validateSignerAuthorization(draft,await signing(draft));check(attempt);
        account={...account,proof,installed:true};await vault.put('market/account',account);check(attempt);
        await queuePublic(proof);await startRuntime({justAuthorized:true});
      } else if (!account.proof || account.installed===false) {
        if (!enrollmentSigner && account.mode==='extension') {
          const nip07=extension();if(nip07&&await nip07.getPublicKey()===account.owner){check(attempt);signer=enrollmentSigner=draft=>nip07.signEvent(draft);}
        }
        if (!enrollmentSigner) {chatStatus='pending';return;}
        const result=await authorizeSignerDevice({owner:account.owner,runtime:transport,relays:getRelays(),signal:controller.signal,
          signEvent:enrollmentSigner,freshOwner:account.freshOwner===true&&!account.proof,deviceSecret:Uint8Array.from(account.deviceSecret),
          onAuthorized:(event,device)=>{const info=enrollmentRemote?.linkInfo;if(info!==undefined&&(!info||info.v!==1||info.linkId!==enrollmentRemote.transportPubkey||info.device!==device||!HEX.test(info.approver)||!AppKeys.fromEvent(event).getDevice(info.approver)))throw new Error('Invalid device-link approval.');},
          onPrepared:async({event,deviceSecret})=>{check(attempt);account={...account,deviceSecret:Array.from(deviceSecret),proof:event};await vault.put('market/account',account);},
        });
        result.deviceSecret.fill(0);check(attempt);account.installed=true;await vault.put('market/account',account);
        enrollmentRemote?.close();enrollmentRemote=undefined;
        await startRuntime({justAuthorized:true});
      } else await startRuntime();
      check(attempt);
      for(const pubkey of conversations.keys())void runtime?.setupUser(pubkey).catch(report);
      void syncOrders();void syncControls();
    })().catch(()=>{if(attempt===generation&&status==='ready'){chatStatus='pending';notify();}}).finally(()=>{if(attempt===generation)activation=undefined;});
    return activation;
  }
  function scheduleBackground() {
    if(status!=='ready'||controller?.signal.aborted)return;
    void activateChat();void syncPublic();void syncProfile();void syncOrders();void syncControls();
    if(!retryTimer){retryTimer=setTimeout(()=>{retryTimer=undefined;scheduleBackground();},15000);retryTimer.unref?.();}
  }
  async function sendReceipt(peer:string,ids:string[],type:'delivered'|'seen'){
    if(!controls?.preferences()[type])return;
    const eligible=ids.filter(id=>{const message=conversations.get(peer)?.find(m=>m.id===id);return message&&!message.mine&&(message._chat?.sentReceipt!=='seen'&&(type==='seen'||message._chat?.sentReceipt!=='delivered'));}).slice(0,128);
    if(!eligible.length)return;await controls.receipt(peer,eligible,type);
    for(const id of eligible){const message=conversations.get(peer)?.find(m=>m.id===id);if(message)await saveMessage(peer,message);}
    queueMicrotask(()=>void syncControls());
  }
  async function syncControls(){
    if(syncingControls||!controls||!state().canSend)return syncingControls;
    const attempt=generation,book=controls,activeRuntime=runtime,attempted=new Set<string>();
    syncingControls=(async()=>{for(const job of book.jobs()){check(attempt);attempted.add(job.rumor.id);await activeRuntime.sendEvent(job.peer,job.rumor);check(attempt);await book.handed(job.rumor.id);}})().catch(report).finally(()=>{if(attempt===generation){syncingControls=undefined;if(book.jobs().some(job=>!attempted.has(job.rumor.id)))queueMicrotask(()=>void syncControls());}});
    return syncingControls;
  }
  async function syncOrders() {
    if(syncingOrders || !orders || !state().canSend)return syncingOrders;
    const attempt=generation,book=orders,activeRuntime=runtime,attempted=new Set();
    syncingOrders=(async()=>{
      await book.prune();await pruneOrderQueues();
      for(const job of book.jobs()){
        check(attempt);
        attempted.add(job.id);
        if(!book.canPublish(job.id))continue;
        if(job.handed){void activeRuntime.setupUser(job.recipient).catch(report);continue;}
        try{
          // The exact rumor was durably saved with the local order before this
          // background discovery/encryption step. Retries reuse its ID and tags.
          await activeRuntime.sendEvent(job.recipient,job.rumor);check(attempt);
          await book.handed(job.id);
          if(job.action!=='location')await saveMessage(job.recipient,{id:job.id,text:job.rumor.content,mine:true,createdAt:job.rumor.created_at,...(rumorMilliseconds(job.rumor)!==undefined?{createdAtMs:rumorMilliseconds(job.rumor)}:{}),delivery:book.jobs().some(item=>item.id===job.id)?'queued':'sent',orderId:job.orderId,context:orderContext(job.orderId),system:true});
        }catch{check(attempt);report();}
      }
    })().catch(()=>{}).finally(()=>{if(attempt===generation){syncingOrders=undefined;if(book.jobs().some(job=>!job.handed&&!attempted.has(job.id)))queueMicrotask(()=>void syncOrders());}});
    return syncingOrders;
  }
  async function openLocal() {
    const attempt=generation;
    account=await vault.get<AccountRecord>('market/account');check(attempt);
    if(!account||!HEX.test(account.owner))throw new Error('This profile could not be opened.');
    if(!account.deviceSecret){account.deviceSecret=Array.from(generateSecretKey());await vault.put('market/account',account);}
    if(!Array.isArray(account.deviceSecret)||account.deviceSecret.length!==32)throw new Error('This device key is unavailable.');
    if(account.mode==='local'){
      ownerSecret=Uint8Array.from(account.ownerSecret??[]);
      if(ownerSecret.length!==32||getPublicKey(ownerSecret)!==account.owner)throw new Error('This profile key is unavailable.');
      signer=enrollmentSigner=draft=>finalizeEvent(draft,ownerSecret);
    }
    controller??=new AbortController();transport??=transportFactory();
    controls=createChatControls({vault,owner:account.owner,device:getPublicKey(Uint8Array.from(account.deviceSecret)),check:()=>check(attempt)});await controls.load();check(attempt);
    conversations.clear();
    for(const key of await vault.list('market/messages/'))conversations.set(key.slice('market/messages/'.length),await vault.get<ChatMessage[]>(key));
    orders=createOrderBook({vault,developerMint,owner:account.owner,device:getPublicKey(Uint8Array.from(account.deviceSecret)),notify,check:()=>check(attempt)});
    await orders.load();check(attempt);
    for(const [peer,messages] of conversations)for(const message of messages)if(controls.pendingFor(peer,message.id).length)await saveMessage(peer,message);
    publicQueue=new Map();
    for(const key of await vault.list('market/public/')){const event=verifiedPrivateEvent(await vault.get(key));if(event&&event.pubkey===account.owner&&(publicAccountEvent(event)||(event.kind===37368&&event.id===account.proof?.id)))publicQueue.set(event.id,event);}
    profilePatch=await vault.get<{name:string;picture?:string}>('market/profile-patch');
    check(attempt);status='ready';error='';chatStatus='connecting';notify();scheduleBackground();
    if(account.mode==='extension'&&!signer){const nip07=extension();if(nip07)void nip07.getPublicKey().then(owner=>{if(attempt===generation&&owner===account.owner){signer=enrollmentSigner=draft=>nip07.signEvent(draft);notify();scheduleBackground();}}).catch(()=>{});}
    return state();
  }
  const authorize = async ({owner,mode,sign,password,localSecret,remote,freshOwner=false}:{owner:string;mode:AccountMode;sign:AccountSigner;password?:string;localSecret?:Uint8Array;remote?:RemoteSigner;freshOwner?:boolean;signal?:AbortSignal;onCommitting?:()=>void}) => {
    const attempt=generation;
    if(runtime||status==='ready')throw new Error('A profile is already open on this device.');
    transport?.close();transport=transportFactory();controller?.abort();controller=new AbortController();
    const existing=(await vault.status()).exists;check(attempt);
    if(existing){await vault.unlock(password);account=await vault.get<AccountRecord>('market/account');check(attempt);if(account?.owner!==owner)throw new Error('A different profile is saved on this device.');}
    else {account={owner,mode,installed:false,freshOwner,deviceSecret:Array.from(generateSecretKey()),...(localSecret?{ownerSecret:Array.from(localSecret)}:{})};await vault.create({'market/account':account},{password});}
    savedStatus=await vault.status();check(attempt);
    enrollmentSigner=sign;enrollmentRemote=remote;signer=mode==='linked'?undefined:sign;
    try{return await openLocal();}finally{localSecret?.fill(0);}
  };
  return {
    state,
    async restore() {
      const attempt = generation;
      savedStatus = await vault.status();
      check(attempt);
      if (!savedStatus.exists) return state();
      if (!savedStatus.password) return this.unlock();
      status = 'locked'; notify();
      return state();
    },
    async unlock(password?:string) {
      const attempt = generation;
      await vault.unlock(password);
      check(attempt);
      account = await vault.get<AccountRecord>('market/account');
      return openLocal();
    },
    async createAccount({ password }:{password?:string} = {}) {
      let key;
      if ((await vault.status()).exists) {
        await vault.unlock(password); const pending = await vault.get<AccountRecord>('market/account');
        if (pending?.installed !== false || pending.mode !== 'local') throw new Error('An account already exists on this device.');
        key = Uint8Array.from(pending.ownerSecret);
      } else key = generateSecretKey();
      return authorize({ owner: getPublicKey(key), mode: 'local', sign: draft => finalizeEvent(draft, key), password, localSecret: key, freshOwner: !(await vault.status()).exists });
    },
    async loginWithKey({ key, password }:{key?:string|Uint8Array;password?:string} = {}) {
      const bytes = secretBytes(key);
      return authorize({ owner: getPublicKey(bytes), mode: 'local', sign: draft => finalizeEvent(draft, bytes), password, localSecret: bytes });
    },
    async loginWithExtension({ password }:{password?:string} = {}) {
      const attempt = generation;
      const nip07 = extension();
      if (!nip07) throw new Error('Install or enable a Nostr signer extension.');
      const owner = await nip07.getPublicKey();
      check(attempt);
      if (!HEX.test(owner)) throw new Error('Invalid account from signer.');
      return authorize({ owner, mode: 'extension', sign: draft => nip07.signEvent(draft), password });
    },
    async loginWithSigner({ password, bunkerLink, signal = new AbortController().signal, onConnectionLink, onAuthUrl, onCommitting }:SignerLoginOptions = {}) {
      const attempt = generation;
      const signerTransport = transportFactory();
      const remote = new RemoteSigner({ runtime: signerTransport, relays: getRelays(), bunkerLink, signal, onConnectionLink, onAuthUrl, onClose: () => signerTransport.close() });
      try {
        const owner = await remote.connect();
        check(attempt);
        return await authorize({ owner, mode: 'linked', sign: draft => remote.signEvent(draft), remote, password, signal, onCommitting });
      } catch(cause) {remote.close();signerTransport.close();throw cause;}
    },
    async reconnect() {
      requireReady();
      generation++; controller?.abort();
      const closing = outbox?.close(); runtime?.close(); transport?.close();
      await closing; await messageWrites; await vault.flush();
      ownerSecret?.fill(0); runtime = outbox = transport = ownerSecret = undefined;
      await orders?.flush();await controls?.flush();controls=undefined;syncingControls=undefined;orders=undefined;syncingOrders=undefined;
      authorizationChecked = false; conversations.clear();activation=syncing=syncingProfile=undefined;clearTimeout(retryTimer);retryTimer=undefined;controller=undefined;signer=enrollmentSigner=undefined;
      return openLocal();
    },
    async connectExtensionSigner() {
      requireReady();
      const nip07 = extension();
      if (!nip07 || await nip07.getPublicKey() !== account.owner) throw new Error('Choose the same account in your Nostr signer.');
      postingRemote?.close(); postingTransport?.close();
      signer = draft => nip07.signEvent(draft); notify(); return state();
    },
    async connectPostingSigner({ bunkerLink, signal = new AbortController().signal, onConnectionLink, onAuthUrl }:SignerLoginOptions = {}) {
      requireReady();
      const attempt = generation, owner = account.owner;
      const channel = transportFactory();
      let remote;
      remote = new RemoteSigner({ runtime: channel, relays: getRelays(), bunkerLink, signal, onConnectionLink, onAuthUrl,
        permissions: ['sign_event:0', 'sign_event:3', 'sign_event:30402', 'sign_event:30406', 'sign_event:7368', 'sign_event:24242'], timeoutMs: 15 * 60_000,
        onClose: () => {
          channel.close();
          if (postingRemote === remote) { postingRemote = postingTransport = undefined; signer = undefined; notify(); }
        },
      });
      try {
        if (await remote.connect() !== owner) throw new Error('Choose the same account in your Nostr signer.');
        check(attempt);
        postingRemote?.close(); postingTransport?.close();
        postingRemote = remote; postingTransport = channel;
        signer = draft => remote.signEvent(draft); notify(); return state();
      } catch (cause) { remote.close(); channel.close(); throw cause; }
    },
    async open(pubkey) {
      requireReady();
      if (!HEX.test(pubkey)) throw new Error('Invalid person.');
      if (!conversations.has(pubkey)) { await vault.put(`market/messages/${pubkey}`, []); conversations.set(pubkey, []); notify(); }
      if(runtime)void runtime.setupUser(pubkey).catch(report);
      return state().conversations.find(item => item.pubkey === pubkey);
    },
    async send(pubkey, text, context?:MessageContext) {
      requireReady();
      if (!state().canSend) throw new Error('This device is not authorized to send.');
      if (!HEX.test(pubkey) || typeof text !== 'string' || !text.trim() || text.length > 16_000) throw new Error('Write a message of up to 16,000 characters.');
      if(context&&(!validMessageContext(context)||context.order_id&&!validOrderContext(context.order_id,pubkey)))throw new Error('This order is not shared with this person.');
      if(!conversations.has(pubkey)){await vault.put(`market/messages/${pubkey}`,[]);conversations.set(pubkey,[]);}
      lastChatMs=Math.max(Date.now(),lastChatMs+1,...(conversations.get(pubkey)??[]).filter(message=>message.mine).map(message=>messageMilliseconds(message)+1));
      const rumor = await runtime.sendMessage(pubkey, text, {tags:[...contextTags(context),['ms',String(lastChatMs)]]});
      const diagnostics = await runtime.queuedMessageDiagnostics(rumor.id);
      await saveMessage(pubkey, { id: rumor.id, text, context,orderId:context?.order_id,mine: true, createdAt: rumor.created_at,...(rumorMilliseconds(rumor)!==undefined?{createdAtMs:rumorMilliseconds(rumor)}:{}), delivery: diagnostics.some(entry=>entry.ownerPubkey===pubkey) ? 'queued' : 'sent' });
      return rumor.id;
    },
    async react(peer:string,messageId:string,emoji:string){
      requireReady();if(!state().canSend)throw Error('This device is not authorized to send.');
      const message=conversations.get(peer)?.find(m=>m.id===messageId);if(!message)throw Error('Message not found in this conversation.');
      await controls.reaction(peer,message,emoji);await saveMessage(peer,message);scheduleBackground();
    },
    async markSeen(peer:string,messageIds:string[]){requireReady();if(!HEX.test(peer)||!Array.isArray(messageIds)||messageIds.length>128)throw Error('Choose visible messages in this conversation.');await sendReceipt(peer,messageIds,'seen');},
    async setReceiptPreferences(patch:Partial<ReceiptPreferences>){requireReady();await controls.setPreferences(patch);notify();},
    async requestOrder(listing:OrderListing, options?:{quantity?:number;note?:string;deliveryRequest?:DeliveryRequest}) { requireReady();const order=await orders.request(listing,options);scheduleBackground();return order; },
    async requestDelivery(sourceOrderId:string, serviceListing:OrderListing, destination:DeliveryPlace) { requireReady();const order=await orders.requestDelivery(sourceOrderId,serviceListing,destination);scheduleBackground();return order; },
    async updateOrder(id:string, patch:OrderPatch) { requireReady();const order=await orders.update(id,patch);await pruneOrderQueues();scheduleBackground();return order; },
    async archiveOrder(id, archived=true) { requireReady();return orders.archive(id,archived); },
    inviteUrl() { requireChat(); const invite = Invite.deserialize(runtime.getDelegateManager().getInvite().serialize()); invite.ownerPubkey = account.owner; return invite.getUrl(invitationBase(undefined)); },
    async acceptInvite(url) { requireChat(); const invite = Invite.fromUrl(url); if (invite.metadataPrivacyVersion !== 2) throw new Error('Ask for a new chat invitation.'); const result = await runtime.acceptInvite(invite); await this.open(result.ownerPublicKey); return result.ownerPublicKey; },
    async revokeDevice(pubkey) {
      requireChat();
      if (!signer) throw new Error('Use your account signer to remove a device.');
      const previous = await fetchSignerRoster(account.owner, getRelays(), controller.signal, transport);
      if (!previous) throw new Error('Could not confirm the device list.');
      const keys = AppKeys.fromEvent(previous);
      if (!keys.getDevice(pubkey)) throw new Error('This device is already removed.');
      keys.removeDevice(pubkey);
      const draft = keys.getEvent({ ownerPubkey: account.owner, createdAt: Math.max(now(), previous.created_at + 1) });
      draft.pubkey = account.owner;
      const signed = validateSignerAuthorization(draft, await signing(draft));
      const latest = await fetchSignerRoster(account.owner, getRelays(), controller.signal, transport);
      if (latest?.id !== previous.id) throw new Error('Your device list changed. Try again.');
      const receipt = await transport.publish(signed, { signal: controller.signal });
      if (!receipt.remoteAccepted) throw new Error('Could not remove this device.');
      await runtime.applyVerifiedAppKeysEvent(signed); notify();
    },
    signEvent: signing,
    async publishSignedEvent(raw) {
      requireReady();
      const event = verifiedPrivateEvent(raw);
      if (!event || event.pubkey !== account.owner || !publicAccountEvent(event)) throw new Error('Invalid public account event.');
      return queuePublic(event);
    },
    async publishSignedEvents(raws) {
      requireReady();
      if(!Array.isArray(raws)||!raws.length||raws.length>2)throw new Error('Invalid publication.');
      const events=raws.map(raw=>verifiedPrivateEvent(raw));
      if(events.some(event=>!event||event.pubkey!==account.owner||!publicAccountEvent(event)))throw new Error('Invalid public account event.');
      return queuePublicEvents(events);
    },
    async publishEvent(draft) { return this.publishSignedEvent(await signing(draft)); },
    async updateProfile({ name, picture }:{name?:string;picture?:string} = {}) {
      requireReady();
      if (typeof name !== 'string' || !name.trim() || name.length > 80) throw new Error('Choose a name of up to 80 characters.');
      if (picture) { const url = new URL(picture); if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Use a secure profile photo URL.'); }
      const patch={name:name.trim(),...(picture!==undefined?{picture}:{})};
      const attempt=generation;await vault.put('market/profile-patch',patch);check(attempt);profilePatch=patch;notify();scheduleBackground();
      return {delivery:'queued',accepted:[]};
    },
    exportKey() { if (!ownerSecret) throw new Error('Your account key is held by your signer.'); return nip19.nsecEncode(ownerSecret); },
    async lock() {
      generation++; clearTimeout(retryTimer);retryTimer=undefined;enrollmentRemote?.close();enrollmentRemote=undefined;activation=syncing=syncingProfile=undefined; postingRemote?.close(); postingTransport?.close(); postingRemote = postingTransport = undefined; controller?.abort(); const closing = outbox?.close(); runtime?.close(); transport?.close();
      await closing;
      await messageWrites; await orders?.flush();await controls?.flush(); await vault.flush(); vault.lock();
      ownerSecret?.fill(0); account = runtime = transport = outbox = signer = ownerSecret = undefined;
      conversations.clear();lastChatMs=0;controls=undefined;syncingControls=undefined;orders=undefined;syncingOrders=undefined;publicQueue.clear();profilePatch=undefined;enrollmentSigner=undefined;controller=undefined;authorizationChecked = false;status='locked';chatStatus='connecting';error='';notify();
    },
    async destroy() { await this.lock(); },
  };
}
