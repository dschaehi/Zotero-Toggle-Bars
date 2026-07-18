Toggles = {
  id: null,
  version: null,
  rootURI: null,
  initialized: false,

  // Track UI states
  states: {
    tabBar: true,
    annotationBar: true,
    fullscreen: false,  // Add tracking for fullscreen state
    fullscreenEnteredByFocusedMode: false,
    focused: false,  // Add tracking for focused mode state
    contextPaneState: null // Add tracking for context pane state
  },

  // The native title-bar attributes belong to the owning Zotero window. Keep
  // their exact pre-focused-mode values until native fullscreen has settled.
  titlebarAttributeSessions: new WeakMap(),
  TITLEBAR_ATTRIBUTES: ['drawintitlebar', 'tabsintitlebar', 'chromemargin'],

  // Constants
  SHORTCUTS: {
    FOCUSED_MODE: {  // Single shortcut for focused mode
      mac: "f",     // Ctrl+Cmd+F on Mac
      other: "F11"  // F11 on Windows/Linux
    }
  },

  // Preference keys
  PREFS: {
    CONTEXT_PANE_STATE: 'extensions.focusedMode.contextPaneState',
    HIDE_ANNOTATION_BAR: 'extensions.focusedMode.hideAnnotationBar',
    DISABLE_HOVER_REVEAL: 'extensions.focusedMode.disableHoverReveal'
  },

  // Track added elements for cleanup
  addedElementIDs: [],
  registeredShortcuts: [],

  init({ id, version, rootURI }) {
    if (this.initialized) return;
    this.id = id;
    this.version = version;
    this.rootURI = rootURI;
    this.initialized = true;

    // Ensure fullscreen CSS is ready
    this.ensureFullscreenCSS();

    // Load saved context pane state
    this.loadSavedContextPaneState();

    // Register tab selection listener
    this.registerTabChangeListener();
  },

  log(msg) {
    Zotero.debug("Focused Mode: " + msg);
  },

  /**
   * Get platform information (Mac vs other)
   * @returns {boolean} True if Mac, false otherwise
   */
  getPlatform() {
    try {
      return Components.classes["@mozilla.org/xre/app-info;1"]
             .getService(Components.interfaces.nsIXULRuntime)
             .OS === "Darwin";
    } catch (e) {
      try {
        return Services.appinfo.OS === "Darwin";
      } catch (e2) {
        this.log("Platform detection failed, assuming Mac");
        return true;
      }
    }
  },

  /**
   * Add keyboard shortcut listener with simplified logic
   * @param {Document} doc - Document to attach listener to
   * @param {string|Object} key - Key to listen for, or object with platform-specific keys
   * @param {Function} callback - Function to call when shortcut triggered
   * @param {Object} options - Additional options
   */
  toggleListener(doc, key, callback, options = {}) {
    let resolvedKey = key;
    if (typeof key === 'object') {
      resolvedKey = this.getPlatform() ? key.mac : key.other;
    }

    this.registeredShortcuts = this.registeredShortcuts || [];
    if (this.registeredShortcuts.some(shortcut => shortcut.doc === doc && shortcut.key === resolvedKey)) {
      return;
    }

    // Create a named function for the event handler so we can track it
    const keydownHandler = (event) => {
      // Get platform information
      const isMac = this.getPlatform();

      // Handle platform-specific keys
      let targetKey = key;
      if (typeof key === 'object') {
        targetKey = isMac ? key.mac : key.other;
      }

      // Always log shortcut attempts for debugging
      this.log(`Key pressed: ${event.key}, ctrl=${event.ctrlKey}, cmd=${event.metaKey}, platform=${isMac ? 'Mac' : 'Other'}`);

      // For Cmd+Ctrl+F on Mac
      if (isMac && targetKey === 'f' && options.requireCtrlCmd &&
          event.ctrlKey && event.metaKey && event.key.toLowerCase() === 'f') {
        this.log("✓ Mac Ctrl+Cmd+F shortcut matched");
        callback();
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      // For F11 on Windows/Linux
      if (!isMac && targetKey === 'F11' && options.f11Special &&
          event.key === 'F11') {
        this.log("✓ F11 shortcut matched on Windows/Linux");
        callback();
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      // For standard Ctrl+key shortcuts
      const keyMatch = event.key.toLowerCase() === targetKey.toLowerCase();
      if (keyMatch && event.ctrlKey &&
          ((isMac && options.requireCtrlCmd && event.metaKey) || // Mac with Cmd
           (!isMac && options.requireCtrlCmd) ||                // Windows/Linux with Ctrl
           (!options.requireCtrlCmd))) {                        // Plain Ctrl shortcut
        this.log(`✓ ${isMac ? 'Mac' : 'Windows/Linux'} shortcut matched for key: ${targetKey}`);
        callback();
        event.preventDefault();
        event.stopPropagation();
      }
    };

    // Add the event listener at document level
    doc.addEventListener('keydown', keydownHandler, true);

    // Store reference to the handler for cleanup
    this.registeredShortcuts.push({
      doc,
      handler: keydownHandler,
      key: resolvedKey
    });
  },

  toggleReaderListeners(window, key, callback, options = {}) {
    const readers = Zotero.Reader?._readers || [];
    for (const reader of readers) {
      const readerDoc = reader?._iframeWindow?.document;
      const ownerWindow = readerDoc?.defaultView?.top || readerDoc?.defaultView;
      if (!readerDoc || ownerWindow !== window) {
        continue;
      }

      this.toggleListener(readerDoc, key, callback, options);
    }
  },

  /**
   * Create menu item with associated command and shortcut
   */
  createMenuItem(doc, { id, l10nId, shortcutKey, callback, requireCtrlCmd = false, f11Special = false }) {
    const menuItem = doc.createXULElement('menuitem');
    menuItem.id = id;
    menuItem.setAttribute('data-l10n-id', l10nId);

    // Create a wrapper that logs execution and only runs when document is viewed
    const wrappedCallback = () => {
      const isViewing = this.isViewingDocument();
      this.log(`Menu item clicked: ${id}, document is being viewed: ${isViewing}`);

      // Remove this condition to make menu items work regardless of document view
      // if (!isViewing) return;

      callback();
    };

    menuItem.addEventListener('command', wrappedCallback);
    this.storeAddedElement(menuItem);

    // Add keyboard shortcut - always register it
    if (shortcutKey) {
      this.toggleListener(doc, shortcutKey, wrappedCallback, {
        requireCtrlCmd,
        f11Special
      });
      this.toggleReaderListeners(doc.defaultView, shortcutKey, wrappedCallback, {
        requireCtrlCmd,
        f11Special
      });
    }

    return menuItem;
  },

  createMenuSeparator(doc, { id }) {
    const separator = doc.createXULElement('menuseparator');
    separator.id = id;
    this.storeAddedElement(separator);
    return separator;
  },

  rightClickMenuItems: new Map(),
  getRightClickMenuItems(doc) {
    const saved = this.rightClickMenuItems.get(doc);
    if (saved) return saved;

    const focusedModeCombinedCallback = () => {
      this.toggleFocusedModeCombined(doc);
      this.log("Focused mode toggle triggered via right-click menu");
    };

    const items = {
      mainItem: this.createMenuItem(doc, {
        id: 'toggle-focused-right-click-main',
        l10nId: 'toggle-focused-right-click',
        callback: focusedModeCombinedCallback,
      }),
      mainSeparator: this.createMenuSeparator(doc, {
        id: 'toggle-focused-right-click-main-sep'
      }),
      readerItem: this.createMenuItem(doc, {
        id: 'toggle-focused-right-click-reader',
        l10nId: 'toggle-focused-right-click',
        callback: focusedModeCombinedCallback,
      }),
      readerSeparator: this.createMenuSeparator(doc, {
        id: 'toggle-focused-right-click-reader-sep'
      }),
    };
    items.mainItem.hidden = !this.states.fullscreen;
    items.mainSeparator.hidden = !this.states.fullscreen;

    this.rightClickMenuItems.set(doc, items);
    return items;
  },

  addMenuItems(doc, manualPopup) {
    try {
      // Find the view popup menu
      const viewPopup = manualPopup
        ? doc.querySelectorAll("menupopup")[2]
        : doc.getElementById('menu_viewPopup');

      if (!viewPopup) {
        this.log("View popup menu not found");
        return;
      }

      // Add focused mode + bars toggle
      const focusedModeCombinedCallback = () => {
        // Always allow focused mode toggle
        this.toggleFocusedModeCombined(doc);

        // Log that it was triggered
        this.log("Focused mode toggle triggered via menu/shortcut");
      };

      const focusedModeCombinedItem = this.createMenuItem(doc, {
        id: 'toggle-focused-combined',
        l10nId: 'toggle-focused-combined',
        shortcutKey: this.SHORTCUTS.FOCUSED_MODE,
        callback: focusedModeCombinedCallback,
        requireCtrlCmd: true,
        f11Special: true
      });
      viewPopup.appendChild(focusedModeCombinedItem);

      // Set up dynamic menu item state updating
      this.setupMenuItemUpdating(doc, [focusedModeCombinedItem]);

      // add right-click menu items
      const { mainItem, mainSeparator } = this.getRightClickMenuItems(doc);
      const mainRightClick = doc.getElementById('zotero-itemmenu');
      mainRightClick?.appendChild(mainSeparator);
      mainRightClick?.appendChild(mainItem);
    } catch (e) {
      this.log(`Error adding menu items: ${e.message}`);
    }
  },

  toggleTabBar(doc, hide) {
    try {
      const forceState = hide !== undefined
      const shouldHide = forceState ? hide : this.states.tabBar;

      const titleBar = doc.getElementById("zotero-title-bar");
      if (!titleBar) {
        this.log("Tab bar element not found");
        return;
      }

      if (shouldHide) {
        titleBar.style.display = "none";
      } else {
        titleBar.removeAttribute("style");
      }

      this.states.tabBar = !shouldHide;
    } catch (e) {
      this.log(`Error toggling tab bar: ${e.message}`);
    }
  },

  toggleAnnotation(hide) {
    try {
      this.log('hide annotation bar = ' + Zotero.Prefs.get(this.PREFS.HIDE_ANNOTATION_BAR, true))

      const forceState = hide !== undefined;
      // Use the provided state or toggle based on current state
      const shouldHide = forceState ? hide : this.states.annotationBar;

      Zotero.Reader._readers.forEach(reader => {
        if (!reader || !reader._iframeWindow) return;

        const doc = reader._iframeWindow.document;
        if (doc.documentElement) {
          doc.documentElement.dataset.hideAnnotationBar ??= this.hideAnnotationBar
        }

        // Save scroll position before modifying styles
        const viewerContainer = doc.getElementById('viewerContainer');
        let savedScrollTop = null;
        let savedScrollLeft = null;
        if (viewerContainer) {
          savedScrollTop = viewerContainer.scrollTop;
          savedScrollLeft = viewerContainer.scrollLeft;
        }

        const styleId = 'toggle-bars-reader-style';
        let style = doc.getElementById(styleId);

        if (shouldHide) {
          // Create or update style to hide elements
          if (!style) {
            style = doc.createElement('style');
            style.id = styleId;
            doc.head.appendChild(style);
          }

          style.textContent = `
            [data-hide-annotation-bar="true"] .toolbar      { display: none !important; }
            [data-hide-annotation-bar="true"] .view-popup   { margin-top: -40px !important; }
            [data-hide-annotation-bar="true"] #sidebarContainer { display: none !important; }
            [data-hide-annotation-bar="true"] #split-view      { top: 0 !important; left: 0 !important; right: 0 !important; }
            [data-hide-annotation-bar="true"] #viewerContainer { top: 0 !important; }
          `;
        } else if (style) {
          // Remove the style element to restore default appearance
          style.remove();
        }

        // Restore scroll position after modifying styles
        if (viewerContainer && savedScrollTop != null) {
          // Use requestAnimationFrame to ensure the DOM has updated
          reader._iframeWindow.requestAnimationFrame(() => {
            viewerContainer.scrollTop = savedScrollTop;
            if (savedScrollLeft != null) {
              viewerContainer.scrollLeft = savedScrollLeft;
            }
          });
        }
      });

      this.states.annotationBar = !shouldHide;

      this.log(`Annotation UI ${this.states.annotationBar ? 'visible' : 'hidden'}`);
    } catch (e) {
      this.log(`Error toggling annotation UI: ${e.message}`);
    }
  },

  // Helper to adjust element style
  adjustElement(element, property, value) {
    if (element) element.style[property] = value;
  },

  // Helper to reset element style
  resetElement(element) {
    if (element) element.removeAttribute("style");
  },

  toggleCombined(doc) {
    try {
      // If tab bar is visible and annotation bar is hidden,
      // only hide the tab bar without showing annotation bar
      if (this.states.tabBar && !this.states.annotationBar) {
        this.toggleTabBar(doc);
      }
      // If both are visible or both are hidden, toggle both
      else if ((this.states.tabBar && this.states.annotationBar) ||
              (!this.states.tabBar && !this.states.annotationBar)) {
        this.toggleTabBar(doc);
        this.toggleAnnotation();
      }
      // If tab bar is hidden and annotation bar is visible,
      // only show tab bar without hiding annotation bar
      else if (!this.states.tabBar && this.states.annotationBar) {
        this.toggleTabBar(doc);
      }

      this.log(`Combined toggle: tab bar ${this.states.tabBar ? 'visible' : 'hidden'}, ` +
               `annotation bar ${this.states.annotationBar ? 'visible' : 'hidden'}`);
    } catch (e) {
      this.log(`Error toggling combined tab bar and annotation bar: ${e.message}`);
    }
  },

  toggleFocusedMode(window) {
    try {
      if (!window) {
        this.log("Error: No window provided to toggleFocusedMode");
        return;
      }

      const enteringFocusedMode = !this.states.focused;

      if (enteringFocusedMode) {
        this.states.fullscreenEnteredByFocusedMode = !window.fullScreen;
        if (this.states.fullscreenEnteredByFocusedMode) {
          window.fullScreen = true;
        }
      } else {
        if (this.states.fullscreenEnteredByFocusedMode && window.fullScreen) {
          window.fullScreen = false;
        }
        this.states.fullscreenEnteredByFocusedMode = false;
      }

      this.states.fullscreen = window.fullScreen;
      this.states.focused = enteringFocusedMode;
      this.log(`Toggled focused mode: ${enteringFocusedMode ? 'enabled' : 'disabled'}`);
    } catch (e) {
      this.log(`Error toggling focused mode: ${e.message}`);
    }
  },

  captureTitlebarAttributes(window, root) {
    if (this.titlebarAttributeSessions.has(window)) {
      return;
    }

    const attributes = {};
    for (const name of this.TITLEBAR_ATTRIBUTES) {
      attributes[name] = {
        present: root.hasAttribute(name),
        value: root.getAttribute(name)
      };
    }
    this.titlebarAttributeSessions.set(window, { attributes });
  },

  restoreTitlebarAttributes(window, root) {
    const session = this.titlebarAttributeSessions.get(window);
    if (!session) {
      return;
    }

    for (const name of this.TITLEBAR_ATTRIBUTES) {
      const saved = session.attributes[name];
      if (saved.present) {
        root.setAttribute(name, saved.value);
      } else {
        root.removeAttribute(name);
      }
    }
    this.titlebarAttributeSessions.delete(window);
  },

  restoreTitlebarAttributesAfterFullscreenExit(window, root, waitForFullscreenExit) {
    const restoreAfterFrame = () => {
      window.requestAnimationFrame(() => this.restoreTitlebarAttributes(window, root));
    };

    if (!waitForFullscreenExit || !window.fullScreen) {
      restoreAfterFrame();
      return;
    }

    const onFullscreen = () => {
      if (!window.fullScreen) {
        restoreAfterFrame();
      }
    };
    window.addEventListener('fullscreen', onFullscreen, { once: true });
  },

  toggleFocusedModeCombined(doc) {
    try {
      if (!doc) {
        this.log("Error: No document provided to toggleFocusedModeCombined");
        return;
      }

      // Get the window from document
      const window = doc.defaultView;
      const wasFullscreen = window.fullScreen;

      // Ensure fullscreen CSS is in place
      this.ensureFullscreenCSS(doc);

      // Toggle fullscreen state
      const enteringFullscreen = !this.states.focused;

      // Apply fullscreen class to root element
      if (enteringFullscreen) {
        this.captureTitlebarAttributes(window, doc.documentElement);
        doc.documentElement.classList.add('fullscreen');
        doc.documentElement.setAttribute('drawintitlebar', true);
        doc.documentElement.setAttribute('tabsintitlebar', true);
        doc.documentElement.setAttribute(
          'chromemargin',
          Zotero.isMac ? '0,-1,-1,-1' : '0,2,2,2'
        );
        this.addMouseListener(doc);
        this.addRightClickMenuItem(doc);
      } else {
        doc.documentElement.classList.remove('fullscreen');
        this.removeMouseListener(doc);
        this.removeRightClickMenuItem(doc);
      }
      this.log(`listener length: ${this.registeredMouseListeners?.size}`);

      if (enteringFullscreen) {
        this.states.fullscreenEnteredByFocusedMode = !wasFullscreen;
        if (this.states.fullscreenEnteredByFocusedMode) {
          window.fullScreen = true;
        }
      } else {
        const exitingNativeFullscreen = this.states.fullscreenEnteredByFocusedMode && window.fullScreen;
        this.restoreTitlebarAttributesAfterFullscreenExit(
          window,
          doc.documentElement,
          exitingNativeFullscreen
        );
        if (this.states.fullscreenEnteredByFocusedMode && window.fullScreen) {
          window.fullScreen = false;
        }
        this.states.fullscreenEnteredByFocusedMode = false;
      }

      this.states.fullscreen = window.fullScreen;
      this.states.focused = enteringFullscreen;

      // Toggle UI elements
      this.toggleTabBar(doc, enteringFullscreen);
      this.toggleAnnotation(enteringFullscreen);
      if (this.hideAnnotationBar) {
        this.toggleContextPane(enteringFullscreen);
      }

      this.log(`Toggled focused mode: ${enteringFullscreen ? 'enabled' : 'disabled'}`);
    } catch (e) {
      this.log(`Error in focused mode combined toggle: ${e.message}`);
    }
  },

  toggleContextPane(hide) {
    try {
      const doc = Zotero.getMainWindow().document;
      const splitter = doc.querySelector('#zotero-context-splitter');
      if (!splitter) {
        this.log("Context pane splitter not found");
        return;
      }

      if (hide) {
        // Store current state before collapsing
        const currentState = splitter.getAttribute('state') || '';
        splitter.dataset.prevState = currentState;
        this.saveContextPaneState(currentState);
        splitter.setAttribute('state', 'collapsed');
        this.log("Context pane hidden");
      } else {
        // Restore previous state
        const prev = splitter.dataset.prevState || this.states.contextPaneState || '';
        if (prev) {
          splitter.setAttribute('state', prev);
        } else {
          splitter.removeAttribute('state');
        }
        delete splitter.dataset.prevState;
        this.log(`Context pane restored to state: ${prev || 'default'}`);
      }
    } catch (e) {
      this.log(`Error toggling context pane: ${e.message}`);
    }
  },

  saveContextPaneState(state) {
    try {
      if (!state) return;
      this.states.contextPaneState = state;
      Zotero.Prefs.set(this.PREFS.CONTEXT_PANE_STATE, state, true);
      this.log(`Saved context pane state: ${state}`);
    } catch (e) {
      this.log(`Error saving context pane state: ${e.message}`);
    }
  },

  loadSavedContextPaneState() {
    try {
      const contextPaneState = Zotero.Prefs.get(this.PREFS.CONTEXT_PANE_STATE, true);
      if (contextPaneState) {
        this.states.contextPaneState = contextPaneState;
        this.log(`Loaded saved context pane state: ${this.states.contextPaneState}`);
      }
    } catch (e) {
      this.log(`Error loading context pane state: ${e.message}`);
    }
  },

  getContextPaneState() {
    try {
      const doc = Zotero.getMainWindow().document;
      const splitter = doc.querySelector('#zotero-context-splitter');
      if (splitter) {
        return splitter.getAttribute('state') || '';
      }
    } catch (e) {
      this.log(`Error getting context pane state: ${e.message}`);
    }
    return '';
  },

  /**
   * A global preference determining whether to hide annotation bar on focused reading mode
   * @type {boolean}
   */
  get hideAnnotationBar() {
    return Zotero.Prefs.get(this.PREFS.HIDE_ANNOTATION_BAR, true) ?? true
  },

  /**
   * A global preference determining whether to disable hover reveal of UI in focused mode
   * @type {boolean}
   */
  get disableHoverReveal() {
    return Zotero.Prefs.get(this.PREFS.DISABLE_HOVER_REVEAL, true) ?? false
  },

  /**
   * Check if a PDF document is currently being viewed
   * @returns {boolean} True if viewing a document, false otherwise
   */
  isViewingDocument() {
    try {
      // Simple and reliable method: check if we're in a reader tab
      if (Zotero.Tabs && Zotero.Tabs.selectedID) {
        const currentTabID = Zotero.Tabs.selectedID;
        const isReaderTab = currentTabID.startsWith('reader-');

        // Add more logging to debug what's happening
        this.log(`Current tab: ${currentTabID}, is reader tab: ${isReaderTab}`);

        return isReaderTab;
      }

      return false;
    } catch (e) {
      this.log(`Error in isViewingDocument: ${e.message}`);
      return false;
    }
  },

  /**
   * Update menu item state based on document viewing status - simplified
   */
  setupMenuItemUpdating(doc, menuItems) {
    // Keep items enabled all the time for now
    this.log("Menu items will remain enabled");

    // We could re-enable this later if needed
    /*
    const updateMenuItems = () => {
      const isViewing = this.isViewingDocument();
      for (const item of menuItems) {
        if (item) {
          item.disabled = false; // Always enabled for testing
        }
      }
    };

    // Initial update
    updateMenuItems();
    */
  },

  registeredMouseListeners: new Map(),

  addMouseListener(doc) {
    // If hover reveal is disabled in preferences, don't add mouse listeners
    if (this.disableHoverReveal) {
      this.log('hover reveal disabled in preferences, skipping mouse listeners');
      return null;
    }

    const listenerElement = doc.querySelector('#browser');
    const fullscreenElement = doc.querySelector('.fullscreen');

    if (!listenerElement || !fullscreenElement) {
      return null;
    }

    let showMenuItemsTimeout = 0;
    const showMenuItems = () => {
      clearTimeout(hideMenuItemsTimeout);
      hideMenuItemsTimeout = 0;
      if (showMenuItemsTimeout > 0) {
        return;
      }
      showMenuItemsTimeout = setTimeout(() => {
        if (!this.states.tabBar) {
          this.toggleTabBar(doc, false);
        }
        if (!this.states.annotationBar) {
          this.toggleAnnotation(false);
        }
        fullscreenElement.classList.remove('fullscreen');
      }, 50);
    };

    let hideMenuItemsTimeout = 0;
    const hideMenuItems = () => {
      clearInterval(showMenuItemsTimeout);
      showMenuItemsTimeout = 0;
      if (hideMenuItemsTimeout > 0) {
        return;
      }
      hideMenuItemsTimeout = setTimeout(() => {
        if (this.states.tabBar) {
          this.toggleTabBar(doc, true);
        }
        if (this.states.annotationBar) {
          this.toggleAnnotation(true);
        }
        fullscreenElement.classList.add('fullscreen');
      }, 150);
    };

    const onMoveListener = (e) => {
      if (e.y < 1) {
        showMenuItems();
      } else if (e.y > 50) {
        hideMenuItems();
      }
    }

    const onLeaveListener = (e) => {
      clearInterval(hideMenuItemsTimeout);
      hideMenuItemsTimeout = 0;
    }

    listenerElement.addEventListener('mousemove', onMoveListener, { passive: true });
    listenerElement.addEventListener('mouseleave', onLeaveListener, { passive: true });

    this.registeredMouseListeners ??= new Map();
    this.registeredMouseListeners.set(doc, [
      {
        handler: onMoveListener,
        target: listenerElement,
      },
      {
        handler: onLeaveListener,
        target: listenerElement,
      }
    ]);
    this.log('added fullscreen mouse listeners');
  },

  removeMouseListener(doc) {
    const listeners = this.registeredMouseListeners?.get(doc);
    if (!listeners) {
      return false
    }
    for (const listener of listeners) {
      listener.target.removeEventListener('mousemove', listener.handler);
    }
    this.registeredMouseListeners.delete(doc);
  },

  rightClickPopupObservers: new Map(),

  addRightClickMenuItem(doc, win = doc?.defaultView) {
    try {
      const { mainItem, mainSeparator, readerItem, readerSeparator } = this.getRightClickMenuItems(doc);
      mainSeparator.hidden = false;
      mainItem.hidden = false;

      const observer = this.rightClickPopupObservers.get(doc)
        || new win.MutationObserver((mutationList) => {
          for (const mutation of mutationList) {
            if (mutation.type === 'childList') {
              const menu = mutation.addedNodes[0];
              if (menu?.tagName?.toLowerCase() === 'menupopup') {
                menu.appendChild(readerSeparator);
                menu.appendChild(readerItem);
              }
            }
          }
        });
      this.rightClickPopupObservers.set(doc, observer);

      // Try multiple selectors to find the popupset for the reader context menu
      // In main window, it's a sibling of browser.reader
      // In standalone/new windows, it might be at a different location
      let readerRightClick = doc.querySelector('browser.reader+popupset');
      
      // Fallback: try to find any popupset in the document (for standalone windows)
      if (!readerRightClick) {
        readerRightClick = doc.querySelector('popupset');
        this.log('Using fallback popupset selector for standalone window');
      }
      
      if (!readerRightClick) {
        this.log('No popupset found for right-click menu');
        return;
      }
      
      observer.observe(readerRightClick, {
        childList: true,
      });
    } catch (e) {
      this.log(`Error adding popup observer: ${e.message}`);
    }
  },

  removeRightClickMenuItem(doc) {
    try {
      const { mainItem, mainSeparator } = this.getRightClickMenuItems(doc);
      mainItem.hidden = true;
      mainSeparator.hidden = true;
      const observer = this.rightClickPopupObservers.get(doc);
      observer?.disconnect();
    } catch (e) {
      this.log(`Error removing popup observer: ${e.message}`);
    }
  },

  addToWindow(window, manualPopup = false) {
    try {
      // Use Fluent for localization
      window.MozXULElement.insertFTLIfNeeded("toggles.ftl");
      this.addMenuItems(window.document, manualPopup);
    } catch (e) {
      this.log(`Error adding to window: ${e.message}`);
    }
  },

  addToAllWindows() {
    try {
      // Add to existing windows
      const windows = Zotero.getMainWindows();
      for (let win of windows) {
        if (win.ZoteroPane) {
          this.addToWindow(win);
        }
      }

      // Add listener for new windows
      const windowListener = {
        onOpenWindow: (aWindow) => {
          const domWindow = aWindow.QueryInterface(Components.interfaces.nsIInterfaceRequestor)
            .getInterface(Components.interfaces.nsIDOMWindow);

          domWindow.addEventListener("load", () => {
            this.addToWindow(domWindow, true);
          }, {once: true});
        }
      };

      Services.wm.addListener(windowListener);
    } catch (e) {
      this.log(`Error adding to all windows: ${e.message}`);
    }
  },

  storeAddedElement(elem) {
    if (!elem.id) {
      throw new Error("Element must have an id");
    }
    this.addedElementIDs.push(elem.id);
  },

  removeFromWindow(window) {
    try {
      const doc = window.document;

      // Clear menu update intervals
      if (this.menuUpdateIntervals) {
        for (let intervalId of this.menuUpdateIntervals) {
          window.clearInterval(intervalId);
        }
        this.menuUpdateIntervals = [];
      }

      // Remove keyboard event listeners
      if (this.registeredShortcuts) {
        this.registeredShortcuts = this.registeredShortcuts.filter((shortcut) => {
          const shortcutWindow = shortcut.doc?.defaultView?.top || shortcut.doc?.defaultView;
          const belongsToWindow = shortcut.doc === doc || shortcutWindow === window;

          if (belongsToWindow && shortcut.handler) {
            shortcut.doc.removeEventListener('keydown', shortcut.handler, true);
          }

          return !belongsToWindow;
        });
      }

      // Remove all elements added to DOM
      for (let id of this.addedElementIDs) {
        const element = doc.getElementById(id);
        if (element) element.remove();
      }

      // Remove localization
      const ftlLink = doc.querySelector('[href="toggles.ftl"]');
      if (ftlLink) ftlLink.remove();
    } catch (e) {
      this.log(`Error removing from window: ${e.message}`);
    }
  },

  removeFromAllWindows() {
    // Clean up tab listener if it exists
    if (this.tabListener && Zotero.Tabs && typeof Zotero.Tabs.removeListener === 'function') {
      Zotero.Tabs.removeListener(this.tabListener);
    }

    // Clean up mutation observer if it exists
    if (this.tabObserver) {
      this.tabObserver.disconnect();
    }

    // Existing code
    const windows = Zotero.getMainWindows();
    for (let win of windows) {
      if (win.ZoteroPane) {
        this.removeFromWindow(win);
      }
    }
  },

  registerTabChangeListener() {
    try {
      // Method 1: Use Zotero's Tabs API
      if (Zotero.Tabs && typeof Zotero.Tabs.addListener === 'function') {
        this.tabListener = {
          onSelect: (tab) => {
            this.restoreUIElementsOnTabChange();
          }
        };
        Zotero.Tabs.addListener(this.tabListener);
        this.log("Tab change listener registered via API");
      }

      // Method 2: Enhanced keyboard shortcut monitoring for tab navigation
      const windows = Zotero.getMainWindows();
      for (let win of windows) {
        if (win.ZoteroPane) {
          // Monitor keyboard events at the capturing phase
          win.document.addEventListener('keydown', (event) => {
            // Check for tab navigation shortcuts (Cmd+Shift+[ or ], Cmd+number)
            if ((event.metaKey && event.shiftKey && (event.key === '[' || event.key === ']')) ||
                (event.metaKey && /^\d$/.test(event.key))) {
              // Longer delay to ensure tab change completes
              setTimeout(() => this.restoreUIElementsOnTabChange(), 50);
            }
          }, true);

          // Also watch for keyup events
          win.document.addEventListener('keyup', (event) => {
            if ((event.metaKey && event.shiftKey && (event.key === '[' || event.key === ']')) ||
                (event.metaKey && /^\d$/.test(event.key))) {
              setTimeout(() => this.restoreUIElementsOnTabChange(), 50);
            }
          }, true);

          // Method 3: Monitor tab element clicks directly
          const tabList = win.document.getElementById("zotero-tab-toolbar");
          if (tabList) {
            tabList.addEventListener('click', () => {
              setTimeout(() => this.restoreUIElementsOnTabChange(), 50);
            }, true);
          }

          // Method 4: Broader mutation observer for tab changes
          const mainWindow = win.document.getElementById("main-window");
          if (mainWindow) {
            this.tabObserver = new MutationObserver((mutations) => {
              for (const mutation of mutations) {
                // Look for relevant changes to detect tab switching
                if (mutation.type === 'attributes' &&
                    (mutation.attributeName === 'selected' ||
                     mutation.attributeName === 'class')) {
                  setTimeout(() => this.restoreUIElementsOnTabChange(), 50);
                  break;
                }
              }
            });

            // Configure observer with appropriate options
            this.tabObserver.observe(mainWindow, {
              attributes: true,
              subtree: true,
              attributeFilter: ['selected', 'class']
            });

            this.log("Tab mutation observer configured");
          }

          // Method 5: Use window's hashchange event
          win.addEventListener('hashchange', () => {
            setTimeout(() => this.restoreUIElementsOnTabChange(), 50);
          });
        }
      }
    } catch (e) {
      this.log(`Error registering tab change listener: ${e.message}`);
    }
  },

  restoreUIElementsOnTabChange() {
    try {
      // Get main window document
      const doc = Zotero.getMainWindow().document;

      // If we're in fullscreen/focused mode, leave elements hidden
      if (this.states.focused) {
        return;
      }

      // Otherwise restore all UI elements to visible
      if (!this.states.tabBar) {
        this.toggleTabBar(doc);
        this.log("Tab bar restored on tab change");
      }

      // Restore annotation bar if hidden
      if (!this.states.annotationBar) {
        Zotero.Reader._readers.forEach(reader => {
          if (!reader || !reader._iframeWindow) return;

          const rdoc = reader._iframeWindow.document;
          const style = rdoc.getElementById('toggle-bars-reader-style');
          if (style) style.remove();

          // Restore annotation bar
          this.resetElement(rdoc.querySelector(".toolbar"));
          this.resetElement(rdoc.querySelector("#split-view"));
          this.resetElement(rdoc.querySelector("#viewerContainer"));
          this.resetElement(rdoc.querySelector("#sidebarContainer"));
        });

        this.states.annotationBar = true;
        this.log("Annotation bar restored on tab change");
      }

      // Restore context pane using saved state
      const splitter = doc.querySelector('#zotero-context-splitter');
      if (splitter && splitter.getAttribute('state') === 'collapsed' && this.states.contextPaneState) {
        // Only restore if we have a saved state and the pane is currently collapsed
        splitter.setAttribute('state', this.states.contextPaneState);
        this.log(`Context pane restored to saved state: ${this.states.contextPaneState}`);
      }
    } catch (e) {
      this.log(`Error restoring UI elements: ${e.message}`);
    }
  },

  debugTabChangeHandling() {
    this.log("DEBUG: Testing tab change handling");
    this.log(`Current state - tabBar: ${this.states.tabBar}, annotationBar: ${this.states.annotationBar}, focused: ${this.states.focused}`);
    this.restoreUIElementsOnTabChange();
    this.log("DEBUG: Tab change handling test complete");
  },

  ensureFullscreenCSS(doc) {
    try {
      const targetDoc = doc || Zotero.getMainWindow().document;
      if (targetDoc.getElementById('fullscreen-style')) return;

      const style = targetDoc.createElement('style');
      style.id = 'fullscreen-style';
      style.textContent = `
        .fullscreen { margin: 0; padding: 0; overflow: hidden; }
        .fullscreen #mainPane { width: 100vw; height: 100vh; }
        .fullscreen .zotero-toolbar,
        .fullscreen .zotero-tb-button,
        .fullscreen #zotero-title-bar,
        .fullscreen #main-menubar,
        .fullscreen #titlebar,
        .fullscreen .topbar { display: none !important; }
      `;
      targetDoc.documentElement.appendChild(style);
      this.storeAddedElement(style);
      this.log("Added fullscreen CSS");
    } catch (e) {
      this.log(`Error adding fullscreen CSS: ${e.message}`);
    }
  },

  async main() {
    // Plugin initialization complete
    this.log("Focused Mode plugin initialized");
    
    // If we're in reader mode, apply the saved context pane state
    setTimeout(() => {
      try {
        if (this.isViewingDocument() && this.states.contextPaneState) {
          const doc = Zotero.getMainWindow().document;
          const splitter = doc.querySelector('#zotero-context-splitter');
          if (splitter) {
            splitter.setAttribute('state', this.states.contextPaneState);
            this.log(`Applied saved context pane state on startup: ${this.states.contextPaneState}`);
          }
        }
      } catch (e) {
        this.log(`Error applying saved context pane state: ${e.message}`);
      }
    }, 1000); // Wait a bit to ensure Zotero is fully loaded
  }
};
