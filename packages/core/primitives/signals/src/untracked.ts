/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {setActiveConsumer} from './graph';

/**
 * Execute an arbitrary function in a non-reactive (non-tracking) context. The executed function
 * can, optionally, return a value.
 */

export function untracked<T>(nonReactiveReadsFn: () => T): T {
  // 1. 把全局 consumer 设置成 null
  //    等同于停止依赖收集
  const prevConsumer = setActiveConsumer(null);
  try {
    // 2. 执行 untracked 内的代码
    return nonReactiveReadsFn();
  } finally {
    // 3. 还原全局 consumer，恢复依赖收集
    setActiveConsumer(prevConsumer);
  }
}
