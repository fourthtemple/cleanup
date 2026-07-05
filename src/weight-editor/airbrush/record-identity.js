export function textureAirbrushRecordIdentity(record = null, fallback = "record") {
  return record?.uuid
    || record?.id
    || record?.object?.uuid
    || record?.object?.id
    || record?.geometry?.uuid
    || record?.geometry?.id
    || fallback;
}
