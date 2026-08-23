import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdmissionsStore } from "../src/admissions-store.js";
import type { AppConfig } from "../src/config.js";
import { openDatabase } from "../src/database.js";

type ToolDefinition = { name: string; handler: (args: Record<string, any>, extra: unknown) => Promise<any> };
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  tool: (name: string, _description: string, _schema: unknown, handler: ToolDefinition["handler"]) => ({
    name,
    handler
  }),
  createSdkMcpServer: (options: unknown) => options
}));

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function config(root: string): AppConfig {
  return {
    host: "127.0.0.1",
    port: 8787,
    databasePath: ":memory:",
    workspaceRoot: root,
    runtime: "demo",
    claudeAuthConfigured: false,
    claudeAuthSource: "none",
    claudeSettingsMode: "isolated",
    claudeConfigDir: path.join(root, ".claude"),
    claudeConfigDirExplicit: false,
    model: "sonnet",
    modelDisplay: "sonnet",
    effort: "high",
    maxConcurrency: 2,
    maxTurns: 30,
    runTimeoutMs: 20_000,
    maxBudgetUsd: 2,
    logLevel: "silent",
    nodeEnv: "test"
  };
}

function parse(result: any) {
  return JSON.parse(result.content[0].text);
}

describe("admissions MCP tools", () => {
  it("falls back from synthetic DNS answers to public DNS without accepting ordinary private answers", async () => {
    const { resolvePublicAddresses } = await import("../src/admissions-tools.js");
    const dnsFetch = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toContain("cloudflare-dns.com/dns-query");
      return new Response(JSON.stringify({ Status: 0, Answer: [{ type: 1, data: "104.16.4.14" }] }), {
        status: 200,
        headers: { "content-type": "application/dns-json" }
      });
    });
    await expect(
      resolvePublicAddresses("www.ntu.edu.sg", async () => ["198.18.0.86"], dnsFetch as typeof fetch)
    ).resolves.toEqual(["104.16.4.14"]);
    expect(dnsFetch).toHaveBeenCalledTimes(1);

    dnsFetch.mockClear();
    await expect(
      resolvePublicAddresses("internal.example", async () => ["127.0.0.1"], dnsFetch as typeof fetch)
    ).resolves.toEqual(["127.0.0.1"]);
    expect(dnsFetch).not.toHaveBeenCalled();
  });

  it("provides a domain-filtered application-managed official search fallback", async () => {
    const { createAdmissionsMcpServers } = await import("../src/admissions-tools.js");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "admissions-search-"));
    roots.push(root);
    const database = openDatabase(":memory:");
    const store = new AdmissionsStore(database);
    store.createCycle({
      name: "2027",
      degree: "Master",
      fieldOfStudy: "AI",
      intakeTerm: "Fall",
      targetRegions: ["新加坡"],
      active: true
    });
    const rss = `<?xml version="1.0"?><rss><channel>
      <item><title>NTU MSAI &amp; Admissions</title><link>https://www.ntu.edu.sg/education/graduate-programme/msai</link><description>Official &lt;b&gt;programme&lt;/b&gt; page</description></item>
      <item><title>Aggregator</title><link>https://example.com/ntu</link><description>Not official</description></item>
    </channel></rss>`;
    const fetchImpl = vi.fn(
      async () => new Response(rss, { status: 200, headers: { "content-type": "application/rss+xml" } })
    );
    const servers = createAdmissionsMcpServers({
      store,
      config: config(root),
      workspacePath: root,
      fetchImpl: fetchImpl as typeof fetch,
      resolveHost: async () => ["13.107.21.200"]
    }) as any;
    const search = (servers.admissions_evidence.tools as ToolDefinition[]).find(
      (item) => item.name === "search_official_sources"
    )!;
    const result = parse(
      await search.handler(
        { query: String.raw`NTU \"MSAI\" deadline`, domains: ["ntu.edu.sg", "nus.edu.sg"], limit: 5 },
        {}
      )
    );
    expect(result.query).toBe('NTU "MSAI" deadline');
    expect(result.results).toEqual([
      {
        title: "NTU MSAI & Admissions",
        url: "https://www.ntu.edu.sg/education/graduate-programme/msai",
        snippet: "Official programme page"
      }
    ]);
    const requested = fetchImpl.mock.calls.map((call) => String(call[0]));
    expect(requested.some((url) => url.includes("site%3Antu.edu.sg") && !url.includes("site%3Anus.edu.sg"))).toBe(true);
    expect(requested.some((url) => url.includes("site%3Anus.edu.sg") && !url.includes("site%3Antu.edu.sg"))).toBe(true);
    expect(requested.every((url) => !url.includes("OR"))).toBe(true);
    database.close();
  });

  it("falls back from Bing RSS to HTML results and keeps only official hosts", async () => {
    const { createAdmissionsMcpServers } = await import("../src/admissions-tools.js");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "admissions-search-html-"));
    roots.push(root);
    const database = openDatabase(":memory:");
    const store = new AdmissionsStore(database);
    store.createCycle({
      name: "2027",
      degree: "Master",
      fieldOfStudy: "AI",
      intakeTerm: "Fall",
      targetRegions: ["新加坡"],
      active: true
    });
    const bingHtml = `<html><ol>
      <li class="b_algo"><h2><a href="https://www.nus.edu.sg/graduate/ai">NUS AI programme</a></h2><p>Official admissions page</p></li>
      <li class="b_algo"><h2><a href="https://aggregator.example/nus">Aggregator</a></h2><p>Not official</p></li>
    </ol></html>`;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const requested = String(url);
      if (requested.includes("format=rss")) {
        return new Response("<html><body>not rss</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" }
        });
      }
      if (requested.includes("bing.com/search")) {
        return new Response(bingHtml, { status: 200, headers: { "content-type": "text/html" } });
      }
      throw new Error(`unexpected search url ${requested}`);
    });
    const servers = createAdmissionsMcpServers({
      store,
      config: config(root),
      workspacePath: root,
      fetchImpl: fetchImpl as typeof fetch,
      resolveHost: async () => ["13.107.21.200"]
    }) as any;
    const search = (servers.admissions_evidence.tools as ToolDefinition[]).find(
      (item) => item.name === "search_official_sources"
    )!;
    const result = parse(await search.handler({ query: "NUS AI master", domains: ["nus.edu.sg"], limit: 5 }, {}));
    expect(result.results).toEqual([
      {
        title: "NUS AI programme",
        url: "https://www.nus.edu.sg/graduate/ai",
        snippet: "Official admissions page"
      }
    ]);
    database.close();
  });

  it("falls back to DuckDuckGo when Bing search is unavailable", async () => {
    const { createAdmissionsMcpServers } = await import("../src/admissions-tools.js");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "admissions-search-ddg-"));
    roots.push(root);
    const database = openDatabase(":memory:");
    const store = new AdmissionsStore(database);
    const ddg = `<html>
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.hkust.edu.hk%2Fadmissions">HKUST Admissions</a>
      <span class="result__snippet">Official graduate admissions</span>
    </html>`;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const requested = String(url);
      if (requested.includes("bing.com")) {
        return new Response("blocked", { status: 403, headers: { "content-type": "text/html" } });
      }
      if (requested.includes("duckduckgo.com")) {
        return new Response(ddg, { status: 200, headers: { "content-type": "text/html" } });
      }
      throw new Error(`unexpected search url ${requested}`);
    });
    const servers = createAdmissionsMcpServers({
      store,
      config: config(root),
      workspacePath: root,
      fetchImpl: fetchImpl as typeof fetch,
      resolveHost: async () => ["52.142.124.128"]
    }) as any;
    const search = (servers.admissions_evidence.tools as ToolDefinition[]).find(
      (item) => item.name === "search_official_sources"
    )!;
    const result = parse(await search.handler({ query: "HKUST AI master", domains: ["hkust.edu.hk"], limit: 5 }, {}));
    expect(result.results).toEqual([
      {
        title: "HKUST Admissions",
        url: "https://www.hkust.edu.hk/admissions",
        snippet: "Official graduate admissions"
      }
    ]);
    database.close();
  });

  it("extracts embedded text and candidate links from a JavaScript-rendered official page", async () => {
    const { createAdmissionsMcpServers } = await import("../src/admissions-tools.js");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "admissions-js-page-"));
    roots.push(root);
    const database = openDatabase(":memory:");
    const store = new AdmissionsStore(database);
    const cycle = store.createCycle({
      name: "2027",
      degree: "Master",
      fieldOfStudy: "AI",
      intakeTerm: "Fall",
      targetRegions: ["新加坡"],
      active: true
    });
    const html = `<html>
      <head>
        <title>NUS SCALE</title>
        <meta name="description" content="Graduate programmes at NUS SCALE">
        <script type="application/ld+json">{"@type":"WebPage","description":"Official graduate admissions information for NUS SCALE programmes."}</script>
        <script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"summary":"The MSc in Artificial Intelligence is a full-time graduate programme."}}}</script>
      </head>
      <body>
        <div id="__next"></div>
        <noscript>Enable JavaScript to view programme details including application deadlines.</noscript>
        <a href="/graduate/admissions">Admissions</a>
        <a href="https://other.edu/x">Other school</a>
      </body>
    </html>`;
    const fetchImpl = vi.fn(async () => new Response(html, { status: 200, headers: { "content-type": "text/html" } }));
    const servers = createAdmissionsMcpServers({
      store,
      config: config(root),
      workspacePath: root,
      fetchImpl: fetchImpl as typeof fetch,
      resolveHost: async () => ["93.184.216.34"]
    }) as any;
    const fetchPage = (servers.admissions_evidence.tools as ToolDefinition[]).find(
      (item) => item.name === "fetch_official_page"
    )!;
    const result = parse(
      await fetchPage.handler({ url: "https://scale.nus.edu.sg/programmes", cycleId: cycle.id }, {})
    );
    expect(result.jsRendered).toBe(true);
    expect(result.text).toContain("Official graduate admissions information");
    expect(result.text).toContain("MSc in Artificial Intelligence");
    expect(result.candidateLinks).toContain("https://scale.nus.edu.sg/graduate/admissions");
    expect(result.candidateLinks).not.toEqual(expect.arrayContaining(["https://other.edu/x"]));
    expect(result.renderWarning).toMatch(/JavaScript-rendered|candidateLinks/i);
    database.close();
  });

  it("can read an official page before onboarding without pretending it was saved", async () => {
    const { createAdmissionsMcpServers } = await import("../src/admissions-tools.js");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "admissions-pre-onboarding-"));
    roots.push(root);
    const database = openDatabase(":memory:");
    const store = new AdmissionsStore(database);
    const fetchImpl = vi.fn(
      async () =>
        new Response("<html><body>Official programme requirements</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" }
        })
    );
    const servers = createAdmissionsMcpServers({
      store,
      config: config(root),
      workspacePath: root,
      fetchImpl: fetchImpl as typeof fetch,
      resolveHost: async () => ["93.184.216.34"]
    }) as any;
    const fetchPage = (servers.admissions_evidence.tools as ToolDefinition[]).find(
      (item) => item.name === "fetch_official_page"
    )!;
    const result = parse(await fetchPage.handler({ url: "https://example.edu/programme" }, {}));
    expect(result).toMatchObject({ sourceId: null, text: "Official programme requirements" });
    expect(result.saveWarning).toMatch(/not saved/i);
    database.close();
  });

  it("fetches and stores sanitized public evidence while rejecting private addresses", async () => {
    const { createAdmissionsMcpServers } = await import("../src/admissions-tools.js");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "admissions-tools-"));
    roots.push(root);
    const database = openDatabase(":memory:");
    const store = new AdmissionsStore(database);
    const cycle = store.createCycle({
      name: "2027",
      degree: "PhD",
      fieldOfStudy: "AI",
      intakeTerm: "Fall",
      targetRegions: ["美国"],
      active: true
    });
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          "<html><style>hidden</style><script>secret()</script><body><h1>Graduate Admissions</h1><p>Deadline December 1.</p></body></html>",
          { status: 200, headers: { "content-type": "text/html" } }
        )
    );
    const servers = createAdmissionsMcpServers({
      store,
      config: config(root),
      workspacePath: root,
      fetchImpl: fetchImpl as typeof fetch,
      resolveHost: async () => ["93.184.216.34"]
    }) as any;
    const fetchTool = (servers.admissions_evidence.tools as ToolDefinition[]).find(
      (item) => item.name === "fetch_official_page"
    )!;
    const result = parse(await fetchTool.handler({ url: "https://example.edu/graduate", cycleId: cycle.id }, {}));
    expect(result.text).toContain("Graduate Admissions Deadline December 1.");
    expect(result.text).not.toContain("secret()");
    expect(store.listSources(cycle.id)).toHaveLength(1);

    const blockedServers = createAdmissionsMcpServers({
      store,
      config: config(root),
      workspacePath: root,
      fetchImpl: fetchImpl as typeof fetch,
      resolveHost: async () => ["127.0.0.1"]
    }) as any;
    const blockedTool = (blockedServers.admissions_evidence.tools as ToolDefinition[]).find(
      (item) => item.name === "fetch_official_page"
    )!;
    const blocked = await blockedTool.handler({ url: "https://internal.example/", cycleId: cycle.id }, {});
    expect(blocked.isError).toBe(true);
    expect(blocked.content[0].text).toContain("Private network");
    database.close();
  });

  it("checks every redirect hop and rejects oversized response bodies", async () => {
    const { createAdmissionsMcpServers } = await import("../src/admissions-tools.js");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "admissions-fetch-limits-"));
    roots.push(root);
    const database = openDatabase(":memory:");
    const store = new AdmissionsStore(database);
    const cycle = store.createCycle({
      name: "2027",
      degree: "PhD",
      fieldOfStudy: "AI",
      intakeTerm: "Fall",
      targetRegions: ["美国"],
      active: true
    });
    const redirected = createAdmissionsMcpServers({
      store,
      config: config(root),
      workspacePath: root,
      fetchImpl: vi.fn(
        async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } })
      ) as typeof fetch,
      resolveHost: async (host) => (host === "127.0.0.1" ? ["127.0.0.1"] : ["93.184.216.34"])
    }) as any;
    const fetchTool = (redirected.admissions_evidence.tools as ToolDefinition[]).find(
      (item) => item.name === "fetch_official_page"
    )!;
    const redirectResult = await fetchTool.handler({ url: "https://example.edu/graduate", cycleId: cycle.id }, {});
    expect(redirectResult.isError).toBe(true);
    expect(redirectResult.content[0].text).toContain("Private network");

    const oversized = createAdmissionsMcpServers({
      store,
      config: config(root),
      workspacePath: root,
      fetchImpl: vi.fn(
        async () =>
          new Response("ok", { status: 200, headers: { "content-type": "text/html", "content-length": "512001" } })
      ) as typeof fetch,
      resolveHost: async () => ["93.184.216.34"]
    }) as any;
    const oversizedTool = (oversized.admissions_evidence.tools as ToolDefinition[]).find(
      (item) => item.name === "fetch_official_page"
    )!;
    const oversizedResult = await oversizedTool.handler({ url: "https://example.edu/graduate", cycleId: cycle.id }, {});
    expect(oversizedResult.isError).toBe(true);
    expect(oversizedResult.content[0].text).toContain("500 KB");

    const mappedFetch = vi.fn(
      async () => new Response("private", { status: 200, headers: { "content-type": "text/html" } })
    );
    const mapped = createAdmissionsMcpServers({
      store,
      config: config(root),
      workspacePath: root,
      fetchImpl: mappedFetch as typeof fetch,
      resolveHost: async () => ["::ffff:7f00:1"]
    }) as any;
    const mappedTool = (mapped.admissions_evidence.tools as ToolDefinition[]).find(
      (item) => item.name === "fetch_official_page"
    )!;
    const mappedResult = await mappedTool.handler({ url: "https://mapped.example/graduate", cycleId: cycle.id }, {});
    expect(mappedResult.isError).toBe(true);
    expect(mappedResult.content[0].text).toContain("Private network");
    expect(mappedFetch).not.toHaveBeenCalled();

    const abortedFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.signal?.aborted) throw init.signal.reason;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    const aborted = createAdmissionsMcpServers({
      store,
      config: config(root),
      workspacePath: root,
      fetchImpl: abortedFetch as typeof fetch,
      resolveHost: async () => ["93.184.216.34"]
    }) as any;
    const abortedTool = (aborted.admissions_evidence.tools as ToolDefinition[]).find(
      (item) => item.name === "fetch_official_page"
    )!;
    const controller = new AbortController();
    controller.abort();
    const abortedResult = await abortedTool.handler(
      { url: "https://example.edu/graduate", cycleId: cycle.id },
      { signal: controller.signal }
    );
    expect(abortedResult.isError).toBe(true);
    database.close();
  });

  it("updates the tracker and registers only workspace-contained artifacts", async () => {
    const { createAdmissionsMcpServers } = await import("../src/admissions-tools.js");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "admissions-artifact-tools-"));
    roots.push(root);
    const workspace = path.join(root, "conversation");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(path.join(workspace, "sop.md"), "# SOP");
    const database = openDatabase(":memory:");
    const store = new AdmissionsStore(database);
    const cycle = store.createCycle({
      name: "2027",
      degree: "Master",
      fieldOfStudy: "CS",
      intakeTerm: "Fall",
      targetRegions: ["加拿大"],
      active: true
    });
    const servers = createAdmissionsMcpServers({
      store,
      config: config(root),
      workspacePath: workspace,
      resolveHost: async () => ["93.184.216.34"]
    }) as any;
    const trackerTools = servers.application_tracker.tools as ToolDefinition[];
    const addProgram = trackerTools.find((item) => item.name === "add_program")!;
    const program = parse(
      await addProgram.handler(
        {
          school: "Example University",
          program: "MSc CS",
          country: "加拿大",
          degree: "MSc",
          officialUrl: "https://example.edu/msc",
          cycleId: cycle.id
        },
        {}
      )
    );
    expect(program.status).toBe("researching");

    const register = (servers.admissions_artifacts.tools as ToolDefinition[]).find(
      (item) => item.name === "register_artifact"
    )!;
    const artifact = parse(
      await register.handler({ sourceRelativePath: "sop.md", type: "SOP", cycleId: cycle.id }, {})
    );
    expect(artifact).toMatchObject({ type: "SOP", version: 1 });
    await expect(fs.readFile(path.join(root, ".admissions-artifacts", artifact.relativePath), "utf8")).resolves.toBe(
      "# SOP"
    );
    const blocked = await register.handler({ sourceRelativePath: "../outside.md", type: "SOP", cycleId: cycle.id }, {});
    expect(blocked.isError).toBe(true);
    const outside = path.join(root, "outside.md");
    await fs.writeFile(outside, "outside");
    await fs.symlink(outside, path.join(workspace, "linked.md"));
    const symlinked = await register.handler({ sourceRelativePath: "linked.md", type: "SOP", cycleId: cycle.id }, {});
    expect(symlinked.isError).toBe(true);
    expect(symlinked.content[0].text).toMatch(/symbolic|symlink/i);
    database.close();
  });

  it("initializes admissions tracking and manages profile, requirements, and programme deletion", async () => {
    const { createAdmissionsMcpServers } = await import("../src/admissions-tools.js");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "admissions-initialize-"));
    roots.push(root);
    const database = openDatabase(":memory:");
    const store = new AdmissionsStore(database);
    const servers = createAdmissionsMcpServers({
      store,
      config: config(root),
      workspacePath: root,
      resolveHost: async () => ["93.184.216.34"]
    }) as any;
    const tools = servers.application_tracker.tools as ToolDefinition[];
    const initialize = tools.find((item) => item.name === "create_application_cycle")!;
    const cycle = parse(
      await initialize.handler(
        {
          degree: "Master",
          intakeTerm: "2027 Fall",
          fieldOfStudy: "AI",
          targetRegions: ["新加坡", "新加坡", "香港"]
        },
        {}
      )
    );
    expect(cycle).toMatchObject({
      active: true,
      degree: "Master",
      fieldOfStudy: "AI",
      targetRegions: ["新加坡", "香港"]
    });
    expect(store.getApplicantProfile(cycle.id)).toMatchObject({ cycleId: cycle.id });
    const duplicate = await initialize.handler(
      {
        degree: "PhD",
        intakeTerm: "2028 Fall",
        fieldOfStudy: "CS",
        targetRegions: ["美国"]
      },
      {}
    );
    expect(duplicate.isError).toBe(true);

    const setProfile = tools.find((item) => item.name === "set_applicant_profile")!;
    const createdProfile = parse(await setProfile.handler({ educationSummary: "BSc CS", exams: { IELTS: 7.5 } }, {}));
    expect(createdProfile).toMatchObject({ educationSummary: "BSc CS", exams: { IELTS: 7.5 } });
    const updatedProfile = parse(
      await setProfile.handler({ researchSummary: "NLP research", budgetConstraints: "Needs funding" }, {})
    );
    expect(updatedProfile).toMatchObject({
      educationSummary: "BSc CS",
      researchSummary: "NLP research",
      budgetConstraints: "Needs funding"
    });
    expect(store.getApplicantProfile(cycle.id)?.id).toBe(createdProfile.id);

    const englishCycle = store.createCycle({
      name: "2027 Fall",
      degree: "Master",
      fieldOfStudy: "AI",
      intakeTerm: "Fall 2027",
      targetRegions: ["Singapore", "Hong Kong", "USA"],
      active: true
    });
    expect(englishCycle.targetRegions).toEqual(["新加坡", "香港", "美国"]);

    const program = store.createProgram({
      cycleId: cycle.id,
      school: "NTU",
      program: "MSAI",
      country: "Singapore",
      degree: "MSc",
      status: "shortlisted",
      officialUrl: "https://www.ntu.edu.sg/msai",
      applicationFee: null,
      feeCurrency: null,
      deadlineAt: null,
      fundingSummary: "",
      lastVerifiedAt: null
    });
    const updateProgram = tools.find((item) => item.name === "update_program")!;
    const revised = parse(
      await updateProgram.handler(
        {
          programId: program.id,
          officialUrl:
            "https://www.ntu.edu.sg/education/graduate-programme/master-of-science-in-artificial-intelligence",
          deadlineAt: "2026-08-31",
          fundingSummary: "学费 S$63,220"
        },
        {}
      )
    );
    expect(revised).toMatchObject({
      officialUrl: "https://www.ntu.edu.sg/education/graduate-programme/master-of-science-in-artificial-intelligence",
      fundingSummary: "学费 S$63,220"
    });
    expect(revised.deadlineAt).toContain("2026-08-31");
    expect(revised.deadlines).toEqual([
      expect.objectContaining({ label: "", dueAt: expect.stringContaining("2026-08-31") })
    ]);
    const rounds = parse(
      await updateProgram.handler(
        {
          programId: program.id,
          deadlines: [
            { label: "Round 1", dueAt: "2026-08-31" },
            { label: "Round 2", dueAt: "2026-11-15" }
          ]
        },
        {}
      )
    );
    expect(rounds.deadlines.map((item: { label: string }) => item.label)).toEqual(["Round 1", "Round 2"]);
    expect(rounds.deadlineAt).toContain("2026-08-31");
    const addRequirement = tools.find((item) => item.name === "add_requirement")!;
    const requirement = parse(
      await addRequirement.handler({ programId: program.id, label: "Statement of Purpose", type: "statement" }, {})
    );
    expect(requirement).toMatchObject({ programId: program.id, status: "missing", label: "Statement of Purpose" });
    const updateRequirement = tools.find((item) => item.name === "update_requirement_status")!;
    expect(
      parse(await updateRequirement.handler({ requirementId: requirement.id, status: "ready" }, {}))
    ).toMatchObject({ status: "ready" });
    const deleteProgram = tools.find((item) => item.name === "delete_program")!;
    expect(parse(await deleteProgram.handler({ programId: program.id }, {}))).toMatchObject({
      deleted: true,
      programId: program.id,
      school: "NTU",
      program: "MSAI"
    });
    expect(store.getProgram(program.id)).toBeNull();
    expect((await deleteProgram.handler({ programId: program.id }, {})).isError).toBe(true);
    database.close();
  });
});
