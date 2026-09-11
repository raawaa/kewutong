/**
 * vitest 的全局 setup：装上 jest-dom 的断言（`toBeInTheDocument` 等），
 * 每个测试后清理 DOM。
 */
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});
