import test from 'node:test';
import assert from 'node:assert/strict';
import {createChatDrafts} from '../src/chat-drafts.js';

test('purchase enquiry remains a draft through sign-in and does not overwrite typing',()=>{
  const drafts=createChatDrafts();
  assert.equal(drafts.select('seller','','I would like this bicycle.'),'I would like this bicycle.');
  assert.equal(drafts.select('seller','Can I collect tomorrow?','Another listing'),'Can I collect tomorrow?');
  assert.equal(drafts.select('friend','Can I collect tomorrow?'),'');
  assert.equal(drafts.select('seller','Hello friend'),'Can I collect tomorrow?');
  assert.equal(drafts.select('friend','Can I collect tomorrow?'),'Hello friend');
  drafts.clear('seller');assert.equal(drafts.select('seller','Hello friend'),'');
});
