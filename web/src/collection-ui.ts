import { mount, unmount } from 'svelte'
import Panel from './collection/Panel.svelte'
import type { PanelOptions } from './collection/types.ts'

/** One open profile owns its requests. Signing is only reachable from the explicit publish control. */
export function setupCollectionPanel(options: PanelOptions) {
  options.host.replaceChildren()
  const panel = mount(Panel, {target: options.host, props: {options}}) as {refresh(): void}
  return { refresh: () => panel.refresh(), close() { void unmount(panel) } }
}
