import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { InputFileManifestService, MAX_INPUT_FILE_BYTES } from "../src/input-file-manifest.js";
import { AgentStore } from "../src/store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("InputFileManifestService", () => {
  it("builds verified manifests for document and image attachments, including duplicate file names", async () => {
    const fixture = await createFixture();
    const document = await fixture.add("notes.pdf", "application/pdf", "first");
    const image = await fixture.add("notes.pdf", "image/png", "second");
    const result = await fixture.service.buildForAttachments(fixture.conversation.id, [document.id, image.id]);

    expect(result.errors).toEqual([]);
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attachmentId: document.id,
          originalFileName: "notes.pdf",
          mimeType: "application/pdf"
        }),
        expect.objectContaining({ attachmentId: image.id, originalFileName: "notes.pdf", mimeType: "image/png" })
      ])
    );
  });

  it("reports cross-conversation and missing attachment IDs without returning them", async () => {
    const fixture = await createFixture();
    const other = fixture.store.createConversation();
    const attachment = await fixture.add("private.txt", "text/plain", "private", other.id);
    const result = await fixture.service.buildForAttachments(fixture.conversation.id, [attachment.id, "missing"]);

    expect(result.items).toEqual([]);
    expect(result.errors.map((error) => error.message)).toEqual(
      expect.arrayContaining(["附件不属于当前对话，无法使用。", "附件不存在。"])
    );
  });

  it("rejects missing files, directories, unsafe paths, size mismatches, and hash mismatches", async () => {
    const fixture = await createFixture();
    const missing = await fixture.add("missing.txt", "text/plain", "missing", fixture.conversation.id, {
      write: false
    });
    const directory = await fixture.add("folder", "text/plain", "", fixture.conversation.id, { directory: true });
    const traversal = await fixture.add("escape.txt", "text/plain", "escape", fixture.conversation.id, {
      relativePath: "../escape.txt"
    });
    const wrongSize = await fixture.add("size.txt", "text/plain", "size", fixture.conversation.id, { size: 99 });
    const oversized = await fixture.add("large.pdf", "application/pdf", "large", fixture.conversation.id, {
      size: MAX_INPUT_FILE_BYTES + 1
    });
    const wrongHash = await fixture.add("hash.txt", "text/plain", "hash", fixture.conversation.id, {
      sha256: "0".repeat(64)
    });
    const result = await fixture.service.buildForAttachments(fixture.conversation.id, [
      missing.id,
      directory.id,
      traversal.id,
      wrongSize.id,
      oversized.id,
      wrongHash.id
    ]);

    expect(result.items).toEqual([]);
    expect(result.errors.map((error) => error.message)).toEqual(
      expect.arrayContaining([
        "附件文件缺失，无法使用。",
        "附件不是普通文件，无法使用。",
        "附件路径超出当前对话工作区，已拒绝使用。",
        "附件大小与记录不一致，无法使用。",
        "附件大小超出 20 MB 限制，无法使用。",
        "附件内容校验失败，无法使用。"
      ])
    );
  });

  it("builds by message and filters current versus history by message, file name, and MIME type", async () => {
    const fixture = await createFixture();
    const current = await fixture.add("Current Notes.pdf", "application/pdf", "current");
    const historyRun = fixture.store.createRun(fixture.conversation.id, "history", "normal");
    const history = await fixture.add("image.png", "image/png", "history", fixture.conversation.id, {
      messageId: historyRun.userMessageId
    });
    await fixture.add("generated.pdf", "application/pdf", "assistant output", fixture.conversation.id, {
      messageId: historyRun.assistantMessageId
    });
    const messageResult = await fixture.service.buildForMessage(fixture.conversation.id, current.messageId!);
    const assistantResult = await fixture.service.buildForMessage(
      fixture.conversation.id,
      historyRun.assistantMessageId
    );
    const currentOnly = await fixture.service.listForConversation(fixture.conversation.id, {
      currentMessageId: current.messageId!,
      scope: "current",
      fileName: "notes",
      mimeType: "application/pdf"
    });
    const historyOnly = await fixture.service.listForConversation(fixture.conversation.id, {
      currentMessageId: current.messageId!,
      scope: "history",
      sourceMessageId: historyRun.userMessageId,
      mimeType: "image/png"
    });

    expect(messageResult.items).toHaveLength(1);
    expect(assistantResult.items).toEqual([]);
    expect(currentOnly.items).toEqual([
      expect.objectContaining({ attachmentId: current.id, source: "current_message" })
    ]);
    expect(historyOnly.items).toEqual([expect.objectContaining({ attachmentId: history.id, source: "history" })]);
  });
});

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "input-manifest-"));
  roots.push(root);
  const database = openDatabase(":memory:");
  const store = new AgentStore(database);
  const conversation = store.createConversation();
  const run = store.createRun(conversation.id, "with file", "normal");
  const service = new InputFileManifestService(store, root);
  return {
    root,
    database,
    store,
    conversation,
    service,
    async add(
      fileName: string,
      mimeType: string,
      content: string,
      conversationId = conversation.id,
      options: {
        write?: boolean;
        directory?: boolean;
        relativePath?: string;
        size?: number;
        sha256?: string;
        messageId?: string;
      } = {}
    ) {
      const relativePath =
        options.relativePath ?? path.join("attachments", `${Math.random().toString(16).slice(2)}-${fileName}`);
      const absolutePath = path.join(root, conversationId, relativePath);
      if (options.directory) await fs.mkdir(absolutePath, { recursive: true });
      else if (options.write !== false) {
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.writeFile(absolutePath, content);
      }
      const attachment = store.createAttachment({
        conversationId,
        fileName,
        storedName: path.basename(relativePath),
        mimeType,
        size: options.size ?? Buffer.byteLength(content),
        sha256: options.sha256 ?? createHash("sha256").update(content).digest("hex"),
        relativePath
      });
      const messageId = options.messageId ?? run.userMessageId;
      store.database
        .prepare("INSERT OR IGNORE INTO message_attachments (message_id, attachment_id) VALUES (?, ?)")
        .run(messageId, attachment.id);
      return { ...attachment, messageId };
    }
  };
}
