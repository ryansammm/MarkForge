# desktop-tabs Specification

## Purpose

Specifies the OS-window tab strip that sits above the sidebar in Electron
builds, and the page-picker popover that the strip's `+` button opens.

## Requirements

### Requirement: The tab strip is Electron-only

The strip reads `window.markforge` after mount to decide whether to
render. On the web the component returns `null` — the in-app tab reducer
already covers navigation in that context, and adding a second visual
tab system there would be a duplicate.

#### Scenario: Web mode renders nothing

- **WHEN** `window.markforge` is not present
- **THEN** `DesktopTabBar` returns `null`
- **AND** no DOM is created for the strip or the `+` button

#### Scenario: Electron mode renders the strip

- **WHEN** `window.markforge` is present
- **THEN** the strip mounts above the sidebar
- **AND** the `+` button is visible at the right edge of the strip

### Requirement: State is a flat list with a hard 6-tab cap

The reducer state is `{ tabs: { id, path }[], activeId: string | null }`.
There is no per-tab history, no mode, no persistence — the spec calls
for in-memory only.

#### Scenario: Opening a path activates an existing tab

- **WHEN** `open` is dispatched for a path already in the strip
- **THEN** that tab's id becomes the active id
- **AND** no new tab is created

#### Scenario: Opening a new path appends a tab

- **WHEN** `open` is dispatched for a path not in the strip
- **AND** the current tab count is below the cap
- **THEN** a new tab with the path is appended
- **AND** the new tab becomes active

#### Scenario: The 7th open is refused

- **WHEN** `open` is dispatched for a 7th distinct path
- **THEN** the reducer returns `null` (the action is refused)
- **AND** the React state is unchanged
- **AND** the caller renders a toast: `Max 6 tabs. Close one to open
  another.`

#### Scenario: The `+` button is disabled at the cap

- **WHEN** the tab count equals `MAX_DESKTOP_TABS`
- **THEN** the `+` button is `disabled`
- **AND** its `title` is `Max 6 tabs`

### Requirement: The page-picker popover filters by title

The popover is anchored under the `+` button. It shows the documents
from the live index, filtered case-insensitively by title (and path) as
the user types. Empty results show a `No matches` placeholder. Pressing
`Escape` or clicking outside the popover dismisses it without selecting.

#### Scenario: A title substring match returns that page

- **WHEN** the user types a substring that appears in some document's
  title
- **THEN** the popover lists only documents whose title (or path)
  contains that substring, case-insensitively
- **AND** selecting one dispatches `open` and dismisses the popover

#### Scenario: No matches shows the placeholder

- **WHEN** the search input does not match any document
- **THEN** the popover shows the `No matches` placeholder
- **AND** no row can be picked

### Requirement: In-app `navigateTo` mirrors new-tab opens

The in-app navigation reducer and the desktop tab reducer are two
separate slices. They coordinate through `navigateTo`: every
`newTab: true` open also dispatches `open` on the desktop tab reducer,
so the strip tracks what is on screen.

#### Scenario: A new-tab open grows the strip

- **WHEN** the user opens a page with `newTab: true`
- **THEN** the in-app reducer opens a new tab
- **AND** the desktop tab reducer mirrors it
- **AND** the new desktop tab becomes active

#### Scenario: An in-place open does not grow the strip

- **WHEN** the user opens a page with the default in-place intent
- **THEN** the in-app reducer navigates the active tab
- **AND** the desktop strip only changes its active id to the matching
  tab if one already exists

#### Scenario: First active path seeds one tab

- **WHEN** the workspace mounts with no desktop tabs and a non-null
  active path
- **THEN** a single desktop tab is opened for that path
- **AND** that tab is the active one
