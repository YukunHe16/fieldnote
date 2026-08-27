import { describe, expect, it } from "vitest";
import {
  askUserAnswersFromCard,
  buildFeishuAskUserCard,
  feishuReplyOptions,
  feishuRoomKey,
  inboundFilesFromMessage
} from "../src/feishu-room.js";
import { parseCardActionValue } from "../src/feishu.js";

describe("feishu room", () => {
  it("reuses a group chat without opening a new workspace per @", () => {
    expect(
      feishuRoomKey({
        chatType: "group",
        chatId: "oc_group",
        senderId: "ou_a"
      })
    ).toBe("group:oc_group");
    expect(
      feishuRoomKey({
        chatType: "group",
        chatId: "oc_group",
        senderId: "ou_b",
        rootId: "om_thread"
      })
    ).toBe("group:oc_group:om_thread");
    expect(
      feishuRoomKey({
        chatType: "p2p",
        chatId: "oc_dm",
        senderId: "ou_me"
      })
    ).toBe("p2p:ou_me");
  });

  it("replies in the group timeline unless the @ already arrived in a topic", () => {
    expect(feishuReplyOptions({ messageId: "om_at" })).toEqual({
      replyTo: "om_at",
      replyInThread: false
    });
    expect(
      feishuReplyOptions({
        messageId: "om_at",
        rootId: "om_topic",
        threadId: "omt_1"
      })
    ).toEqual({
      replyTo: "om_at",
      replyInThread: true
    });
  });

  it("extracts inbound files from SDK fields and JSON content", () => {
    expect(
      inboundFilesFromMessage({
        files: [{ file_key: "file_1", file_name: "resume.pdf", mime_type: "application/pdf" }]
      })
    ).toMatchObject([{ key: "file_1", kind: "file", fileName: "resume.pdf" }]);
    expect(
      inboundFilesFromMessage({
        content: JSON.stringify({
          zh_cn: {
            content: [
              [{ tag: "img", image_key: "img_photo" }],
              [{ tag: "file", file_key: "file_cv", file_name: "cv.pdf" }]
            ]
          }
        }),
        messageType: "post"
      })
    ).toMatchObject([
      { key: "img_photo", kind: "image" },
      { key: "file_cv", fileName: "cv.pdf" }
    ]);
    expect(
      inboundFilesFromMessage({
        raw: {
          message: { message_type: "file", content: JSON.stringify({ file_key: "file_raw", file_name: "offer.pdf" }) }
        }
      })
    ).toMatchObject([{ key: "file_raw", fileName: "offer.pdf" }]);
  });

  it("builds an AskUser option card that answers the pending question", () => {
    const question = {
      questions: [
        {
          question: "用哪一版简历？",
          options: [{ label: "一页版" }, { label: "两页版" }]
        }
      ]
    };
    const card = buildFeishuAskUserCard(question, {
      conversationId: "c1",
      runId: "r1",
      webAppUrl: "http://127.0.0.1:5173"
    }) as any;
    expect(card.header.title.content).toBe("需要你选择");
    expect(card.body.elements[0].content).toContain("用哪一版简历？");
    expect(card.body.elements[0].content).toContain("一页版");
    expect(card.body.elements[1]).toMatchObject({ tag: "button", width: "fill", text: { content: "一页版" } });
    const value = card.body.elements[1].behaviors[0].value;
    expect(parseCardActionValue(value)).toMatchObject({
      action: "ask_answer",
      runId: "r1",
      answer: "一页版"
    });
    expect(askUserAnswersFromCard(question, "一页版")).toEqual({ "用哪一版简历？": "一页版" });
    expect(card.body.elements.at(-1)).toMatchObject({
      tag: "button",
      text: { content: "去往网页端" }
    });
    expect(card.body.elements.at(-1).behaviors[0].default_url).toContain("conversation=c1");
  });

  it("writes full option labels on the AskUser card instead of a truncated row", () => {
    const card = buildFeishuAskUserCard(
      {
        questions: [
          {
            header: "优先事项",
            question: "眼下这门课里，你最想先弄懂哪一块？",
            options: [
              { label: "递归的调用栈", description: "先收窄到一个具体例子" },
              { label: "指针与引用" },
              { label: "复杂度分析" },
              { label: "缓存机制" }
            ]
          }
        ]
      },
      { conversationId: "c1", runId: "r1" }
    ) as any;
    expect(card.body.elements[0].content).toContain("递归的调用栈");
    expect(card.body.elements[0].content).toContain("先收窄到一个具体例子");
    expect(card.body.elements.filter((item: { tag: string }) => item.tag === "button")).toHaveLength(4);
    expect(card.body.elements[1].text.content).toBe("递归的调用栈");
    expect(card.body.elements.some((item: { tag: string }) => item.tag === "column_set")).toBe(false);
  });
});
