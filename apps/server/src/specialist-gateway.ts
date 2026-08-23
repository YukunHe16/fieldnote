import { query } from "@anthropic-ai/claude-agent-sdk";

export interface SpecialistDescriptor {
  id: string;
  transport: "local-claude";
}

export interface SpecialistExecutionRequest {
  prompt: string;
  options: Record<string, unknown>;
}

export interface SpecialistGateway {
  describe(): SpecialistDescriptor;
  run(request: SpecialistExecutionRequest): AsyncIterable<Record<string, unknown>>;
}

type LocalQueryFactory = (input: { prompt: string; options: Record<string, unknown> }) => AsyncIterable<unknown>;

export class LocalClaudeSpecialistGateway implements SpecialistGateway {
  constructor(private readonly queryFactory: LocalQueryFactory = query as LocalQueryFactory) {}

  describe(): SpecialistDescriptor {
    return { id: "local-claude", transport: "local-claude" };
  }

  async *run(request: SpecialistExecutionRequest): AsyncIterable<Record<string, unknown>> {
    for await (const event of this.queryFactory({ prompt: request.prompt, options: request.options })) {
      if (event && typeof event === "object") yield event as Record<string, unknown>;
    }
  }
}
