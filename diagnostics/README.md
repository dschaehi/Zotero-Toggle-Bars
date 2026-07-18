# Focused Mode diagnostics and reproduction

This commit is diagnostic only. It adds no lifecycle, state-restoration, or
fullscreen behavior change.

## Test isolation and build

Use a fresh profile and an explicit data directory; a profile alone is not
sufficient because Zotero can retain a separate `extensions.zotero.dataDir`.

```sh
test_root=/private/tmp/FocusedMode-Test
mkdir -p "$test_root/data" "$test_root/extensions"
bash build.sh
cp build/zotero-focused-mode.xpi "$test_root/extensions/zotero-focused-mode@jaeheelee.de.xpi"
open -na /Applications/Zotero.app --args -profile "$test_root"
```

Create `$test_root/user.js` before launch with these two lines:

```js
user_pref("extensions.zotero.useDataDir", true);
user_pref("extensions.zotero.dataDir", "/private/tmp/FocusedMode-Test/data");
```

Before testing, check that `prefs.js` contains the same `/private/tmp` data
path, that `data/zotero.sqlite` has no user items, and that no sync username or
sync-server preferences are set. Enable the listed add-on through Zotero's
Add-ons Manager; a manually copied XPI is initially disabled as a sideloaded
add-on on this Zotero build.

## State capture

Load `zotero-state-probe.js` in Zotero's chrome/Browser Console. It is
read-only: it neither invokes focused mode nor changes DOM, preferences, or
window state. Save the result of `FocusedModeDiagnostics.export()` as JSON
after this sequence:

1. `capture('before-entry')`.
2. Enter focused mode and wait for fullscreen transition completion; then
   `capture('after-entry-settled')`.
3. `capture('before-exit')`.
4. Leave focused mode and wait for transition completion; then
   `capture('after-exit-settled')`.

For screenshots, fix the window size and use the same upper-left rectangle for
each phase (for example, `screencapture -R x,y,width,height output.png`). Do
not compare full-window captures, because different fullscreen spaces can move
the window even when title-bar geometry is unchanged.

Run that sequence for every cell below, plus ten consecutive cycles in the
ordinary-library cell. Record a screenshot and JSON file for each cell.

| Window | Selected tab | Required additional checks |
| --- | --- | --- |
| ordinary | library | ten cycles; tab switch while focused |
| ordinary | PDF reader | hover reveal; annotation preference both values |
| maximized | library | new second window |
| maximized | PDF reader | plug-in shutdown while focused |

Also record interrupted fullscreen transitions, an initially-fullscreen window,
and whether listener/observer counts grow across the cycles.

## Lifecycle inventory (source evidence)

`bootstrap.js` loads `toggle.js`, initializes global `Toggles`, installs UI in
existing windows, and registers future-window handling. Shutdown only calls
`removeFromAllWindows()`.

| Area | Entry mutation | Exit/cleanup behavior | Diagnostic concern |
| --- | --- | --- | --- |
| Root chrome | Adds `fullscreen`; sets `drawintitlebar="true"`, `tabsintitlebar="true"`, and `chromemargin` to `0,-1,-1,-1` on macOS | Removes only `fullscreen` | The three attributes have no exit write or restore path. |
| Native fullscreen | Sets `window.fullScreen=true` only when it was initially false | Sets it false only when focused mode entered it | Transition timing is not awaited before later UI mutation. |
| Title/tab bar | Sets `#zotero-title-bar.style.display="none"` | Removes the entire `style` attribute | This can erase unrelated inline properties and does not preserve absence/property-level state. |
| Reader UI | Sets `data-hide-annotation-bar` if absent; injects `#toggle-bars-reader-style`; preserves scroll positions | Removes the injected style; data attribute remains | Existing data value is not snapshotted/restored. |
| Context pane | Saves splitter `state` to `dataset.prevState`; collapses it; persists a nonempty state in a pref | Restores state or removes it; deletes `dataset.prevState` | Pref intentionally outlives the transaction. |
| Hover/reveal | Adds two listeners to `#browser`; toggles title/reader UI and root class on timers | Removes listeners on normal focused-mode exit | Timers are not cancelled on exit; listener state is global, not per window. |
| Context menus | Shows menu items and observes a popup set | Hides items and disconnects observer | Observer object remains in the map; shutdown does not call this cleanup. |
| Startup UI | Adds menu elements and shortcut handlers | Removes tracked shortcut handlers and IDs from one window | `addedElementIDs` is global, so multi-window cleanup is not per-window. |
| Tab change | Registers a Zotero Tabs listener, anonymous keyboard/click/hashchange listeners, and a mutation observer | Removes only the Tabs listener and latest stored observer | Anonymous listeners, `hashchange`, and window-manager listener lack cleanup paths. |

## Static pre-test comparison

This is source evidence, not a claim of GUI reproduction. The entry branch at
`toggle.js:463-469` writes these exact root attributes on macOS:

```json
{
  "drawintitlebar": "true",
  "tabsintitlebar": "true",
  "chromemargin": "0,-1,-1,-1"
}
```

The paired exit branch at `toggle.js:472-475` removes the `fullscreen` class
and cleanup listeners/menus, but does not set, remove, or restore any of those
attributes. A before/after probe showing those attributes absent or different
before entry and present with the listed values after exit would support the
leading hypothesis. Identical attributes after exit would falsify this direct
restoration explanation for that configuration.

Competing explanations to test:

- Native fullscreen transition timing can leave AppKit title-bar layout stale;
  capture at multiple settled delays and compare an initially-fullscreen run.
- Whole-style removal can shift layout if Zotero or another add-on had an
  inline title-bar style before entry; seed a non-display style and compare it.
- Hover-reveal's 50/150 ms timers can race exit; repeat with hover reveal both
  enabled and disabled and capture during an interrupted transition.
- Global (not per-window) state can apply a transition from one window to
  another; compare first and second windows and their listener counts.

The evidence that would falsify all source-derived explanations is a clean
before/after JSON equality for plugin-controlled properties plus a persistent
pixel displacement in same-rectangle title-bar screenshots.

## Execution record: 2026-07-18

- `bash build.sh` completed and produced `build/zotero-focused-mode.xpi`
  (SHA-256 `ec84e3aa0d4c9f6fd72d31a795fdb498c6b2e50cc2bed5ae3ed65a9e12675eb5`).
- A new `/private/tmp/FocusedMode-Test` profile was created. An initial launch
  exposed Zotero's unsafe default data-directory preference (`/Users/jae/Zotero`),
  so that session was stopped before any focused-mode interaction. The corrected
  profile uses `/private/tmp/FocusedMode-Test/data`; its live `prefs.js` confirms
  that path and no sync-account preferences were present.
- Zotero 9.0.6 recognized the XPI, but marked it `active:false` and
  `userDisabled:true` as a sideloaded add-on. Host privacy policy denied both
  display capture and accessibility inspection, so the add-on could not be
  enabled through its own UI and no mode toggle, screenshot, or runtime JSON
  was fabricated.

The later runtime pass, after Computer Use became available, is recorded in
[`runtime-evidence.md`](runtime-evidence.md). It enabled the same XPI through
Plugins Manager and contains the actual GUI state captures, title-bar images,
and temporary-console intervention results.
