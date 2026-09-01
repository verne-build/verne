import * as Schema from "effect/Schema";

const FULL_GIT_REVISION_PATTERN = /^[0-9a-f]{40}$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export const FullGitRevision = Schema.String.check(Schema.isPattern(FULL_GIT_REVISION_PATTERN));

export const UpstreamProvenance = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  product: Schema.Literal("T3 Code"),
  repository: Schema.Literal("pingdotgg/t3code"),
  version: Schema.String.check(Schema.isPattern(SEMVER_PATTERN)),
  revision: FullGitRevision,
});
export type UpstreamProvenance = typeof UpstreamProvenance.Type;

export const decodeUpstreamProvenance = Schema.decodeUnknownSync(UpstreamProvenance);

export const BuildRevision = Schema.Union([FullGitRevision, Schema.Literal("unknown")]);
export type BuildRevision = typeof BuildRevision.Type;

export const VerneBuildIdentity = Schema.Struct({
  product: Schema.Literal("Verne"),
  version: Schema.String.check(Schema.isPattern(SEMVER_PATTERN)),
  revision: BuildRevision,
  upstream: UpstreamProvenance,
});
export type VerneBuildIdentity = typeof VerneBuildIdentity.Type;

const exactRevision = (value: string | undefined): typeof FullGitRevision.Type | null => {
  const candidate = value?.trim().toLowerCase();
  return candidate && FULL_GIT_REVISION_PATTERN.test(candidate)
    ? (candidate as typeof FullGitRevision.Type)
    : null;
};

export function resolveBuildRevision(input: {
  readonly explicitRevision?: string | undefined;
  readonly githubRevision?: string | undefined;
}): BuildRevision {
  return exactRevision(input.explicitRevision) ?? exactRevision(input.githubRevision) ?? "unknown";
}

const shortRevision = (revision: string) =>
  FULL_GIT_REVISION_PATTERN.test(revision) ? revision.slice(0, 7) : revision;

export function formatBuildIdentity(input: {
  readonly product: string;
  readonly version: string;
  readonly revision: BuildRevision;
  readonly upstream: UpstreamProvenance;
}): string {
  return [
    `${input.product} version: ${input.version}`,
    `${input.product} revision: ${shortRevision(input.revision)}`,
    `Based on ${input.upstream.product} ${input.upstream.version}`,
    `${input.upstream.product} revision: ${shortRevision(input.upstream.revision)}`,
  ].join("\n");
}
