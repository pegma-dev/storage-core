import type {
  PublicPackageManifest,
  ValidationOptions,
} from "./release-packages.mjs";

export interface PackageFile {
  readonly path: string;
  readonly size: number;
}
export interface SourceOrigin {
  readonly kind: "source";
  readonly repository: "pegma-dev/storage-core";
  readonly gitCommit: string;
  readonly releaseTag: string | null;
  readonly directory: string;
}
export interface RegistryReuseOrigin {
  readonly kind: "registryReuse";
  readonly registry: "https://registry.npmjs.org/";
  readonly policyEntry: string;
  readonly tarballUrl: string;
  readonly sourceCommit: string;
  readonly sourceTag: string;
  readonly workflowPath: ".github/workflows/publish.yml";
  readonly originalRunId: number;
  readonly originalRunAttempt: number;
}
export interface RegistryDownloadExpectation {
  readonly name: string;
  readonly version: string;
  readonly size: number;
  readonly sha256: string;
  readonly shasum: string;
  readonly integrity: string;
}
export interface ReusePolicyEntry extends RegistryDownloadExpectation {
  readonly directory: string;
  readonly tarballUrl: string;
  readonly sourceCommit: string;
  readonly sourceTag: string;
  readonly workflowPath: ".github/workflows/publish.yml";
  readonly originalRunId: number;
  readonly originalRunAttempt: number;
}
export interface ReusePolicy {
  readonly schemaVersion: 1;
  readonly repository: "pegma-dev/storage-core";
  readonly repositoryId: "1312519623";
  readonly ownerId: "309286193";
  readonly builder: "https://github.com/actions/runner/github-hosted";
  readonly packages: readonly ReusePolicyEntry[];
}
export interface PreparedPackage extends RegistryDownloadExpectation {
  readonly directory: string;
  readonly tarball: string;
  readonly publish: boolean;
  readonly files: readonly PackageFile[];
  readonly package: PublicPackageManifest;
  readonly origin: SourceOrigin | RegistryReuseOrigin;
}
export interface PreparedManifest {
  readonly schemaVersion: 2;
  readonly repository: "pegma-dev/storage-core";
  readonly gitCommit: string;
  readonly releaseTag: string | null;
  readonly registryPolicySha256: string;
  readonly packages: readonly PreparedPackage[];
}
export interface ReleaseIdentity {
  readonly gitCommit: string;
  readonly releaseTag: string | null;
}
export interface PublicationIdentity extends ReleaseIdentity {
  readonly releaseTag: string;
  readonly runId: number;
  readonly runAttempt: number;
}
export interface VerificationOptions extends ValidationOptions {
  readonly manifest?: string;
  readonly output: string;
  readonly expectedManifestSha256?: string;
  readonly runId?: string | number;
  readonly runAttempt?: string | number;
  /** Explicit CLI must exactly match the verified archive tree. Omission (and
   * no RELEASE_NPM_CLI) runs the pinned official tool from owned temporary files. */
  readonly npmCli?: string;
}
export interface VerificationSeams {
  readonly fetch?: typeof globalThis.fetch;
  readonly env?: NodeJS.ProcessEnv;
  readonly run?: (
    command: string,
    args: readonly string[],
    options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
  ) => Promise<{
    readonly status: number | null;
    readonly stdout: string;
    readonly stderr?: string;
  }>;
}
export interface AuthenticatedPackage {
  readonly name: string;
  readonly version: string;
  readonly sourceCommit: string;
  readonly sourceTag: string;
  readonly runId: number;
  readonly attempt: number;
  readonly invocation: string;
  readonly certificate: {
    readonly validFrom: string;
    readonly validTo: string;
  };
}
export interface PublishingJob {
  readonly id: number;
  readonly runId: number;
  readonly attempt: number;
  readonly sourceCommit: string;
  readonly sourceTag: string;
  readonly packages: readonly string[];
  readonly stepName:
    | "Publish verified prepared tarballs"
    | "Verify and publish the prepared release";
  readonly conclusion: "success" | "failure";
  readonly startedAt: string;
  readonly completedAt: string;
  readonly stepStartedAt: string;
  readonly stepCompletedAt: string;
}
export const REGISTRY: "https://registry.npmjs.org/";
export const RELEASE_REPOSITORY: "pegma-dev/storage-core";
export const RELEASE_NPM_VERSION: "11.18.0";
/** Validates a unique canonical inventory subset; does not authenticate pins. */
export function validateReusePolicy(policy: unknown): ReusePolicy;
export function loadReusePolicy(): Promise<{
  readonly policy: ReusePolicy;
  readonly sha256: string;
}>;
export function registryReuseOrigin(
  entry: ReusePolicyEntry,
): RegistryReuseOrigin;
export function canonicalTarball(
  record: Pick<PreparedPackage, "name" | "version">,
): string;
export function inspectReleaseTarball(bytes: Uint8Array): {
  readonly package: PublicPackageManifest;
  readonly files: readonly PackageFile[];
};
export function downloadRegistryArtifact(
  entry: RegistryDownloadExpectation,
  seams?: Pick<VerificationSeams, "fetch">,
): Promise<{
  readonly bytes: Uint8Array;
  readonly metadata: Record<string, unknown>;
  readonly package: PublicPackageManifest;
  readonly files: readonly PackageFile[];
}>;
export function isolatedVerificationEnvironment(
  source: NodeJS.ProcessEnv,
  directory: string,
  publishing?: boolean,
): NodeJS.ProcessEnv;
export function assertTrustedPublishingEnvironment(
  env: NodeJS.ProcessEnv,
  identity: ReleaseIdentity,
): void;
/** Input must be genuine npm-cryptographically-verified audit output. */
export function verifyProvenanceAudit(
  audit: unknown,
  records: readonly PreparedPackage[],
  identity: PublicationIdentity,
  policy: ReusePolicy,
): readonly AuthenticatedPackage[];
/** Facts must already come from npm's genuine verified SLSA audit. */
export function verifyPublishingJobs(
  facts: readonly AuthenticatedPackage[],
  seams?: Pick<VerificationSeams, "fetch">,
  output?: string,
): Promise<readonly PublishingJob[]>;
export function verifyReusedPackages(
  records: readonly PreparedPackage[],
  identity: ReleaseIdentity,
  options: VerificationOptions,
  seams?: VerificationSeams,
): Promise<Record<string, unknown>>;
export function preflightRegistry(
  manifest: PreparedManifest,
  options: VerificationOptions,
  seams?: VerificationSeams,
): Promise<Record<string, unknown>>;
export function runPublicConsumer(
  manifest: PreparedManifest,
  options?: Partial<VerificationOptions>,
  seams?: VerificationSeams,
): Promise<Record<string, unknown>>;
export function verifyRegistryRelease(
  manifest: PreparedManifest,
  options: VerificationOptions,
  seams?: VerificationSeams,
): Promise<Record<string, unknown>>;
