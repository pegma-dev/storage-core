import type { PreparedManifest } from "./release-registry-verify.mjs";

export interface ReleasePackageDefinition {
  readonly directory: string;
  readonly name: string;
}

export interface ValidationOptions {
  readonly root?: string;
  readonly releaseTag?: string;
  readonly releasePrerelease?: boolean | string;
  readonly expectedReleaseCommit?: string;
  readonly requireClean?: boolean;
  readonly requireMainAncestor?: boolean;
  readonly requireReleaseTag?: boolean;
  readonly expectedManifestSha256?: string;
}

export interface ReleaseCommandOptions extends ValidationOptions {
  readonly manifest?: string;
  readonly output?: string;
  readonly skipSmoke?: boolean;
}

export interface PublicPackageManifest {
  readonly name: string;
  readonly version: string;
  readonly [key: string]: unknown;
}

export interface ValidatedPackage {
  readonly definition: ReleasePackageDefinition;
  readonly manifest: PublicPackageManifest;
  readonly packageDirectory: string;
}

export interface ValidationResult {
  readonly root: string;
  readonly packages: readonly ValidatedPackage[];
  readonly releaseTag: string | undefined;
}

export const RELEASE_PACKAGES: readonly ReleasePackageDefinition[];

export function parsePnpmLockfileImporters(
  text: string,
): Record<
  string,
  Record<string, Record<string, { specifier?: string; version?: string }>>
>;

export function lockVersionSatisfiesSpecifier(
  specifier: string,
  version: string,
): boolean;

export function validateLockImporter(
  importer:
    | Record<string, Record<string, { specifier?: string; version?: string }>>
    | undefined,
  manifest: PublicPackageManifest,
  location: string,
): void;

export function parseArguments(
  arguments_: readonly string[],
): ReleaseCommandOptions;

export function validateRepository(
  options?: ValidationOptions,
): Promise<ValidationResult>;

export function validateReleaseTag(options?: {
  readonly root?: string;
  readonly releaseTag?: string;
  readonly expectedReleaseCommit?: string;
}): { headCommit: string; releaseTag: string };

export function decidePublication(
  localIntegrity: string,
  registryIntegrity: string | null,
): "publish" | "skip";

export function prepareRelease(
  options?: ReleaseCommandOptions,
): Promise<{ manifestPath: string; manifest: PreparedManifest }>;

export function verifyPreparedManifest(
  manifestPath: string,
  options?: ValidationOptions,
): Promise<PreparedManifest>;

export function verifyReleaseInventory(
  manifestPath: string,
  suppliedManifest?: unknown,
): Promise<unknown>;

export function smokePreparedRelease(
  options?: ReleaseCommandOptions,
): Promise<void>;

export function isolatedNpmEnvironment(
  source: NodeJS.ProcessEnv,
  userConfigPath: string,
  globalConfigPath: string,
): NodeJS.ProcessEnv;

export function publishPreparedRelease(
  options?: ReleaseCommandOptions,
): Promise<void>;
