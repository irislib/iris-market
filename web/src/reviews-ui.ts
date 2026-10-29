import {element} from './dom.ts';
import {getEventHash} from 'nostr-tools/pure';
import {createUserRow} from './people.ts';
import {buildReviewDraft,cachedReviews,effectiveReviews,loadReviews,mergeReviews,parseReview,rememberReview,reviewSummary} from './reviews.ts';
import type {PublishReview,Review,ReviewAccount,ReviewQuery} from './reviews.ts';

export interface ReviewSummaryView {label:string;count:number}
interface ReviewPanelOptions {
  target:string;query?:ReviewQuery;getAccount?:()=>ReviewAccount;publish?:PublishReview;preview?:boolean;
  onSignIn?:()=>void;onProfile?:(pubkey:string)=>void;onSummary?:(summary:ReviewSummaryView)=>void;
}

/** The form stays mounted through profile metadata refreshes and tab changes. */
export function setupProfileReviews({target,query,getAccount=()=>({canSign:false}),publish,preview=false,onSignIn=()=>{},onProfile=()=>{},onSummary=()=>{}}:ReviewPanelOptions) {
  const panel=element('section',undefined,'profile-reviews'),header=element('div',undefined,'review-header');
  const summary=element('p','', 'review-summary'),write=element('button','Write review','button secondary');write.type='button';
  header.append(element('h2','Reviews'),write);
  const notice=element('p','','small muted');notice.setAttribute('role','status');
  const retry=element('button','Refresh','text-button');retry.type='button';retry.hidden=true;
  const list=element('div',undefined,'review-list'),form=element('form',undefined,'review-form');form.hidden=true;
  const publicNote=element('p','Your rating and review will be public.','review-public-note small');
  const stars=element('fieldset',undefined,'review-rating'),legend=element('legend','Rating');stars.append(legend);
  const starRow=element('div');starRow.setAttribute('role','radiogroup');starRow.setAttribute('aria-label','Rating');stars.append(starRow);
  let selectedRating=0;
  const ratingButtons:Array<HTMLButtonElement>=[];
  const setRating=(rating:number)=>{selectedRating=rating;for(const [index,button] of ratingButtons.entries()){button.textContent=index<rating?'★':'☆';button.setAttribute('aria-checked',String(index+1===rating));button.tabIndex=index+1===(rating||1)?0:-1;}submit.disabled=busy||!rating;};
  for(let rating=1;rating<=5;rating++){
    const button=element('button','☆');button.type='button';button.setAttribute('role','radio');button.setAttribute('aria-label',`${rating} ${rating===1?'star':'stars'}`);
    button.setAttribute('aria-checked','false');button.tabIndex=rating===1?0:-1;
    button.onclick=()=>setRating(rating);
    button.onkeydown=event=>{if(!['ArrowRight','ArrowLeft','ArrowUp','ArrowDown','Home','End'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?1:event.key==='End'?5:(rating-1+(['ArrowRight','ArrowUp'].includes(event.key)?1:-1)+5)%5+1;setRating(next);ratingButtons[next-1].focus();};
    ratingButtons.push(button);starRow.append(button);
  }
  const label=element('label','Review (optional)');label.htmlFor='profile-review-body';
  const text=element('textarea');text.id='profile-review-body';text.rows=4;text.maxLength=3000;
  const error=element('p','','error small');error.setAttribute('role','alert');
  const submit=element('button','Publish review','button primary');submit.type='submit';submit.disabled=true;
  const cancel=element('button','Cancel','text-button');cancel.type='button';cancel.onclick=()=>{form.hidden=true;error.textContent='';};
  const actions=element('div',undefined,'profile-actions');actions.append(submit,cancel);form.append(publicNote,stars,label,text,error,actions);
  panel.append(header,summary,notice,retry,form,list);
  let reviews:Review[]=[],closed=false,busy=false,formOwner:string|undefined;
  let loadController:AbortController|undefined,loading:Promise<void>|undefined,reloadAfter=false;
  let pendingKey='',accountOwner:string|undefined;
  const ownReview=(owner:string|undefined)=>effectiveReviews(reviews).find(review=>review.author===owner);
  const summaryState=():ReviewSummaryView=>{
    const value=reviewSummary(reviews);
    return {count:value.count,label:value.count?`★ ${value.average.toFixed(1)} · ${value.count} ${value.count===1?'review':'reviews'}`:'0 reviews'};
  };
  function draw(){
    const account=getAccount(),value=summaryState();summary.textContent=value.label;onSummary(value);
    write.hidden=preview||account.owner===target;write.disabled=busy;write.textContent=ownReview(account.owner)?'Edit review':'Write review';
    list.replaceChildren();
    for(const review of effectiveReviews(reviews)){
      const card=element('article',undefined,'review-card'),identity=element('div',undefined,'review-header');
      identity.append(createUserRow(review.author,{size:32,className:'review-author',onClick:()=>onProfile(review.author)}));
      const date=element('time',new Date(review.updatedAt*1000).toLocaleDateString(), 'muted small');date.dateTime=new Date(review.updatedAt*1000).toISOString();identity.append(date);
      const rating=element('span','★'.repeat(review.rating)+'☆'.repeat(5-review.rating),'review-stars');rating.setAttribute('role','img');rating.setAttribute('aria-label',`${review.rating} out of 5 stars`);
      card.append(identity,rating);if(review.body)card.append(element('p',review.body,'review-body'));
      if(review.delivery==='queued')card.append(element('span','Waiting to publish','small muted'));
      list.append(card);
    }
  }
  async function read(){
    if(closed||preview)return;
    if(loading){reloadAfter=true;return loading;}
    if(!query){notice.textContent='';retry.hidden=true;draw();return;}
    const controller=new AbortController();loadController=controller;notice.textContent='';retry.hidden=true;
    loading=(async()=>{
      try{
        const result=await loadReviews(target,{query,signal:controller.signal,pending:getAccount().pending});
        if(closed||controller.signal.aborted)return;
        reviews=mergeReviews(result.reviews,cachedReviews(target,getAccount().pending));
        notice.textContent=result.limited?'Showing recent reviews.':'';retry.hidden=!result.incomplete;draw();
      }catch(cause){if(!closed&&!controller.signal.aborted){notice.textContent='';retry.hidden=false;reviews=mergeReviews(reviews,cachedReviews(target,getAccount().pending));draw();}}
      finally{loading=undefined;if(!closed&&reloadAfter){reloadAfter=false;void read();}}
    })();return loading;
  }
  function refresh(){
    if(closed)return;
    const account=getAccount(),nextKey=(account.pending??[]).map(event=>event.id).sort().join(',');
    if(formOwner&&account.owner!==formOwner){form.hidden=true;text.value='';formOwner=undefined;error.textContent='';}
    const syncChanged=account.owner===accountOwner&&pendingKey!==nextKey&&!!pendingKey;
    pendingKey=nextKey;accountOwner=account.owner;
    reviews=mergeReviews(reviews,cachedReviews(target,account.pending));draw();
    if(syncChanged)void read();
  }
  write.onclick=()=>{
    const account=getAccount();if(!account.owner||!account.canSign||!publish){onSignIn();return;}
    if(account.owner===target)return;
    const previous=ownReview(account.owner);formOwner=account.owner;text.value=previous?.body??'';error.textContent='';setRating(previous?.rating??0);
    submit.textContent=previous?'Update review':'Publish review';form.hidden=false;text.focus();
  };
  form.onsubmit=async event=>{
    event.preventDefault();if(busy||closed)return;
    const account=getAccount();
    if(!account.canSign||!account.owner||account.owner!==formOwner||!publish){error.textContent='Your profile changed. Open the review form again.';return;}
    const previous=ownReview(account.owner),now=Math.max(Math.floor(Date.now()/1000),(previous?.event.created_at??0)+1);
    let draft;try{draft=buildReviewDraft({target,author:account.owner,rating:selectedRating,body:text.value,subject:previous?.subject,createdAt:previous?.createdAt,now});}
    catch(cause){error.textContent=cause.message;return;}
    busy=true;stars.disabled=true;text.disabled=true;submit.disabled=true;cancel.disabled=true;write.disabled=true;error.textContent='';
    try{
      const receipt=await publish(draft);
      if(closed)return;
      if(getAccount().owner!==account.owner)throw new Error('Your profile changed. Reopen reviews to see the result.');
      const parsed=parseReview(receipt.event,target);
      if(parsed.author!==account.owner||parsed.id!==getEventHash({...draft,pubkey:account.owner}))throw new Error('The signer returned a different review.');
      const review:Review={...parsed,delivery:receipt.delivery==='published'?'published':'queued'};rememberReview(review);reviews=mergeReviews(reviews,[review]);
      form.hidden=true;notice.textContent=review.delivery==='queued'?'Review saved. Waiting to publish.':'Review published.';draw();
    }catch(cause){if(!closed)error.textContent=cause.message||'Could not save this review. Try again.';}
    finally{busy=false;stars.disabled=false;text.disabled=false;cancel.disabled=false;submit.disabled=!selectedRating;if(!closed)draw();}
  };
  retry.onclick=()=>void read();refresh();if(preview){notice.textContent='Reviews are available in live mode.';}else queueMicrotask(()=>void read());
  return {element:panel,summary:summaryState,refresh,close(){closed=true;loadController?.abort();text.value='';}};
}
