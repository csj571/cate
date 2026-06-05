// =============================================================================
// IPC handlers for LOCAL_PROVIDERS_* channels — thin wrappers around
// LocalProviderManager. Refresh re-probes and pushes fresh models into every
// live agent workspace via AgentManager.
// =============================================================================

import { ipcMain } from 'electron'
import {
  LOCAL_PROVIDERS_LIST,
  LOCAL_PROVIDERS_SAVE,
  LOCAL_PROVIDERS_REMOVE,
  LOCAL_PROVIDERS_REFRESH,
} from '../../shared/ipc-channels'
import log from '../../main/logger'
import type { LocalProviderConfig } from '../../shared/types'
import type { LocalProviderManager } from './localProviders'
import type { AgentManager } from './agentManager'

export function registerLocalProviderHandlers(
  localProviders: LocalProviderManager,
  agentManager: AgentManager,
): void {
  // When a refresh rebuilds models.json, mirror it into every open workspace so
  // running pi processes can pick up newly-served models.
  localProviders.setOnChange(() => {
    void agentManager.syncLocalModelsToOpenSessions()
  })

  ipcMain.handle(LOCAL_PROVIDERS_LIST, async () => {
    const config = await localProviders.list()
    return { config, statuses: localProviders.getStatuses() }
  })

  ipcMain.handle(LOCAL_PROVIDERS_SAVE, async (_event, config: LocalProviderConfig) => {
    await localProviders.save(config)
  })

  ipcMain.handle(LOCAL_PROVIDERS_REMOVE, async (_event, id: string) => {
    await localProviders.remove(id)
  })

  ipcMain.handle(LOCAL_PROVIDERS_REFRESH, async () => {
    try {
      return await localProviders.refresh()
    } catch (err) {
      log.warn('[ipc.localProviders] refresh failed: %O', err)
      return localProviders.getStatuses()
    }
  })
}
