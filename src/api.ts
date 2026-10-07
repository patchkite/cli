import type { AccessKey, App, Deployment, DeploymentMetrics, OS, Package, PatchMetadata, Platform, ReleaseMetadata } from "./core/types.js";
import { openAsBlob } from "node:fs";
import { readConfig, type CliConfig } from "./config.js";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface BinaryBundle {
  fileName: string;
  fileHash: string;
  appVersion: string | null;
  size: number;
  createdBy: string;
  createdTime: number;
}

export interface AdminUser {
  email: string;
  name: string;
  isAdmin: boolean;
  createdTime: number;
  ownedApps: number;
}

/** Management API client. */
export class PatchkiteApi {
  constructor(
    readonly serverUrl: string,
    private readonly accessKey?: string,
  ) {}

  static fromConfig(cfg?: CliConfig | null): PatchkiteApi {
    cfg ??= readConfig();
    if (!cfg) throw new ApiError(401, "Not logged in. Run `patchkite login` first.");
    return new PatchkiteApi(cfg.serverUrl, cfg.accessKey);
  }

  private async request<T>(method: string, pathname: string, body?: unknown | FormData): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.accessKey) headers.authorization = `Bearer ${this.accessKey}`;
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(new URL(pathname, this.serverUrl.replace(/\/?$/, "/")), { method, headers, body: payload });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) throw new ApiError(res.status, json.error ?? `${res.status} ${res.statusText}`);
    return json as T;
  }

  private enc = encodeURIComponent;
  private app = (a: string) => `apps/${this.enc(a)}`;
  private dep = (a: string, d: string) => `${this.app(a)}/deployments/${this.enc(d)}`;

  // Auth
  register = (email: string, password: string, hostname: string) =>
    this.request<{ accessKey: string }>("POST", "auth/register", { email, password, hostname });
  login = (email: string, password: string, hostname: string) =>
    this.request<{ accessKey: string }>("POST", "auth/login", { email, password, hostname });
  logout = () => this.request("POST", "auth/logout");
  account = () => this.request<{ account: { email: string; name: string; isAdmin: boolean } }>("GET", "account").then((r) => r.account);
  updateAccount = (patch: { name?: string; currentPassword?: string; newPassword?: string }) => this.request("PATCH", "account", patch);

  // Admin
  listUsers = () => this.request<{ users: AdminUser[] }>("GET", "admin/users").then((r) => r.users);
  addUser = (email: string, opts: { name?: string; isAdmin?: boolean }) =>
    this.request<{ password?: string }>("POST", "admin/users", { email, ...opts });
  setAdmin = (email: string, isAdmin: boolean) => this.request("PATCH", `admin/users/${this.enc(email)}`, { isAdmin });
  resetPassword = (email: string) =>
    this.request<{ password: string }>("POST", `admin/users/${this.enc(email)}/reset-password`).then((r) => r.password);
  removeUser = (email: string, transferTo?: string) =>
    this.request<{ transferred: string[] }>(
      "DELETE",
      `admin/users/${this.enc(email)}${transferTo ? `?transferTo=${this.enc(transferTo)}` : ""}`,
    );
  gc = (dryRun: boolean) =>
    this.request<{ scanned: number; orphans: string[]; dryRun: boolean }>("POST", `admin/gc${dryRun ? "?dryRun=true" : ""}`);

  // Access keys
  listAccessKeys = () => this.request<{ accessKeys: AccessKey[] }>("GET", "accessKeys").then((r) => r.accessKeys);
  addAccessKey = (friendlyName: string, ttl?: number) =>
    this.request<{ accessKey: AccessKey & { key: string } }>("POST", "accessKeys", { friendlyName, ttl, createdBy: "cli" }).then(
      (r) => r.accessKey,
    );
  patchAccessKey = (name: string, patch: { friendlyName?: string; ttl?: number }) => this.request("PATCH", `accessKeys/${this.enc(name)}`, patch);
  removeAccessKey = (name: string) => this.request("DELETE", `accessKeys/${this.enc(name)}`);
  removeSessions = (createdBy?: string) => this.request("DELETE", `sessions${createdBy ? `?createdBy=${this.enc(createdBy)}` : ""}`);

  // Apps
  listApps = () => this.request<{ apps: App[] }>("GET", "apps").then((r) => r.apps);
  getApp = (name: string) => this.request<{ app: App }>("GET", this.app(name)).then((r) => r.app);
  addApp = (name: string, os: OS, platform: Platform, manuallyProvisionDeployments = false) =>
    this.request<{ app: App }>("POST", "apps", { name, os, platform, manuallyProvisionDeployments }).then((r) => r.app);
  renameApp = (name: string, newName: string) => this.request("PATCH", this.app(name), { name: newName });
  removeApp = (name: string) => this.request("DELETE", this.app(name));
  transferApp = (name: string, email: string) => this.request("POST", `${this.app(name)}/transfer/${this.enc(email)}`);

  // Collaborators
  listCollaborators = (app: string) =>
    this.request<{ collaborators: App["collaborators"] }>("GET", `${this.app(app)}/collaborators`).then((r) => r.collaborators);
  addCollaborator = (app: string, email: string) => this.request("POST", `${this.app(app)}/collaborators/${this.enc(email)}`);
  removeCollaborator = (app: string, email: string) => this.request("DELETE", `${this.app(app)}/collaborators/${this.enc(email)}`);

  // Deployments
  listDeployments = (app: string) => this.request<{ deployments: Deployment[] }>("GET", `${this.app(app)}/deployments`).then((r) => r.deployments);
  getDeployment = (app: string, dep: string) => this.request<{ deployment: Deployment }>("GET", this.dep(app, dep)).then((r) => r.deployment);
  addDeployment = (app: string, name: string, key?: string) =>
    this.request<{ deployment: Deployment }>("POST", `${this.app(app)}/deployments`, { name, key }).then((r) => r.deployment);
  renameDeployment = (app: string, dep: string, newName: string) => this.request("PATCH", this.dep(app, dep), { name: newName });
  removeDeployment = (app: string, dep: string) => this.request("DELETE", this.dep(app, dep));
  history = (app: string, dep: string) => this.request<{ history: Package[] }>("GET", `${this.dep(app, dep)}/history`).then((r) => r.history);
  clearHistory = (app: string, dep: string) => this.request("DELETE", `${this.dep(app, dep)}/history`);
  metrics = (app: string, dep: string) => this.request<{ metrics: DeploymentMetrics }>("GET", `${this.dep(app, dep)}/metrics`).then((r) => r.metrics);

  // Binary bundles (patch base for the first update)
  listBinaries = (app: string) => this.request<{ binaries: BinaryBundle[] }>("GET", `${this.app(app)}/binaries`).then((r) => r.binaries);
  async addBinary(app: string, file: string, info: { fileName: string; appVersion?: string }) {
    const form = new FormData();
    form.set("info", JSON.stringify(info));
    form.set("bundle", await openAsBlob(file), info.fileName);
    return this.request<{ binary: BinaryBundle; created: boolean }>("POST", `${this.app(app)}/binaries`, form);
  }
  removeBinary = (app: string, hash: string) => this.request("DELETE", `${this.app(app)}/binaries/${this.enc(hash)}`);

  // Release
  async release(app: string, dep: string, zipPath: string, meta: ReleaseMetadata) {
    const form = new FormData();
    form.set("packageInfo", JSON.stringify(meta));
    // File-backed blob: the zip is streamed when the request is sent, not loaded fully into memory.
    form.set("package", await openAsBlob(zipPath, { type: "application/zip" }), "package.zip");
    return this.request<{ package: Package }>("POST", `${this.dep(app, dep)}/release`, form).then((r) => r.package);
  }
  patchRelease = (app: string, dep: string, packageInfo: PatchMetadata) =>
    this.request<{ package: Package }>("PATCH", `${this.dep(app, dep)}/release`, { packageInfo }).then((r) => r.package);
  promote = (app: string, src: string, dest: string, packageInfo: PatchMetadata) =>
    this.request<{ package: Package }>("POST", `${this.dep(app, src)}/promote/${this.enc(dest)}`, { packageInfo }).then((r) => r.package);
  rollback = (app: string, dep: string, targetRelease?: string) =>
    this.request<{ package: Package }>("POST", `${this.dep(app, dep)}/rollback${targetRelease ? `/${this.enc(targetRelease)}` : ""}`).then(
      (r) => r.package,
    );
}
