// API types shared with the server. Kept as a local copy so the CLI has no
// internal dependencies; the server is the source of truth.

export type Platform = "react-native" | "flutter";
export type OS = "ios" | "android";

export type ReleaseMethod = "Upload" | "Promote" | "Rollback";

/** Signature file name inside a package. */
export const SIGNATURE_FILE_NAME = ".patchkiterelease";

export interface Package {
  label: string;
  appVersion: string;
  description: string;
  isDisabled: boolean;
  isMandatory: boolean;
  rollout: number | null;
  packageHash: string;
  blobUrl: string;
  size: number;
  uploadTime: number;
  releaseMethod: ReleaseMethod;
  releasedBy: string;
  originalLabel?: string | null;
  originalDeployment?: string | null;
  /** Flutter: engine revision that libapp.so was compiled with. */
  engineRevision?: string | null;
  diffPackageMap?: Record<string, { size: number; url: string }>;
}

export interface Deployment {
  name: string;
  key: string;
  package: Package | null;
}

export interface App {
  name: string;
  os: OS;
  platform: Platform;
  collaborators: Record<string, { permission: "Owner" | "Collaborator" }>;
  deployments: string[];
}

export interface AccessKey {
  name: string;
  friendlyName: string;
  createdBy: string;
  createdTime: number;
  expires: number;
  isSession?: boolean;
}

export interface DeploymentMetrics {
  [label: string]: { active: number; downloaded: number; installed: number; failed: number };
}

/** Release metadata sent with `release`. */
export interface ReleaseMetadata {
  appVersion: string;
  description?: string;
  isMandatory?: boolean;
  isDisabled?: boolean;
  rollout?: number | null;
  engineRevision?: string | null;
}

/** Fields that can be changed with `patch`. */
export interface PatchMetadata {
  label?: string;
  appVersion?: string;
  description?: string;
  isMandatory?: boolean;
  isDisabled?: boolean;
  rollout?: number | null;
}
