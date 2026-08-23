/// <reference types="vite/client" />
import type { ProjectLensApi } from '@shared/ipc'

declare global {
  interface Window {
    api: ProjectLensApi
  }
}

export {}
