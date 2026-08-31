import type { Root } from 'mdast'
import type { Plugin } from 'unified'

/**
 * Remark plugin: no-op pass-through.
 *
 * The project stores `toggle_list` as a single-line `- ` bullet
 * whose block-meta comment carries `type:toggle_list`. There are
 * no children in the data model — a toggle is one line, not a
 * container. The read view renders it as a plain bullet; the edit
 * view's `toggle-list-edit.ts` adds the `▶` arrow.
 *
 * Keeping this plugin as a named no-op so the read view's plugin
 * list can advertise "toggle list supported here" and so future
 * children-bearing toggles have a single seam to extend.
 */

export const remarkToggleList: Plugin<[], Root> = function remarkToggleList() {
  return (tree) => {
    void tree
  }
}
