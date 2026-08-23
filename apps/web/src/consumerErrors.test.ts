import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { consumerSendError } from "./consumerErrors";

describe("consumer error messages", () => {
  it("maps offline and network failures", () => {
    expect(consumerSendError(new Error("anything"), false)).toBe("网络连接中断，恢复后可以重试");
    expect(consumerSendError(new TypeError("fetch failed"))).toBe("网络连接中断，恢复后可以重试");
  });

  it("maps rate limits and generic service errors", () => {
    expect(consumerSendError(new ApiError("rate limited", 429))).toBe("当前请求较多，请稍后再试");
    expect(consumerSendError(new ApiError("internal", 500))).toBe("暂时无法完成，请重试");
  });
});
