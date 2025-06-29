/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

// Required as the signals library is in a separate package, so we need to explicitly ensure the
// global `ngDevMode` type is defined.
declare const ngDevMode: boolean | undefined;

let activeConsumer: ReactiveNode | null = null;
let inNotificationPhase = false;
type Version = number & {__brand: 'Version'};
let epoch: Version = 1 as Version;
export type ReactiveHookFn = (node: ReactiveNode) => void;
let postProducerCreatedFn: ReactiveHookFn | null = null;

export const SIGNAL: unique symbol = /* @__PURE__ */ Symbol('SIGNAL');

export function setActiveConsumer(consumer: ReactiveNode | null): ReactiveNode | null {
  const prev = activeConsumer;
  activeConsumer = consumer;
  return prev;
}

export function getActiveConsumer(): ReactiveNode | null {
  return activeConsumer;
}

export function isInNotificationPhase(): boolean {
  return inNotificationPhase;
}

export interface Reactive {
  [SIGNAL]: ReactiveNode;
}

export function isReactive(value: unknown): value is Reactive {
  return (value as Partial<Reactive>)[SIGNAL] !== undefined;
}

export const REACTIVE_NODE: ReactiveNode = {
  version: 0 as Version,
  lastCleanEpoch: 0 as Version,
  dirty: false,
  producerNode: undefined,
  producerLastReadVersion: undefined,
  producerIndexOfThis: undefined,
  nextProducerIndex: 0,
  liveConsumerNode: undefined,
  liveConsumerIndexOfThis: undefined,
  consumerAllowSignalWrites: false,
  consumerIsAlwaysLive: false,
  kind: 'unknown',
  producerMustRecompute: () => false,
  producerRecomputeValue: () => {},
  consumerMarkedDirty: () => {},
  consumerOnSignalRead: () => {},
};

/**
 * A producer and/or consumer which participates in the reactive graph.
 *
 * Producer `ReactiveNode`s which are accessed when a consumer `ReactiveNode` is the
 * `activeConsumer` are tracked as dependencies of that consumer.
 *
 * Certain consumers are also tracked as "live" consumers and create edges in the other direction,
 * from producer to consumer. These edges are used to propagate change notifications when a
 * producer's value is updated.
 *
 * A `ReactiveNode` may be both a producer and consumer.
 */

export interface ReactiveNode {
  version: Version;
  lastCleanEpoch: Version;
  dirty: boolean;
  
  producerNode: ReactiveNode[] | undefined;

  producerLastReadVersion: Version[] | undefined;
  producerIndexOfThis: number[] | undefined;
  nextProducerIndex: number;
  liveConsumerNode: ReactiveNode[] | undefined;
  liveConsumerIndexOfThis: number[] | undefined;
  consumerAllowSignalWrites: boolean;
  readonly consumerIsAlwaysLive: boolean;
  producerMustRecompute(node: unknown): boolean;
  producerRecomputeValue(node: unknown): void;
  consumerMarkedDirty(node: unknown): void;
  consumerOnSignalRead(node: unknown): void;
  debugName?: string;
  kind: string;
}

interface ConsumerNode extends ReactiveNode {
  producerNode: NonNullable<ReactiveNode['producerNode']>;
  producerIndexOfThis: NonNullable<ReactiveNode['producerIndexOfThis']>;
  producerLastReadVersion: NonNullable<ReactiveNode['producerLastReadVersion']>;
}

interface ProducerNode extends ReactiveNode {
  liveConsumerNode: NonNullable<ReactiveNode['liveConsumerNode']>;
  liveConsumerIndexOfThis: NonNullable<ReactiveNode['liveConsumerIndexOfThis']>;
}

/**
 * Called by implementations when a producer's signal is read.
 */

export function producerAccessed(node: ReactiveNode): void {
  if (inNotificationPhase) {
    throw new Error(
      typeof ngDevMode !== 'undefined' && ngDevMode
        ? `Assertion error: signal read during notification phase`
        : '',
    );
  }

  if (activeConsumer === null) {
    return;
  }

  activeConsumer.consumerOnSignalRead(node);

  // 1. 此时 activeConsumer 是 fullName ReactiveNode
  //    因为之前调用了 setActiveConsumer(fullNameNode)，所以它是全局 activeConsumer
  //    然后，这里会累加一个 producer index
  const idx = activeConsumer.nextProducerIndex++;

  assertConsumerNode(activeConsumer);

  // b1. activeConsumer 是 EffectNode
  //     EffectNode.producerNode[idx] 是上一次的依赖 firstName ReactiveNode
  //     node 是这一次的的依赖 lastName ReactiveNode 
  //     它们不相等所以会进入 if 内
  if (idx < activeConsumer.producerNode.length && activeConsumer.producerNode[idx] !== node) {
    // b2. 如果 activeConsumer 是双向才需要，此时是 EffectNode 所以需要
    if (consumerIsLive(activeConsumer)) {
      // b3. 把 firstNameReactive 拿出来
      const staleProducer = activeConsumer.producerNode[idx];
      // b4. 把 firstNameReactiveNode.liveConsumerNode 里的 EffectNode 移除掉
      producerRemoveLiveConsumerAtIndex(staleProducer, activeConsumer.producerIndexOfThis[idx]);
    }
  }

  // 2. 此时 activeConsumer 是 fullName ReactiveNode
  //    node 是 firstName ReactiveNode
  //    如果 fullNameReactiveNode.producerNode[next producer index] 不是 firstName ReactiveNode
  if (activeConsumer.producerNode[idx] !== node) {
    // 3. 那就把 firstName ReactiveNode push 进去 fullNameReactiveNode.producerNode 里
    //    这就是调用 firstName() 后为什么 fullNameReactiveNode.producerNode array 会有 firstName ReactiveNode 的原因

    // a1. activeConsumer 是 EffectNode
    //    node 是 firstName ReactiveNode 
    //    effect 和 computed 一样，都是把依赖 (a.k.a producer) push 进 ReactiveNode.producerNode 里
    activeConsumer.producerNode[idx] = node;

    // a2. effect 比 computed 多了一个环节
    //     EffectNode 是 live consumer 所以会执行 producerAddLiveConsumer
    // c1. activeConsumer 是 EffectNode (consumerIsAlwaysLive === true)
    //     所以会执行 producerAddLiveConsumer
    //     node 则是 fullNameReactiveNode
    // d1. 此时 activeConsumer 是 fullNameReactiveNode，node 是 firstNameReactiveNode
    activeConsumer.producerIndexOfThis[idx] = consumerIsLive(activeConsumer)
      ? producerAddLiveConsumer(node, activeConsumer, idx)
      : 0;
  }

  // 4. 把 firstName ReactiveNode 当前的 version 记入到 fullNameReactiveNode.producerLastReadVersion array 里
  activeConsumer.producerLastReadVersion[idx] = node.version;
}

/**
 * Increment the global epoch counter.
 *
 * Called by source producers (that is, not computeds) whenever their values change.
 */
export function producerIncrementEpoch(): void {
  epoch++;
}

/**
 * Ensure this producer's `version` is up-to-date.
 */


export function producerUpdateValueVersion(node: ReactiveNode): void {
  // 1. 这个是快速判断方式，我们忽略，不研究那么细
  if (consumerIsLive(node) && !node.dirty) {
    return;
  }

  // 2. 这个是快速判断方式，我们忽略，不研究那么细
  if (!node.dirty && node.lastCleanEpoch === epoch) {
    return;
  }

  // 3. consumerPollProducersForChange 函数就是用来检查 producer version 的
  if (!node.producerMustRecompute(node) && !consumerPollProducersForChange(node)) {
    producerMarkClean(node);
    return;
  }

  // 4. 如果上面都没有中断，
  //    这里执行 producerRecomputeValue 
  //    里面会执行 computation，把返回值放入 node.value (这里 node 是 fullName ReactiveNode)
  //    最后还会累加 node.version
  node.producerRecomputeValue(node);
  producerMarkClean(node);
}

/**
 * Propagate a dirty notification to live consumers of this producer.
 */

export function producerNotifyConsumers(node: ReactiveNode): void {
  if (node.liveConsumerNode === undefined) {
    return;
  }

  const prev = inNotificationPhase;
  inNotificationPhase = true;
  try {
    // 1. for loop 收集的依赖 (e.g. EffectNode)
    for (const consumer of node.liveConsumerNode) {
      if (!consumer.dirty) {
        // 2. 把这些依赖 mark dirty 
        consumerMarkDirty(consumer);
      }
    }
  } finally {
    inNotificationPhase = prev;
  }
}

/**
 * Whether this `ReactiveNode` in its producer capacity is currently allowed to initiate updates,
 * based on the current consumer context.
 */
export function producerUpdatesAllowed(): boolean {
  return activeConsumer?.consumerAllowSignalWrites !== false;
}

export function consumerMarkDirty(node: ReactiveNode): void {
  // 1. set EffectNode.dirty = true
  node.dirty = true;
  producerNotifyConsumers(node); // 这是递归，下面会再讲解
  // 2. 调用 EffectNode.consumerMarkedDirty
  node.consumerMarkedDirty?.(node);
}

export function producerMarkClean(node: ReactiveNode): void {
  node.dirty = false;
  node.lastCleanEpoch = epoch;
}

/**
 * Prepare this consumer to run a computation in its reactive context.
 *
 * Must be called by subclasses which represent reactive computations, before those computations
 * begin.
 */

export function consumerBeforeComputation(node: ReactiveNode | null): ReactiveNode | null {
  // 1. 把 producer index 设置成 0 (重置的意思)
  node && (node.nextProducerIndex = 0);
  // 2. 设置全局 consumer
  return setActiveConsumer(node);
}

/**
 * Finalize this consumer's state after a reactive computation has run.
 *
 * Must be called by subclasses which represent reactive computations, after those computations
 * have finished.
 */

export function consumerAfterComputation(
  node: ReactiveNode | null,
  prevConsumer: ReactiveNode | null,
): void {
  // 1. 还原全局 consumer
  setActiveConsumer(prevConsumer);

  if (
    !node ||
    node.producerNode === undefined ||
    node.producerIndexOfThis === undefined ||
    node.producerLastReadVersion === undefined
  ) {
    return;
  }

  // 1. 如果是双向 (e.g. EffectNode) 就进入
  //    此时 node 是 EffectNode
  if (consumerIsLive(node)) {
    // 2. for loop 多余的依赖
    for (let i = node.nextProducerIndex; i < node.producerNode.length; i++) {
      // 3. 把依赖 ReactiveNode.liveConsumerNode 里的 EffectNode 移除掉
      producerRemoveLiveConsumerAtIndex(node.producerNode[i], node.producerIndexOfThis[i]);
    }
  }

  // 2. 清除多余的 producers
  while (node.producerNode.length > node.nextProducerIndex) {
    node.producerNode.pop();
    node.producerLastReadVersion.pop();
    node.producerIndexOfThis.pop();
  }
}

/**
 * Determine whether this consumer has any dependencies which have changed since the last time
 * they were read.
 */

export function consumerPollProducersForChange(node: ReactiveNode): boolean {
  assertConsumerNode(node);

  // 1. for loop 依赖的 producers (fullNameReactiveNode.producerNode array)
  for (let i = 0; i < node.producerNode.length; i++) {
    const producer = node.producerNode[i];

    // 2. 取出 producer 上一次记入的 version 
    //    从 fullNameReactiveNode.producerLastReadVersion array 里取出对于的 producer (e.g. firstNameReactiveNode) 上一次记入的 version
    const seenVersion = node.producerLastReadVersion[i];

    // 3. 对比之前之后的 producer version
    if (seenVersion !== producer.version) {
      // 4. 不相同就代表 producer 变更了，直接返回 true
      return true;
    }

    // 5. 递归检查 producer 的 producer
    //    因为 ComputedNode 的 producer 也有可能是一个 ComputedNode
    //    举例：
    //    fullName 依赖 firstName 这个只是一层关系
    //    如果有一个 welcomeMessage 是这样 computed(() => `Welcome, ${fullName()}!`);
    //    welcomeMessage 依赖 fullName 依赖 firstName, 这样就两层了，所以这里就需要递归处理检查
    producerUpdateValueVersion(producer);

    // 6. 假设是两层的例子
    //    node 是 welcomeMessage
    //    producer 是 fullName
    //    producerUpdateValueVersion 会检查 firstName 是否变更
    //    如果变更了那会执行 fullNameComputedNode.producerRecomputeValue，
    //    里头会执行 fullName computation，同时累加 fullNameReactiveNode.version
    //    所以这里要判断多一次 producer (fullNameReactiveNode) 的 version
    if (seenVersion !== producer.version) {
      return true;
    }
  }

  return false;
}

/**
 * Disconnect this consumer from the graph.
 */

export function consumerDestroy(node: ReactiveNode): void {
  assertConsumerNode(node);

  // 1. node 是 EffectNode (consumerIsAlwaysLive === true) 所以会进入 if condition
  if (consumerIsLive(node)) {
    // 2. for loop effect 的依赖 firstNameReactiveNode
    for (let i = 0; i < node.producerNode.length; i++) {
      // 3. 把 EffectNode 从 firstNameReactiveNode.liveConsumerNode array 里删除
      producerRemoveLiveConsumerAtIndex(node.producerNode[i], node.producerIndexOfThis[i]);
    }
  }

  node.producerNode.length =
    node.producerLastReadVersion.length =
    node.producerIndexOfThis.length =
      0;
  if (node.liveConsumerNode) {
    node.liveConsumerNode.length = node.liveConsumerIndexOfThis!.length = 0;
  }
}

/**
 * Add `consumer` as a live consumer of this node.
 *
 * Note that this operation is potentially transitive. If this node becomes live, then it becomes
 * a live consumer of all of its current producers.
 */

function producerAddLiveConsumer(
  node: ReactiveNode,  
  consumer: ReactiveNode,  
  indexOfThis: number,
): number {
  assertProducerNode(node);

  // a1. node 是 fullNameReactiveNode
  //     由于这是第一次 effect 依赖收集，所以 fullNameReactiveNode.liveConsumerNode.length 是 0
  //     另外 isConsumerNode 函数是判断 ReactiveNode 有没有 producerNode
  //     此时 fullNameReactiveNode.producerNode === [firstNameReactiveNode, lastNameReactiveNode]
  //     所以 if 的两个条件都满足，可以进入
  if (node.liveConsumerNode.length === 0 && isConsumerNode(node)) {
    // a2. for loop fullName 的 producers (firstName 和 lastName)
    for (let i = 0; i < node.producerNode.length; i++) {
      // a3. 把 fullNameReactiveNode push 进 firstNameReactiveNode.liveConsumerNode 里
      //     firstNameReactiveNode.liveConsumerNode = [fullNameReactiveNode]
      //     注：这里是递归，所以它不仅仅是处理两层依赖关系，更多层也都同样处理
      node.producerIndexOfThis[i] = producerAddLiveConsumer(node.producerNode[i], node, i);
    }
  }

  node.liveConsumerIndexOfThis.push(indexOfThis);
  // 1. node 是 firstName ReactiveNode
  //    consumer 是 EffectNode
  //    把 EffectNode push 进 firstNameReactiveNode.liveConsumerNode 里
  //    liveConsumerNode 的类型是 ReactiveNode Array
  // a4. 把 EffectNode push 进 fullNameReactiveNode.liveConsumerNode 里
  //     fullNameReactiveNode.liveConsumerNode = [EffectNode]
  return node.liveConsumerNode.push(consumer) - 1;
}

/**
 * Remove the live consumer at `idx`.
 */

function producerRemoveLiveConsumerAtIndex(node: ReactiveNode, idx: number): void {
  assertProducerNode(node);

  if (typeof ngDevMode !== 'undefined' && ngDevMode && idx >= node.liveConsumerNode.length) {
    throw new Error(
      `Assertion error: active consumer index ${idx} is out of bounds of ${node.liveConsumerNode.length} consumers)`,
    );
  }

  if (node.liveConsumerNode.length === 1 && isConsumerNode(node)) {
    for (let i = 0; i < node.producerNode.length; i++) {
      producerRemoveLiveConsumerAtIndex(node.producerNode[i], node.producerIndexOfThis[i]);
    }
  }

  const lastIdx = node.liveConsumerNode.length - 1;
  // 1. 把最后一个 ReactiveNode 搬去指定 index 做覆盖
  node.liveConsumerNode[idx] = node.liveConsumerNode[lastIdx];
  node.liveConsumerIndexOfThis[idx] = node.liveConsumerIndexOfThis[lastIdx];

  // 2. 移除最后一个 ReactiveNode 
  node.liveConsumerNode.length--;
  node.liveConsumerIndexOfThis.length--;

  if (idx < node.liveConsumerNode.length) {
    const idxProducer = node.liveConsumerIndexOfThis[idx];
    const consumer = node.liveConsumerNode[idx];
    assertConsumerNode(consumer);
    consumer.producerIndexOfThis[idxProducer] = idx;
  }
}

function consumerIsLive(node: ReactiveNode): boolean {
  return node.consumerIsAlwaysLive || (node?.liveConsumerNode?.length ?? 0) > 0;
}

function assertConsumerNode(node: ReactiveNode): asserts node is ConsumerNode {
  node.producerNode ??= [];
  node.producerIndexOfThis ??= [];
  node.producerLastReadVersion ??= [];
}

function assertProducerNode(node: ReactiveNode): asserts node is ProducerNode {
  node.liveConsumerNode ??= [];
  node.liveConsumerIndexOfThis ??= [];
}

function isConsumerNode(node: ReactiveNode): node is ConsumerNode {
  return node.producerNode !== undefined;
}

export function runPostProducerCreatedFn(node: ReactiveNode): void {
  postProducerCreatedFn?.(node);
}

export function setPostProducerCreatedFn(fn: ReactiveHookFn | null): ReactiveHookFn | null {
  const prev = postProducerCreatedFn;
  postProducerCreatedFn = fn;
  return prev;
}
