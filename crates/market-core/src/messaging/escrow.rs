use super::{Message, Messaging, MessagingResult, now};
use crate::escrow::{AgreementMessage, Proposal, Terms};
use nostr::{Event, EventId, PublicKey};

impl Messaging {
    fn proposal_message(&self, peer: &str, id: EventId) -> MessagingResult<(&Message, &Proposal)> {
        let message = self
            .state
            .conversations
            .get(peer)
            .and_then(|c| c.messages.iter().find(|m| m.id == id.to_hex()))
            .ok_or("Unknown escrow proposal in this conversation")?;
        match &message.escrow {
            Some(AgreementMessage::Propose(p)) => Ok((message, p)),
            _ => Err("This message is not an escrow proposal".into()),
        }
    }
    pub fn escrow_proposal(&self, peer: &str, id: EventId) -> MessagingResult<&Proposal> {
        Ok(self.proposal_message(peer, id)?.1)
    }

    // Reusing a party's key could let the same locked proofs appear to fund two agreements.
    fn require_unused_trade_keys(
        &self,
        terms: &Terms,
        except: Option<EventId>,
    ) -> MessagingResult<()> {
        let except = except.map(|id| id.to_hex());
        let used = self.state.conversations.values().any(|conversation| {
            // A peer cannot reserve our keys by sending an unsolicited proposal.
            let accepted: std::collections::HashSet<_> = conversation
                .messages
                .iter()
                .filter(|m| m.mine)
                .filter_map(|m| match m.escrow {
                    Some(AgreementMessage::Accept { proposal_id }) => Some(proposal_id.to_hex()),
                    _ => None,
                })
                .collect();
            conversation.messages.iter().any(|message| {
                let Some(AgreementMessage::Propose(previous)) = &message.escrow else {
                    return false;
                };
                except.as_ref() != Some(&message.id)
                    && (message.mine || accepted.contains(&message.id))
                    && [terms.buyer_key, terms.seller_key].iter().any(|key| {
                        [previous.terms.buyer_key, previous.terms.seller_key]
                            .iter()
                            .any(|old| old.x_only_public_key() == key.x_only_public_key())
                    })
            })
        });
        if used {
            return Err("Use fresh buyer and seller keys for each escrow proposal".into());
        }
        Ok(())
    }
    pub fn propose_escrow(&mut self, event: &Event, terms: Terms) -> MessagingResult<()> {
        self.require_unused_trade_keys(&terms, None)?;
        let p = Proposal::for_event(event, terms, self.owner, now()).map_err(|e| e.to_string())?;
        self.send_private(
            &event.pubkey.to_hex(),
            "Escrow terms proposed.",
            None,
            Some(AgreementMessage::Propose(Box::new(p))),
        )
    }

    pub fn accept_escrow(
        &mut self,
        peer: &str,
        id: EventId,
        current: &Event,
    ) -> MessagingResult<()> {
        let (message, p) = self.proposal_message(peer, id)?;
        if message.mine || current.pubkey != self.owner {
            return Err("Only the listing author can accept the other party's proposal".into());
        }
        if self.agreed_escrow(peer, id).is_ok() {
            return Ok(());
        }
        self.require_unused_trade_keys(&p.terms, Some(id))?;
        let taker = PublicKey::from_hex(peer).map_err(|_| "Invalid counterparty")?;
        let expected = Proposal::for_event(current, p.terms.clone(), taker, now())
            .map_err(|e| e.to_string())?;
        if p != &expected {
            return Err("Escrow proposal no longer matches this listing".into());
        }
        self.send_private(
            peer,
            "Escrow terms accepted.",
            None,
            Some(AgreementMessage::Accept { proposal_id: id }),
        )
    }

    pub fn agreed_escrow(&self, peer: &str, id: EventId) -> MessagingResult<&Proposal> {
        let (message, p) = self.proposal_message(peer, id)?;
        if !self.state.conversations[peer].messages.iter().any(|reply|
            reply.mine != message.mine && matches!(reply.escrow, Some(AgreementMessage::Accept { proposal_id }) if proposal_id == id)) {
            return Err("The other party has not accepted these terms".into());
        }
        Ok(p)
    }
}
