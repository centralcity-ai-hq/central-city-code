import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getEffectiveTheme,
  getStoredThemePreference,
  getSystemTheme,
  watchSystemTheme,
} from '../src/shell/theme.js';

/*
 * "System" theme (no stored choice) follows the device's light/dark setting, live; an explicit
 * stored choice or ?theme= wins. The browser globals are stubbed per test and removed after.
 */

type Listener = () => void;

function stubWindow(options: { dark: boolean; stored?: string | null; search?: string }) {
  const listeners: Listener[] = [];
  const media = {
    get matches() {
      return state.dark;
    },
    addEventListener: (_type: string, listener: Listener) => listeners.push(listener),
  };
  const store = new Map<string, string>();
  if (options.stored) store.set('cc-theme', options.stored);
  const state = { dark: options.dark };
  const win = {
    location: { search: options.search ?? '' },
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
    matchMedia: (query: string) => {
      assert.equal(query, '(prefers-color-scheme: dark)');
      return media;
    },
  };
  (globalThis as { window?: unknown }).window = win;
  return {
    store,
    setDark(dark: boolean) {
      state.dark = dark;
      listeners.forEach((listener) => listener());
    },
    listeners,
  };
}

function stubDocument() {
  const meta: Record<string, string> = {};
  const root = { dataset: {} as Record<string, string>, style: {} as Record<string, string> };
  (globalThis as { document?: unknown }).document = {
    documentElement: root,
    querySelector: (selector: string) => ({
      setAttribute: (_name: string, value: string) => void (meta[selector] = value),
    }),
    querySelectorAll: () => [],
  };
  return { root, meta };
}

function restore() {
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
}

test('with no stored choice the theme follows the device setting', (t) => {
  t.after(restore);
  stubWindow({ dark: true });
  assert.equal(getStoredThemePreference(), 'system');
  assert.equal(getSystemTheme(), 'dark');
  assert.equal(getEffectiveTheme(), 'dark');
  stubWindow({ dark: false });
  assert.equal(getSystemTheme(), 'light');
  assert.equal(getEffectiveTheme(), 'light');
});

test('a stored choice or ?theme= wins over the device setting', (t) => {
  t.after(restore);
  stubWindow({ dark: true, stored: 'light' });
  assert.equal(getEffectiveTheme(), 'light');
  stubWindow({ dark: false, stored: 'dark' });
  assert.equal(getEffectiveTheme(), 'dark');
  stubWindow({ dark: true, stored: 'dark', search: '?theme=light' });
  assert.equal(getEffectiveTheme(), 'light');
});

test('without matchMedia the system theme is light', (t) => {
  t.after(restore);
  (globalThis as { window?: unknown }).window = { location: { search: '' } };
  assert.equal(getSystemTheme(), 'light');
});

test('a live device change re-applies the theme only while no theme is chosen', (t) => {
  t.after(restore);
  const device = stubWindow({ dark: false });
  const { root, meta } = stubDocument();
  watchSystemTheme();
  watchSystemTheme(); // registered once
  assert.equal(device.listeners.length, 1);

  device.setDark(true);
  assert.equal(root.dataset.theme, 'dark');
  assert.equal(root.style.colorScheme, 'dark');
  assert.equal(meta['meta[name="color-scheme"]'], 'dark');
  assert.equal(meta['meta[name="theme-color"]'], '#0c1426');

  device.setDark(false);
  assert.equal(root.dataset.theme, 'light');

  // An explicit choice: the device change is ignored.
  device.store.set('cc-theme', 'dark');
  root.dataset.theme = 'dark';
  device.setDark(false);
  assert.equal(root.dataset.theme, 'dark');
});
