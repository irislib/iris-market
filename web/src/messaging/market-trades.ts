import {getEventHash} from 'nostr-tools';
import {sha256} from '@noble/hashes/sha2.js';
import {bytesToHex} from '@noble/hashes/utils.js';
import type {Rumor} from 'nostr-double-ratchet';
import '../../../shared/escrow/trade.js';
import type {Vault} from './vault.ts';

export const TRADE_TAG = 'iris-market/escrow-trade';
const legacyStore = 'market/private-trade-tools/v1';
const maxStep = 64 * 1024, maxPendingStep = 4 * 1024;
const maxRows = 2048, maxPendingRows = 128, maxJobs = 256;
const actions = new Set(['invite', 'join', 'approve', 'funded', 'payout', 'cosign', 'settled', 'dispute', 'rated']);
const dealStrings = ['listing_id', 'revision', 'title', 'maker', 'taker', 'buyer', 'seller', 'funder', 'beneficiary', 'provider', 'mint'];
const now = () => Math.floor(Date.now() / 1000);
const utf8 = new TextEncoder();
const isId = (value:unknown):value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = (value:unknown):value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
type Step = {v:1; trade_id:string; action:string; [name:string]:unknown};
type Row = {id:string; peer:string; mine:boolean; created_at:number; step:Step; operation_id:string};
type Job = {peer:string; rumor:Rumor; expires?:number};
type Data = {v:1; rows:Row[]; jobs:Job[]};
type Deal = {buyer:string; seller:string; provider:string; taker:string; funder:string; beneficiary:string};
const protocol = (globalThis as unknown as {IrisEscrow:{
  hash(value:unknown):Promise<string>;canonical(value:unknown):string;validateDeal(value:unknown):Deal;
}}).IrisEscrow;
const initial = ():Data => ({v:1, rows:[], jobs:[]});

function shallowJson(value:unknown, depth = 0):boolean {
  if (!value || typeof value !== 'object') return true;
  return depth < 24 && Object.values(value).every(child => shallowJson(child, depth + 1));
}

function parseStep(payload:unknown):Step | undefined {
  if (typeof payload !== 'string' || payload.length > maxStep || utf8.encode(payload).length > maxStep) return;
  try {
    const step = JSON.parse(payload);
    if (object(step) && shallowJson(step) && step.v === 1 && isId(step.trade_id) && typeof step.action === 'string' && actions.has(step.action)) return step as Step;
  } catch { /* Malformed data from a peer is not a trade message. */ }
}

function invitation(step:Step, actor:string, owner:string):Deal | undefined {
  if (step.action !== 'invite') return;
  try {
    const deal = protocol.validateDeal(step.deal);
    if (actor === deal.taker && [deal.buyer, deal.seller, deal.provider].includes(owner)) return deal;
  } catch { /* Only complete invitations from their taker can pin a trade. */ }
}

// Only an authenticated recipient receipt corroborated by another signer gets an inbox hint.
function receiptHints(rows:Row[], owner:string) {
  const approved=new Map<string,string>(), observed=new Set<string>(),receipts=new Set<string>();
  for(const r of rows){
    const s=r.step;
    if(!isId(s.deal_hash)||!isId(s.terms_hash))continue;
    const key=s.trade_id+s.deal_hash, actor=r.mine?owner:r.peer;
    if(r.mine&&s.action==='approve')approved.set(key,s.terms_hash);
    if(s.action==='settled')receipts.add(s.trade_id);
    const direction=s.direction==='refund'||s.direction==='release'?s.direction:'';
    observed.add([key,s.terms_hash,s.action,actor,direction].join('/'));
  }
  return (r:Row) => {
    if(!receipts.has(r.step.trade_id))return;
    const d=invitation(r.step,r.mine?owner:r.peer,owner);if(!d)return;
    const key=r.step.trade_id+bytesToHex(sha256(utf8.encode(protocol.canonical(r.step.deal)))), terms=approved.get(key);
    if(!terms)return;
    const has=(action:string,actor:string,direction='')=>observed.has([key,terms,action,actor,direction].join('/'));
    if(!has('funded',d.funder))return;
    for(const direction of ['release','refund']){
      const payee=direction==='release'?d.beneficiary:d.funder, other=direction==='release'?d.funder:d.beneficiary;
      const second=has('cosign',other,direction)||(has('cosign',d.provider,direction)&&(has('dispute',d.buyer)||has('dispute',d.seller)));
      if(second && has('payout',payee,direction) && has('settled',payee,direction))return direction;
    }
  };
}

function summary(row:Row,receipt:(row:Row)=>string|undefined):Row {
  const step:Step = {v:1, trade_id:row.step.trade_id, action:row.step.action};
  if (step.action === 'invite' && object(row.step.deal)) {
    const value = row.step.deal, deal:Record<string, string | number> = {};
    for (const field of dealStrings) {
      const text = value[field];
      if (typeof text === 'string' && utf8.encode(text).length <= 2048) deal[field] = text;
    }
    if (typeof value.sats === 'number' && Number.isSafeInteger(value.sats) && value.sats > 0 && value.sats <= 1e12) deal.sats = value.sats;
    step.deal = deal;
    const outcome=receipt(row);if(outcome)step.outcome=outcome;
  }
  return {id:row.id, peer:row.peer, mine:row.mine, created_at:row.created_at, operation_id:row.operation_id, step};
}

function validRecord(row:Row) {
  return row && isId(row.id) && isId(row.peer) && isId(row.operation_id) && typeof row.mine === 'boolean'
    && Number.isSafeInteger(row.created_at) && row.created_at >= 0 && object(row.step) && row.step.v === 1
    && isId(row.step.trade_id) && actions.has(row.step.action);
}

function readRumor(rumor:Rumor, sender:string, senderDevice:string, owner:string) {
  const tags = rumor.tags.filter(tag => tag[0] === TRADE_TAG), recipients = rumor.tags.filter(tag => tag[0] === 'p');
  const tag = tags[0];
  if (rumor.kind !== 14 || tags.length !== 1 || tag.length !== 4 || tag[1] !== '1' || !isId(tag[2])
      || recipients.length !== 1 || recipients[0][1] !== owner || !isId(sender) || sender === owner
      || !isId(senderDevice) || ![senderDevice, sender].includes(rumor.pubkey) || !isId(rumor.id)
      || !Number.isSafeInteger(rumor.created_at) || rumor.created_at < 0 || rumor.created_at > now() + 300) return;
  const step = parseStep(tag[3]);
  if (!step || getEventHash(rumor) !== rumor.id) return;
  return {row:{id:rumor.id, peer:sender, mine:false, created_at:rumor.created_at, operation_id:tag[2], step}, size:utf8.encode(tag[3]).length};
}

export function createMarketTrades(vault:Vault, owner:string, device:string, check:()=>void) {
  const store = legacyStore + '/' + owner;
  let data = initial(), writes = Promise.resolve();
  let legacyRemainder:Data | undefined;
  function serial<T>(fn:()=>Promise<T>) {
    const op = writes.then(() => { check(); return fn(); });
    writes = op.then(() => {}, () => {});
    return op;
  }
  async function save(next:Data) {
    check();
    // Move the old book on the first mutation without duplicating a wallet-sized journal.
    if (legacyRemainder) await vault.putMany([[store, next], [legacyStore, legacyRemainder]]);
    else await vault.put(store, next);
    check();
    legacyRemainder = undefined;
    data = next;
  }
  async function admit(row:Row, size:number) {
    const {step, peer} = row;
    if (data.rows.some(r => !r.mine && r.peer === peer && r.operation_id === row.operation_id)) return;
    const history = data.rows.filter(r => r.step.trade_id === step.trade_id);
    if (step.action === 'invite' && !invitation(step, peer, owner)) return;

    const join = history.find(r => r.mine && r.step.action === 'join');
    if (join) {
      let pinned:Deal | undefined;
      for (const record of history) {
        const deal = invitation(record.step, record.mine ? owner : record.peer, owner);
        if (deal && await protocol.hash(deal) === join.step.deal_hash) { pinned = deal; break; }
      }
      if (!pinned || ![pinned.buyer, pinned.seller, pinned.provider].includes(peer)) return;
      const digest = step.action === 'invite' ? await protocol.hash(step.deal) : step.deal_hash;
      if (digest !== join.step.deal_hash || step.action === 'funded' && peer !== pinned.funder) return;
    } else if (!['invite','join'].includes(step.action) || size > maxPendingStep) return;

    // Two conflicting values are sufficient to warn participants. Arbitrary direction strings cannot create new buckets.
    const variants = history.filter(r => !r.mine && r.peer === peer && r.step.action === step.action
      && (r.step.direction === 'refund') === (step.direction === 'refund'));
    if (variants.length >= 2) return;
    const digest = variants.length ? await protocol.hash(step) : undefined;
    for (const previous of variants) if (await protocol.hash(previous.step) === digest) return;

    const joined = new Set(data.rows.filter(r => r.mine && r.step.action === 'join').map(r => r.step.trade_id));
    const pending = data.rows.filter(r => !r.mine && !joined.has(r.step.trade_id));
    let rows = data.rows;
    if ((!join && pending.length >= maxPendingRows) || rows.length >= maxRows) {
      // Evict by local arrival order. Peer-controlled timestamps must never protect unsolicited rows.
      if (!pending.length) return;
      rows = rows.filter(r => r !== pending[0]);
    }
    await save({...data, rows:[...rows, row]});
  }
  return {
    load() {
      return serial(async () => {
        let stored = await vault.get<Data>(store), useLegacy = false;
        // Unscoped journals in older wallets belong to the owner recorded in the same encrypted vault.
        if (!stored && (await vault.get<{owner?:string}>('market/account'))?.owner === owner) {
          stored = await vault.get<Data>(legacyStore);
          useLegacy = !!stored;
        }
        if (stored && (stored.v !== 1 || !Array.isArray(stored.rows) || stored.rows.length > maxRows
            || !stored.rows.every(validRecord) || !Array.isArray(stored.jobs) || stored.jobs.length > maxJobs
            || !stored.jobs.every(job => job && isId(job.peer) && isId(job.rumor?.id)))) throw Error('The saved private trade journal is invalid.');
        check();
        if (useLegacy) {
          // Older app versions shared this storage key with other private request types.
          const isTrade = (job:Job) => job.rumor.tags?.some(tag => tag[0] === TRADE_TAG);
          legacyRemainder = {...stored, rows:[], jobs:stored.jobs.filter(job => !isTrade(job))};
          data = {v:1, rows:stored.rows, jobs:stored.jobs.filter(isTrade)};
        } else {
          legacyRemainder = undefined;
          data = stored ?? initial();
        }
      });
    },
    rows(privateView:boolean) { if(privateView)return structuredClone(data.rows);const receipt=receiptHints(data.rows,owner);return data.rows.map(r=>summary(r,receipt)); },
    jobs:() => structuredClone(data.jobs),
    flush:() => writes,
    handed(id:string) {
      return serial(async () => {
        const jobs = data.jobs.filter(job => job.rumor.id !== id);
        if (jobs.length !== data.jobs.length) await save({...data, jobs});
      });
    },
    async receive(rumor:Rumor, sender:string, senderDevice:string) {
      if (!Array.isArray(rumor?.tags) || !rumor.tags.some(tag => Array.isArray(tag) && tag[0] === TRADE_TAG)) return false;
      let candidate:ReturnType<typeof readRumor>;
      try { candidate = readRumor(rumor, sender, senderDevice, owner); } catch { return true; }
      if (candidate) await serial(() => admit(candidate.row, candidate.size));
      return true;
    },
    async send(peers:string[], input:Step, operationId:string) {
      const payload = JSON.stringify(input), step = parseStep(payload);
      if (!step || !isId(operationId) || !Array.isArray(peers) || peers.length < 1 || peers.length > 2
          || new Set(peers).size !== peers.length || peers.some(p => !isId(p) || p === owner || p === device)) throw Error('Invalid escrow action or recipients.');
      const recipients = [...peers];
      await serial(async () => {
        const previous = data.rows.filter(r => r.mine && r.operation_id === operationId);
        if (previous.length) {
          const digest = await protocol.hash(step);
          if (previous.length !== recipients.length || !previous.every(r => recipients.includes(r.peer))
              || await protocol.hash(previous[0].step) !== digest) throw Error('This action already belongs to a different trade.');
          return;
        }
        if (data.rows.length + recipients.length > maxRows || data.jobs.length + recipients.length > maxJobs) throw Error('Your private trade queue is full.');
        const next = {v:1 as const, rows:[...data.rows], jobs:[...data.jobs]};
        for (const peer of recipients) {
          const wire = {kind:14, pubkey:device, created_at:now(), content:'Private escrow update',
            tags:[['p',peer], ['ms',String(Date.now())], [TRADE_TAG,'1',operationId,payload]]};
          const rumor = {...wire, id:getEventHash(wire)};
          next.jobs.push({peer, rumor});
          next.rows.push({id:rumor.id, peer, mine:true, created_at:rumor.created_at, operation_id:operationId, step});
        }
        await save(next);
      });
    },
  };
}
