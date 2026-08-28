import { createHash } from "node:crypto";

export const CACHE_BANK_VERSION = "cache-v1" as const;
export const CACHE_BANK_SET_IDS = [
  "trace-3c",
  "compulsory-repeated",
  "fully-associative-working-set",
  "write-policy-traffic",
  "set-mapping",
  "amat-tradeoff"
] as const;

export type CacheBankSetId = (typeof CACHE_BANK_SET_IDS)[number];
export type CacheTargetConcept =
  | "compulsory-conflict-capacity"
  | "compulsory-versus-repeated-access"
  | "fully-associative-lru-working-set"
  | "write-through-versus-write-back-traffic"
  | "set-index-and-associativity"
  | "average-memory-access-time";

export type CacheOrganization =
  | { kind: "direct"; lineSizeBytes: number; capacityLines: number }
  | { kind: "set-associative"; lineSizeBytes: number; setCount: number; ways: number }
  | { kind: "fully-associative"; lineSizeBytes: number; capacityLines: number };

export interface CacheAccess {
  address: number;
  operation?: "read" | "write";
  sizeBytes?: number;
}

export interface TraceProblem {
  config: CacheOrganization;
  accesses: number[];
}

export interface WriteTrafficProblem {
  config: CacheOrganization;
  accesses: Array<Required<Pick<CacheAccess, "address" | "operation" | "sizeBytes">>>;
  writeMissPolicy: "write-allocate" | "no-write-allocate";
  flushAtEnd: boolean;
}

export interface MappingProblem {
  config: CacheOrganization;
  addresses: number[];
}

export interface AmatOption {
  hitTimeNs: number;
  missRate: number;
  missPenaltyNs: number;
}

export interface AmatProblem {
  optionA: AmatOption;
  optionB: AmatOption;
}

export type CacheScenario =
  | { kind: "trace-3c"; primary: TraceProblem; transfer: TraceProblem }
  | { kind: "compulsory-repeated"; primary: TraceProblem; transfer: TraceProblem }
  | { kind: "fully-associative-working-set"; primary: TraceProblem; transfer: TraceProblem }
  | { kind: "write-policy-traffic"; primary: WriteTrafficProblem; transfer: WriteTrafficProblem }
  | { kind: "set-mapping"; primary: MappingProblem; transfer: MappingProblem }
  | { kind: "amat-tradeoff"; primary: AmatProblem; transfer: AmatProblem };

export type CacheMissClass = "compulsory" | "conflict" | "capacity";

export interface CacheSimulationStep {
  index: number;
  address: number;
  blockNumber: number;
  setIndex: number;
  tag: number;
  hit: boolean;
  evictedBlock: number | null;
}

export interface CacheSimulationResult {
  config: CacheOrganization;
  hits: number;
  misses: number;
  steps: CacheSimulationStep[];
}

export interface ClassifiedCacheStep extends CacheSimulationStep {
  missClass: CacheMissClass | null;
  fullyAssociativeHit: boolean;
}

export interface ClassifiedTraceResult {
  config: CacheOrganization;
  hits: number;
  misses: number;
  compulsoryMisses: number;
  conflictMisses: number;
  capacityMisses: number;
  steps: ClassifiedCacheStep[];
}

export interface WriteTrafficResult {
  policy: "write-through" | "write-back";
  writeMissPolicy: "write-allocate" | "no-write-allocate";
  flushAtEnd: boolean;
  hits: number;
  misses: number;
  memoryReadBytes: number;
  memoryWriteBytes: number;
  writeBacks: number;
  totalTrafficBytes: number;
}

export interface AddressMapping {
  address: number;
  blockNumber: number;
  offset: number;
  setIndex: number;
  tag: number;
}

export interface TraceOracle {
  kind: "trace-3c" | "compulsory-repeated";
  result: ClassifiedTraceResult;
}

export interface WorkingSetOracle {
  kind: "fully-associative-working-set";
  result: CacheSimulationResult;
  uniqueBlocks: number;
  capacityLines: number;
}

export interface WritePolicyOracle {
  kind: "write-policy-traffic";
  writeThrough: WriteTrafficResult;
  writeBack: WriteTrafficResult;
  lowerTrafficPolicy: "write-through" | "write-back" | "tie";
}

export interface MappingOracle {
  kind: "set-mapping";
  mappings: AddressMapping[];
  collisionSets: number[];
}

export interface AmatOracle {
  kind: "amat-tradeoff";
  optionA: number;
  optionB: number;
  lowerAmatOption: "A" | "B" | "tie";
}

export type CacheOracle = TraceOracle | WorkingSetOracle | WritePolicyOracle | MappingOracle | AmatOracle;

export interface RenderedCachePart {
  prompt: string;
  oracle: CacheOracle;
  rubric: string[];
  canonicalAnswer: string;
}

export interface RenderedCacheCandidate {
  version: typeof CACHE_BANK_VERSION;
  setId: CacheBankSetId;
  targetConcept: CacheTargetConcept;
  scenario: CacheScenario;
  primary: RenderedCachePart;
  transfer: RenderedCachePart;
  parameterSignature: string;
  candidateSha256: string;
  machineVerified: true;
}

export interface CacheValidationResult {
  valid: boolean;
  issues: string[];
  parameterSignature: string | null;
}

export class CacheBankValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid cache-bank candidate: ${issues.join("; ")}`);
  }
}

const TARGET_BY_SET: Record<CacheBankSetId, CacheTargetConcept> = {
  "trace-3c": "compulsory-conflict-capacity",
  "compulsory-repeated": "compulsory-versus-repeated-access",
  "fully-associative-working-set": "fully-associative-lru-working-set",
  "write-policy-traffic": "write-through-versus-write-back-traffic",
  "set-mapping": "set-index-and-associativity",
  "amat-tradeoff": "average-memory-access-time"
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const integer = (value: unknown): value is number => finite(value) && Number.isInteger(value);
const powerOfTwo = (value: number): boolean => value > 0 && (value & (value - 1)) === 0;
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const numberText = (value: number): string => Number(value.toFixed(6)).toString();
const hex = (value: number): string => `0x${value.toString(16).toUpperCase()}`;

function exactKeyIssues(value: Record<string, unknown>, path: string, expected: readonly string[]): string[] {
  const actual = Object.keys(value);
  const missing = expected.filter((key) => !actual.includes(key));
  const extra = actual.filter((key) => !expected.includes(key));
  return [
    ...missing.map((key) => `schema:${path} is missing ${key}`),
    ...extra.map((key) => `schema:${path} has unknown key ${key}`)
  ];
}

/** JSON with recursively sorted object keys; arrays retain protocol order. */
export function stableCacheJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (isRecord(item))
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .filter((key) => item[key] !== undefined)
          .map((key) => [key, normalize(item[key])])
      );
    if (typeof item === "number" && !Number.isFinite(item))
      throw new Error("Non-finite numbers are not canonical JSON");
    return item;
  };
  return JSON.stringify(normalize(value));
}

function geometry(config: CacheOrganization): {
  lineSizeBytes: number;
  setCount: number;
  ways: number;
  capacityLines: number;
} {
  if (config.kind === "direct")
    return {
      lineSizeBytes: config.lineSizeBytes,
      setCount: config.capacityLines,
      ways: 1,
      capacityLines: config.capacityLines
    };
  if (config.kind === "fully-associative")
    return {
      lineSizeBytes: config.lineSizeBytes,
      setCount: 1,
      ways: config.capacityLines,
      capacityLines: config.capacityLines
    };
  return {
    lineSizeBytes: config.lineSizeBytes,
    setCount: config.setCount,
    ways: config.ways,
    capacityLines: config.setCount * config.ways
  };
}

function configIssues(value: unknown, path: string): string[] {
  if (!isRecord(value)) return [`schema:${path} must be an object`];
  const kind = value.kind;
  if (!new Set(["direct", "set-associative", "fully-associative"]).has(String(kind)))
    return [`schema:${path}.kind is invalid`];
  const issues = exactKeyIssues(
    value,
    path,
    kind === "set-associative"
      ? ["kind", "lineSizeBytes", "setCount", "ways"]
      : ["kind", "lineSizeBytes", "capacityLines"]
  );
  const lineSize = value.lineSizeBytes;
  if (!integer(lineSize)) issues.push(`schema:${path}.lineSizeBytes must be an integer`);
  else if (!powerOfTwo(lineSize) || lineSize < 4 || lineSize > 256)
    issues.push(`range:${path}.lineSizeBytes must be a power of two from 4 to 256`);
  if (kind === "set-associative") {
    if (!integer(value.setCount) || !integer(value.ways))
      issues.push(`schema:${path}.setCount and ways must be integers`);
    else {
      if (!powerOfTwo(value.setCount) || value.setCount < 1 || value.setCount > 64)
        issues.push(`range:${path}.setCount must be a power of two from 1 to 64`);
      if (!powerOfTwo(value.ways) || value.ways < 2 || value.ways > 16)
        issues.push(`range:${path}.ways must be a power of two from 2 to 16`);
      if (value.setCount * value.ways > 128) issues.push(`range:${path} may contain at most 128 lines`);
    }
  } else if (!integer(value.capacityLines)) {
    issues.push(`schema:${path}.capacityLines must be an integer`);
  } else if (!powerOfTwo(value.capacityLines) || value.capacityLines < 1 || value.capacityLines > 128) {
    issues.push(`range:${path}.capacityLines must be a power of two from 1 to 128`);
  }
  return issues;
}

function addressListIssues(value: unknown, path: string, minimum = 3): string[] {
  if (!Array.isArray(value)) return [`schema:${path} must be an array`];
  if (value.length < minimum || value.length > 24) return [`range:${path} must contain ${minimum} to 24 addresses`];
  const issues: string[] = [];
  value.forEach((address, index) => {
    if (!integer(address)) issues.push(`schema:${path}[${index}] must be an integer`);
    else if (address < 0 || address > 0xffffff) issues.push(`range:${path}[${index}] is outside 0..0xFFFFFF`);
  });
  return issues;
}

function traceProblemIssues(value: unknown, path: string): string[] {
  if (!isRecord(value)) return [`schema:${path} must be an object`];
  return [
    ...exactKeyIssues(value, path, ["config", "accesses"]),
    ...configIssues(value.config, `${path}.config`),
    ...addressListIssues(value.accesses, `${path}.accesses`)
  ].sort();
}

function mappingProblemIssues(value: unknown, path: string): string[] {
  if (!isRecord(value)) return [`schema:${path} must be an object`];
  return [
    ...exactKeyIssues(value, path, ["config", "addresses"]),
    ...configIssues(value.config, `${path}.config`),
    ...addressListIssues(value.addresses, `${path}.addresses`)
  ].sort();
}

function writeProblemIssues(value: unknown, path: string, minimumAccesses = 3, includePolicy = false): string[] {
  if (!isRecord(value)) return [`schema:${path} must be an object`];
  const issues = [
    ...exactKeyIssues(value, path, [
      "config",
      "accesses",
      "writeMissPolicy",
      "flushAtEnd",
      ...(includePolicy ? ["policy"] : [])
    ]),
    ...configIssues(value.config, `${path}.config`)
  ];
  if (value.writeMissPolicy !== "write-allocate" && value.writeMissPolicy !== "no-write-allocate")
    issues.push(`schema:${path}.writeMissPolicy is invalid`);
  if (typeof value.flushAtEnd !== "boolean") issues.push(`schema:${path}.flushAtEnd must be boolean`);
  if (includePolicy && value.policy !== "write-through" && value.policy !== "write-back")
    issues.push(`schema:${path}.policy is invalid`);
  if (!Array.isArray(value.accesses) || value.accesses.length < minimumAccesses || value.accesses.length > 24) {
    issues.push(`range:${path}.accesses must contain ${minimumAccesses} to 24 accesses`);
  } else {
    const lineSize = isRecord(value.config) && integer(value.config.lineSizeBytes) ? value.config.lineSizeBytes : null;
    value.accesses.forEach((access, index) => {
      if (!isRecord(access)) {
        issues.push(`schema:${path}.accesses[${index}] must be an object`);
        return;
      }
      issues.push(...exactKeyIssues(access, `${path}.accesses[${index}]`, ["address", "operation", "sizeBytes"]));
      if (access.operation !== "read" && access.operation !== "write")
        issues.push(`schema:${path}.accesses[${index}].operation is invalid`);
      if (!integer(access.address) || access.address < 0 || access.address > 0xffffff)
        issues.push(`range:${path}.accesses[${index}].address is invalid`);
      if (!integer(access.sizeBytes) || access.sizeBytes < 1 || (lineSize !== null && access.sizeBytes > lineSize))
        issues.push(`range:${path}.accesses[${index}].sizeBytes is invalid`);
      if (
        lineSize !== null &&
        integer(access.address) &&
        integer(access.sizeBytes) &&
        (access.address % lineSize) + access.sizeBytes > lineSize
      )
        issues.push(`range:${path}.accesses[${index}] crosses a cache-line boundary`);
    });
  }
  return issues.sort();
}

function amatOptionIssues(value: unknown, path: string): string[] {
  if (!isRecord(value)) return [`schema:${path} must be an object`];
  const issues = exactKeyIssues(value, path, ["hitTimeNs", "missRate", "missPenaltyNs"]);
  if (!finite(value.hitTimeNs)) issues.push(`schema:${path}.hitTimeNs must be finite`);
  else if (value.hitTimeNs < 0.1 || value.hitTimeNs > 20) issues.push(`range:${path}.hitTimeNs is outside 0.1..20`);
  if (!finite(value.missRate)) issues.push(`schema:${path}.missRate must be finite`);
  else if (value.missRate < 0 || value.missRate > 1) issues.push(`range:${path}.missRate is outside 0..1`);
  if (!finite(value.missPenaltyNs)) issues.push(`schema:${path}.missPenaltyNs must be finite`);
  else if (value.missPenaltyNs < 1 || value.missPenaltyNs > 1_000)
    issues.push(`range:${path}.missPenaltyNs is outside 1..1000`);
  return issues;
}

function amatProblemIssues(value: unknown, path: string): string[] {
  if (!isRecord(value)) return [`schema:${path} must be an object`];
  return [
    ...exactKeyIssues(value, path, ["optionA", "optionB"]),
    ...amatOptionIssues(value.optionA, `${path}.optionA`),
    ...amatOptionIssues(value.optionB, `${path}.optionB`)
  ];
}

function assertConfig(config: CacheOrganization): void {
  const issues = configIssues(config, "config");
  if (issues.length) throw new CacheBankValidationError(issues);
}

/** Simulates an initially empty cache. Every organization uses true LRU within each set. */
export function simulateColdCache(config: CacheOrganization, accesses: readonly number[]): CacheSimulationResult {
  assertConfig(config);
  const addressIssues = addressListIssues(accesses, "accesses", 1);
  if (addressIssues.length) throw new CacheBankValidationError(addressIssues);
  const shape = geometry(config);
  const sets = Array.from({ length: shape.setCount }, () => [] as Array<{ block: number; usedAt: number }>);
  const steps: CacheSimulationStep[] = [];
  accesses.forEach((address, index) => {
    const blockNumber = Math.floor(address / shape.lineSizeBytes);
    const setIndex = blockNumber % shape.setCount;
    const tag = Math.floor(blockNumber / shape.setCount);
    const set = sets[setIndex]!;
    const found = set.find((line) => line.block === blockNumber);
    let evictedBlock: number | null = null;
    if (found) {
      found.usedAt = index;
    } else {
      if (set.length === shape.ways) {
        let lru = 0;
        for (let cursor = 1; cursor < set.length; cursor += 1) if (set[cursor]!.usedAt < set[lru]!.usedAt) lru = cursor;
        evictedBlock = set[lru]!.block;
        set.splice(lru, 1);
      }
      set.push({ block: blockNumber, usedAt: index });
    }
    steps.push({ index, address, blockNumber, setIndex, tag, hit: Boolean(found), evictedBlock });
  });
  const hits = steps.filter((step) => step.hit).length;
  return { config, hits, misses: steps.length - hits, steps };
}

/** Classifies misses by comparing with an equal-capacity fully associative LRU cache. */
export function classifyColdCacheMisses(config: CacheOrganization, accesses: readonly number[]): ClassifiedTraceResult {
  const actual = simulateColdCache(config, accesses);
  const shape = geometry(config);
  const baseline = simulateColdCache(
    { kind: "fully-associative", lineSizeBytes: shape.lineSizeBytes, capacityLines: shape.capacityLines },
    accesses
  );
  const seen = new Set<number>();
  const steps = actual.steps.map((step, index): ClassifiedCacheStep => {
    const fullyAssociativeHit = baseline.steps[index]!.hit;
    let missClass: CacheMissClass | null = null;
    if (!step.hit) {
      if (!seen.has(step.blockNumber)) missClass = "compulsory";
      else missClass = fullyAssociativeHit ? "conflict" : "capacity";
    }
    seen.add(step.blockNumber);
    return { ...step, missClass, fullyAssociativeHit };
  });
  const count = (kind: CacheMissClass) => steps.filter((step) => step.missClass === kind).length;
  return {
    config,
    hits: actual.hits,
    misses: actual.misses,
    compulsoryMisses: count("compulsory"),
    conflictMisses: count("conflict"),
    capacityMisses: count("capacity"),
    steps
  };
}

export function mapCacheAddress(config: CacheOrganization, address: number): AddressMapping {
  assertConfig(config);
  if (!integer(address) || address < 0 || address > 0xffffff)
    throw new CacheBankValidationError(["range:address is outside 0..0xFFFFFF"]);
  const shape = geometry(config);
  const blockNumber = Math.floor(address / shape.lineSizeBytes);
  return {
    address,
    blockNumber,
    offset: address % shape.lineSizeBytes,
    setIndex: blockNumber % shape.setCount,
    tag: Math.floor(blockNumber / shape.setCount)
  };
}

export function calculateAmat(option: AmatOption): number {
  const issues = amatOptionIssues(option, "option");
  if (issues.length) throw new CacheBankValidationError(issues);
  return option.hitTimeNs + option.missRate * option.missPenaltyNs;
}

/** Counts cache-line fills, write-through word writes, and dirty write-backs in bytes. */
export function calculateWriteTraffic(
  config: CacheOrganization,
  accesses: readonly Required<Pick<CacheAccess, "address" | "operation" | "sizeBytes">>[],
  options: {
    policy: "write-through" | "write-back";
    writeMissPolicy: "write-allocate" | "no-write-allocate";
    flushAtEnd: boolean;
  }
): WriteTrafficResult {
  const input: WriteTrafficProblem = { config, accesses: [...accesses], ...options };
  const issues = writeProblemIssues(input, "traffic", 1, true);
  if (issues.length) throw new CacheBankValidationError(issues);
  const shape = geometry(config);
  const sets = Array.from(
    { length: shape.setCount },
    () => [] as Array<{ block: number; dirty: boolean; usedAt: number }>
  );
  let hits = 0;
  let misses = 0;
  let memoryReadBytes = 0;
  let memoryWriteBytes = 0;
  let writeBacks = 0;
  const evictIfNeeded = (set: Array<{ block: number; dirty: boolean; usedAt: number }>) => {
    if (set.length < shape.ways) return;
    let lru = 0;
    for (let cursor = 1; cursor < set.length; cursor += 1) if (set[cursor]!.usedAt < set[lru]!.usedAt) lru = cursor;
    const evicted = set[lru]!;
    if (evicted.dirty) {
      memoryWriteBytes += shape.lineSizeBytes;
      writeBacks += 1;
    }
    set.splice(lru, 1);
  };
  accesses.forEach((access, index) => {
    const block = Math.floor(access.address / shape.lineSizeBytes);
    const set = sets[block % shape.setCount]!;
    let line = set.find((entry) => entry.block === block);
    if (line) hits += 1;
    else misses += 1;
    if (access.operation === "read") {
      if (!line) {
        evictIfNeeded(set);
        memoryReadBytes += shape.lineSizeBytes;
        line = { block, dirty: false, usedAt: index };
        set.push(line);
      }
      line.usedAt = index;
      return;
    }
    if (!line && options.writeMissPolicy === "no-write-allocate") {
      memoryWriteBytes += access.sizeBytes;
      return;
    }
    if (!line) {
      evictIfNeeded(set);
      memoryReadBytes += shape.lineSizeBytes;
      line = { block, dirty: false, usedAt: index };
      set.push(line);
    }
    line.usedAt = index;
    if (options.policy === "write-through") memoryWriteBytes += access.sizeBytes;
    else line.dirty = true;
  });
  if (options.policy === "write-back" && options.flushAtEnd) {
    for (const set of sets)
      for (const line of set)
        if (line.dirty) {
          memoryWriteBytes += shape.lineSizeBytes;
          writeBacks += 1;
          line.dirty = false;
        }
  }
  return {
    policy: options.policy,
    writeMissPolicy: options.writeMissPolicy,
    flushAtEnd: options.flushAtEnd,
    hits,
    misses,
    memoryReadBytes,
    memoryWriteBytes,
    writeBacks,
    totalTrafficBytes: memoryReadBytes + memoryWriteBytes
  };
}

function scenarioSchemaIssues(value: unknown): string[] {
  if (!isRecord(value)) return ["schema:scenario must be an object"];
  if (!CACHE_BANK_SET_IDS.includes(value.kind as CacheBankSetId)) return ["schema:scenario.kind is invalid"];
  const kind = value.kind as CacheBankSetId;
  const envelope = exactKeyIssues(value, "scenario", ["kind", "primary", "transfer"]);
  if (kind === "write-policy-traffic")
    return [
      ...envelope,
      ...writeProblemIssues(value.primary, "primary"),
      ...writeProblemIssues(value.transfer, "transfer")
    ];
  if (kind === "set-mapping")
    return [
      ...envelope,
      ...mappingProblemIssues(value.primary, "primary"),
      ...mappingProblemIssues(value.transfer, "transfer")
    ];
  if (kind === "amat-tradeoff")
    return [
      ...envelope,
      ...amatProblemIssues(value.primary, "primary"),
      ...amatProblemIssues(value.transfer, "transfer")
    ];
  return [
    ...envelope,
    ...traceProblemIssues(value.primary, "primary"),
    ...traceProblemIssues(value.transfer, "transfer")
  ];
}

function traceBlocks(problem: TraceProblem): number[] {
  const { lineSizeBytes } = geometry(problem.config);
  return problem.accesses.map((address) => Math.floor(address / lineSizeBytes));
}

function difficultyIssues(scenario: CacheScenario): string[] {
  const issues: string[] = [];
  for (const [label, problem] of [
    ["primary", scenario.primary],
    ["transfer", scenario.transfer]
  ] as const) {
    if (scenario.kind === "trace-3c") {
      const trace = problem as TraceProblem;
      const result = classifyColdCacheMisses(trace.config, trace.accesses);
      if (result.compulsoryMisses === 0 || result.conflictMisses === 0 || result.capacityMisses === 0)
        issues.push(`difficulty:${label} must exhibit compulsory, conflict, and capacity misses`);
    } else if (scenario.kind === "compulsory-repeated") {
      const trace = problem as TraceProblem;
      const result = classifyColdCacheMisses(trace.config, trace.accesses);
      if (result.compulsoryMisses < 2 || result.hits === 0)
        issues.push(`difficulty:${label} must contain at least two first touches and a repeated-access hit`);
    } else if (scenario.kind === "fully-associative-working-set") {
      const trace = problem as TraceProblem;
      if (trace.config.kind !== "fully-associative") {
        issues.push(`single_target:${label} must use a fully associative cache`);
        continue;
      }
      const result = classifyColdCacheMisses(trace.config, trace.accesses);
      const uniqueBlocks = new Set(traceBlocks(trace)).size;
      if (uniqueBlocks <= trace.config.capacityLines || result.hits === 0 || result.capacityMisses === 0)
        issues.push(`difficulty:${label} must exceed the working-set limit and include both a hit and a capacity miss`);
    } else if (scenario.kind === "write-policy-traffic") {
      const write = problem as WriteTrafficProblem;
      const wt = calculateWriteTraffic(write.config, write.accesses, {
        policy: "write-through",
        writeMissPolicy: write.writeMissPolicy,
        flushAtEnd: write.flushAtEnd
      });
      const wb = calculateWriteTraffic(write.config, write.accesses, {
        policy: "write-back",
        writeMissPolicy: write.writeMissPolicy,
        flushAtEnd: write.flushAtEnd
      });
      if (
        !write.accesses.some((access) => access.operation === "write") ||
        wt.hits === 0 ||
        wt.totalTrafficBytes === wb.totalTrafficBytes
      )
        issues.push(
          `difficulty:${label} must contain a write hit and distinguish write-through from write-back traffic`
        );
    } else if (scenario.kind === "set-mapping") {
      const mapping = problem as MappingProblem;
      if (mapping.config.kind === "fully-associative") {
        issues.push(`single_target:${label} must expose more than one set`);
        continue;
      }
      const mappings = mapping.addresses.map((address) => mapCacheAddress(mapping.config, address));
      const distinctSets = new Set(mappings.map((entry) => entry.setIndex));
      const collision = mappings.some((left, index) =>
        mappings.slice(index + 1).some((right) => left.setIndex === right.setIndex && left.tag !== right.tag)
      );
      if (distinctSets.size < 2 || !collision)
        issues.push(`difficulty:${label} must cover multiple sets and a same-set/different-tag collision`);
    } else {
      const amat = problem as AmatProblem;
      const a = calculateAmat(amat.optionA);
      const b = calculateAmat(amat.optionB);
      if (stableCacheJson(amat.optionA) === stableCacheJson(amat.optionB) || Math.abs(a - b) < 0.1)
        issues.push(`difficulty:${label} options must differ and have AMATs separated by at least 0.1 ns`);
    }
  }
  return issues;
}

function scenarioParameterSignature(scenario: CacheScenario): string {
  return `${scenario.kind}:${sha256(stableCacheJson({ primary: scenario.primary, transfer: scenario.transfer }))}`;
}

export function validateCacheScenario(
  input: unknown,
  options: { seenParameterSignatures?: ReadonlySet<string> } = {}
): CacheValidationResult {
  const issues = scenarioSchemaIssues(input);
  if (issues.length) return { valid: false, issues: [...new Set(issues)].sort(), parameterSignature: null };
  const scenario = input as CacheScenario;
  if (stableCacheJson(scenario.primary) === stableCacheJson(scenario.transfer))
    issues.push("independence:primary and transfer parameters must differ");
  issues.push(...difficultyIssues(scenario));
  const parameterSignature = scenarioParameterSignature(scenario);
  if (options.seenParameterSignatures?.has(parameterSignature))
    issues.push("duplicate_parameters:parameter signature already exists in this bank build");
  return { valid: issues.length === 0, issues: [...new Set(issues)].sort(), parameterSignature };
}

function describeConfig(config: CacheOrganization): string {
  const shape = geometry(config);
  const organization =
    config.kind === "direct"
      ? "direct-mapped"
      : config.kind === "fully-associative"
        ? "fully associative"
        : `${shape.ways}-way set associative`;
  return `${organization}, ${shape.capacityLines} lines, ${shape.lineSizeBytes} bytes per line, ${shape.setCount} sets`;
}

function traceAnswer(result: ClassifiedTraceResult): string {
  const steps = result.steps.map((step) => `${step.index + 1}:${step.hit ? "hit" : step.missClass}`).join(", ");
  return `Steps ${steps}. Totals: ${result.hits} hits, ${result.compulsoryMisses} compulsory, ${result.conflictMisses} conflict, and ${result.capacityMisses} capacity misses.`;
}

function renderTrace(kind: "trace-3c" | "compulsory-repeated", problem: TraceProblem): RenderedCachePart {
  const result = classifyColdCacheMisses(problem.config, problem.accesses);
  const focus =
    kind === "trace-3c"
      ? "For every access, state hit or miss; classify each miss as compulsory, conflict, or capacity using an equal-capacity fully associative LRU baseline."
      : "Identify which first touches are compulsory misses and which repeated accesses hit; also report any other miss class that occurs.";
  return {
    prompt: `Start with an empty ${describeConfig(problem.config)} cache using LRU within each set. The byte-address trace is ${problem.accesses.map(hex).join(", ")}. ${focus}`,
    oracle: { kind, result },
    rubric:
      kind === "trace-3c"
        ? [
            "Correct hit/miss sequence",
            "First-touch misses labelled compulsory",
            "Conflict/capacity decided by the fully associative baseline"
          ]
        : [
            "First touch distinguished from repetition",
            "Repeated hits identified from resident blocks",
            "Counts consistent with the trace"
          ],
    canonicalAnswer: traceAnswer(result)
  };
}

function renderWorkingSet(problem: TraceProblem): RenderedCachePart {
  const result = simulateColdCache(problem.config, problem.accesses);
  const shape = geometry(problem.config);
  const uniqueBlocks = new Set(traceBlocks(problem)).size;
  const classified = classifyColdCacheMisses(problem.config, problem.accesses);
  const sequence = result.steps
    .map(
      (step) =>
        `${step.index + 1}:${step.hit ? "hit" : `miss${step.evictedBlock === null ? "" : `/evict block ${step.evictedBlock}`}`}`
    )
    .join(", ");
  return {
    prompt: `Start with an empty ${describeConfig(problem.config)} LRU cache. The byte-address trace is ${problem.accesses.map(hex).join(", ")}. Trace LRU residency, identify evictions, and explain where the working set exceeds capacity.`,
    oracle: { kind: "fully-associative-working-set", result, uniqueBlocks, capacityLines: shape.capacityLines },
    rubric: [
      "LRU order updated on hits",
      "Correct victim chosen on each full-cache miss",
      "Capacity miss tied to the working-set limit"
    ],
    canonicalAnswer: `Steps ${sequence}. There are ${result.hits} hits and ${result.misses} misses across ${uniqueBlocks} unique blocks; ${classified.capacityMisses} miss(es) are capacity misses with a ${shape.capacityLines}-line limit.`
  };
}

function renderWritePolicy(problem: WriteTrafficProblem): RenderedCachePart {
  const options = { writeMissPolicy: problem.writeMissPolicy, flushAtEnd: problem.flushAtEnd } as const;
  const writeThrough = calculateWriteTraffic(problem.config, problem.accesses, { ...options, policy: "write-through" });
  const writeBack = calculateWriteTraffic(problem.config, problem.accesses, { ...options, policy: "write-back" });
  const lowerTrafficPolicy =
    writeThrough.totalTrafficBytes === writeBack.totalTrafficBytes
      ? "tie"
      : writeThrough.totalTrafficBytes < writeBack.totalTrafficBytes
        ? "write-through"
        : "write-back";
  const accessText = problem.accesses
    .map((access) => `${access.operation === "read" ? "R" : "W"}${access.sizeBytes}@${hex(access.address)}`)
    .join(", ");
  return {
    prompt: `Start with an empty ${describeConfig(problem.config)} LRU cache and ${problem.writeMissPolicy}. Apply ${accessText}. Compare memory traffic for write-through and write-back; ${problem.flushAtEnd ? "flush dirty lines at the end" : "do not flush at the end"}. Count line fills, word writes, and dirty write-backs in bytes.`,
    oracle: { kind: "write-policy-traffic", writeThrough, writeBack, lowerTrafficPolicy },
    rubric: [
      "Line fills counted once per allocated miss",
      "Write-through and dirty write-back bytes distinguished",
      "Evictions and the stated final-flush rule applied"
    ],
    canonicalAnswer: `Write-through: ${writeThrough.memoryReadBytes} read + ${writeThrough.memoryWriteBytes} written = ${writeThrough.totalTrafficBytes} bytes. Write-back: ${writeBack.memoryReadBytes} read + ${writeBack.memoryWriteBytes} written = ${writeBack.totalTrafficBytes} bytes with ${writeBack.writeBacks} write-back(s). Lower traffic: ${lowerTrafficPolicy}.`
  };
}

function renderMapping(problem: MappingProblem): RenderedCachePart {
  const mappings = problem.addresses.map((address) => mapCacheAddress(problem.config, address));
  const bySet = new Map<number, Set<number>>();
  for (const mapping of mappings) {
    const tags = bySet.get(mapping.setIndex) ?? new Set<number>();
    tags.add(mapping.tag);
    bySet.set(mapping.setIndex, tags);
  }
  const collisionSets = [...bySet.entries()]
    .filter(([, tags]) => tags.size > 1)
    .map(([set]) => set)
    .sort((a, b) => a - b);
  return {
    prompt: `For a ${describeConfig(problem.config)} cache, map byte addresses ${problem.addresses.map(hex).join(", ")} to block number, set index, tag, and byte offset. Identify addresses that compete for the same set with different tags.`,
    oracle: { kind: "set-mapping", mappings, collisionSets },
    rubric: [
      "Offset and block number use the line size",
      "Set index uses block modulo set count",
      "Tag and same-set collisions are correct"
    ],
    canonicalAnswer: `${mappings.map((mapping) => `${hex(mapping.address)}→block ${mapping.blockNumber}, set ${mapping.setIndex}, tag ${mapping.tag}, offset ${mapping.offset}`).join("; ")}. Collision sets: ${collisionSets.join(", ")}.`
  };
}

function renderAmat(problem: AmatProblem): RenderedCachePart {
  const optionA = calculateAmat(problem.optionA);
  const optionB = calculateAmat(problem.optionB);
  const lowerAmatOption = optionA === optionB ? "tie" : optionA < optionB ? "A" : "B";
  const describe = (option: AmatOption) =>
    `hit ${numberText(option.hitTimeNs)} ns, miss rate ${numberText(option.missRate)}, miss penalty ${numberText(option.missPenaltyNs)} ns`;
  return {
    prompt: `Use AMAT = hit time + miss rate × miss penalty. Option A has ${describe(problem.optionA)}; option B has ${describe(problem.optionB)}. Compute both AMATs and choose the lower one.`,
    oracle: { kind: "amat-tradeoff", optionA, optionB, lowerAmatOption },
    rubric: [
      "Miss rate used as a fraction",
      "Both AMAT values include hit time",
      "Lower-AMAT option selected from the computed values"
    ],
    canonicalAnswer: `A = ${numberText(optionA)} ns; B = ${numberText(optionB)} ns; lower AMAT: ${lowerAmatOption}.`
  };
}

function renderPart(scenario: CacheScenario, problem: CacheScenario["primary"]): RenderedCachePart {
  if (scenario.kind === "trace-3c" || scenario.kind === "compulsory-repeated")
    return renderTrace(scenario.kind, problem as TraceProblem);
  if (scenario.kind === "fully-associative-working-set") return renderWorkingSet(problem as TraceProblem);
  if (scenario.kind === "write-policy-traffic") return renderWritePolicy(problem as WriteTrafficProblem);
  if (scenario.kind === "set-mapping") return renderMapping(problem as MappingProblem);
  return renderAmat(problem as AmatProblem);
}

function candidateCore(scenario: CacheScenario): Omit<RenderedCacheCandidate, "candidateSha256"> {
  const parameterSignature = scenarioParameterSignature(scenario);
  return {
    version: CACHE_BANK_VERSION,
    setId: scenario.kind,
    targetConcept: TARGET_BY_SET[scenario.kind],
    scenario,
    primary: renderPart(scenario, scenario.primary),
    transfer: renderPart(scenario, scenario.transfer),
    parameterSignature,
    machineVerified: true
  };
}

function leakageIssues(candidate: Pick<RenderedCacheCandidate, "primary" | "transfer">): string[] {
  const issues: string[] = [];
  for (const label of ["primary", "transfer"] as const) {
    const part = candidate[label];
    if (part.prompt.includes(part.canonicalAnswer) || /(?:answer|答案)\s*(?:is|[:：])/i.test(part.prompt))
      issues.push(`answer_leakage:${label} prompt exposes the canonical answer`);
  }
  return issues;
}

export function createCacheCandidate(
  scenario: CacheScenario,
  options: { seenParameterSignatures?: ReadonlySet<string> } = {}
): RenderedCacheCandidate {
  const validation = validateCacheScenario(scenario, options);
  if (!validation.valid) throw new CacheBankValidationError(validation.issues);
  const core = candidateCore(scenario);
  const leaks = leakageIssues(core);
  if (leaks.length) throw new CacheBankValidationError(leaks);
  return { ...core, candidateSha256: sha256(stableCacheJson(core)) };
}

/** Recomputes every host-owned field; intended as the freeze-time hard gate. */
export function verifyCacheCandidate(candidate: RenderedCacheCandidate): CacheValidationResult {
  const scenarioValidation = validateCacheScenario(candidate.scenario);
  if (!scenarioValidation.valid) return scenarioValidation;
  const expectedCore = candidateCore(candidate.scenario);
  const expected = { ...expectedCore, candidateSha256: sha256(stableCacheJson(expectedCore)) };
  const issues = leakageIssues(candidate);
  if (candidate.setId !== candidate.scenario.kind || candidate.targetConcept !== TARGET_BY_SET[candidate.scenario.kind])
    issues.push("single_target:set id or target concept does not match the scenario kind");
  if (candidate.parameterSignature !== expected.parameterSignature)
    issues.push("duplicate_parameters:parameter signature does not match canonical parameters");
  if (stableCacheJson(candidate.primary.oracle) !== stableCacheJson(expected.primary.oracle))
    issues.push("oracle_mismatch:primary oracle does not recompute");
  if (stableCacheJson(candidate.transfer.oracle) !== stableCacheJson(expected.transfer.oracle))
    issues.push("oracle_mismatch:transfer oracle does not recompute");
  if (stableCacheJson(candidate.primary) !== stableCacheJson(expected.primary))
    issues.push("oracle_mismatch:primary rendering, rubric, or answer is not canonical");
  if (stableCacheJson(candidate.transfer) !== stableCacheJson(expected.transfer))
    issues.push("oracle_mismatch:transfer rendering, rubric, or answer is not canonical");
  const { candidateSha256: _storedSha, ...actualCore } = candidate;
  if (candidate.candidateSha256 !== sha256(stableCacheJson(actualCore)))
    issues.push("oracle_mismatch:candidate SHA does not match canonical content");
  return {
    valid: issues.length === 0,
    issues: [...new Set(issues)].sort(),
    parameterSignature: expected.parameterSignature
  };
}
