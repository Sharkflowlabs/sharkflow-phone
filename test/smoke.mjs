import crypto from 'node:crypto';
const B='http://localhost:8787', TOKEN='authtoken123';
let cookie='';
const ok=(c,m)=>{console.log((c?'PASS ':'FAIL ')+m); if(!c) process.exitCode=1;};
async function api(path,opts={}){const r=await fetch(B+path,{method:opts.method||'GET',headers:{...(opts.body!==undefined?{'content-type':'application/json'}:{}),cookie},body:opts.body!==undefined?JSON.stringify(opts.body):undefined});const sc=r.headers.get('set-cookie');if(sc)cookie=sc.split(';')[0];return {status:r.status,data:await r.json().catch(()=>null)};}
async function tw(path,params,bad){const url=B+path;const data=url+Object.keys(params).sort().map(k=>k+params[k]).join('');const sig=crypto.createHmac('sha1',TOKEN).update(data).digest('base64');const r=await fetch(url,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded','x-twilio-signature':bad?'nope':sig},body:new URLSearchParams(params)});return {status:r.status,text:await r.text()};}

ok((await api('/api/contacts')).status===401,'API needs login');
ok((await api('/api/login',{method:'POST',body:{password:'wrong'}})).status===401,'wrong password rejected');
ok((await api('/api/login',{method:'POST',body:{password:'test-pass'}})).status===200 && cookie,'login works');
const me=await api('/api/me'); ok(me.data.stages.length===8 && me.data.callingReady,'me + stages');
const c=await api('/api/contacts',{method:'POST',body:{phone:'(555) 201-3344',name:'Mike',business:'Mike Roofing'}}); ok(c.status===201 && c.data.contact.phone==='+15552013344','create contact normalizes phone');
ok((await api('/api/contacts',{method:'POST',body:{phone:'555-201-3344'}})).status===409,'duplicate blocked');
const id=c.data.contact.id;
ok((await api(`/api/contacts/${id}`,{method:'PATCH',body:{stage:'Mockup sent',next_follow_up:'2026-11-20'}})).data.contact.stage==='Mockup sent','patch stage+followup');
ok((await api(`/api/contacts/${id}`,{method:'PATCH',body:{stage:'Bogus'}})).status===400,'bad stage rejected');
const due=await api('/api/contacts?view=due&today=2026-11-22'); ok(due.data.contacts.length===1 && due.data.counts.due===1,'due view');
ok((await tw('/twilio/sms',{From:'+15552013344',Body:'hi there',MessageSid:'SM1'},true)).status===403,'bad signature rejected');
ok((await tw('/twilio/sms',{From:'+15552013344',Body:'Yes send it over',MessageSid:'SM1'})).status===200,'inbound sms accepted');
ok((await api(`/api/contacts/${id}`)).data.contact.opt_in_channel==='Texted us first','texting first records opt-in');
ok((await tw('/twilio/sms',{From:'+61412345678',Body:'who is this',MessageSid:'SM2'})).status===200,'inbound from new AU number');
let list=await api('/api/contacts?view=unread'); ok(list.data.contacts.length===2,'unread view has 2');
let tl=await api(`/api/contacts/${id}/timeline`); ok(tl.data.items.some(i=>i.body==='Yes send it over'),'timeline shows inbound');
ok((await api(`/api/contacts/${id}`,{method:'PATCH',body:{opt_in_at:null}})).status===200,'clear opt-in');
ok((await api(`/api/contacts/${id}/messages`,{method:'POST',body:{body:'hi'}})).status===409,'send blocked without opt-in');
ok((await api(`/api/contacts/${id}`,{method:'PATCH',body:{opt_in_at:'2026-11-22'}})).status===400,'opt-in needs channel');
ok((await api(`/api/contacts/${id}`,{method:'PATCH',body:{opt_in_at:'2026-11-22',opt_in_channel:'Instagram DM',opt_in_note:'said yes to demo link'}})).data.contact.opt_in_channel==='Instagram DM','opt-in saved');
const send=await api(`/api/contacts/${id}/messages`,{method:'POST',body:{body:'Here is your mockup'}}); ok(send.status===502,'send with fake creds fails cleanly ('+send.data.error+')');
tl=await api(`/api/contacts/${id}/timeline`); const f=tl.data.items.find(i=>i.status==='failed'); ok(f && f.body.includes('Reply STOP to opt out.'),'first text gets opt-out line');
await tw('/twilio/sms',{From:'+15552013344',Body:' stop ',MessageSid:'SM3'});
ok((await api(`/api/contacts/${id}`)).data.contact.opted_out===1,'STOP opts out');
ok((await api(`/api/contacts/${id}/messages`,{method:'POST',body:{body:'hello?'}})).status===409,'sending blocked after STOP');
await tw('/twilio/sms',{From:'+15552013344',Body:'START',MessageSid:'SM4'});
ok((await api(`/api/contacts/${id}`)).data.contact.opted_out===0,'START opts back in');
let v=await tw('/twilio/voice-in',{From:'+15552013344',To:'+18885550100',CallSid:'CA1'}); ok(v.text.includes('<Client>owner</Client>') && v.text.includes('/twilio/voice-after'),'inbound call rings browser');
ok(v.text.includes('may be recorded') && v.text.includes('record="record-from-answer-dual"'),'inbound call announced + recorded');
v=await tw('/twilio/voice-after',{CallSid:'CA1',DialCallStatus:'no-answer'}); ok(v.text.includes('<Record'),'missed call -> voicemail');
await tw('/twilio/voicemail',{CallSid:'CA1',RecordingSid:'RE1',RecordingDuration:'14'});
tl=await api(`/api/contacts/${id}/timeline`); ok(tl.data.items.some(i=>i.type==='call'&&i.has_recording&&i.status==='voicemail'),'voicemail logged');
v=await tw('/twilio/voice-out',{Caller:'client:owner',To:'(555) 777-1212',CallSid:'CA2'}); ok(v.text.includes('>+15557771212</Number>') && v.text.includes('callerId="+18885550100"'),'browser outbound call TwiML');
ok(v.text.includes('/twilio/whisper') && v.text.includes('record="record-from-answer-dual"'),'outbound call recorded with whisper notice');
ok((await tw('/twilio/whisper',{CallSid:'CA9'})).text.includes('may be recorded'),'whisper plays notice');
ok((await tw('/twilio/voice-out',{Caller:'client:intruder',To:'+15557771212',CallSid:'CA3'})).text.includes('<Reject/>'),'other identities rejected');
await tw('/twilio/dial-done',{CallSid:'CA2',DialCallStatus:'completed',DialCallDuration:'65'});
await tw('/twilio/recording',{CallSid:'CA2',RecordingSid:'RE2',RecordingDuration:'63'});
await tw('/twilio/recording',{CallSid:'CA1',RecordingSid:'RE9',RecordingDuration:'5'});
{ const l=await api('/api/contacts?q=777'); const cid=l.data.contacts[0].id; const t2=await api(`/api/contacts/${cid}/timeline`);
  ok(t2.data.items.some(i=>i.type==='call'&&i.status==='answered'&&i.has_recording),'outbound call recording saved'); }
{ const t3=await api(`/api/contacts/${id}/timeline`); ok(t3.data.items.some(i=>i.type==='call'&&i.status==='voicemail'),'call recording does not overwrite voicemail'); }
const t=await api('/api/voice-token'); const [h,p,s]=t.data.token.split('.'); const exp=crypto.createHmac('sha256','keysecret').update(h+'.'+p).digest('base64url');
const pl=JSON.parse(Buffer.from(p,'base64url')); ok(s===exp && pl.grants.voice.outgoing.application_sid==='AP_test' && pl.grants.identity==='owner','voice token signed correctly');
ok((await fetch(B+'/').then(r=>r.text())).includes('Sharkflow Phone'),'UI served');
ok((await fetch(B+'/vendor/twilio.min.js')).status===200,'voice sdk served');
