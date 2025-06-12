/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {
  REACTIVE_NODE,
  ReactiveNode,
  SIGNAL,
  consumerAfterComputation,
  consumerBeforeComputation,
  consumerDestroy,
  consumerPollProducersForChange,
  isInNotificationPhase,
  setActiveConsumer,
} from '../../../primitives/signals';
import {FLAGS, LViewFlags, LView, EFFECTS} from '../interfaces/view';
import {markAncestorsForTraversal} from '../util/view_utils';
import {inject} from '../../di/injector_compatibility';
import {Injector} from '../../di/injector';
import {assertNotInReactiveContext} from './asserts';
import {assertInInjectionContext} from '../../di/contextual';
import {DestroyRef, NodeInjectorDestroyRef} from '../../linker/destroy_ref';
import {ViewContext} from '../view_context';
import {noop} from '../../util/noop';
import {
  ChangeDetectionScheduler,
  NotificationSource,
} from '../../change_detection/scheduling/zoneless_scheduling';
import {setIsRefreshingViews} from '../state';
import {EffectScheduler, SchedulableEffect} from './root_effect_scheduler';

import {emitEffectCreatedEvent, setInjectorProfilerContext} from '../debug/injector_profiler';

/**
 * A global reactive effect, which can be manually destroyed.
 *
 * @publicApi 20.0
 */

export interface EffectRef {
  destroy(): void;
}

export class EffectRefImpl implements EffectRef {
  [SIGNAL]: EffectNode;

  constructor(node: EffectNode) {
    this[SIGNAL] = node;
  }

  destroy(): void {
    this[SIGNAL].destroy();
  }
}

/**
 * Options passed to the `effect` function.
 *
 * @publicApi 20.0
 */
export interface CreateEffectOptions {
  /**
   * The `Injector` in which to create the effect.
   *
   * If this is not provided, the current [injection context](guide/di/dependency-injection-context)
   * will be used instead (via `inject`).
   */
  injector?: Injector;

  /**
   * Whether the `effect` should require manual cleanup.
   *
   * If this is `false` (the default) the effect will automatically register itself to be cleaned up
   * with the current `DestroyRef`.
   *
   * If this is `true` and you want to use the effect outside an injection context, you still
   * need to provide an `Injector` to the effect.
   */
  manualCleanup?: boolean;

  /**
   * @deprecated no longer required, signal writes are allowed by default.
   */
  allowSignalWrites?: boolean;

  /**
   * A debug name for the effect. Used in Angular DevTools to identify the effect.
   */
  debugName?: string;
}

/**
 * An effect can, optionally, register a cleanup function. If registered, the cleanup is executed
 * before the next effect run. The cleanup function makes it possible to "cancel" any work that the
 * previous effect run might have started.
 *
 * @publicApi 20.0
 */
export type EffectCleanupFn = () => void;

/**
 * A callback passed to the effect function that makes it possible to register cleanup logic.
 *
 * @publicApi 20.0
 */
export type EffectCleanupRegisterFn = (cleanupFn: EffectCleanupFn) => void;

/**
 * Registers an "effect" that will be scheduled & executed whenever the signals that it reads
 * changes.
 *
 * Angular has two different kinds of effect: component effects and root effects. Component effects
 * are created when `effect()` is called from a component, directive, or within a service of a
 * component/directive. Root effects are created when `effect()` is called from outside the
 * component tree, such as in a root service.
 *
 * The two effect types differ in their timing. Component effects run as a component lifecycle
 * event during Angular's synchronization (change detection) process, and can safely read input
 * signals or create/destroy views that depend on component state. Root effects run as microtasks
 * and have no connection to the component tree or change detection.
 *
 * `effect()` must be run in injection context, unless the `injector` option is manually specified.
 *
 * @publicApi 20.0
 */

export function effect(
  effectFn: (onCleanup: EffectCleanupRegisterFn) => void,
  options?: CreateEffectOptions,
): EffectRef {

  //#region 省略...
  ngDevMode &&
    assertNotInReactiveContext(
      effect,
      'Call `effect` outside of a reactive context. For example, schedule the ' +
        'effect inside the component constructor.',
    );

  if (ngDevMode && !options?.injector) {
    assertInInjectionContext(effect);
  }

  if (ngDevMode && options?.allowSignalWrites !== undefined) {
    console.warn(
      `The 'allowSignalWrites' flag is deprecated and no longer impacts effect() (writes are always allowed)`,
    );
  }
  //#endregion

  // 1. effect 依赖 Injector
  const injector = options?.injector ?? inject(Injector);
  // 2. 从 injector 获取 DestroyRef，其目的是为了在 injector destroy 时，也一并 destroy 掉 effect。
  let destroyRef = options?.manualCleanup !== true ? injector.get(DestroyRef) : null;

  let node: EffectNode;

  // 3. viewContext 跟组件有关，后面章节才会教，本篇例子中它是 null
  const viewContext = injector.get(ViewContext, null, {optional: true});

  // 4. effect 依赖 ChangeDetectionScheduler class provider
  const notifier = injector.get(ChangeDetectionScheduler);

  if (viewContext !== null) {
    node = createViewEffect(viewContext.view, notifier, effectFn);
    if (destroyRef instanceof NodeInjectorDestroyRef && destroyRef._lView === viewContext.view) {
      destroyRef = null;
    }
  } else {
    // 5. 创建 EffectNode (也就是创建 ReactiveNode)
    node = createRootEffect(effectFn, injector.get(EffectScheduler), notifier);
  }
  node.injector = injector;

  if (destroyRef !== null) {
    // 6. 监听 injector destroy，当 injector destroy 时也一并 destroy 掉 effect 
    //    需要把 destroyRef.onDestroy 返回的 removeListener 函数保存起来
    //    因为有可能 effect 会被 manual destroy 掉，这时就需要 removeListener
    node.onDestroyFn = destroyRef.onDestroy(() => node.destroy());
  }

  // 7. 用 EffectNode 来创建 EffectRef
  const effectRef = new EffectRefImpl(node);

  if (ngDevMode) {
    node.debugName = options?.debugName ?? '';
    const prevInjectorProfilerContext = setInjectorProfilerContext({injector, token: null});
    try {
      emitEffectCreatedEvent(effectRef);
    } finally {
      setInjectorProfilerContext(prevInjectorProfilerContext);
    }
  }

  // 8. 返回 EffectRef
  return effectRef;
}

export interface EffectNode extends ReactiveNode, SchedulableEffect {
  hasRun: boolean;
  cleanupFns: EffectCleanupFn[] | undefined;
  injector: Injector;
  notifier: ChangeDetectionScheduler;

  onDestroyFn: () => void;
  fn: (cleanupFn: EffectCleanupRegisterFn) => void;
  run(): void;
  destroy(): void;
  maybeCleanup(): void;
}

export interface ViewEffectNode extends EffectNode {
  view: LView;
}

export interface RootEffectNode extends EffectNode {
  scheduler: EffectScheduler;
}

export const BASE_EFFECT_NODE: Omit<EffectNode, 'fn' | 'destroy' | 'injector' | 'notifier'> =
  (() => ({
    ...REACTIVE_NODE,
    consumerIsAlwaysLive: true,
    consumerAllowSignalWrites: true,
    dirty: true,
    hasRun: false,
    cleanupFns: undefined,
    zone: null,
    kind: 'effect',
    onDestroyFn: noop,
    run(this: EffectNode): void {
      // 1. 把 EffectNode.dirty 设置成 false
      this.dirty = false;

      if (ngDevMode && isInNotificationPhase()) {
        throw new Error(`Schedulers cannot synchronously execute watches while scheduling.`);
      }

      if (this.hasRun && !consumerPollProducersForChange(this)) {
        return;
      }
      this.hasRun = true;

      const registerCleanupFn: EffectCleanupRegisterFn = (cleanupFn) =>
        (this.cleanupFns ??= []).push(cleanupFn);

      // 2. 开启依赖收集
      const prevNode = consumerBeforeComputation(this);
      const prevRefreshingViews = setIsRefreshingViews(false);
      try {
        // 3. 做一些清理动作，比如把上一次 callback 执行时注册的 cleanup 清掉 
        this.maybeCleanup();
        // 4. 执行 callback
        this.fn(registerCleanupFn);
      } finally {
        setIsRefreshingViews(prevRefreshingViews);
        // 5. 关闭依赖收集
        consumerAfterComputation(this, prevNode);
      }
    },
    maybeCleanup(this: EffectNode): void {
      if (!this.cleanupFns?.length) {
        return;
      }
      const prevConsumer = setActiveConsumer(null);
      try {
        // Attempt to run the cleanup functions. Regardless of failure or success, we consider
        // cleanup "completed" and clear the list for the next run of the effect. Note that an error
        // from the cleanup function will still crash the current run of the effect.
        while (this.cleanupFns.length) {
          this.cleanupFns.pop()!();
        }
      } finally {
        this.cleanupFns = [];
        setActiveConsumer(prevConsumer);
      }
    },
  }))();

export const ROOT_EFFECT_NODE: Omit<RootEffectNode, 'fn' | 'scheduler' | 'notifier' | 'injector'> =
    (() => ({
    ...BASE_EFFECT_NODE,
    consumerMarkedDirty(this: RootEffectNode) {
      // 1. scheduler 是 EffectScheduler
      this.scheduler.schedule(this);

      // 2. notifier 是 ChangeDetectionScheduler
      this.notifier.notify(NotificationSource.RootEffect);
    },
    destroy(this: RootEffectNode) {
      consumerDestroy(this);
      this.onDestroyFn();
      this.maybeCleanup();
      // 把 EffectNode 从 EffectScheduler 里移除
      this.scheduler.remove(this);
    },
  }))();

export const VIEW_EFFECT_NODE: Omit<ViewEffectNode, 'fn' | 'view' | 'injector' | 'notifier'> =
  /* @__PURE__ */ (() => ({
    ...BASE_EFFECT_NODE,
    consumerMarkedDirty(this: ViewEffectNode): void {
      this.view[FLAGS] |= LViewFlags.HasChildViewsToRefresh;
      markAncestorsForTraversal(this.view);
      this.notifier.notify(NotificationSource.ViewEffect);
    },
    destroy(this: ViewEffectNode): void {
      consumerDestroy(this);
      this.onDestroyFn();
      this.maybeCleanup();
      this.view[EFFECTS]?.delete(this);
    },
  }))();

export function createViewEffect(
  view: LView,
  notifier: ChangeDetectionScheduler,
  fn: (onCleanup: EffectCleanupRegisterFn) => void,
): ViewEffectNode {
  const node = Object.create(VIEW_EFFECT_NODE) as ViewEffectNode;
  node.view = view;
  node.zone = typeof Zone !== 'undefined' ? Zone.current : null;
  node.notifier = notifier;
  node.fn = fn;

  view[EFFECTS] ??= new Set();
  view[EFFECTS].add(node);

  node.consumerMarkedDirty(node);
  return node;
}

export function createRootEffect(
  fn: (onCleanup: EffectCleanupRegisterFn) => void,
  scheduler: EffectScheduler,
  notifier: ChangeDetectionScheduler,
): RootEffectNode {
  // 1. 创建 EffectNode
  const node = Object.create(ROOT_EFFECT_NODE) as RootEffectNode;

  // 2. fn 就是 effect callback
  node.fn = fn;

  // 3. scheduler 是 EffectScheduler
  node.scheduler = scheduler;

  // 4. notifier 是 ChangeDetectionScheduler
  node.notifier = notifier;

  node.zone = typeof Zone !== 'undefined' ? Zone.current : null;

  // 5. 把 EffectNode 添加进 EffectScheduler
  node.scheduler.add(node);

  // 6. ChangeDetectionScheduler 发布通知 
  node.notifier.notify(NotificationSource.RootEffect);

  // 7. 返回 EffectNode 
  return node;
}
