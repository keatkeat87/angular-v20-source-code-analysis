/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {getActiveConsumer} from '../../../primitives/signals';

import {RuntimeError, RuntimeErrorCode} from '../../errors';

/**
 * Asserts that the current stack frame is not within a reactive context. Useful
 * to disallow certain code from running inside a reactive context (see {@link /api/core/rxjs/toSignal toSignal})
 *
 * @param debugFn a reference to the function making the assertion (used for the error message).
 *
 * @publicApi
 */

export function assertNotInReactiveContext(debugFn: Function, extraContext?: string): void {
  // 只要全局 consumer 不等于 null 就 Error
  if (getActiveConsumer() !== null) {
    throw new RuntimeError(
      RuntimeErrorCode.ASSERTION_NOT_INSIDE_REACTIVE_CONTEXT,
      ngDevMode &&
        `${debugFn.name}() cannot be called from within a reactive context.${
          extraContext ? ` ${extraContext}` : ''
        }`,
    );
  }
}
