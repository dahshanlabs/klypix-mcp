// The NEW optional top-level properties later releases added to tools that a
// frozen snapshot already holds (policy: "Later releases add tools or NEW
// optional top-level fields only" — test/tool-schema-freeze.mjs). Each is
// named here, so an accidental addition still fails every freeze check.
export const ALLOWED_NEW_PROPERTIES = Object.freeze({
  brain_sync: Object.freeze(['role', 'agent']),   // 1.109.0 small identity
});

// The schema as an older snapshot would see it: the listed additions removed
// (only when optional), everything else byte-for-byte as served.
export function withoutAllowedAdditions(name, schema) {
  const allowed = ALLOWED_NEW_PROPERTIES[name];
  if (!allowed || !schema || typeof schema !== 'object' || !schema.properties) return schema;
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const properties = {};
  for (const [key, value] of Object.entries(schema.properties)) {
    if (allowed.includes(key) && !required.has(key)) continue;
    properties[key] = value;
  }
  return { ...schema, properties };
}
