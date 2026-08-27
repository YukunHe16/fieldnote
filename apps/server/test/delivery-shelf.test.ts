import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { DeliveryShelf } from "../src/delivery-shelf.js";

describe("delivery shelf", () => {
  it("stores a presented file and cites it into another workspace", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "shelf-"));
    const source = path.join(root, "source");
    const target = path.join(root, "target");
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "resume.pdf"), "pdf");
    const shelf = new DeliveryShelf(openDatabase(":memory:"));
    const item = shelf.put({
      profileId: "local-operator",
      conversationId: "c1",
      fileName: "resume.pdf",
      mimeType: "application/pdf",
      relativePath: "resume.pdf",
      sourceWorkspace: source
    });
    expect(shelf.search("local-operator", "resume")[0]?.id).toBe(item.id);
    expect(shelf.citeIntoWorkspace(item, target)).toBe(path.join("shelf", "resume.pdf"));
    expect(fs.readFileSync(path.join(target, "shelf", "resume.pdf"), "utf8")).toBe("pdf");
    expect(shelf.fileAbsolutePath(item, root)).toBe(path.join(source, "resume.pdf"));
    expect(shelf.remove(item.id)?.id).toBe(item.id);
    expect(shelf.get(item.id)).toBeNull();
    expect(fs.existsSync(path.join(source, "resume.pdf"))).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
