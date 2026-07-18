# Runtime evidence — macOS 26.5.2 / Zotero 9.0.6

All runtime work used the disposable `FocusedMode-Test` profile. Its active
data directory was `/private/tmp/FocusedMode-Test/data`; its empty database had
no user items before the test and no Zotero Sync account preferences. The
development XPI was enabled through Zotero's Plugins Manager as version 0.6.2
(`active: true`, `userDisabled: false`). No production source was changed.

## Ordinary library window

The four-phase state files show the expected entry mutations and their leak on
exit:

| Phase | fullScreen | drawintitlebar | tabsintitlebar | chromemargin | root class | title-bar style |
| --- | --- | --- | --- | --- | --- | --- |
| before entry | false | absent | absent | absent | absent | absent |
| after entry | true | `true` | `true` | `0,-1,-1,-1` | `fullscreen` | `display: none;` |
| after exit | false | `true` | `true` | `0,-1,-1,-1` | empty | absent |

The same-size title-bar crops show no ordinary-window displacement: the red
traffic-light centroid was `(18.5, 17.5)` before entry, after exit, and after
temporarily removing the leaked attributes. The leaked state is therefore not
sufficient to create the visual regression in this geometry.

## Maximized library window — reproduced

The maximized four-phase state records have the same attribute leak. Here it
correlates with the visual defect:

| Image | Red traffic-light centroid | Result |
| --- | --- | --- |
| before entry | `(13.2, 12.4)` | baseline |
| after exit | `(13.2, 8.6)` | 3.8 px upward shift |
| after temporary removal of all leaked attributes | `(13.2, 12.4)` | exact baseline return |

The temporary intervention used Zotero's JavaScript runner only. It removed
`drawintitlebar`, `tabsintitlebar`, and `chromemargin` from the main XUL root;
no plugin source or installed XPI was changed.

Individual intervention results in the maximized normal window:

| Temporary state | Centroid | Interpretation |
| --- | --- | --- |
| `drawintitlebar="true"` only | `(13.2, 12.4)` | no shift |
| `tabsintitlebar="true"` only | `(13.2, 12.4)` | no shift |
| `chromemargin="0,-1,-1,-1"` only | `(13.2, 12.4)` | no shift |
| all three after focused-mode exit | `(13.2, 8.6)` | shift reproduced |

After ten additional command-driven cycles, the three attributes still leaked
but the centroid was back at `(13.2, 12.4)`. This rules out a simple
"attributes present equals shifted" model and supports native fullscreen
transition timing or an AppKit layout-state interaction as a contributing
condition.

## Evidence files

- `ordinary-library-*.json` and `maximized-library-*.json` are structured
  state captures from Zotero's JavaScript runner.
- `titlebar/*.png` are identical `420×90` upper-left crops extracted from
  Computer Use screenshots.
- The full-window PNGs preserve the original visual context for each crop.

## Not executed

PDF-reader ordinary/maximized configurations, tab switching, a second window,
plug-in shutdown while focused, and controlled hover-timer interruptions remain
unexecuted. The native file picker repeatedly selected the pre-existing XPI
instead of the disposable PDF fixture under desktop automation, so the reader
test was stopped rather than alter the test workflow further.
