/**
 * Contract-specific check implementations are intentionally registered here.
 * An empty registry means the module is incomplete; the runner never converts
 * fixture declarations or an absent checker into a pass.
 */
export async function loadChecks(_moduleId, options = {}) {
  if (['M02', 'M03', 'M04', 'M05', 'M06', 'M07'].includes(_moduleId)) {
    try {
      const implementation = await import(`./${_moduleId.toLowerCase()}.mjs`)
      return implementation.createChecks(options)
    } catch (error) {
      if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
      return new Map()
    }
  }
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
  if (_moduleId === 'M09') {
    const implementation = await import('./m09.mjs')
    return implementation.createChecks(options)
  }
  if (_moduleId === 'M08') {
    const implementation = await import('./m08.mjs')
    return implementation.createChecks(options)
  }
  return new Map()
}
