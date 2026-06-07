# BUG: Session Search and Preview Pane Issues

## Summary

Two related bugs affecting the TUI session list dialogs:

1. **Session search broken** - Typing in the search box does not filter results; all sessions continue to display
2. **Preview pane doesn't update** (experimental only) - Side panel preview stalls when navigating session list

---

## Bug #1: Session Search Does Not Filter Results

### Description

When searching in the session list dialog (`/sessions` command), typing a search query appears to do nothing. Sessions that don't match the query are still displayed as if no filtering occurred.

### Affected Components

- `DialogSessionList` (basic session list - always active)
- `SessionSwitcherDialog` (experimental - when `OPENCODE_EXPERIMENTAL_SESSION_SWITCHER=1`)

### Expected Behavior

- Typing a search term filters sessions by title
- Empty results should display "No results found" message

### Actual Behavior

- All sessions continue to be displayed regardless of search query
- Appears as if search has no effect

### Root Cause

Both dialogs use `skipFilter={true}` on `DialogSelect`, which bypasses client-side filtering. They rely entirely on server-side search via API calls:

```tsx
const [searchResults, { refetch }] = createResource(
  () => ({ query: search(), filter: sync.session.query() }),
  async (input) => {
    if (!input.query) return undefined
    const result = await sdk.client.session.list({ search: input.query, limit: 30, ...input.filter })
    return result.data ?? []
  },
)

const sessions = createMemo(() => searchResults() ?? sync.data.session)
```

When the API returns an empty array or encounters an error, the fallback `sync.data.session` shows ALL unfiltered sessions, giving the impression that search does nothing.

### Related Code

- `packages/opencode/src/cli/cmd/tui/component/dialog-session-list.tsx` (line 232: `skipFilter={true}`)
- `packages/opencode/src/cli/cmd/tui/feature-plugins/session/dialog.tsx` (line 255: `skipFilter={true}`)

### Reproduction Steps

1. Run `opencode` (or `OPENCODE_EXPERIMENTAL_SESSION_SWITCHER=1 opencode` for experimental version)
2. Type `/sessions` to open session list
3. Type a search term that doesn't match any session titles
4. Observe: All sessions are still displayed

### Proposed Fixes

**Option A (Simplest): Remove `skipFilter={true}`**

Delete line 255 from `dialog.tsx` and line 232 from `dialog-session-list.tsx`.

**How it works:**
- User types → `onFilter={setSearch}` fires API call (server-side filtering)
- **Also:** DialogSelect applies fuzzysort on `props.options` using `store.filter`
- If API returns empty `[]` → `options()` = `[]` → fuzzysort on empty array = `[]` → shows "No results found" ✅
- If API fails/never updates → fallback still works because `sync.data.session` has all sessions, and **client-side fuzzysort** handles filtering

**Pros:**
- Simplest change (delete 2 lines total)
- Provides redundant filtering layers (server + client)
- Minimal risk

**Cons:**
- Dual filtering might seem redundant
- Slight performance impact with very large session lists

---

**Option B (More Complex): Keep `skipFilter={true}` but add proper fallback**

1. Change `searchResults()` resource to return `undefined` on empty results instead of `[]`
2. Add explicit "No results found" check in `options()` memo
3. Add error handling for API failures

**Pros:**
- Keeps server-only filtering as designed
- More explicit control over UX states

**Cons:**
- More complex changes
- Requires changes in multiple places
- Still relies on server-side search working correctly

---

## Bug #2: Session Switcher Preview Pane Doesn't Update

### Description

In the experimental session switcher dialog, the preview pane on the right side doesn't update to show details for the currently selected session while navigating up/down the list with arrow keys, even when stopping on a session for extended periods (>150ms).

### Affected Components

- `SessionSwitcherDialog` only (experimental, enabled via `OPENCODE_EXPERIMENTAL_SESSION_SWITCHER=1`)

### Expected Behavior

- When selecting a session in the list, preview pane immediately (or after brief debounce) displays that session's details, recent messages, and file diffs

### Actual Behavior

- Preview pane remains stuck showing previous session or empty state
- Does not update even when pausing on a new session for more than 150ms

### Suspected Root Cause

The `scheduleFocused` function uses a debounced signal with 150ms delay:

```tsx
const [focusedSession, setFocusedSession, scheduleFocused] = createLeadingTrailingSignal<string | undefined>(
  undefined,
  150,
)
```

The `onMove` handler calls `scheduleFocused(option.value)`, but the debounced signal may not be triggering reactivity properly in the `SessionPreviewPane` component.

### Related Code

- `packages/opencode/src/cli/cmd/tui/feature-plugins/session/dialog.tsx:54-57` (debounced signal creation)
- `packages/opencode/src/cli/cmd/tui/feature-plugins/session/dialog.tsx:259-261` (onMove handler)
- `packages/opencode/src/cli/cmd/tui/feature-plugins/session/preview-pane.tsx:51-56` (createLeadingTrailingSignal)

### Reproduction Steps

1. Run `OPENCODE_EXPERIMENTAL_SESSION_SWITCHER=1 opencode`
2. Type `/sessions` to open experimental session switcher
3. Use arrow keys to navigate up/down the session list
4. Pause on a session for >150ms
5. Observe: Preview pane does not update to show that session's details

### Proposed Fix

- Investigate why debounced signal isn't triggering reactivity
- Consider using immediate setter (`setFocusedSession`) instead of debounced (`scheduleFocused`) for onMove
- Add debug logging to verify signal updates are firing

---

## Investigation Notes

### Timeline

- **Dec 23, 2025**: `skipFilter={true}` introduced in PR #6053 to fix model selector favorites disappearing when filtering
- **May 11, 2026**: Session quick-switch added in PR #26858, copied `skipFilter={true}` pattern
- **May 29, 2026**: Session switcher plugin added in PR #29861, also used `skipFilter={true}`
- **Present**: Both bugs present in v1.16.2 release

### Why Model Selector Works

The model selector (`dialog-model.tsx`) also uses `skipFilter={true}` but works correctly because:
- It performs **client-side fuzzysort filtering** inside the `options()` memo
- `onFilter={setQuery}` fires but is unnecessary (filtering happens in options memo)
- No server dependency means no fallback issues

### Why Session Dialogs Fail

Session dialogs rely on **server-side search** via API:
- `onFilter={setSearch}` triggers API call to `sdk.client.session.list({ search: query })`
- No client-side fallback filtering
- When API returns empty/error → shows ALL sessions via fallback
- User sees no visual indication that search "worked"

---

## Next Steps

- [x] **FIXED:** Implement fix for Issue #1 (remove skipFilter)
  - Applied to: `dialog-session-list.tsx:232`, `session/dialog.tsx:255`
  - GitHub Issue: #31182 - https://github.com/anomalyco/opencode/issues/31182
  - Binary version: 1.16.2-oc
- [ ] File GitHub Issue #2: Preview pane doesn't update
- [ ] Investigate and fix Issue #2 (debounce reactivity)

---

## Fix Applied (Bug #1)

**Date:** 2026-06-07  
**Changes:**
- Removed `skipFilter={true}` from `dialog-session-list.tsx:232`
- Removed `skipFilter={true}` from `session/dialog.tsx:255`

**Build procedure followed:**
```bash
cd /root/opencode/opencode/repos/opencode
git checkout v1.16.2
# Apply fix (remove skipFilter={true} from both files)
cd packages/opencode
OPENCODE_VERSION="1.16.2-oc" OPENCODE_CHANNEL="latest" bun run build
cp dist/opencode-linux-x64/bin/opencode /tmp/oc-new && mv /tmp/oc-new /usr/local/bin/oc
```

**How it works:**
- Server-side API search still fires via `onFilter={setSearch}`
- DialogSelect now applies client-side fuzzysort as backup
- If API returns empty results → `options()` returns `[]` → fuzzysort on empty array = `[]` → shows "No results found"
- If API fails → `sync.data.session` fallback + client-side filtering still works

**Test binary:** `1.16.2-oc` installed at `/usr/local/bin/oc`

---

## Related Issues

- No existing GitHub issues for these specific bugs
- Issue #31125: "TUI sessions dialog can stay empty if opened before session list loads" (different issue)
- Issue #16733: "TUI /sessions only show sessions from last 30 days" (pruning, not search)
