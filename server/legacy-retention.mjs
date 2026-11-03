// Legacy operational request documents did not carry an account lookup key.
// Keep a bounded technical retention period rather than pretend they were deleted per account.
const RETENTION_MS=30*24*60*60*1000;
export function expiredLegacyRequest(data,now=Date.now()){
 return !data?.accountKey&&Number.isSafeInteger(data?.createdAtMs)&&data.createdAtMs>=0&&data.createdAtMs<=now-RETENTION_MS;
}
