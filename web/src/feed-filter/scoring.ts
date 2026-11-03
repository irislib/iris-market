// Pinned Xenova/nli-deberta-v3-xsmall config.json at revision
// 2a4f614a701367a02d51389039afc998faeda637 maps 0=contradiction,
// 1=entailment, 2=neutral (config SHA256 ec0bd14cc28640326474399cd61d38ccd52b64900228799d0f81debda8c4bc53).
// Neutral is a competing nonmatch, not evidence to discard before normalization.
export function debertaEntailmentScore(logits:ArrayLike<number>):number {
  if(logits.length!==3||![0,1,2].every(index=>Number.isFinite(logits[index])))throw new Error('The local model returned invalid relevance scores.');
  const maximum=Math.max(logits[0],logits[1],logits[2]);
  const contradiction=Math.exp(logits[0]-maximum),entailment=Math.exp(logits[1]-maximum),neutral=Math.exp(logits[2]-maximum);
  return entailment/(contradiction+entailment+neutral);
}

// The fourth column is the marketplace-trained entailment logit. Applying
// three quarters of the learned change recovers sentence matches while
// admitting fewer incidental mentions than the fully tuned head.
export function marketplaceEntailmentScore(logits:ArrayLike<number>, conversational:boolean):number {
  if(logits.length!==4)throw new Error('The local model returned invalid relevance scores.')
  const entailment=conversational ? .25*logits[1]+.75*logits[3] : logits[1]
  return debertaEntailmentScore([logits[0],entailment,logits[2]])
}
