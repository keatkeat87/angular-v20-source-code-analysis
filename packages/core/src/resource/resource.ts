/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {untracked} from '../render3/reactivity/untracked';
import {computed} from '../render3/reactivity/computed';
import {signal, signalAsReadonlyFn, WritableSignal} from '../render3/reactivity/signal';
import {Signal} from '../render3/reactivity/api';
import {effect, EffectRef} from '../render3/reactivity/effect';
import {
  ResourceOptions,
  ResourceStatus,
  WritableResource,
  Resource,
  ResourceRef,
  ResourceStreamingLoader,
  StreamingResourceOptions,
  ResourceStreamItem,
  ResourceLoaderParams,
} from './api';

import {ValueEqualityFn} from '../../primitives/signals';

import {Injector} from '../di/injector';
import {assertInInjectionContext} from '../di/contextual';
import {inject} from '../di/injector_compatibility';
import {PendingTasks} from '../pending_tasks';
import {linkedSignal} from '../render3/reactivity/linked_signal';
import {DestroyRef} from '../linker/destroy_ref';

/**
 * Whether a `Resource.value()` should throw an error when the resource is in the error state.
 *
 * This internal flag is being used to gradually roll out this behavior.
 */
const RESOURCE_VALUE_THROWS_ERRORS_DEFAULT = true;

/**
 * Constructs a `Resource` that projects a reactive request to an asynchronous operation defined by
 * a loader function, which exposes the result of the loading operation via signals.
 *
 * Note that `resource` is intended for _read_ operations, not operations which perform mutations.
 * `resource` will cancel in-progress loads via the `AbortSignal` when destroyed or when a new
 * request object becomes available, which could prematurely abort mutations.
 *
 * @experimental 19.0
 */
export function resource<T, R>(
  options: ResourceOptions<T, R> & {defaultValue: NoInfer<T>},
): ResourceRef<T>;

/**
 * Constructs a `Resource` that projects a reactive request to an asynchronous operation defined by
 * a loader function, which exposes the result of the loading operation via signals.
 *
 * Note that `resource` is intended for _read_ operations, not operations which perform mutations.
 * `resource` will cancel in-progress loads via the `AbortSignal` when destroyed or when a new
 * request object becomes available, which could prematurely abort mutations.
 *
 * @experimental 19.0
 */

export function resource<T, R>(options: ResourceOptions<T, R>): ResourceRef<T | undefined>;
export function resource<T, R>(options: ResourceOptions<T, R>): ResourceRef<T | undefined> {
  if (ngDevMode && !options?.injector) {
    assertInInjectionContext(resource);
  }

  // 1. params 以前 (v20 之前) 叫 request，后来 rename 成 params
  //    这里是向后兼容代码
  const oldNameForParams = (
    options as ResourceOptions<T, R> & {request: ResourceOptions<T, R>['params']}
  ).request;

  // 2. 如果没有提供 options.params，这里会补一个 () => null 作为 default
  const params = (options.params ?? oldNameForParams ?? (() => null)) as () => R;

  // 3. 实例化 ResourceImpl 并 return 它
  return new ResourceImpl<T | undefined, R>(
    params,
    // 4. options 可以选择提供 loader 或 stream 其中一个
    //    这里 getLoader 会统一它们，把 loader 强转成 stream，方便后续统一调用方式
    getLoader(options),
    options.defaultValue,
    options.equal ? wrapEqualityFn(options.equal) : undefined,
    // 5. resource 内部会使用 effect，所以需要 injector
    options.injector ?? inject(Injector),
    RESOURCE_VALUE_THROWS_ERRORS_DEFAULT,
  );
}

type ResourceInternalStatus = 'idle' | 'loading' | 'resolved' | 'local';

/**
 * Internal state of a resource.
 */
interface ResourceProtoState<T> {
  extRequest: WrappedRequest;

  // For simplicity, status is internally tracked as a subset of the public status enum.
  // Reloading and Error statuses are projected from Loading and Resolved based on other state.
  status: ResourceInternalStatus;
}

interface ResourceState<T> extends ResourceProtoState<T> {
  previousStatus: ResourceStatus;
  stream: Signal<ResourceStreamItem<T>> | undefined;
}

type WrappedRequest = {request: unknown; reload: number};

/**
 * Base class which implements `.value` as a `WritableSignal` by delegating `.set` and `.update`.
 */

abstract class BaseWritableResource<T> implements WritableResource<T> {

  readonly value: WritableSignal<T>;
  abstract readonly status: Signal<ResourceStatus>;
  abstract readonly error: Signal<Error | undefined>;
  abstract reload(): boolean;

  // 1. value 是一个用 computed 创建的 Signal 对象
  constructor(value: Signal<T>) {
    // 2. 它被用作 Resource.value
    this.value = value as WritableSignal<T>;
    // 3. 并且扩展了 set、update 方法

    this.value.set = this.set.bind(this);
    this.value.update = this.update.bind(this);

    this.value.asReadonly = signalAsReadonlyFn;
  }

  abstract set(value: T): void;

  update(updateFn: (value: T) => T): void {
    this.set(updateFn(untracked(this.value)));
  }

  // 1. status 是 'error' 就是 isError true
  private readonly isError = computed(() => this.status() === 'error');

  // 2. status 是 'loading' or 'reloading' 就是 isLoading true
  readonly isLoading = computed(() => this.status() === 'loading' || this.status() === 'reloading');

  // 3. 没有 error 同时不是 undefined，那就是 hasValue true
  //    null 也算 hasValue 哦，只有 undefined 才不算
  hasValue(): this is ResourceRef<Exclude<T, undefined>> {
    if (this.isError()) {
      return false;
    }

    return this.value() !== undefined;
  }

  asReadonly(): Resource<T> {
    return this;
  }
}

/**
 * Implementation for `resource()` which uses a `linkedSignal` to manage the resource's state.
 */

export class ResourceImpl<T, R> extends BaseWritableResource<T> implements ResourceRef<T> {
  private readonly pendingTasks: PendingTasks;

  /**
   * The current state of the resource. Status, value, and error are derived from this.
   */
  private readonly state: WritableSignal<ResourceState<T>>;

  /**
   * Combines the current request with a reload counter which allows the resource to be reloaded on
   * imperative command.
   */
  protected readonly extRequest: WritableSignal<WrappedRequest>;

  private readonly effectRef: EffectRef;

  private pendingController: AbortController | undefined;
  private resolvePendingTask: (() => void) | undefined = undefined;
  private destroyed = false;

  constructor(
    // 1. request 是旧的称呼，现在改叫 params 了
    request: () => R,
    // 2. loader / stream 被统一后叫 loaderFn
    private readonly loaderFn: ResourceStreamingLoader<T, R>,
    defaultValue: T,
    private readonly equal: ValueEqualityFn<T> | undefined,
    injector: Injector,
    throwErrorsFromValue: boolean = RESOURCE_VALUE_THROWS_ERRORS_DEFAULT,
  ) {
    // 3. run 父类的 constructor
    super(
      // 4. 用 computed 创建一个 Signal 并作为父类 constructor 的参数
      computed(
        () => {
          const streamValue = this.state().stream?.();

          if (!streamValue) {
            return defaultValue;
          }

          // Prevents `hasValue()` from throwing an error when a reload happened in the error state
          if (this.state().status === 'loading' && this.error()) {
            return defaultValue;
          }

          if (!isResolved(streamValue)) {
            if (throwErrorsFromValue) {
              throw new ResourceValueError(this.error()!);
            } else {
              return defaultValue;
            }
          }

          return streamValue.value;
        },
        {equal},
      ),
    );

    // 5. 把 params 和 reload 关联起来
    this.extRequest = linkedSignal({
      source: request,
      computation: (request) => ({request, reload: 0}),
    });
 
    // 6. 把 params, reload, value 和 status 关联起来
    this.state = linkedSignal<WrappedRequest, ResourceState<T>>({
      source: this.extRequest,
      computation: (extRequest, previous) => {
        const status = extRequest.request === undefined ? 'idle' : 'loading';
        if (!previous) {
          return {
            extRequest,
            status,
            previousStatus: 'idle',
            stream: undefined, 
          };
        } else {
          return {
            extRequest,
            status,
            previousStatus: projectStatusOfState(previous.value),
            stream:
              previous.value.extRequest.request === extRequest.request
                ? previous.value.stream
                : undefined,
          };
        }
      },
    });

    // 7. 调用 effect callback
    this.effectRef = effect(this.loadEffect.bind(this), {
      injector,
      manualCleanup: true,
    });

    this.pendingTasks = injector.get(PendingTasks);

    // Cancel any pending request when the resource itself is destroyed.
    injector.get(DestroyRef).onDestroy(() => this.destroy());
  }

  override readonly status = computed(() => projectStatusOfState(this.state()));

  override readonly error = computed(() => {
    const stream = this.state().stream?.();
    return stream && !isResolved(stream) ? stream.error : undefined;
  });

  /**
   * Called either directly via `WritableResource.set` or via `.value.set()`.
   */
  override set(value: T): void {
    if (this.destroyed) {
      return;
    }

    const current = untracked(this.value);
    const state = untracked(this.state);

    if (state.status === 'local' && (this.equal ? this.equal(current, value) : current === value)) {
      return;
    }

    // Enter Local state with the user-defined value.
    this.state.set({
      extRequest: state.extRequest,
      status: 'local',
      previousStatus: 'local',
      stream: signal({value}),
    });

    // We're departing from whatever state the resource was in previously, so cancel any in-progress
    // loading operations.
    this.abortInProgressLoad();
  }

  override reload(): boolean {
    const {status} = untracked(this.state);
    if (status === 'idle' || status === 'loading') {
      return false;
    }

    // 1. 每当执行 reload 方法时，extRequest 的 reload count 就会累加，params 则用回当前值
    this.extRequest.update(({request, reload}) => ({request, reload: reload + 1}));
    return true;
  }

  destroy(): void {
    this.destroyed = true;
    this.effectRef.destroy();
    this.abortInProgressLoad();

    // Destroyed resources enter Idle state.
    this.state.set({
      extRequest: {request: undefined, reload: 0},
      status: 'idle',
      previousStatus: 'idle',
      stream: undefined,
    });
  }

  private async loadEffect(): Promise<void> {
    // 1. 监听 params 和 reload，当 params 变更或 reload 时，执行 effect callback
    const extRequest = this.extRequest();

    const {status: currentStatus, previousStatus} = untracked(this.state);

    if (extRequest.request === undefined) {
      return;
    } else if (currentStatus !== 'loading') {
      // We're not in a loading or reloading state, so this loading request is stale.
      return;
    }

    this.abortInProgressLoad();

    let resolvePendingTask: (() => void) | undefined = (this.resolvePendingTask =
      this.pendingTasks.add());

    const {signal: abortSignal} = (this.pendingController = new AbortController());

    try {
      const stream = await untracked(() => {
        return this.loaderFn({
          params: extRequest.request as Exclude<R, undefined>,
          // TODO(alxhub): cleanup after g3 removal of `request` alias.
          request: extRequest.request as Exclude<R, undefined>,
          abortSignal,
          previous: {
            status: previousStatus,
          },
        } as ResourceLoaderParams<R>);
      });

      if (abortSignal.aborted || untracked(this.extRequest) !== extRequest) {
        return;
      }

      this.state.set({
        extRequest,
        status: 'resolved',
        previousStatus: 'resolved',
        stream,
      });
    } catch (err) {
      if (abortSignal.aborted || untracked(this.extRequest) !== extRequest) {
        return;
      }

      this.state.set({
        extRequest,
        status: 'resolved',
        previousStatus: 'error',
        stream: signal({error: encapsulateResourceError(err)}),
      });
    } finally {
      // Resolve the pending task now that the resource has a value.
      resolvePendingTask?.();
      resolvePendingTask = undefined;
    }
  }

  private abortInProgressLoad(): void {
    untracked(() => this.pendingController?.abort());
    this.pendingController = undefined;

    // Once the load is aborted, we no longer want to block stability on its resolution.
    this.resolvePendingTask?.();
    this.resolvePendingTask = undefined;
  }
}

/**
 * Wraps an equality function to handle either value being `undefined`.
 */
function wrapEqualityFn<T>(equal: ValueEqualityFn<T>): ValueEqualityFn<T | undefined> {
  return (a, b) => (a === undefined || b === undefined ? a === b : equal(a, b));
}

function getLoader<T, R>(options: ResourceOptions<T, R>): ResourceStreamingLoader<T, R> {
  // 1. 如果是提供 options.stream，那就直接返回 stream
  if (isStreamingResourceOptions(options)) {
    return options.stream;
  }

  // 2. 如果是提供 options.loader
  //    那就 wrap 一层，把 loader 强转成 stream 
  return async (params) => {
    try {
      // 3. wrap 成 Signal<ResourceStreamItem> 
      return signal({value: await options.loader(params)});
    } catch (err) {
      // 4. wrap 成 Signal<ResourceStreamItem> 
      return signal({error: encapsulateResourceError(err)});
    }
  };
}

function isStreamingResourceOptions<T, R>(
  options: ResourceOptions<T, R>,
): options is StreamingResourceOptions<T, R> {
  return !!(options as StreamingResourceOptions<T, R>).stream;
}

/**
 * Project from a state with `ResourceInternalStatus` to the user-facing `ResourceStatus`
 */
function projectStatusOfState(state: ResourceState<unknown>): ResourceStatus {
  switch (state.status) {
    case 'loading':
      return state.extRequest.reload === 0 ? 'loading' : 'reloading';
    case 'resolved':
      return isResolved(state.stream!()) ? 'resolved' : 'error';
    default:
      return state.status;
  }
}

function isResolved<T>(state: ResourceStreamItem<T>): state is {value: T} {
  return (state as {error: unknown}).error === undefined;
}

export function encapsulateResourceError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new ResourceWrappedError(error);
}

class ResourceValueError extends Error {
  constructor(error: Error) {
    super(
      ngDevMode
        ? `Resource is currently in an error state (see Error.cause for details): ${error.message}`
        : error.message,
      {cause: error},
    );
  }
}

class ResourceWrappedError extends Error {
  constructor(error: unknown) {
    super(
      ngDevMode
        ? `Resource returned an error that's not an Error instance: ${String(error)}. Check this error's .cause for the actual error.`
        : String(error),
      {cause: error},
    );
  }
}
