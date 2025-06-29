/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {defaultEquals, ValueEqualityFn} from './equality';
import {
  consumerAfterComputation,
  consumerBeforeComputation,
  producerAccessed,
  producerUpdateValueVersion,
  REACTIVE_NODE,
  ReactiveNode,
  setActiveConsumer,
  SIGNAL,
  runPostProducerCreatedFn,
} from './graph';

// Required as the signals library is in a separate package, so we need to explicitly ensure the
// global `ngDevMode` type is defined.
declare const ngDevMode: boolean | undefined;

/**
 * A computation, which derives a value from a declarative reactive expression.
 *
 * `Computed`s are both producers and consumers of reactivity.
 */

export interface ComputedNode<T> extends ReactiveNode {
  value: T;
  error: unknown;
  computation: () => T;
  equal: ValueEqualityFn<T>;
}

export type ComputedGetter<T> = (() => T) & {
  [SIGNAL]: ComputedNode<T>;
};

/**
 * Create a computed signal which derives a reactive value from an expression.
 */

export function createComputed<T>(
  computation: () => T,
  equal?: ValueEqualityFn<T>,
): ComputedGetter<T> {

  const node: ComputedNode<T> = Object.create(COMPUTED_NODE);
  node.computation = computation;
  if (equal !== undefined) {
    node.equal = equal;
  }

  // 1. 这就是 computed getter 函数
  // a1. 这是 fullName getter
  const computed = () => {

    // 2. 首先检查依赖的 producers 是否有变更
    //    如果有变更，那就重跑 computation 然后 update node.value (它就是缓存值)
    //    没有就会原封不动
    // a2. 执行 computation 收集依赖
    //     收集结果：fullNameReactiveNode.producerNode = [firstNameReactiveNode, lastNameReactiveNode];
    producerUpdateValueVersion(node);

    // 3. 和 Signal getter 一样要调用 producerAccessed (因为 computed 也可以作为其它人的 producer
    // a3. fullName 又被 effect 依赖所以进入 producerAccessed
    producerAccessed(node);

    if (node.value === ERRORED) {
      throw node.error;
    }

    // 4. 返回缓存值
    return node.value;
  };

  (computed as ComputedGetter<T>)[SIGNAL] = node;
  if (typeof ngDevMode !== 'undefined' && ngDevMode) {
    const debugName = node.debugName ? ' (' + node.debugName + ')' : '';
    computed.toString = () => `[Computed${debugName}: ${node.value}]`;
  }
  runPostProducerCreatedFn(node);

  return computed as unknown as ComputedGetter<T>;
}

/**
 * A dedicated symbol used before a computed value has been calculated for the first time.
 * Explicitly typed as `any` so we can use it as signal's value.
 */
export const UNSET: any = /* @__PURE__ */ Symbol('UNSET');

/**
 * A dedicated symbol used in place of a computed signal value to indicate that a given computation
 * is in progress. Used to detect cycles in computation chains.
 * Explicitly typed as `any` so we can use it as signal's value.
 */
export const COMPUTING: any = /* @__PURE__ */ Symbol('COMPUTING');

/**
 * A dedicated symbol used in place of a computed signal value to indicate that a given computation
 * failed. The thrown error is cached until the computation gets dirty again.
 * Explicitly typed as `any` so we can use it as signal's value.
 */
export const ERRORED: any = /* @__PURE__ */ Symbol('ERRORED');

// Note: Using an IIFE here to ensure that the spread assignment is not considered
// a side-effect, ending up preserving `COMPUTED_NODE` and `REACTIVE_NODE`.
// TODO: remove when https://github.com/evanw/esbuild/issues/3392 is resolved.

const COMPUTED_NODE = /* @__PURE__ */ (() => {
  return {
    ...REACTIVE_NODE,
    value: UNSET,
    dirty: true,
    error: null,
    equal: defaultEquals,
    kind: 'computed',

    producerMustRecompute(node: ComputedNode<unknown>): boolean {
      return node.value === UNSET || node.value === COMPUTING;
    },

    producerRecomputeValue(node: ComputedNode<unknown>): void {
      if (node.value === COMPUTING) {
        throw new Error(
          typeof ngDevMode !== 'undefined' && ngDevMode ? 'Detected cycle in computations.' : '',
        );
      }

      const oldValue = node.value;
      node.value = COMPUTING;

      // 1. before computation 要做一些 preparation
      // a1. 开启依赖收集
      const prevConsumer = consumerBeforeComputation(node);
      let newValue: unknown;
      let wasEqual = false;
      try {

        // 2. 执行 computation
        //    里面会调用 firstName, lastName getter 
        //    getter 里面会调用 producerAccessed
        //    producerAccessed 会把 firstName Reactive push 到 fullNameReactiveNode.producerNode array 里
        // a2. 执行 computation (without await)
        newValue = node.computation();
        
        // a3. 结束依赖收集
        setActiveConsumer(null);
        wasEqual =
          oldValue !== UNSET &&
          oldValue !== ERRORED &&
          newValue !== ERRORED &&
          node.equal(oldValue, newValue);
      } catch (err) {
        newValue = ERRORED;
        node.error = err;
      } finally {
        // 3. after computation 要做一些 cleaning
        consumerAfterComputation(node, prevConsumer);
      }

      // 1. 如果执行完 computation 发现新值和旧值是 equal 的，那就当什么也没有发生。
      if (wasEqual) {
        node.value = oldValue;
        return;
      }

      // 2. 如果有新值，那就更新缓存，并且累加 version
      node.value = newValue;
      node.version++;
    },
  };
})();
