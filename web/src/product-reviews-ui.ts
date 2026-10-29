import {element} from './dom.ts';
import {createUserRow} from './people.ts';
import {loadProductReviews,productReviewsFromEvents,productReviewTarget} from './product-reviews.ts';
import type {ProductReview} from './product-reviews.ts';
import type {ReviewQuery} from './reviews.ts';

interface ProductReviewOptions {
  listing:{id:string;author?:string};query?:ReviewQuery;preview?:boolean;onProfile?:(pubkey:string)=>void;
}
/** Read-only product recommendations. Seller/profile ratings have a separate projection. */
export function setupProductReviews({listing,query,preview=false,onProfile=()=>{}}:ProductReviewOptions) {
  const target=productReviewTarget(listing.id.startsWith('30402:')?listing.id:`30402:${listing.id}`);
  if(listing.author&&target.split(':')[1]!==listing.author)throw new Error('Product author does not match its address.');
  const panel=element('section',undefined,'profile-reviews product-reviews'),header=element('div',undefined,'review-header');
  header.append(element('h2','Product reviews'));
  const summary=element('p','','review-summary'),notice=element('p','','small muted'),list=element('div',undefined,'review-list');
  notice.setAttribute('role','status');
  const retry=element('button','Retry','text-button');retry.type='button';retry.hidden=true;
  panel.append(header,summary,notice,retry,list);
  let closed=false,loaded=false,incomplete=false,reviews:ProductReview[]=[],loading:Promise<void>|undefined;
  let controller:AbortController|undefined,expiryTimer:ReturnType<typeof setTimeout>|undefined;
  function draw(){
    if(closed)return;clearTimeout(expiryTimer);list.replaceChildren();
    summary.textContent=reviews.length?`${reviews.length} ${reviews.length===1?'review':'reviews'} · Purchases not verified`:'';
    if(!reviews.length&&loaded&&!incomplete)list.append(element('p','No product reviews found.','muted small'));
    for(const review of reviews){
      const card=element('article',undefined,'review-card'),identity=element('div',undefined,'review-header');
      identity.append(createUserRow(review.author,{size:32,className:'review-author',onClick:()=>{if(!closed)onProfile(review.author);}}));
      const date=element('time',new Date(review.updatedAt*1000).toLocaleDateString(),'muted small');date.dateTime=new Date(review.updatedAt*1000).toISOString();identity.append(date);
      const recommendation=review.rating===1?'Recommends this item':review.rating===0?'Doesn’t recommend this item':`Recommendation score: ${Math.round(review.rating*100)}%`;
      card.append(identity,element('p',recommendation,'small'));
      if(review.body)card.append(element('p',review.body,'review-body'));
      const dimensions=Object.entries(review.ratings).filter(([dimension])=>dimension!=='thumb');
      if(dimensions.length){
        const details=element('details'),heading=element('summary','Rating details');details.append(heading);
        for(const [dimension,score] of dimensions)details.append(element('p',`${dimension.replace(/[-_]/g,' ')}: ${Math.round(score*100)}%`,'small muted'));
        card.append(details);
      }
      list.append(card);
    }
    const expirations=reviews.flatMap(review=>review.event.tags.filter(tag=>tag[0]==='expiration').map(tag=>Number(tag[1])*1000));
    if(expirations.length)expiryTimer=setTimeout(()=>{if(closed)return;reviews=productReviewsFromEvents(reviews.map(review=>review.event),target);draw();},Math.min(2147483647,Math.max(1,Math.min(...expirations)-Date.now())));
  }
  function read():Promise<void> {
    if(closed||preview)return Promise.resolve();if(loading)return loading;
    if(!query){notice.textContent='Reviews are unavailable.';return Promise.resolve();}
    controller=new AbortController();const request=controller;notice.textContent='Loading reviews…';retry.hidden=true;
    loading=(async()=>{
      try {
        const result=await loadProductReviews(target,{query,signal:request.signal});if(closed||request.signal.aborted)return;
        reviews=result.reviews;loaded=true;incomplete=result.incomplete||result.limited;
        notice.textContent=result.incomplete?'Some reviews may be unavailable.':result.limited?'Showing recent reviews.':'';
        retry.hidden=!result.incomplete;draw();
      }catch{if(!closed&&!request.signal.aborted){notice.textContent='Couldn’t refresh reviews.';retry.hidden=false;}}
      finally{loading=undefined;}
    })();return loading;
  }
  retry.onclick=()=>void read();
  if(preview)panel.hidden=true;
  return {element:panel,start:()=>loaded?Promise.resolve():read(),refresh:read,destroy(){closed=true;controller?.abort();clearTimeout(expiryTimer);}};
}
