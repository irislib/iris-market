/** One category set for web and native; values are the lowercase NIP-99 tags. */
export const LISTING_CATEGORIES:readonly (readonly [string,string])[]=Object.freeze([['food','Food'],['home','Home'],['clothing','Clothing'],['electronics','Electronics'],['services','Services'],['transport','Transport'],['work','Work'],['other','Other']] as const);
/** Earlier web and native categories stay editable. */
export const LEGACY_CATEGORIES:readonly string[]=Object.freeze(['tech','books','music','garden','outdoors']);
