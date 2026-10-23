const DEFAULT_VARIANTS = Object.freeze(['generation', 'baseline'])
const ALLOWED_VARIANTS = new Set(DEFAULT_VARIANTS)

function appendVariant(variants, value, errorCode = 'invalid-variant') {
  if (!ALLOWED_VARIANTS.has(value) || variants.includes(value)) throw new Error(errorCode)
  return [...variants, value]
}

function resolveVariants(variants, errorCode = 'invalid-variant') {
  if (!Array.isArray(variants)) throw new Error(errorCode)
  const selected = []
  for (const value of variants) {
    const next = appendVariant(selected, value, errorCode)
    selected.splice(0, selected.length, ...next)
  }
  return selected.length ? selected : [...DEFAULT_VARIANTS]
}

module.exports = { DEFAULT_VARIANTS, appendVariant, resolveVariants }
