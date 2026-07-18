/*
 * Read-only probe for the Zotero chrome/Browser Console.
 *
 * Load this file in the disposable FocusedMode-Test profile, then call:
 *   FocusedModeDiagnostics.capture('before-entry');
 *   FocusedModeDiagnostics.capture('after-entry-settled');
 *   FocusedModeDiagnostics.capture('before-exit');
 *   FocusedModeDiagnostics.capture('after-exit-settled');
 *
 * The probe deliberately does not toggle focused mode or mutate the DOM.
 */
(function () {
  function attrs(node) {
    if (!node) return null;
    return Object.fromEntries(node.getAttributeNames().sort().map(name => [name, node.getAttribute(name)]));
  }

  function rect(node) {
    if (!node) return null;
    const value = node.getBoundingClientRect();
    return {
      x: value.x, y: value.y, width: value.width, height: value.height,
      top: value.top, right: value.right, bottom: value.bottom, left: value.left
    };
  }

  function nodeState(doc, selector) {
    const node = doc.querySelector(selector);
    if (!node) return null;
    const computed = doc.defaultView.getComputedStyle(node);
    return {
      selector,
      attributes: attrs(node),
      className: node.className || '',
      style: node.getAttribute('style'),
      rect: rect(node),
      computed: {
        display: computed.display,
        margin: computed.margin,
        padding: computed.padding,
        top: computed.top,
        left: computed.left,
        right: computed.right,
        height: computed.height
      }
    };
  }

  function readerState(reader) {
    const doc = reader?._iframeWindow?.document;
    if (!doc) return null;
    return {
      id: reader._itemID || reader._id || null,
      root: nodeState(doc, 'html'),
      toolbar: nodeState(doc, '.toolbar'),
      sidebar: nodeState(doc, '#sidebarContainer'),
      splitView: nodeState(doc, '#split-view'),
      viewer: nodeState(doc, '#viewerContainer'),
      injectedStyle: nodeState(doc, '#toggle-bars-reader-style')
    };
  }

  function pref(key) {
    try {
      return Zotero.Prefs.get(key, true);
    } catch (error) {
      return { error: String(error) };
    }
  }

  function capture(phase, win = Zotero.getMainWindow()) {
    const doc = win.document;
    const toggles = typeof Toggles === 'undefined' ? null : Toggles;
    const snapshot = {
      phase,
      capturedAt: new Date().toISOString(),
      zoteroVersion: Zotero.version,
      platform: Services.appinfo.OS,
      selectedTab: Zotero.Tabs?.selectedID || null,
      window: {
        fullScreen: win.fullScreen,
        screenX: win.screenX,
        screenY: win.screenY,
        outerWidth: win.outerWidth,
        outerHeight: win.outerHeight,
        innerWidth: win.innerWidth,
        innerHeight: win.innerHeight,
        documentElement: nodeState(doc, 'html'),
        mainWindow: nodeState(doc, '#main-window'),
        titleBar: nodeState(doc, '#zotero-title-bar'),
        nativeTitleBar: nodeState(doc, '#titlebar'),
        browser: nodeState(doc, '#browser'),
        contextSplitter: nodeState(doc, '#zotero-context-splitter'),
        fullscreenStyle: nodeState(doc, '#fullscreen-style')
      },
      readers: (Zotero.Reader?._readers || []).map(readerState).filter(Boolean),
      preferences: {
        contextPaneState: pref('extensions.focusedMode.contextPaneState'),
        hideAnnotationBar: pref('extensions.focusedMode.hideAnnotationBar'),
        disableHoverReveal: pref('extensions.focusedMode.disableHoverReveal')
      },
      plugin: toggles && {
        states: { ...toggles.states },
        addedElementIDs: [...(toggles.addedElementIDs || [])],
        shortcutCount: (toggles.registeredShortcuts || []).length,
        mouseListenerCount: toggles.registeredMouseListeners?.size || 0,
        popupObserverCount: toggles.rightClickPopupObservers?.size || 0,
        hasTabListener: Boolean(toggles.tabListener),
        hasTabObserver: Boolean(toggles.tabObserver)
      }
    };
    this.snapshots.push(snapshot);
    Zotero.debug(`Focused Mode diagnostics: ${JSON.stringify(snapshot)}`);
    return snapshot;
  }

  globalThis.FocusedModeDiagnostics = {
    snapshots: [],
    capture,
    export() {
      return JSON.stringify(this.snapshots, null, 2);
    }
  };
})();
