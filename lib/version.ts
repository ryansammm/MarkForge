/**
 * Single source for the version shown in the UI.
 *
 * Kept in lockstep with package.json by hand - one string here beats a build
 * step that reads JSON at import time for the two places it is displayed.
 */
export const APP_VERSION = '1.0.1'

/** The maker's mark, shown beside the version. */
export const APP_SIGNATURE = 'XYKS'
