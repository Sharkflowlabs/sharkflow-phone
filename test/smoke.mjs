import crypto from 'node:crypto';
const B='http://localhost:8787', TOKEN='authtoken123';
let cookie='';
const ok=(c,m)=>{console.log((c?'PASS ':'FAIL ')+m); if(!c) process.exitCode=1;};
async function api(path,opts={}){const r=await fetch(B+path,{method:opts.method||'GET',headers:{...(opts.body!==undefined?{'content-type':'application/json'}:{}),cookie},body:opts.body!==undefined?JSON.stringify(opts.body):undefined});const sc=r.headers.get('set-cookie');if(sc)cookie=sc.split(';')[0];return {status:r.status,data:await r.json().catch(()=>null)};}
async function tw(path,params,bad){const url=B+path;const data=url+Object.keys(params).sort().map(k=>k+params[k]).join('');const sig=crypto.createHmac('sha1',TOKEN).update(data).digest('base64');const r=await fetch(url,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded','x-twilio-signature':bad?'nope':sig},body:new URLSearchParams(params)});return {status:r.status,text:await r.text()};}

ok((await api('/api/contacts')).status===401,'API needs login');
ok((await api('/api/login',{method:'POST',body:{password:'wrong'}})).status===401,'wrong password rejected');
ok((await api('/api/login',{method:'POST',body:{password:'test-pass'}})).status===200 && cookie,'login works');
const me=await api('/api/me'); ok(me.data.stages.length===11 && me.data.prospectStages.join()==='New,Messaged,Replied,No reply,Not interested' && me.data.dealStages.join()==='Interested,Demo,In build,Closed / Site live,LTO,Lost' && me.data.channels.includes('WhatsApp') && me.data.callingReady,'me + prospect statuses + deal stages + channels');
const c=await api('/api/contacts',{method:'POST',body:{phone:'(555) 201-3344',name:'Mike',business:'Mike Roofing'}}); ok(c.status===201 && c.data.contact.phone==='+15552013344','create contact normalizes phone');
ok((await api('/api/contacts',{method:'POST',body:{phone:'555-201-3344'}})).status===409,'duplicate blocked');
const id=c.data.contact.id;
ok((await api(`/api/contacts/${id}`,{method:'PATCH',body:{stage:'Interested',next_follow_up:'2026-11-20'}})).data.contact.stage==='Interested','patch stage+followup');
ok((await api(`/api/contacts/${id}`,{method:'PATCH',body:{stage:'Bogus'}})).status===400,'bad stage rejected');
await api('/api/tasks',{method:'POST',body:{title:'Send mockup',due:'2026-11-21',contact_id:id}});
const due=await api('/api/contacts?view=due&today=2026-11-22'); ok(due.data.contacts.length===1 && due.data.counts.due===1 && due.data.contacts[0].task_title==='Send mockup','tasks due view');
{ const pl=await api('/api/pipeline'); const c=pl.data.contacts.find(x=>x.id===id); ok(c.task_title==='Send mockup' && c.task_due==='2026-11-21' && c.open_tasks===1 && !('next_follow_up' in c),'pipeline card shows next task, no follow-up date'); }
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
tl=await api(`/api/contacts/${id}/timeline`); const f=tl.data.items.find(i=>i.status==='failed'); ok(f && f.body.includes('msg & data rates may apply') && f.body.includes('STOP to opt out'),'first text is preceded by the opt-in confirmation');
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
ok((await fetch(B+'/').then(r=>r.text())).includes('Sharkflow CRM'),'UI served');
ok((await fetch(B+'/vendor/twilio.min.js')).status===200,'voice sdk served');

{ const r=await fetch(B+'/public/optin',{method:'POST',headers:{'content-type':'application/json',origin:'https://evil.example'},body:JSON.stringify({phone:'5553334444',consent:true})}); ok(r.status===403,'opt-in form rejects other sites'); }
{ const r=await fetch(B+'/public/optin',{method:'POST',headers:{'content-type':'application/json',origin:'https://sharkflowlabs.pages.dev'},body:JSON.stringify({phone:'5553334444',name:'Ann',business:'Ann Plumbing',consent:false})}); ok(r.status===400,'opt-in form needs consent'); }
{ const r=await fetch(B+'/public/optin',{method:'POST',headers:{'content-type':'application/json',origin:'https://sharkflowlabs.pages.dev'},body:JSON.stringify({phone:'5553334444',name:'Ann',business:'Ann Plumbing',consent:true,consent_text:'I agree'})});
  ok(r.status===200 && r.headers.get('access-control-allow-origin')==='https://sharkflowlabs.pages.dev','opt-in form accepted');
  const l=await api('/api/contacts?q=Ann'); const c=l.data.contacts[0]; ok(c && c.opt_in_channel==='Website form' && c.unread===1,'form creates opted-in unread lead'); }

{ const H={'content-type':'application/json',origin:'https://sharkflowlabs.pages.dev'};
  let r=await fetch(B+'/public/lead',{method:'POST',headers:H,body:JSON.stringify({phone:'5556667777',name:'Bob',agree_terms:false})}); ok(r.status===400,'quote form needs terms');
  r=await fetch(B+'/public/lead',{method:'POST',headers:H,body:JSON.stringify({phone:'5556667777',name:'Bob',business:'Bob Roofing',email:'bob@x.com',trade:'Roofing',message:'Need a site',agree_terms:true,consent_contact:false})}); ok(r.status===200,'quote form accepted without contact consent');
  let c=(await api('/api/contacts?q=Bob')).data.contacts[0]; ok(c && !c.opt_in_at && c.email==='bob@x.com' && c.notes.includes('Need a site'),'lead saved, texting stays locked');
  r=await fetch(B+'/public/lead',{method:'POST',headers:H,body:JSON.stringify({phone:'+44 7700 900123',name:'Uk',business:'UK Plumb',agree_terms:true,consent_contact:true,consent_text:'ok to text'})});
  c=(await api('/api/contacts?q=UK%20Plumb')).data.contacts[0]; ok(r.status===200 && c && c.phone==='+447700900123' && c.opt_in_channel==='Website form','UK lead with consent logged as opt-in');
  r=await fetch(B+'/public/lead',{method:'POST',headers:H,body:JSON.stringify({phone:'5551112222',agree_terms:true,company_website_hp:'spam'})});
  ok(r.status===200 && !(await api('/api/contacts?q=5551112222')).data.contacts.length,'honeypot drops bots'); }

// ---------- CRM ----------
{ const J=(b)=>({method:'POST',body:b});
  const p=await api('/api/contacts',J({instagram:'https://www.instagram.com/acme.roof/',business:'Acme Roof'}));
  ok(p.status===201 && p.data.contact.phone===null && p.data.contact.instagram==='acme.roof','contact without phone (Instagram only)');
  ok((await api('/api/contacts',J({}))).status===400,'empty contact rejected');
  const pid=p.data.contact.id;
  ok((await api(`/api/contacts/${pid}/messages`,J({body:'hi'}))).status===409,'cannot text without a phone');
  let r=await api(`/api/contacts/${pid}/touch`,J({today:'2026-11-22'})); ok(r.data.contact.stage==='Messaged' && r.data.contact.next_follow_up===null,'touch 1 -> Messaged, no follow-up date');
  for (let i=0;i<3;i++) r=await api(`/api/contacts/${pid}/touch`,J({today:'2026-11-22'}));
  ok(r.data.contact.stage==='No reply' && r.data.contact.next_follow_up===null,'4 touches with no reply -> No reply, no follow-up date');
  r=await api(`/api/contacts/${pid}/replied`,J({today:'2026-11-22'})); ok(r.data.contact.stage==='Replied' && r.data.contact.touches===0,'replied -> Replied');
  let tk=await api(`/api/tasks?contact=${pid}`); ok(!tk.data.tasks.some(t=>t.title==='Send the demo link'),'stage change adds no automatic task');
  r=await api(`/api/contacts/${pid}`,{method:'PATCH',body:{stage:'In build',value:'$1,200',hot:true,today:'2026-11-22'}});
  ok(r.data.contact.value===1200 && r.data.contact.hot===1 && r.data.contact.deadline==='2026-11-29','In build sets value, hot and 7 day deadline');
  r=await api(`/api/contacts/${pid}/touch`,J({today:'2026-11-22'})); ok(r.data.contact.stage==='In build','touch on active deal keeps stage');
  const nt=await api('/api/tasks',J({title:'Call back',due:'2026-11-21'})); ok(nt.status===201,'task created');
  ok((await api(`/api/tasks/${nt.data.task.id}`,{method:'PATCH',body:{done:true}})).data.task.done===1,'task done');
  await api('/api/tasks',J({title:'Chase payment',contact_id:pid}));
  { const all=await api('/api/tasks?doneLimit=200'); ok(all.data.done.some(t=>t.id===nt.data.task.id) && all.data.tasks.some(t=>t.contact_id===pid && t.contact_stage==='In build'),'tasks list has done tasks and contact stage'); }
  const st=await api('/api/stats?today=2026-11-22'); ok(st.data.active>=1 && st.data.open_value>=1200,'pipeline counts In build value');
  { const a=await api('/api/contacts',J({business:'Bulk A',instagram:'bulk.a'})), b=await api('/api/contacts',J({business:'Bulk B',instagram:'bulk.b'}));
    await api('/api/tasks',J({title:'x',contact_id:a.data.contact.id}));
    const d=await api('/api/contacts/bulk-delete',J({ids:[a.data.contact.id,b.data.contact.id]})); const pl=await api('/api/pipeline');
    ok(d.data.deleted===2 && !pl.data.contacts.some(c=>c.business.startsWith('Bulk ')),'bulk delete removes selected deals');
    ok((await api('/api/contacts/bulk-delete',J({ids:[]}))).status===400,'bulk delete needs ids'); }
  const pr=await api('/api/prospects',J({lines:['@new.paint, New Paint','instagram.com/acme.roof','!!bad']})); ok(pr.data.added===1 && pr.data.skipped===2,'bulk Instagram paste skips duplicates');
  ok((await api('/api/pipeline')).data.contacts.length>=3,'pipeline list');
  ok((await api(`/api/contacts/${pid}`,{method:'DELETE',body:{}})).status===200,'delete contact with tasks'); }

{ const J=(b)=>({method:'POST',body:b});
  const c=await api('/api/contacts',J({phone:'5554443322',business:'Dial Test'})); const id=c.data.contact.id;
  let r=await api(`/api/contacts/${id}/disposition`,J({outcome:'no_answer',today:'2026-11-22'})); ok(r.data.contact.stage==='Messaged' && r.data.contact.touches===1,'dialer no answer = touch');
  r=await api(`/api/contacts/${id}/disposition`,J({outcome:'interested',note:'wants demo',today:'2026-11-22'})); ok(r.data.contact.stage==='Interested' && r.data.contact.next_follow_up===null,'dialer interested moves stage');
  r=await api(`/api/contacts/${id}/disposition`,J({outcome:'callback',callback:'2026-11-25',today:'2026-11-22'}));
  { const t=await api(`/api/tasks?contact=${id}`); ok(t.data.tasks.some(x=>x.title==='Call back' && x.due==='2026-11-25' && !x.done),'call back later -> task with that date'); }
  ok((await api(`/api/contacts/${id}/disposition`,J({outcome:'bogus'}))).status===400,'bad outcome rejected');
  ok((await api(`/api/contacts/${id}/notes`,J({body:'Sent DM',kind:'dm'}))).status===200,'log DM note');
  const tl=await api(`/api/contacts/${id}/timeline`); ok(tl.data.items.filter(i=>i.type==='activity').length===4,'activities on timeline');
  const st=await api('/api/stats?today='+new Date().toISOString().slice(0,10)); ok(st.data.dials_today>=2,'dials counted');
  r=await api(`/api/contacts/${id}/disposition`,J({outcome:'not_interested',today:'2026-11-22'})); ok(r.data.contact.stage==='Lost' && r.data.contact.lost_reason==='Not interested','not interested -> Lost'); }
{ const r=await api('/api/assistant/extract',{method:'POST',body:{}}); ok(r.status===400||r.status===503,'assistant asks for a screenshot or text (or an AI engine)'); }
{ // Prospects vs deals: channel field, Not interested on a prospect stays a prospect, on a deal it's Lost.
  const J=(b)=>({method:'POST',body:b});
  const p=await api('/api/contacts',J({business:'WA Roofing',phone:'5553330001',channel:'WhatsApp'})); ok(p.data.contact.stage==='New' && p.data.contact.channel==='WhatsApp','new prospect is New with a channel');
  ok((await api(`/api/contacts/${p.data.contact.id}`,{method:'PATCH',body:{channel:'fb'}})).data.contact.channel==='Facebook','channel alias cleaned');
  ok((await api(`/api/contacts/${p.data.contact.id}`,{method:'PATCH',body:{channel:'carrier pigeon'}})).data.contact.channel==='','unknown channel cleared');
  let r=await api(`/api/contacts/${p.data.contact.id}/disposition`,J({outcome:'not_interested',today:'2026-11-26'})); ok(r.data.contact.stage==='Not interested','prospect says no -> Not interested');
  r=await api(`/api/contacts/${p.data.contact.id}/replied`,J({today:'2026-11-26'})); ok(r.data.contact.stage==='Replied','not interested then replies -> Replied');
  r=await api(`/api/contacts/${p.data.contact.id}`,{method:'PATCH',body:{stage:'Demo',today:'2026-11-26'}}); ok(r.data.contact.stage==='Demo','Demo stage');
  r=await api(`/api/contacts/${p.data.contact.id}/disposition`,J({outcome:'interested',today:'2026-11-26'})); ok(r.data.contact.stage==='Demo','interested call keeps a Demo deal in Demo');
  r=await api(`/api/contacts/${p.data.contact.id}`,{method:'PATCH',body:{stage:'Closed / Site live',value:500,today:'2026-11-26'}}); ok(r.data.contact.stage==='Closed / Site live','closed / site live');
  const st=await api('/api/stats?today=2026-11-26'); ok(st.data.won_value>=500,'won value counts Closed / Site live');
  const q=await api('/api/contacts',J({business:'Deal No',phone:'5553330002',stage:'Interested'}));
  r=await api(`/api/contacts/${q.data.contact.id}/disposition`,J({outcome:'not_interested',today:'2026-11-26'})); ok(r.data.contact.stage==='Lost','deal says no -> Lost'); }
{ // Paste-from-sheet import: preview saves nothing, flags duplicates (CRM + same paste) and bad rows, then adds only new rows.
  const rows=[
    {business:'Peachtree Pest Pros',name:'Dana',phone:'(404) 555-0101',email:'dana@peachpest.com',source:'ZoomInfo',channel:'whatsapp',first_contact:'11/20/2026',notes:'Emailed'},
    {business:'Mike Roofing',phone:'404-555-0102'},
    {business:'Peachtree Pest Pros',phone:'404-555-0109'},
    {business:'Bad Number Co',phone:'12'},
    {business:'Odd Date LLC',first_contact:'someday'},
    {name:'Instagram Only',instagram:'https://instagram.com/igonly_biz/',source:'instagram'},
  ];
  const before=(await api('/api/contacts')).data.contacts.length;
  const p=await api('/api/import',{method:'POST',body:{rows,preview:true,stage:'Replied'}});
  ok(p.status===200 && p.data.rows.map(r=>r.status).join()==='new,duplicate,duplicate,error,error,new','import preview statuses');
  ok(p.data.rows[1].match && p.data.rows[1].match.id && /already in CRM/.test(p.data.rows[1].reason),'preview links the existing CRM contact');
  ok(/row 1/.test(p.data.rows[2].reason),'preview catches repeats inside the paste');
  ok(p.data.rows[0].source==='ZoomInfo' && p.data.rows[5].source==='Instagram','ZoomInfo + case-insensitive sources kept');
  ok((await api('/api/contacts')).data.contacts.length===before,'preview saves nothing');
  const r=await api('/api/import',{method:'POST',body:{rows,stage:'Replied'}});
  ok(r.data.added===2 && r.data.skipped===4,'import adds only new rows ('+JSON.stringify([r.data.added,r.data.skipped])+')');
  const all=(await api('/api/contacts?q=Peachtree')).data.contacts; const c=all[0];
  ok(all.length===1 && c.phone==='+14045550101' && c.stage==='Replied' && c.last_touch==='2026-11-20' && c.notes.startsWith('First contact 2026-11-20') && c.source==='ZoomInfo' && c.channel==='WhatsApp','imported row saved correctly');
  ok((await api('/api/contacts?q=igonly_biz')).data.contacts[0].instagram==='igonly_biz','instagram url cleaned');
  const again=await api('/api/import',{method:'POST',body:{rows,preview:true}}); ok(again.data.rows.filter(x=>x.status==='new').length===0,'re-pasting the same rows finds nothing new');
  ok((await api('/api/import',{method:'POST',body:{rows:[]}})).status===400,'empty import rejected');
}
{ const me=await api('/api/me'); ok(me.data.senderEmail==='hello@sharkflowlabs.com','sender email for Gmail drafts');
  const r=await api('/api/assistant/draft',{method:'POST',body:{contact_id:1,channel:'email',instructions:''}}); ok(r.status===400||r.status===503,'draft needs instructions (or an AI engine)'); }
{ // Source links: Facebook typed in the Instagram box moves to links, IG links become the handle, sources fill in.
  let r=await api('/api/contacts',{method:'POST',body:{business:'GA Painting Test',instagram:'https://www.facebook.com/profile.php?id=61592348535146'}});
  let c=r.data.contact; ok(c.instagram==='' && c.links==='https://www.facebook.com/profile.php?id=61592348535146' && c.source==='Facebook','facebook link in IG box goes to links + source Facebook');
  r=await api(`/api/contacts/${c.id}`,{method:'PATCH',body:{links:c.links+'\nyelp.com/biz/ga-painting\nhttps://instagram.com/gapainting/\nnot a link',today:'2026-11-27'}});
  c=r.data.contact; ok(c.instagram==='gapainting' && c.links==='https://www.facebook.com/profile.php?id=61592348535146\nhttps://yelp.com/biz/ga-painting','links cleaned, IG link becomes handle ('+JSON.stringify([c.instagram,c.links])+')');
  r=await api(`/api/contacts/${c.id}`,{method:'PATCH',body:{instagram:'https://www.bbb.org/us/x',today:'2026-11-27'}});
  ok(r.data.contact.links.split('\n').length===3 && r.data.contact.instagram==='','link typed in IG box is added to links');
  ok((await api('/api/contacts?q=ga-painting')).data.contacts.length===1,'search finds links');
  r=await api('/api/contacts',{method:'POST',body:{business:'Quick Link Co',link:'https://yelp.com/biz/quick-link'}});
  ok(r.data.contact.links==='https://yelp.com/biz/quick-link' && r.data.contact.source==='Yelp','quick add link sets Yelp source');
  r=await api('/api/prospects',{method:'POST',body:{lines:['https://www.facebook.com/bestpaintco, Best Paint Co','https://www.facebook.com/bestpaintco']}});
  ok(r.data.added===1 && r.data.skipped===1,'paste a list takes facebook links and skips repeats');
}
