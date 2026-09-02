const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'zotero-focused-mode', 'toggle.js'),
  'utf8'
);

function createSplitter(state) {
  return {
    dataset: {},
    getAttribute(name) {
      return name === 'state' ? state : null;
    },
    setAttribute(name, value) {
      if (name === 'state') state = value;
    },
    removeAttribute(name) {
      if (name === 'state') state = '';
    }
  };
}

function createToggles(splitter) {
  const document = {
    querySelector(selector) {
      return selector === '#zotero-context-splitter' ? splitter : null;
    }
  };
  const sandbox = {
    Zotero: {
      Reader: { _readers: [] },
      debug() {},
      getMainWindow() {
        return { document };
      }
    }
  };

  vm.runInNewContext(source, sandbox, { filename: 'toggle.js' });
  return sandbox.Toggles;
}

test('ordinary UI restoration does not reopen a manually closed context pane', () => {
  const splitter = createSplitter('collapsed');
  const toggles = createToggles(splitter);

  toggles.states.contextPaneState = 'open';
  toggles.restoreUIElementsOnTabChange();

  assert.equal(splitter.getAttribute('state'), 'collapsed');
});

test('focused mode restores an open context pane', () => {
  const splitter = createSplitter('open');
  const toggles = createToggles(splitter);

  toggles.toggleContextPane(true);
  assert.equal(splitter.getAttribute('state'), 'collapsed');
  toggles.toggleContextPane(false);

  assert.equal(splitter.getAttribute('state'), 'open');
});

test('focused mode preserves an already collapsed context pane', () => {
  const splitter = createSplitter('collapsed');
  const toggles = createToggles(splitter);

  toggles.toggleContextPane(true);
  toggles.toggleContextPane(false);

  assert.equal(splitter.getAttribute('state'), 'collapsed');
});
