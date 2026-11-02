import {nip19} from 'nostr-tools'
import {element} from './dom.ts'
import {listingURL} from './routes.ts'
import {matchCandidates,type MatchAction,type MatchView} from './private-matches.ts'

export function setupPrivateMatches(api,getListings){
  const section=element('details',undefined,'settings-section')
  section.append(element('summary','Private matching'))
  const label=element('label','Find a match privately','checkbox-label'),toggle=element('input')
  toggle.type='checkbox';label.prepend(toggle)
  const open=element('button','Open private matching'),settingsError=element('p',undefined,'error')
  section.append(label,element('p','Keep pending offers and requests with a helper you choose for up to seven days.'),open,settingsError)
  document.querySelector('#preferences-dialog')?.append(section)
  const dialog=element('dialog'),body=element('div'),error=element('p',undefined,'error'),rows=element('div')
  const close=element('button','Close');close.onclick=()=>dialog.close()
  const helper=element('input'),text=element('input'),side=element('select')
  helper.placeholder='Helper’s npub or public key';helper.setAttribute('aria-label','Helper')
  text.placeholder='Shareable summary';text.maxLength=200;text.setAttribute('aria-label','Shareable summary')
  for(const [value,name] of [['offer','I’m offering'],['request','I’m looking for']]){
    const opt=element('option',name);opt.value=value;side.append(opt)
  }
  side.setAttribute('aria-label','Offer or request')
  const share=element('button','Share privately');share.onclick=async()=>{
    try{
      const raw=helper.value.trim(),decoded=raw.startsWith('npub1')?nip19.decode(raw):null
      const pubkey=decoded?.type==='npub'?decoded.data:raw
      if(await act({op:'share',helper:pubkey,side:side.value as 'offer'|'request',summary:text.value}))text.value=''
    }catch{error.textContent='Enter the helper’s public key.'}
  }
  body.append(element('h2','Find a match privately'),close,element('p','Your helper stores your entry locally and may share this summary privately when checking interest. Leave contact details out of it.'),helper,side,text,share,error,rows)
  dialog.append(body);document.body.append(dialog)
  let selected='',busy=false
  async function act(action:MatchAction,listing?){
    if(busy)return false
    busy=true;error.textContent='';settingsError.textContent=''
    try{await api.messaging.privateMatch(action,listing);return true}
    catch(e){(dialog.open?error:settingsError).textContent=e instanceof Error?e.message:'Could not save this change.';return false}
    finally{busy=false;sync()}
  }
  function action(title:string,fn:()=>void){const button=element('button',title);button.type='button';button.onclick=fn;return button}
  function render(v:MatchView){
    rows.replaceChildren()
    const add=(parent:HTMLElement,caption:string,...children:HTMLElement[])=>{
      const row=element('div',undefined,'settings-section');row.append(element('p',caption),...children);parent.append(row);return row
    }
    const until=(at:number)=>new Date(at*1000).toLocaleDateString()
    for(const entry of Object.values(v.sent))add(rows,`Pending with your helper · ${entry.summary} · expires ${until(entry.expires_at)}`,action('Withdraw',()=>void act({op:'withdraw',entry:entry.id})))
    for(const entry of Object.values(v.received)){
      const row=add(rows,`${entry.side==='offer'?'Private offer':'Private request'} · ${entry.summary} · expires ${until(entry.expires_at)}`,action('Find matches',()=>{selected=entry.id;render(v)}))
      if(selected!==entry.id)continue
      const inventory=getListings(),candidates=matchCandidates(v,entry.id,inventory)
      if(!candidates.length)row.append(element('p','No matching offers or requests yet.'))
      for(const c of candidates){
        const choose=c.kind==='private'?()=>act({op:'suggest',left:entry.id,right:c.id}):()=>act({op:'send_public',entry:entry.id,listing:c.id},inventory.find(l=>l.id===c.id))
        add(row,c.summary,action(c.kind==='private'?'Ask both privately':'Send public listing privately',()=>void choose()))
      }
    }
    for(const [proposal,p] of Object.entries(v.pairs)){
      const names=p.entries.map(id=>v.received[id]?.summary).join(' ↔ ')
      const ready=p.votes.every(v=>v===true)
      add(rows,`${names} · ${p.introduced?'Introduced':p.votes.includes(false)?'Declined':ready?'Both agreed':'Awaiting replies'}`,...(ready&&!p.introduced?[action('Introduce privately',()=>void act({op:'introduce',proposal}))]:[]))
    }
    for(const [proposal,p] of Object.entries(v.interests)){
      const buttons:HTMLButtonElement[]=[]
      if(p.vote===null)for(const [title,accept] of [['Agree to introduction',true],['Decline',false]] as const)buttons.push(action(title,()=>void act({op:'vote',proposal,accept})))
      if(p.contact)buttons.push(action('Open private chat',()=>{dialog.close();api.openChat(p.contact)}))
      add(rows,`Possible match · ${p.summary}. ${p.contact?'You have been introduced.':p.vote===null?'If both agree, your helper can share your messaging identity with the other person.':p.vote?'You agreed.':'You declined.'}`,...buttons)
    }
    for(const lead of Object.values(v.public_leads)){
      const id=lead.listing.replace(/^30402:/,'')
      const link=element('a','Open public listing')
      try{link.href=listingURL(id)}catch{continue}
      add(rows,lead.title,link)
    }
  }
  function sync(){
    const v=api.messaging.privateMatchView();toggle.checked=!!v
    toggle.disabled=api.state().status!=='ready';open.hidden=!v
    if(dialog.open){if(v)render(v);else dialog.close()}
  }
  toggle.onchange=()=>void act({op:'enable',enabled:toggle.checked})
  dialog.addEventListener('close',()=>{
    selected='';helper.value='';text.value='';error.textContent='';rows.replaceChildren()
  })
  open.onclick=()=>{selected='';error.textContent='';dialog.showModal();sync()}
  api.onState(sync);sync()
}
