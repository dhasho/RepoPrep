/**
 * Contract-specific check implementations are intentionally registered here.
 * An empty registry means the module is incomplete; the runner never converts
 * fixture declarations or an absent checker into a pass.
 */
export async function loadChecks(_moduleId) {
  if (_moduleId === 'P0') {
    const implementation = await import('./p0.mjs')
    return implementation.createChecks()
  }
  if (_moduleId === 'M01') {
    try {
      const implementation = await import('./m01.mjs')
      return implementation.createChecks?.() ?? implementation.checks ?? new Map()
    } catch (error) {
      if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
    }
  }
  return new Map()
}
