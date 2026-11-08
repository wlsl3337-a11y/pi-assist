import test from 'node:test';import assert from 'node:assert/strict';
import {createProfileStorage,inspectLegacy,migrateLegacy,LEGACY_OWNER_EMAIL,nativeRecordProfile} from './profile-storage.mjs';
const A={key:'a'.repeat(64),email:LEGACY_OWNER_EMAIL,guest:false},B={key:'b'.repeat(64),email:'test@example.invalid',guest:false};
function memory(){const values=new Map();let fail=null;return{values,setFail:key=>fail=key,getItem:async k=>values.get(k)??null,setItem:async(k,v)=>{if(fail&&k.includes(fail))throw Error('quota');values.set(k,v);},removeItem:async k=>values.delete(k),listKeys:async p=>[...values.keys()].filter(k=>k.startsWith(p))};}
function seed(raw){raw.values.set('pi:index:v1',JSON.stringify({patients:{old:{}},wounds:{w:{}},assess:{r:{}}}));raw.values.set('pi:a:r',JSON.stringify({id:'r',photo:{dataUrl:'synthetic'}}));raw.values.set('pi:draft:v1:new',JSON.stringify({id:'draft',values:{pid:'old'}}));}
test('records, photos, drafts and enumeration are isolated between accounts and guest storage',async()=>{
 const raw=memory(),a=createProfileStorage(raw,A),b=createProfileStorage(raw,B),g=createProfileStorage(raw,{key:'guest',guest:true});
 await a.setItem('pi:a:same','A photo');await a.setItem('pi:draft:v1:new','A draft');await b.setItem('pi:a:same','B photo');await g.setItem('pi:a:same','guest photo');
 assert.equal(await a.getItem('pi:a:same'),'A photo');assert.equal(await b.getItem('pi:a:same'),'B photo');assert.equal(await b.getItem('pi:draft:v1:new'),null);
 assert.deepEqual(await b.listKeys('pi:'),['pi:a:same']);await b.removeItem('pi:a:same');assert.equal(await a.getItem('pi:a:same'),'A photo');assert.equal(await g.getItem('pi:a:same'),'guest photo');
});
test('in-flight writes through an old adapter remain with the old account after another profile opens',async()=>{
 const raw=memory(),old=createProfileStorage(raw,A);const pending=Promise.resolve().then(()=>old.setItem('pi:draft:v1:new','old draft'));const next=createProfileStorage(raw,B);await pending;assert.equal(await next.getItem('pi:draft:v1:new'),null);assert.equal(await old.getItem('pi:draft:v1:new'),'old draft');
});
test('legacy ownership is explicit and test/guest accounts cannot claim or view shared records',async()=>{
 const raw=memory();seed(raw);assert.equal((await inspectLegacy(raw,B)).protected,true);assert.equal((await inspectLegacy(raw,{key:'guest',guest:true})).protected,true);
 await assert.rejects(()=>migrateLegacy(raw,B,true));await assert.rejects(()=>migrateLegacy(raw,A,false));assert.equal(await createProfileStorage(raw,B).getItem('pi:index:v1'),null);
});
test('confirmed migration copies exact records and drafts, keeps the source, and is idempotent',async()=>{
 const raw=memory();seed(raw);const original=new Map(raw.values);await migrateLegacy(raw,A,true);await migrateLegacy(raw,A,true);
 for(const [key,value]of original){assert.equal(raw.values.get(key),value);assert.equal(await createProfileStorage(raw,A).getItem(key),value);assert.equal(await createProfileStorage(raw,B).getItem(key),null);}
 assert.equal((await inspectLegacy(raw,A)).needed,false);
});
test('partial migration failure preserves originals and completes safely on retry',async()=>{
 const raw=memory();seed(raw);raw.setFail('pi:a:r');await assert.rejects(()=>migrateLegacy(raw,A,true));assert(raw.values.has('pi:a:r'));assert.equal(await createProfileStorage(raw,A).getItem('pi:index:v1'),null);raw.setFail(null);await migrateLegacy(raw,A,true);assert.equal((await inspectLegacy(raw,A)).needed,false);
});
test('different existing destination data is never overwritten',async()=>{
 const raw=memory();seed(raw);const target=createProfileStorage(raw,A);await target.setItem('pi:a:r','different');await assert.rejects(()=>migrateLegacy(raw,A,true));assert.equal(await target.getItem('pi:a:r'),'different');assert(raw.values.has('pi:index:v1'));
});
test('only the confirmed owner can clear the hidden recovery copy; another profile stays intact',async()=>{
 const raw=memory();seed(raw);await migrateLegacy(raw,A,true);const a=createProfileStorage(raw,A),b=createProfileStorage(raw,B);await b.setItem('pi:a:other','another account');await b.clearLegacyBackup();assert(raw.values.has('pi:a:r'));await a.clearLegacyBackup();assert(!raw.values.has('pi:a:r'));assert.equal(await a.getItem('pi:a:r'),JSON.stringify({id:'r',photo:{dataUrl:'synthetic'}}));assert.equal(await b.getItem('pi:a:other'),'another account');
});
test('Google provider identity survives Firebase UID recreation and keys contain no raw account identifiers',async()=>{
 const p=user=>({uid:user,email:'x@example.invalid',providerData:[{providerId:'google.com',uid:'stable-google'}]});const a=await nativeRecordProfile(p('old')),b=await nativeRecordProfile(p('new'));assert.equal(a.key,b.key);assert.match(a.key,/^[a-f0-9]{64}$/);assert(!a.key.includes('google'));assert.equal((await nativeRecordProfile(null)).key,'guest');
});
