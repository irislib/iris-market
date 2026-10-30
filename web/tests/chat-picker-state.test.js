import test from 'node:test';
import assert from 'node:assert/strict';
import {createChatPickerState,revealChatPicker} from '../src/chat-picker-state.ts';
test('periodic row replacement preserves the open message picker, selection and navigation close it',()=>{
 const state=createChatPickerState(),pickers=[{dataset:{messageId:'message-a'},open:false},{dataset:{messageId:'message-b'},open:false}],root={querySelectorAll:()=>pickers.filter(p=>p.open),ownerDocument:{activeElement:null}};
 state.capture('alice|general',root);pickers[0].open=true;
 state.capture('alice|general',root);assert.equal(state.isOpen('message-a'),true);assert.equal(state.isOpen('message-b'),false);
 const replacement={dataset:{messageId:'message-a'},open:state.isOpen('message-a')};pickers[0]=replacement;state.capture('alice|general',root);assert.equal(state.isOpen('message-a'),true);
 replacement.open=false;state.capture('alice|general',root);assert.equal(state.isOpen('message-a'),false);
 replacement.open=true;state.capture('bob|general',root);assert.equal(state.isOpen('message-a'),false);
 state.capture('bob|general',root);assert.equal(state.isOpen('message-a'),true);state.reset();state.capture('bob|general',root);assert.equal(state.isOpen('message-a'),false);
});
test('keyboard focus returns to the same action after an open picker row is replaced',()=>{
 let focused=0;const state=createChatPickerState(),option={getAttribute:()=> 'Heart',focus:options=>{assert.equal(options.preventScroll,true);focused++;}},picker={dataset:{messageId:'message'},querySelectorAll:()=>[option]},root={querySelectorAll:()=>[picker],contains:value=>value===picker,ownerDocument:{activeElement:null}};
 state.capture('alice',root);root.ownerDocument.activeElement={closest:()=>picker,getAttribute:()=> 'Heart'};state.capture('alice',root);state.restoreFocus(root);assert.equal(focused,1);
});

test('opening a clipped picker scrolls only its message pane enough to show the choices',()=>{
 const area={scrollTop:150,scrollHeight:1000,clientHeight:300,getBoundingClientRect:()=>({top:100,bottom:400})};
 revealChatPicker(area,{getBoundingClientRect:()=>({top:350,bottom:430})},{innerHeight:844});assert.equal(area.scrollTop,186);
 area.scrollTop=100;revealChatPicker(area,{getBoundingClientRect:()=>({top:50,bottom:130})},{innerHeight:844});assert.equal(area.scrollTop,44);
 area.scrollTop=150;revealChatPicker(area,{getBoundingClientRect:()=>({top:180,bottom:260})},{innerHeight:844});assert.equal(area.scrollTop,150);
});
