/*
 * A small stand-in for React's hooks, so a component's effects can be tested under Node without
 * a DOM renderer (tests/helpers/hook-render.ts loads it in place of 'react' for files in src/).
 * A component is called as a function; its hooks keep their state in slots by call order, the
 * way React does, and its effects run after each render when their dependencies change, with the
 * previous cleanup first. State setters mark the component for another render (flush()).
 * Everything that is not a hook is React's own.
 */
import * as React from 'react';

// React's own non-hook exports, for the src modules that import them.
export const {
  Children,
  Component,
  Fragment,
  PureComponent,
  StrictMode,
  Suspense,
  cloneElement,
  createContext,
  createElement,
  createRef,
  forwardRef,
  isValidElement,
  lazy,
  memo,
  startTransition,
  use,
} = React;

type Deps = readonly unknown[] | undefined;
interface EffectSlot {
  deps: Deps;
  cleanup?: (() => void) | void;
}

interface Instance {
  slots: unknown[];
  index: number;
  pending: Array<{ slot: EffectSlot; run: () => (() => void) | void }>;
  dirty: boolean;
}

let current: Instance | null = null;

function slot<T>(make: () => T): T {
  if (!current) throw new Error('A hook was called outside a test render');
  const at = current.index++;
  if (at >= current.slots.length) current.slots.push(make());
  return current.slots[at] as T;
}

function changed(before: Deps, after: Deps) {
  if (!before || !after || before.length !== after.length) return true;
  return before.some((value, at) => !Object.is(value, after[at]));
}

export function useState<T>(initial: T | (() => T)) {
  const owner = current!;
  const state = slot(() => {
    const box = {
      value: typeof initial === 'function' ? (initial as () => T)() : initial,
      set: (next: T | ((value: T) => T)) => {
        const value =
          typeof next === 'function' ? (next as (value: T) => T)(box.value) : (next as T);
        if (Object.is(value, box.value)) return;
        box.value = value;
        owner.dirty = true;
      },
    };
    return box;
  });
  return [state.value, state.set] as const;
}

export function useReducer<S, A>(reducer: (state: S, action: A) => S, initial: S) {
  const [state, set] = useState(initial);
  return [state, (action: A) => set((value) => reducer(value, action))] as const;
}

export function useRef<T>(initial: T) {
  return slot(() => ({ current: initial }));
}

function effect(run: () => (() => void) | void, deps?: Deps) {
  const owner = current!;
  let fresh = false;
  const state = slot<EffectSlot>(() => {
    fresh = true;
    return { deps };
  });
  if (fresh || changed(state.deps, deps)) {
    state.deps = deps;
    owner.pending.push({ slot: state, run });
  }
}

export const useEffect = effect;
export const useLayoutEffect = effect;
export const useInsertionEffect = effect;

export function useMemo<T>(make: () => T, deps: Deps) {
  const memo = slot(() => ({ deps: undefined as Deps, value: undefined as T, set: false }));
  if (!memo.set || changed(memo.deps, deps)) {
    memo.value = make();
    memo.deps = deps;
    memo.set = true;
  }
  return memo.value;
}

export function useCallback<T>(callback: T, deps: Deps) {
  return useMemo(() => callback, deps);
}

let ids = 0;
export function useId() {
  return slot(() => `:t${++ids}:`);
}

export function useContext<T>(context: React.Context<T>): T {
  return (context as unknown as { _currentValue: T })._currentValue;
}

export function useSyncExternalStore<T>(_subscribe: unknown, getSnapshot: () => T) {
  return getSnapshot();
}

export function useDeferredValue<T>(value: T) {
  return value;
}

export function useTransition() {
  return [false, (run: () => void) => run()] as const;
}

export function useImperativeHandle() {}
export function useDebugValue() {}

const fake = {
  ...React,
  useState,
  useReducer,
  useRef,
  useEffect,
  useLayoutEffect,
  useInsertionEffect,
  useMemo,
  useCallback,
  useId,
  useContext,
  useSyncExternalStore,
  useDeferredValue,
  useTransition,
  useImperativeHandle,
  useDebugValue,
};
export default fake;

/** One mounted component: render it, run its effects, re-render while state changes. */
export class TestRoot<P> {
  private instance: Instance = { slots: [], index: 0, pending: [], dirty: false };
  private effects = new Set<EffectSlot>();
  output: React.ReactNode = null;

  constructor(
    private component: (props: P) => React.ReactNode,
    public props: P,
    /** The node a host element's ref object receives (its type and props), as React would. */
    private node: (type: string, props: Record<string, unknown>) => unknown = () => ({}),
  ) {
    this.render();
  }

  /** Render with new props (a parent's re-render), then run the effects whose deps changed. */
  render(props: P = this.props) {
    this.props = props;
    const previous = current;
    current = this.instance;
    this.instance.index = 0;
    this.instance.pending = [];
    this.instance.dirty = false;
    try {
      this.output = this.component(props);
    } finally {
      current = previous;
    }
    this.attach(this.output);
    const pending = this.instance.pending;
    for (const { slot } of pending) slot.cleanup?.();
    for (const { slot, run } of pending) {
      slot.cleanup = run();
      this.effects.add(slot);
    }
  }

  /** Let promises settle, then re-render while a state setter asked for it. */
  async flush() {
    for (let round = 0; round < 20; round++) {
      await new Promise((resolve) => setImmediate(resolve));
      if (!this.instance.dirty) continue;
      this.render();
    }
    if (this.instance.dirty) this.render();
  }

  private attach(node: React.ReactNode) {
    if (Array.isArray(node)) return node.forEach((child) => this.attach(child as React.ReactNode));
    if (!React.isValidElement<Record<string, unknown>>(node)) return;
    const ref = node.props.ref as { current: unknown } | undefined;
    if (typeof node.type === 'string' && ref && typeof ref === 'object' && ref.current == null)
      ref.current = this.node(node.type, node.props);
    this.attach(node.props.children as React.ReactNode);
  }

  unmount() {
    for (const effect of this.effects) effect.cleanup?.();
    this.effects.clear();
  }
}
