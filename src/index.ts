#!/usr/bin/env node
import type { OS, Package, PatchMetadata, Platform } from "./core/types.js";
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { Command, Option } from "commander";
import { PatchkiteApi, ApiError } from "./api.js";
import { CONFIG_PATH, readConfig, writeConfig, deleteConfig, DEFAULT_SERVER_URL } from "./config.js";
import { parseRollout, releaseFlutter, releasePath, releaseReact } from "./commands/release.js";
import { c, confirm, formatDate, formatSize, openUrl, prompt, promptHidden, success, table } from "./ui.js";
import { extractBinaryBundle } from "./binary.js";
import { makeTempDir } from "./package.js";

/** Multi-character aliases (e.g. `--des`, `--dev`). */
const ALIASES: Record<string, string> = {
  "--des": "--description",
  "--dev": "--development",
  "--eo": "--extraBundlerOptions",
  "--hf": "--extraHermesFlags",
  "--pod": "--podFile",
  "--hermes": "--useHermes",
  "--key": "--accessKey",
};
const argv = process.argv.map((a) => {
  const [flag, ...rest] = a.split("=");
  const mapped = ALIASES[flag!];
  return mapped ? [mapped, ...rest].join("=") : a;
});

const api = () => PatchkiteApi.fromConfig();
const program = new Command("patchkite")
  .description("Patchkite CLI — OTA updates for React Native & Flutter")
  .version("1.0.0");

const parseBool = (v: string | undefined) => (v === undefined ? true : !/^(false|0|no)$/i.test(v));
const collect = (v: string, prev: string[] = []) => [...prev, v];
const fmtOption = () => new Option("--format <format>", "Output format").choices(["table", "json"]).default("table");

// ---------------------------------------------------------------- auth

async function saveLogin(serverUrl: string, accessKey: string) {
  const client = new PatchkiteApi(serverUrl, accessKey);
  const account = await client.account();
  writeConfig({ serverUrl, accessKey });
  console.log(c.green(`Successfully logged in as ${account.email}. Session saved to ${CONFIG_PATH}.`));
}

program
  .command("register")
  .description("Register a new account on a Patchkite server")
  .argument("[serverUrl]", "Patchkite server URL", DEFAULT_SERVER_URL)
  .option("--email <email>", "Register directly in the terminal (no browser)")
  .action(async (serverUrl: string, o: { email?: string }) => {
    if (!o.email) {
      openUrl(`${serverUrl}/web/register?hostname=${encodeURIComponent(hostname())}`);
      console.log(`A browser window has been opened to register. When you are done, copy the access key shown.`);
      return saveLogin(serverUrl, await prompt("Enter your access key: "));
    }
    const password = await promptHidden("Password (min. 8 characters): ");
    const { accessKey } = await new PatchkiteApi(serverUrl).register(o.email, password, hostname());
    await saveLogin(serverUrl, accessKey);
  });

program
  .command("login")
  .description("Log in to a Patchkite server")
  .argument("[serverUrl]", "Patchkite server URL", DEFAULT_SERVER_URL)
  .option("--accessKey <accessKey>", "Log in with an existing access key (alias --key)")
  .option("--email <email>", "Log in with email/password in the terminal")
  .action(async (serverUrl: string, o: { accessKey?: string; email?: string }) => {
    if (o.accessKey) return saveLogin(serverUrl, o.accessKey);
    if (o.email) {
      const password = await promptHidden("Password: ");
      const { accessKey } = await new PatchkiteApi(serverUrl).login(o.email, password, hostname());
      return saveLogin(serverUrl, accessKey);
    }
    openUrl(`${serverUrl}/web/cli-login?hostname=${encodeURIComponent(hostname())}`);
    console.log("A browser window has been opened to authenticate. After logging in, copy the access key shown.");
    await saveLogin(serverUrl, await prompt("Enter your access key: "));
  });

program
  .command("logout")
  .description("Log out of the current session")
  .action(async () => {
    const cfg = readConfig();
    if (!cfg) return console.log("Not logged in.");
    await new PatchkiteApi(cfg.serverUrl, cfg.accessKey).logout().catch(() => {});
    deleteConfig();
    success("logged out.");
  });

program
  .command("whoami")
  .description("Display the account you are logged in as")
  .action(async () => {
    const cfg = readConfig();
    const account = await api().account();
    console.log(`${account.email}${account.isAdmin ? c.gray(" [admin]") : ""} ${c.gray(`(${cfg?.serverUrl})`)}`);
  });

program
  .command("change-password")
  .description("Change your account password (other login sessions are signed out)")
  .action(async () => {
    const currentPassword = await promptHidden("Current password: ");
    const newPassword = await promptHidden("New password (min. 8 characters): ");
    if ((await promptHidden("Confirm new password: ")) !== newPassword) throw new Error("New passwords do not match");
    await api().updateAccount({ currentPassword, newPassword });
    success("changed the password. Login sessions on other devices have been signed out.");
  });

// ---------------------------------------------------------------- admin

const admin = program.command("admin").description("Server administration (admins only)");
const user = admin.command("user").description("Manage server users");
user
  .command("list")
  .alias("ls")
  .addOption(fmtOption())
  .action(async (o: { format: string }) => {
    const users = await api().listUsers();
    if (o.format === "json") return console.log(JSON.stringify(users, null, 2));
    table(
      ["Email", "Name", "Role", "Apps", "Created"],
      users.map((u) => [u.email, u.name, u.isAdmin ? "Admin" : "User", u.ownedApps, formatDate(u.createdTime)]),
    );
  });
user
  .command("add")
  .argument("<email>")
  .option("--name <name>", "Display name")
  .option("--admin", "Make the user an admin")
  .description("Create an account with a temporary password")
  .action(async (email: string, o: { name?: string; admin?: boolean }) => {
    const { password } = await api().addUser(email, { name: o.name, isAdmin: o.admin });
    success(`created the "${email}" user.`);
    if (password) console.log(`Temporary password: ${c.bold(password)} ${c.gray("(share it with the user and ask them to change it with `patchkite change-password`)")}`);
  });
user
  .command("remove")
  .alias("rm")
  .argument("<email>")
  .option("--transfer-to <email>", "Transfer apps owned by this user to another user")
  .action(async (email: string, o: { transferTo?: string }) => {
    if (!(await confirm(`Remove user "${email}"? All of their access keys and collaborator access will also be removed.`))) return;
    const { transferred } = await api().removeUser(email, o.transferTo);
    success(`removed the "${email}" user.`);
    if (transferred.length) console.log(`Apps transferred to ${o.transferTo}: ${transferred.join(", ")}`);
  });
user
  .command("reset-password")
  .argument("<email>")
  .description("Generate a new temporary password and revoke all of the user's sessions and access keys")
  .action(async (email: string) => {
    if (!(await confirm(`Reset the password for "${email}"? All sessions and access keys of this user will be revoked.`))) return;
    const password = await api().resetPassword(email);
    console.log(`Temporary password for ${email}: ${c.bold(password)}`);
  });
user
  .command("set-admin")
  .argument("<email>")
  .option("--revoke", "Revoke the admin role")
  .action(async (email: string, o: { revoke?: boolean }) => {
    await api().setAdmin(email, !o.revoke);
    success(o.revoke ? `revoked admin from "${email}".` : `made "${email}" an admin.`);
  });
admin
  .command("gc")
  .description("Delete orphaned package/diff blobs from storage")
  .option("--dry-run", "Only list the blobs that would be deleted")
  .action(async (o: { dryRun?: boolean }) => {
    const r = await api().gc(!!o.dryRun);
    for (const k of r.orphans) console.log(c.gray(k));
    success(`${r.dryRun ? "found" : "deleted"} ${r.orphans.length} orphaned blob(s) out of ${r.scanned} scanned.`);
  });

// ---------------------------------------------------------------- access-key

const accessKey = program.command("access-key").description("Manage access keys");
accessKey
  .command("add")
  .argument("<name>")
  .option("--ttl <ttl>", "Time to live, e.g. 60d, 12h, 30m", "60d")
  .description("Create a new access key (for CI/CD)")
  .action(async (name: string, o: { ttl: string }) => {
    const key = await api().addAccessKey(name, parseTtl(o.ttl));
    console.log(`Successfully created the "${name}" access key: ${c.bold(key.key)}`);
    console.log(`(Expires ${formatDate(key.expires)}. Store it somewhere safe; it will not be shown again.)`);
  });
accessKey
  .command("patch")
  .argument("<name>")
  .option("--name <newName>", "New name")
  .option("--ttl <ttl>", "New time to live")
  .action(async (name: string, o: { name?: string; ttl?: string }) => {
    await api().patchAccessKey(name, { friendlyName: o.name, ttl: o.ttl ? parseTtl(o.ttl) : undefined });
    success(`updated the "${name}" access key.`);
  });
accessKey
  .command("remove")
  .alias("rm")
  .argument("<name>")
  .action(async (name: string) => {
    if (!(await confirm(`Remove access key "${name}"?`))) return;
    await api().removeAccessKey(name);
    success(`removed the "${name}" access key.`);
  });
accessKey
  .command("list")
  .alias("ls")
  .addOption(fmtOption())
  .action(async (o: { format: string }) => {
    const keys = await api().listAccessKeys();
    if (o.format === "json") return console.log(JSON.stringify(keys, null, 2));
    table(
      ["Name", "Created", "Expires"],
      keys.filter((k) => !k.isSession).map((k) => [k.friendlyName, formatDate(k.createdTime), formatDate(k.expires)]),
    );
  });

const session = program.command("session").description("Manage login sessions");
session
  .command("remove")
  .alias("rm")
  .argument("<machineName>")
  .action(async (machine: string) => {
    await api().removeSessions(machine);
    success(`removed the login session for "${machine}".`);
  });

function parseTtl(v: string): number {
  const m = v.match(/^(\d+)\s*([smhdy]?)$/);
  if (!m) throw new Error(`Invalid TTL "${v}"`);
  const mult = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, y: 365 * 864e5, "": 864e5 }[m[2] as "s"];
  return Number(m[1]) * mult;
}

// ---------------------------------------------------------------- app

const app = program.command("app").description("Manage apps");
app
  .command("add")
  .argument("<appName>")
  .argument("[os]", "ios | android (inferred from the name by default, e.g. MyApp-iOS)")
  .argument("[platform]", "react-native | flutter", "react-native")
  .option("--manuallyProvisionDeployments", "Don't create the default Staging/Production deployments")
  .description("Register a new app")
  .action(async (name: string, os: string | undefined, platform: string, o: { manuallyProvisionDeployments?: boolean }) => {
    const guessed = os ?? (/ios$/i.test(name) ? "ios" : /android$/i.test(name) ? "android" : undefined);
    if (!guessed || !["ios", "android"].includes(guessed.toLowerCase())) {
      throw new Error('OS is required: `patchkite app add <appName> <ios|android> [react-native|flutter]`');
    }
    if (!["react-native", "flutter"].includes(platform)) throw new Error('Platform must be "react-native" or "flutter"');
    const client = api();
    const created = await client.addApp(name, guessed.toLowerCase() as OS, platform as Platform, !!o.manuallyProvisionDeployments);
    console.log(`Successfully added the "${created.name}" app, along with the following default deployments:`);
    const deps = await client.listDeployments(name);
    table(["Name", "Deployment Key"], deps.map((d) => [d.name, d.key]));
  });
app
  .command("remove")
  .alias("rm")
  .argument("<appName>")
  .action(async (name: string) => {
    if (!(await confirm(`Remove app "${name}" and all of its deployments?`))) return;
    await api().removeApp(name);
    success(`removed the "${name}" app.`);
  });
app
  .command("rename")
  .argument("<currentAppName>")
  .argument("<newAppName>")
  .action(async (from: string, to: string) => {
    await api().renameApp(from, to);
    success(`renamed the "${from}" app to "${to}".`);
  });
app
  .command("list")
  .alias("ls")
  .addOption(fmtOption())
  .action(async (o: { format: string }) => {
    const apps = await api().listApps();
    if (o.format === "json") return console.log(JSON.stringify(apps, null, 2));
    table(["Name", "OS", "Platform", "Deployments"], apps.map((a) => [a.name, a.os, a.platform, a.deployments.join(", ")]));
  });
app
  .command("transfer")
  .argument("<appName>")
  .argument("<email>")
  .action(async (name: string, email: string) => {
    if (!(await confirm(`Transfer ownership of "${name}" to ${email}?`))) return;
    await api().transferApp(name, email);
    success(`transferred the ownership of the "${name}" app to "${email}".`);
  });

// ---------------------------------------------------------------- collaborator

const collab = program.command("collaborator").description("Manage app collaborators");
collab
  .command("add")
  .argument("<appName>")
  .argument("<email>")
  .action(async (name: string, email: string) => {
    await api().addCollaborator(name, email);
    success(`added "${email}" as a collaborator to the "${name}" app.`);
  });
collab
  .command("remove")
  .alias("rm")
  .argument("<appName>")
  .argument("<email>")
  .action(async (name: string, email: string) => {
    await api().removeCollaborator(name, email);
    success(`removed "${email}" as a collaborator from the "${name}" app.`);
  });
collab
  .command("list")
  .alias("ls")
  .argument("<appName>")
  .addOption(fmtOption())
  .action(async (name: string, o: { format: string }) => {
    const list = await api().listCollaborators(name);
    if (o.format === "json") return console.log(JSON.stringify(list, null, 2));
    table(["E-mail Address"], Object.entries(list).map(([email, v]) => [`${email}${v.permission === "Owner" ? c.gray(" (Owner)") : ""}`]));
  });

// ---------------------------------------------------------------- binary

const binary = program
  .command("binary")
  .description("Built-in JS bundles of store binaries (React Native), used as the patch base for the first update");
binary
  .command("add")
  .argument("<appName>")
  .argument("<artifact>", "APK, AAB, IPA, or bundle file from a store build")
  .option("--bundle-name <name>", "Bundle file name (default: index.android.bundle / main.jsbundle depending on the app OS)")
  .option("-t, --targetBinaryVersion <version>", "Binary version (informational only)")
  .description("Register the bundle from a store build; run this in CI after a release build")
  .action(async (appName: string, artifact: string, o: { bundleName?: string; targetBinaryVersion?: string }) => {
    const client = api();
    const app = await client.getApp(appName);
    const bundleName = o.bundleName ?? (app.os === "ios" ? "main.jsbundle" : "index.android.bundle");
    const dir = await makeTempDir();
    const file = await extractBinaryBundle(artifact, bundleName, dir);
    const { binary: b, created } = await client.addBinary(appName, file, { fileName: bundleName, appVersion: o.targetBinaryVersion });
    if (created) success(`registered the binary bundle ${b.fileHash.slice(0, 12)} (${formatSize(b.size)}) for "${appName}".`);
    else console.log(`Bundle ${b.fileHash.slice(0, 12)} is already registered for "${appName}".`);
    console.log(c.gray("Future updates to devices running this binary will be sent as patches against this bundle."));
  });
binary
  .command("list")
  .alias("ls")
  .argument("<appName>")
  .addOption(fmtOption())
  .action(async (appName: string, o: { format: string }) => {
    const list = await api().listBinaries(appName);
    if (o.format === "json") return console.log(JSON.stringify(list, null, 2));
    table(
      ["Hash", "Bundle", "Version", "Size", "By", "Registered"],
      list.map((b) => [b.fileHash.slice(0, 12), b.fileName, b.appVersion ?? "-", formatSize(b.size), b.createdBy, formatDate(b.createdTime)]),
    );
  });
binary
  .command("remove")
  .alias("rm")
  .argument("<appName>")
  .argument("<hash>", "Bundle hash (a prefix is enough)")
  .action(async (appName: string, hash: string) => {
    await api().removeBinary(appName, hash);
    success(`removed the binary bundle ${hash}.`);
  });

// ---------------------------------------------------------------- deployment

function metricsCell(pkg: Package | null, m?: { active: number; installed: number; failed: number; downloaded: number }, totalActive = 0) {
  if (!pkg) return c.gray("No installs recorded");
  if (!m) return c.gray("No installs recorded");
  const pct = totalActive ? ((m.active / totalActive) * 100).toFixed(0) : "0";
  const lines = [`Active: ${pct}% (${m.active} of ${totalActive})`, `Total: ${m.installed}`];
  if (m.failed) lines.push(c.red(`Rollbacks: ${m.failed}`));
  if (pkg.rollout != null) lines.push(`Rollout: ${pkg.rollout}%`);
  if (pkg.isDisabled) lines.push(c.yellow("Disabled"));
  return lines.join("\n");
}

function metadataCell(pkg: Package | null) {
  if (!pkg) return c.gray("No updates released");
  return [
    `Label: ${pkg.label}`,
    `App Version: ${pkg.appVersion}`,
    `Mandatory: ${pkg.isMandatory ? "Yes" : "No"}`,
    `Release Time: ${formatDate(pkg.uploadTime)}`,
    `Released By: ${pkg.releasedBy}`,
    ...(pkg.description ? [`Description: ${pkg.description}`] : []),
  ].join("\n");
}

const deployment = program.command("deployment").description("Manage deployments");
deployment
  .command("add")
  .argument("<appName>")
  .argument("<deploymentName>")
  .option("-k, --key <key>", "Use a specific deployment key")
  .action(async (appName: string, name: string, o: { key?: string }) => {
    const d = await api().addDeployment(appName, name, o.key);
    console.log(`Successfully added the "${name}" deployment with key "${d.key}" to the "${appName}" app.`);
  });
deployment
  .command("clear")
  .argument("<appName>")
  .argument("<deploymentName>")
  .description("Clear the entire release history of a deployment")
  .action(async (appName: string, name: string) => {
    if (!(await confirm(`Remove all releases in the "${name}" deployment? This cannot be undone.`))) return;
    await api().clearHistory(appName, name);
    success(`cleared the release history associated with the "${name}" deployment from the "${appName}" app.`);
  });
deployment
  .command("remove")
  .alias("rm")
  .argument("<appName>")
  .argument("<deploymentName>")
  .action(async (appName: string, name: string) => {
    if (!(await confirm(`Remove deployment "${name}"?`))) return;
    await api().removeDeployment(appName, name);
    success(`removed the "${name}" deployment from the "${appName}" app.`);
  });
deployment
  .command("rename")
  .argument("<appName>")
  .argument("<currentDeploymentName>")
  .argument("<newDeploymentName>")
  .action(async (appName: string, from: string, to: string) => {
    await api().renameDeployment(appName, from, to);
    success(`renamed the "${from}" deployment to "${to}" for the "${appName}" app.`);
  });
deployment
  .command("list")
  .alias("ls")
  .argument("<appName>")
  .option("-k, --displayKeys", "Display deployment keys")
  .addOption(fmtOption())
  .action(async (appName: string, o: { displayKeys?: boolean; format: string }) => {
    const client = api();
    const deps = await client.listDeployments(appName);
    if (o.format === "json") return console.log(JSON.stringify(deps, null, 2));
    const rows = await Promise.all(
      deps.map(async (d) => {
        const m = await client.metrics(appName, d.name);
        const totalActive = Object.values(m).reduce((s, x) => s + x.active, 0);
        const row = [d.name, metadataCell(d.package), metricsCell(d.package, d.package ? m[d.package.label] : undefined, totalActive)];
        if (o.displayKeys) row.splice(1, 0, d.key);
        return row;
      }),
    );
    table(o.displayKeys ? ["Name", "Deployment Key", "Update Metadata", "Install Metrics"] : ["Name", "Update Metadata", "Install Metrics"], rows);
  });
deployment
  .command("history")
  .alias("h")
  .argument("<appName>")
  .argument("<deploymentName>")
  .option("-a, --displayAuthor", "Display who released each update")
  .addOption(fmtOption())
  .action(async (appName: string, name: string, o: { displayAuthor?: boolean; format: string }) => {
    const client = api();
    const [history, metrics] = await Promise.all([client.history(appName, name), client.metrics(appName, name)]);
    if (o.format === "json") return console.log(JSON.stringify(history, null, 2));
    const totalActive = Object.values(metrics).reduce((s, x) => s + x.active, 0);
    const head = ["Label", "Release Time", "App Version", "Mandatory", "Description", "Install Metrics"];
    if (o.displayAuthor) head.splice(2, 0, "Released By");
    table(
      head,
      history.map((p) => {
        let released = formatDate(p.uploadTime);
        if (p.releaseMethod === "Promote") released += c.gray(`\n(Promoted ${p.originalLabel} from "${p.originalDeployment}")`);
        if (p.releaseMethod === "Rollback") released += c.gray(`\n(Rolled back to ${p.originalLabel})`);
        const row = [p.label, released, p.appVersion, p.isMandatory ? "Yes" : "No", p.description || "", metricsCell(p, metrics[p.label], totalActive)];
        if (o.displayAuthor) row.splice(2, 0, p.releasedBy);
        return row;
      }),
    );
  });

// ---------------------------------------------------------------- release

const withCommonReleaseOptions = (cmd: Command) =>
  cmd
    .option("-d, --deploymentName <name>", "Target deployment", "Staging")
    .option("--description <text>", "Description / changelog (alias --des)")
    .option("-m, --mandatory", "Mark the update as mandatory")
    .option("-x, --disabled", "Release as disabled (not downloadable)")
    .option("-r, --rollout <percent>", "Percentage of users who receive the update (1-100)")
    .option("-k, --privateKeyPath <path>", "RSA private key for code signing")
    .option("--noDuplicateReleaseError", "Don't error if the package contents are identical to the latest release");

withCommonReleaseOptions(
  program
    .command("release")
    .description("Release an update from a directory/file")
    .argument("<appName>")
    .argument("<updateContentsPath>")
    .argument("<targetBinaryVersion>"),
).action(async (appName: string, contentPath: string, target: string, o) => {
  await releasePath(api(), appName, contentPath, target, o);
});

withCommonReleaseOptions(
  program
    .command("release-react")
    .description("Bundle the React Native JS, then release it")
    .argument("<appName>")
    .argument("<platform>", "ios | android")
    .option("-t, --targetBinaryVersion <version>", "Semver range of the binary version (default: from Info.plist/build.gradle)")
    .option("-b, --bundleName <name>", "Bundle file name")
    .option("-e, --entryFile <path>", "JS entry file")
    .option("--development", "Bundle in development mode (alias --dev)")
    .option("-o, --outputDir <dir>", "Save the bundle output to this directory")
    .option("-s, --sourcemapOutput <file>", "Sourcemap output path")
    .option("--sourcemapOutputDir <dir>", "Sourcemap output directory")
    .option("-g, --gradleFile <path>", "Path to build.gradle")
    .option("-p, --plistFile <path>", "Path to Info.plist")
    .option("--podFile <path>", "Path to the Podfile (alias --pod)")
    .option("-c, --config <path>", "Path to the Metro config")
    .option("--useHermes [bool]", "Force Hermes on/off (alias --hermes)", parseBool)
    .option("--extraHermesFlags <flag>", "Extra hermesc flag (alias --hf)", collect)
    .option("--extraBundlerOptions <opt>", "Extra Metro bundler option (alias --eo)", collect),
).action(async (appName: string, platform: string, o) => {
  await releaseReact(api(), appName, platform, o);
});

withCommonReleaseOptions(
  program
    .command("release-flutter")
    .description("Build a Flutter APK, then release the Dart code (libapp.so) — Android only")
    .argument("<appName>")
    .argument("<platform>", "android")
    .option("-t, --targetBinaryVersion <version>", "Semver range of the binary version (default: version in pubspec.yaml)")
    .option("--targetAbis <abis>", "Comma-separated ABIs (default: arm64-v8a,armeabi-v7a,x86_64)")
    .option("--buildArgs <arg>", "Extra argument for `flutter build apk`", collect)
    .option("--apk <path>", "Use an already built APK (skip the build)")
    .option("--flutterPath <path>", "Path to the flutter executable", "flutter"),
).action(async (appName: string, platform: string, o) => {
  await releaseFlutter(api(), appName, platform, o);
});

// ---------------------------------------------------------------- patch / promote / rollback

function patchFromOptions(o: {
  label?: string;
  description?: string;
  mandatory?: boolean;
  disabled?: boolean;
  rollout?: string;
  targetBinaryVersion?: string;
}): PatchMetadata {
  const patch: PatchMetadata = {};
  if (o.label) patch.label = o.label;
  if (o.description !== undefined) patch.description = o.description;
  if (o.mandatory !== undefined) patch.isMandatory = o.mandatory;
  if (o.disabled !== undefined) patch.isDisabled = o.disabled;
  if (o.rollout !== undefined) patch.rollout = parseRollout(o.rollout);
  if (o.targetBinaryVersion) patch.appVersion = o.targetBinaryVersion;
  return patch;
}

const withPatchOptions = (cmd: Command) =>
  cmd
    .option("-l, --label <label>", "Release label (default: latest release)")
    .option("--description <text>", "New description (alias --des)")
    .option("-m, --mandatory [bool]", "Set mandatory", parseBool)
    .option("-x, --disabled [bool]", "Set disabled", parseBool)
    .option("-r, --rollout <percent>", "New rollout (can only be increased)")
    .option("-t, --targetBinaryVersion <version>", "New target binary version");

withPatchOptions(
  program
    .command("patch")
    .description("Update the metadata of an existing release")
    .argument("<appName>")
    .argument("<deploymentName>"),
).action(async (appName: string, dep: string, o) => {
  const patch = patchFromOptions(o);
  const pkg = await api().patchRelease(appName, dep, patch);
  success(`updated the "${pkg.label}" release of "${appName}" app's "${dep}" deployment.`);
});

withPatchOptions(
  program
    .command("promote")
    .description("Promote a release from one deployment to another")
    .argument("<appName>")
    .argument("<sourceDeploymentName>")
    .argument("<destDeploymentName>")
    .option("--noDuplicateReleaseError", "Don't error if the release is identical"),
).action(async (appName: string, src: string, dest: string, o) => {
  try {
    const pkg = await api().promote(appName, src, dest, patchFromOptions(o));
    success(`promoted the "${src}" deployment of the "${appName}" app to the "${dest}" deployment (${pkg.label}).`);
  } catch (e) {
    if (o.noDuplicateReleaseError && e instanceof ApiError && e.status === 409) return console.log(c.yellow(`[Warning] ${e.message}`));
    throw e;
  }
});

program
  .command("rollback")
  .description("Roll back a deployment to a previous release")
  .argument("<appName>")
  .argument("<deploymentName>")
  .option("--targetRelease <label>", "Label of the release to roll back to (default: the previous release)")
  .action(async (appName: string, dep: string, o: { targetRelease?: string }) => {
    if (!(await confirm(`Roll back the "${dep}" deployment?`))) return;
    const pkg = await api().rollback(appName, dep, o.targetRelease);
    success(`performed a rollback on the "${dep}" deployment of the "${appName}" app (${pkg.label} → ${pkg.originalLabel}).`);
  });

// ---------------------------------------------------------------- debug

program
  .command("debug")
  .description("Stream Patchkite logs from a connected device/emulator")
  .argument("<platform>", "ios | android")
  .action((platform: string) => {
    const [cmd, args] =
      platform === "android"
        ? ["adb", ["logcat"]]
        : [
            // `script` provides a pseudo-TTY so `log stream` emits output line by line (unbuffered).
            "script",
            [
              "-q",
              "/dev/null",
              "xcrun",
              "simctl",
              "spawn",
              "booted",
              "log",
              "stream",
              "--level",
              "debug",
              "--style",
              "compact",
              "--predicate",
              'eventMessage CONTAINS "[Patchkite]"',
            ],
          ];
    const child = spawn(cmd as string, args as string[], { stdio: ["ignore", "pipe", "inherit"] });
    console.log(c.gray(`Listening for Patchkite logs (${platform})... Press Ctrl+C to stop.`));
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        // Skip the filter line echoed by `log stream`.
        if (!line.includes("[Patchkite]") || line.includes("CONTAINS")) continue;
        console.log(line.slice(line.indexOf("[Patchkite]")).trimEnd());
      }
    });
  });

program.showHelpAfterError();
program.parseAsync(argv).catch((e: Error) => {
  console.error(c.red(`[Error]  ${e.message}`));
  process.exitCode = 1;
});

