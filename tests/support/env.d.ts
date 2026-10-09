/**
 * 测试运行时的最小类型声明。
 *
 * 本项目测试只使用 Node.js 内置能力（node:test / node:assert/strict），
 * 不安装任何第三方测试库，也不依赖 @types/node。
 * 这里仅声明测试中实际用到的 API，供 tsc 类型检查使用；
 * 运行时由 Node 原生提供。
 */

declare module "node:test" {
  export type TestHandler = () => void | Promise<void>;

  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: TestHandler): void;
  export function beforeEach(fn: TestHandler): void;
  export function afterEach(fn: TestHandler): void;
}

declare module "node:assert/strict" {
  export type ErrorChecker = (error: unknown) => boolean;

  export interface Assert {
    ok(value: unknown, message?: string): void;
    fail(message?: string): never;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    throws(
      fn: () => unknown,
      checker?: ErrorChecker | RegExp | Error,
      message?: string,
    ): void;
    rejects(
      promise: Promise<unknown> | (() => Promise<unknown>),
      checker?: ErrorChecker | RegExp | Error,
      message?: string,
    ): Promise<void>;
    match(value: string, regexp: RegExp, message?: string): void;
  }

  const assert: Assert;
  export default assert;
}

declare function setTimeout(
  handler: (...args: unknown[]) => void,
  timeout?: number,
): unknown;
declare function clearTimeout(handle?: unknown): void;
