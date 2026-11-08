// Settled operational metadata only. Account balances and anti-trial markers
// live in another collection and are never scanned by this policy.
export const REQUEST_RETENTION_MS=30*24*60*60*1000;
export function expiredTechnicalRequest(data,now=Date.now()){
 if(!data||data.schemaVersion!==1||!Number.isSafeInteger(now))return false;
 if(!['succeeded','failed','expired'].includes(data.status))return false;
 const time=data.finishedAtMs===undefined?data.createdAtMs:data.finishedAtMs;
 if(!Number.isSafeInteger(time)||time<0||time>now)return false;
 if(!Number.isSafeInteger(data.createdAtMs)||data.createdAtMs<0||time<data.createdAtMs)return false;
 return time<=now-REQUEST_RETENTION_MS;
}
