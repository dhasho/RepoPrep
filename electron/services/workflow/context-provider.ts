import { buildContext } from '../context-builder'

/** Main-process injection point. Providers consume the same approved scan and read policy. */
export interface ContextProvider {
  readonly id: string
  readonly build: typeof buildContext
}

/** The static adapter delegates without changing selection, budgets, or rendering. */
export const staticContextProvider: ContextProvider = Object.freeze({
  id: 'structure-v1',
  build: buildContext
})
