import type {BitcoinQuote} from '../bitcoin-orders.ts';
import type {EscrowOffer} from '../escrow-offer.ts';
import type {ListingDates} from '../listing-dates.ts';

export interface PublicListingEvent {id:string;pubkey:string;created_at:number;kind:number;tags:readonly (readonly string[])[];content:string;sig:string}
export interface ListingPresentation extends ListingDates {externalOrder?:BitcoinQuote;escrow?:EscrowOffer;title:string;side:string;category:string;tags?:readonly string[];price:string;currency:string;location:string;imageUrl?:string;description:string;author?:string;id?:string;rawEvent?:PublicListingEvent}
export interface ListingPageOptions {
  saved?:boolean;onSave?:(listing:ListingPresentation)=>void;onBuy?:(listing:ListingPresentation)=>void;onProfile?:(key:string)=>void;
  priceNode:(listing:ListingPresentation,className:string)=>HTMLElement;authorRow?:(listing:ListingPresentation)=>HTMLElement;
  isPreview?:boolean;owner?:string;onCloseBitcoin?:(listing:ListingPresentation)=>Promise<void>;onEdit?:(listing:ListingPresentation)=>void;onToast?:(message:string)=>void;draftPreview?:boolean;localImage?:string;
}
